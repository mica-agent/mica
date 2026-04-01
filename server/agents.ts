// Mica AI Team — Canvas-Specialized Agents (Claude Agent SDK)
// Uses Claude Code subscription auth — no API key needed.

// Allow nested Claude Code sessions (we're running inside Claude Code's terminal)
delete process.env.CLAUDECODE;

import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import type { SDKMessage, SDKResultSuccess } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod/v4";
import fs from "fs";
import path from "path";
import os from "os";
import type { ProjectExecutor } from "./projectExecutor.js";
import {
  listFiles,
  readCanvasFile,
  writeCanvasFile,
  deleteCanvasFile,
  getAllFilesAsContext,
  getProjectConfig,
  invalidateExtensionCache,
} from "./canvasFiles.js";
import { readMicaConfig, getProjectPath } from "./projectConnection.js";
import { CONTAINER_PROJECT_DIR } from "./dockerSpawn.js";

// ── Project executor for container access ──────────────────
let _executor: ProjectExecutor | null = null;
export function setAgentExecutor(exec: ProjectExecutor): void {
  _executor = exec;
}

// ── Write hook for reactive agent ──────────────────────────
// Called before agent writes a file — allows ReactiveAgent to suppress feedback loops.
let onAgentWrite: ((project: string, canvas: string, filename: string) => void) | null = null;

export function setAgentWriteHook(hook: (project: string, canvas: string, filename: string) => void): void {
  onAgentWrite = hook;
}

// ── Helpers ────────────────────────────────────────────────

/** Build a human-readable one-liner from a tool_use block. */
export function describeToolUse(name: string, input?: Record<string, unknown>): string {
  if (!input) return name;
  switch (name) {
    case "Bash": {
      const cmd = String(input.command || "").split("\n")[0].slice(0, 80);
      return cmd ? `$ ${cmd}` : "Running command";
    }
    case "Read": {
      const fp = String(input.file_path || "");
      return fp ? `Read ${fp.split("/").pop()}` : "Reading file";
    }
    case "Write": {
      const fp = String(input.file_path || "");
      return fp ? `Write ${fp.split("/").pop()}` : "Writing file";
    }
    case "Edit": {
      const fp = String(input.file_path || "");
      return fp ? `Edit ${fp.split("/").pop()}` : "Editing file";
    }
    case "Glob":
      return input.pattern ? `Glob ${input.pattern}` : "Searching files";
    case "Grep":
      return input.pattern ? `Grep ${input.pattern}` : "Searching code";
    default: {
      // MCP tools come as "server__tool" — show just the tool part
      if (name.includes("__")) {
        const toolPart = name.split("__").pop() || name;
        // Try to extract a meaningful arg
        const firstArg = Object.values(input).find((v) => typeof v === "string" && v.length > 0);
        return firstArg ? `${toolPart}: ${String(firstArg).slice(0, 60)}` : toolPart;
      }
      return name;
    }
  }
}

// ── Types ──────────────────────────────────────────────────

export type CanvasId = string;

export interface AgentResponse {
  canvas: CanvasId;
  message: string;
  consultation?: Consultation | null;
  filesChanged?: boolean;
  cost?: number;
  sessionId?: string;
}

export interface Consultation {
  targetCanvas: CanvasId;
  question: string;
  context: string;
}

// ── Agent system prompts ───────────────────────────────────

export function getAgentIdentity(canvas: string): string {
  // Generic identity — canvas-specific personality comes from _brief.brief
  return `You are the AI agent for the "${canvas}" workspace in Mica.`;
}

export const TOOL_INSTRUCTIONS = `
You have access to tools for managing files on the shared whiteboard, reading other canvases, and cross-canvas collaboration.

## Your Canvas's Whiteboard
- list_files: See what files exist on your whiteboard
- read_file: Read a specific file's content
- write_file: Create or update a file (this is how you create artifacts)
- delete_file: Remove a file

When creating files, use kebab-case names with descriptive titles:
- .md for rich content (personas, briefs, analyses, decisions)
- .mmd for mermaid diagrams (flowcharts, architecture, sequences)
- .html for interactive widgets, styled documents, or visual layouts
- .txt for simple notes and lists

## Cross-Canvas Awareness
- list_cross_canvas: See what files exist on another canvas's whiteboard
- read_cross_canvas: Read a specific file from another canvas

USE THESE PROACTIVELY. Before making decisions, check what other canvases have decided.

## Cross-Canvas Collaboration
- consult_canvas: Ask another canvas's agent a question. Response comes back immediately.
  Decision record saved to both whiteboards as _decision-*.md.

Both directions are normal and expected. Don't wait to be asked — if you discover
something that affects another canvas, consult them proactively.

## Decision Files (_decision-*.md)
These are the connective tissue between canvases. They capture:
- What was asked and why
- What the other canvas responded
- The resulting decision

When you see _decision-*.md files on your whiteboard, READ THEM — they contain agreements with other canvases that constrain your work.

## Shell Execution (Your Agent Tools)
- You have access to Bash for running shell commands directly (install packages, inspect files, etc.)
- This is YOUR tool as an agent — do NOT confuse it with the card bridge
- Card classes access the shell via \`mica.exec()\` in their export functions, NOT via your Bash tool
- When building a card that needs to run commands, write export functions that call \`mica.exec()\`

## Custom Card Classes

Card classes are interactive widgets on the whiteboard. Each is a directory with a \`render.js\` file.

### How to create one (3 steps):

**Step 1:** Write the render.js to \`.card-classes/<classname>/render.js\`:

\`\`\`javascript
// .card-classes/file-browser/render.js
export default function render(content, config) {
  // content = the card file's text content
  // config = { project, canvas, filename }
  // Returns HTML string with <style> and <script> blocks
  return \\\`
    <div style="padding:16px;font-family:sans-serif;">
      <div id="output">Loading...</div>
    </div>
    <script>
      // 'mica' and 'container' are injected automatically
      // mica.call(fn, args) → calls an export function
      // container.querySelector(...) → scoped DOM queries
      const data = await mica.call('get_data', {});
      container.querySelector('#output').textContent = JSON.stringify(data);
    </script>
  \\\`;
}

// Named exports are callable from browser via mica.call()
// They run server-side and have access to the full mica bridge
export async function get_data(content, args, mica) {
  // Use mica.exec() for filesystem/shell access:
  const result = await mica.exec('ls -la ' + (args.dir || '.'));
  return { files: result.stdout, error: result.exitCode !== 0 ? result.stderr : null };
}
\`\`\`

**Step 2:** Register in \`.card-classes/_manifest.json\`:
\`\`\`json
{
  "file-browser": {
    "extension": ".file-browser",
    "badge": "FILES",
    "defaultTitle": "File Browser"
  }
}
\`\`\`

**Step 3:** Create a card file with matching extension to place it on the whiteboard:
\`write_file\` with filename \`my-files.file-browser\` (content can be empty or initial data).

### Server bridge in export functions:
- \`await mica.write(content)\` — update this card's file
- \`await mica.readFile(filename)\` — read a canvas file
- \`await mica.writeFile(filename, content)\` — write a canvas file
- \`await mica.exec(command, { cwd?, timeout? })\` — run a shell command, returns \`{ stdout, stderr, exitCode }\`. cwd defaults to project root. Use this for filesystem access (ls, cat, find, etc.)
- \`await mica.fetch(url, opts)\` — HTTP request (requires \`network: true\` in manifest)
- \`await mica.agent.chat(message)\` — send a message to the AI agent
- \`await mica.log(message)\` — append to activity log
- \`await mica.emit(event, data)\` — broadcast to all widgets

### Interactive shell channel (browser-side):
Cards can open an interactive shell for streaming/long-running processes:
\`\`\`javascript
const ch = mica.openChannel('shell', { cols: 80, rows: 24 });
ch.onData((data) => console.log(data.output));  // PTY output
ch.send({ input: 'npm test\\n' });               // send input
ch.send({ resize: true, cols: 120, rows: 40 }); // resize
ch.close();                                       // close when done
\`\`\`

### Key rules:
- render.js runs in a V8 isolate — NO require/import, NO fs/net/fetch. Use \`mica.*\` bridge only
- render() is synchronous, returns HTML string. Exports can be async
- Use \`mica.exec()\` for filesystem access — e.g. \`mica.exec('find . -maxdepth 2 -type f')\`
- Use inline styles (not <style> rules) for widget layout to avoid conflicts
- Use fixed pixel heights (not 100%) — card body max-height is 280px, use ≤260px
- \`container.querySelector()\` not \`document.querySelector()\` for DOM scoping
- For CDN libraries, use \`export const dependencies = { scripts: [...], styles: [...] }\`
- Register cleanup with \`mica.onDestroy(() => ...)\` for libraries that allocate resources
- Look at existing card classes for patterns: \`ls card-classes/\` and \`cat card-classes/<name>/render.js\`

IMPORTANT: Actually use the tools when appropriate — don't just describe what you'd do.

ACTIVITY LOG: When you write or delete files, provide a clear summary/reason — this is automatically logged to _log.log so the human can see what you did and why, even when they weren't watching. This is critical for async collaboration.
`;

export const GOAL_INSTRUCTIONS = `
## Goal-Driven Collaboration

You are a COLLABORATOR, not just a chatbot. Your behavior is driven by the canvas's _goal.goal file.

### How to use _goal.goal:
1. READ IT on every conversation turn to understand what "done" looks like for this canvas.
2. ASSESS PROGRESS: After each interaction, mentally evaluate which checklist items are satisfied by the current whiteboard files and which still have gaps.
3. SURFACE GAPS: Proactively tell the human what's missing or weak. Don't wait to be asked.
4. SUGGEST NEXT STEPS: End your responses with a concrete suggestion for what to work on next, based on the goal checklist.
5. UPDATE THE GOAL: When a checklist item is clearly satisfied, update _goal.goal to check it off ([x]). When new risks or questions emerge, add them.

### How to use _todo.todo:
_todo.todo is the shared commitment tracker between you and the human. It has three sections: Active, Blocked, Done.

FORMAT for items:
- [ ] @agent Draft the API contract — **priority: high**
- [ ] @human Review persona assumptions — **priority: medium**
- [x] @agent Write initial product brief — **done: 2026-03-13**

RULES:
- Prefix every item with @agent or @human to show who owns it.
- When you spot a gap from _goal.goal that needs action, ADD it to _todo.todo.
- **CRITICAL: When you complete a task, IMMEDIATELY update _todo.todo** — move the item to the Done section with [x] and a date. Do this in the SAME turn as completing the work, not later. The human sees the todo card on the whiteboard and uses it to track what's done.
- When something is blocked on another canvas or a human decision, move it to Blocked with a note about what it's waiting on.
- Keep it concise — this is a commitment tracker, not a project plan.

### Working style — be a real teammate:
- **Create cards spontaneously**: When something comes up in conversation that deserves its own artifact — a decision, a question to investigate, a comparison, a risk analysis — just create a file for it. Don't ask permission. A good teammate grabs a marker and writes on the whiteboard mid-discussion.
- **Think out loud on the board**: If you're working through a complex problem, create a working document (e.g., "options-analysis.md", "open-questions.md") rather than only discussing it in chat. Chat is ephemeral; the whiteboard is the shared memory.
- **Name files descriptively**: "competitive-landscape.md" not "analysis.md". The filename IS the card title on the whiteboard.
- **Use diagrams**: When relationships, flows, or hierarchies would be clearer as a visual, create a .mmd mermaid file. Don't default to text for everything.

### Initiative levels:
- When the human gives a DIRECT INSTRUCTION → Execute it, then assess how it moved the goal forward.
- When the human asks an OPEN QUESTION → Answer it, then connect your answer back to the goal and suggest what to tackle next.
- When the human says something VAGUE like "what should we work on?" → Read the goal, assess the whiteboard, and propose the highest-impact next step.

### Tone:
You are a skilled teammate, not an assistant. Push back when something seems wrong. Celebrate real progress. Be honest about gaps. Keep the team focused on what matters.
`;

export function getAgentMeta(canvas: string): { name: string; role: string } {
  const label = canvas
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
  return {
    name: `${label} Agent`,
    role: `AI collaborator for the ${label} workspace`,
  };
}

// ── Activity log helper ─────────────────────────────────────

export async function appendToLog(project: string, canvas: CanvasId, entry: string) {
  const timestamp = new Date().toISOString().replace("T", " ").slice(0, 16);
  const line = `- **${timestamp}** — ${entry}\n`;
  try {
    const existing = await readCanvasFile(project, canvas, "_log.log");
    await writeCanvasFile(project, canvas, "_log.log", existing.content + line);
  } catch {
    // No log yet — create it
    await writeCanvasFile(project, canvas, "_log.log", `# Activity Log\n\n${line}`);
  }
}

// ── MCP Tools for canvas operations ─────────────────────────

// Track which project+canvas the current query is operating on
let currentProject: string = "";
let currentCanvas: CanvasId = "workspace";
let pendingConsultation: Consultation | null = null;
let filesWereChanged = false;

const listFilesTool = tool(
  "list_files",
  "List all files on the current canvas's whiteboard.",
  {},
  async () => {
    const files = await listFiles(currentProject, currentCanvas);
    const listing = files
      .map((f) => `${f.name} (${f.type}, modified ${f.modifiedAt})`)
      .join("\n");
    return {
      content: [
        {
          type: "text" as const,
          text: listing || "(No files yet)",
        },
      ],
    };
  }
);

const readFileTool = tool(
  "read_file",
  "Read a specific file from the whiteboard.",
  {
    filename: z.string().describe("The filename to read (e.g., product-brief.md)"),
  },
  async (args) => {
    const file = await readCanvasFile(currentProject, currentCanvas, args.filename);
    return {
      content: [
        {
          type: "text" as const,
          text: file.content,
        },
      ],
    };
  }
);

const writeFileTool = tool(
  "write_file",
  "Create or update a file. For canvas cards, use a simple filename (e.g., notes.md). For card classes, use a path like .card-classes/my-widget/render.js",
  {
    filename: z
      .string()
      .describe(
        "Filename or path. Canvas cards: 'user-persona.md'. Card classes: '.card-classes/my-widget/render.js' or '.card-classes/_manifest.json'"
      ),
    content: z.string().describe("The file content"),
    summary: z.string().describe("One-line summary of what you did and why (for the activity log)"),
  },
  async (args) => {
    // Reject path traversal
    if (args.filename.includes("..")) {
      return { content: [{ type: "text" as const, text: "Invalid path: '..' not allowed." }] };
    }

    // Route .card-classes/ paths to .mica/.card-classes/ in the project
    if (args.filename.startsWith(".card-classes/")) {
      const projectPath = await getProjectPath(currentProject);
      const targetPath = path.join(projectPath, ".mica", args.filename);
      await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.promises.writeFile(targetPath, args.content, "utf-8");
      // Invalidate extension cache when manifest changes
      if (args.filename.endsWith("_manifest.json")) {
        invalidateExtensionCache();
      }
      filesWereChanged = true;
      await appendToLog(currentProject, currentCanvas, `Updated **${args.filename}**: ${args.summary}`);
      return {
        content: [{ type: "text" as const, text: `File "${args.filename}" written to .mica/${args.filename}` }],
      };
    }

    // Standard canvas file write
    onAgentWrite?.(currentProject, currentCanvas, args.filename);
    await writeCanvasFile(currentProject, currentCanvas, args.filename, args.content);
    filesWereChanged = true;
    // Append to activity log (skip if writing the log itself)
    if (args.filename !== "_log.log") {
      await appendToLog(currentProject, currentCanvas, `Updated **${args.filename}**: ${args.summary}`);
    }
    return {
      content: [
        {
          type: "text" as const,
          text: `File "${args.filename}" written to ${currentCanvas} whiteboard.`,
        },
      ],
    };
  }
);

const deleteFileTool = tool(
  "delete_file",
  "Delete a file from the whiteboard.",
  {
    filename: z.string().describe("The filename to delete"),
    reason: z.string().describe("Why this file is being deleted (for the activity log)"),
  },
  async (args) => {
    onAgentWrite?.(currentProject, currentCanvas, args.filename);
    await deleteCanvasFile(currentProject, currentCanvas, args.filename);
    filesWereChanged = true;
    await appendToLog(currentProject, currentCanvas, `Deleted **${args.filename}**: ${args.reason}`);
    return {
      content: [
        {
          type: "text" as const,
          text: `File "${args.filename}" deleted from ${currentCanvas} whiteboard.`,
        },
      ],
    };
  }
);


// ── Cross-canvas tools ─────────────────────────────────────

const readCrossCanvasTool = tool(
  "read_cross_canvas",
  "Read a file from another canvas's whiteboard. Use this to check what decisions, constraints, or artifacts exist in other canvases before making your own decisions.",
  {
    canvas: z
      .string()
      .describe("Which canvas to read from (e.g., 'workspace', 'mission', etc.)"),
    filename: z.string().describe("The filename to read (e.g., _goal.goal, product-brief.md)"),
  },
  async (args) => {
    try {
      const file = await readCanvasFile(currentProject, args.canvas, args.filename);
      return {
        content: [
          {
            type: "text" as const,
            text: `[From ${args.canvas} canvas — ${args.filename}]\n\n${file.content}`,
          },
        ],
      };
    } catch {
      return {
        content: [
          {
            type: "text" as const,
            text: `File "${args.filename}" not found in ${args.canvas} canvas.`,
          },
        ],
      };
    }
  }
);

const listCrossCanvasTool = tool(
  "list_cross_canvas",
  "List files on another canvas's whiteboard. Use this to discover what artifacts and decisions exist in other canvases.",
  {
    canvas: z
      .string()
      .describe("Which canvas to list files from (e.g., 'workspace', 'mission', etc.)"),
  },
  async (args) => {
    const files = await listFiles(currentProject, args.canvas);
    const listing = files
      .map((f) => `${f.name} (${f.type}, modified ${f.modifiedAt})`)
      .join("\n");
    return {
      content: [
        {
          type: "text" as const,
          text: `[${args.canvas} canvas files]\n${listing || "(No files yet)"}`,
        },
      ],
    };
  }
);

const consultCanvasTool = tool(
  "consult_canvas",
  "Consult another canvas's agent — ask a question and get their response. Use for decisions that need another perspective. The Q&A is saved as a decision record on both whiteboards.",
  {
    target_canvas: z
      .string()
      .describe("Which canvas agent to ask (e.g., 'workspace', 'mission', etc.)"),
    question: z.string().describe("The question or decision needed"),
    context: z.string().describe("Relevant context for the target agent"),
  },
  async (args) => {
    const targetCanvas = args.target_canvas;
    const fromMeta = getAgentMeta(currentCanvas);
    const toMeta = getAgentMeta(targetCanvas);

    // Call the target agent directly (synchronous consultation)
    const response = await chatWithAgent(
      currentProject,
      targetCanvas,
      `[Cross-canvas question from ${fromMeta.name} (${currentCanvas} canvas)]\n\nQuestion: ${args.question}\n\nContext: ${args.context}\n\nPlease respond from your perspective as the ${toMeta.name}. Be concrete and actionable. If this leads to a decision, state it clearly.`
    );

    const responseText = response.message || "(No response)";

    // Write decision record to both canvases
    const timestamp = new Date().toISOString().slice(0, 10);
    const slug = args.question
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .slice(0, 40)
      .replace(/-$/, "");
    const decisionFilename = `_decision-${slug}.md`;
    const decisionContent = `# Cross-Canvas Decision\n\n**Date:** ${timestamp}\n**From:** ${fromMeta.name} (${currentCanvas})\n**To:** ${toMeta.name} (${targetCanvas})\n\n## Question\n${args.question}\n\n## Context\n${args.context}\n\n## Response from ${toMeta.name}\n${responseText}\n`;

    // Save to originating canvas
    await writeCanvasFile(currentProject, currentCanvas, decisionFilename, decisionContent);
    await appendToLog(currentProject, currentCanvas, `Cross-canvas decision with ${targetCanvas}: "${args.question}" → saved to **${decisionFilename}**`);

    // Save to target canvas
    await writeCanvasFile(currentProject, targetCanvas, decisionFilename, decisionContent);
    await appendToLog(currentProject, targetCanvas, `Responded to ${currentCanvas} canvas: "${args.question}" → saved to **${decisionFilename}**`);

    filesWereChanged = true;

    return {
      content: [
        {
          type: "text" as const,
          text: `[Response from ${toMeta.name} (${targetCanvas} canvas)]\n\n${responseText}\n\n---\nDecision saved to ${decisionFilename} on both whiteboards.`,
        },
      ],
    };
  }
);

// Create a fresh MCP server per call to avoid "Already connected to a transport" errors.
function createMicaToolServer() {
  return createSdkMcpServer({
    name: "mica-tools",
    tools: [listFilesTool, readFileTool, writeFileTool, deleteFileTool, readCrossCanvasTool, listCrossCanvasTool, consultCanvasTool],
  });
}

// ── Session tracking per project/canvas ─────────────────────

const canvasSessions: Record<string, string | undefined> = {};

function sessionKey(project: string, canvas: string): string {
  return `${project}/${canvas}`;
}

// ── Agent Runner ───────────────────────────────────────────

export type ProgressCallback = (event: {
  type: string;
  tool?: string;
  elapsed?: number;
  description?: string;
}) => void;

export async function chatWithAgent(
  project: string,
  canvas: CanvasId,
  userMessage: string,
  _imageBase64?: string,
  onProgress?: ProgressCallback,
  resumeSessionId?: string,
): Promise<AgentResponse> {
  // Set current project+canvas for tool callbacks
  currentProject = project;
  currentCanvas = canvas;
  pendingConsultation = null;
  filesWereChanged = false;

  // Build system prompt with current file context
  const fileContext = await getAllFilesAsContext(project, canvas);

  // Read _brief.brief for canvas-specific instructions (user-editable)
  let briefContent = "";
  try {
    const brief = await readCanvasFile(project, canvas, "_brief.brief");
    briefContent = `\n## Canvas Brief (from _brief.brief)\n\n${brief.content}\n`;
  } catch {
    // No _brief.brief yet — that's fine, use defaults
  }

  const systemPrompt = `${getAgentIdentity(canvas)}
${briefContent}
${TOOL_INSTRUCTIONS}
${GOAL_INSTRUCTIONS}

## Current Whiteboard Files (${canvas} canvas)

${fileContext}`;

  let resultText = "";
  let cost = 0;
  let sessionId: string | undefined;

  // Resolve model: per-agent config > project default > fallback
  const micaConfig = await readMicaConfig(project);
  const model = micaConfig?.agents?.[canvas]?.model
    || micaConfig?.model
    || "claude-sonnet-4-6";

  const options: Record<string, unknown> = {
    systemPrompt,
    cwd: CONTAINER_PROJECT_DIR,
    mcpServers: { "mica-tools": createMicaToolServer() },
    tools: ["Bash"], // enable shell execution for code generation
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    maxTurns: 10,
    model,
    settings: { forceLoginMethod: "claudeai" as const },
    settingSources: ["user" as const, "project" as const],
    ...(resumeSessionId ? { resume: resumeSessionId } : {}),
  };

  // Run inside the shared project container.
  if (_executor) {
    options.spawnClaudeCodeProcess = await _executor.createAgentSpawner(project, canvas);
  }

  // Emit initial "thinking" event so the UI knows we're active immediately
  onProgress?.({ type: "thinking", description: "Thinking..." });

  for await (const message of query({
    prompt: userMessage,
    options: options as import("@anthropic-ai/claude-agent-sdk").Options,
  })) {
    const msg = message as SDKMessage;

    // Emit progress events for tool use
    if (onProgress) {
      if (msg.type === "assistant" && msg.message?.content) {
        for (const block of msg.message.content) {
          if ("type" in block && block.type === "tool_use" && "name" in block) {
            const b = block as { name: string; input?: Record<string, unknown> };
            const detail = describeToolUse(b.name, b.input);
            onProgress({ type: "tool_start", tool: b.name, description: detail });
          }
        }
      }
    }

    // Only keep the last assistant message's text (not intermediate narration)
    if (msg.type === "assistant" && msg.message?.content) {
      let turnText = "";
      for (const block of msg.message.content) {
        if ("type" in block && block.type === "text" && "text" in block) {
          turnText += (block as { text: string }).text;
        }
      }
      if (turnText) resultText = turnText;
    }

    if (msg.type === "result" && "result" in msg) {
      const result = msg as SDKResultSuccess;
      resultText = result.result || resultText;
      cost = result.total_cost_usd || 0;
      sessionId = result.session_id;
    }
  }

  // If agent used all turns on tool calls without producing text, provide a fallback
  if (!resultText.trim()) {
    resultText = filesWereChanged
      ? "Done — I made changes to the whiteboard. Let me know if you'd like me to continue."
      : "I looked into it but ran out of steps before I could respond. Say 'continue' and I'll pick up where I left off.";
  }

  return {
    canvas,
    message: resultText,
    consultation: pendingConsultation ? { ...pendingConsultation } : null,
    filesChanged: filesWereChanged,
    cost,
    sessionId,
  };
}

// consultCanvas is now handled inline by the consult_canvas tool.
// Kept as a convenience for the team discuss flow.
export async function consultCanvas(
  project: string,
  fromCanvas: CanvasId,
  toCanvas: CanvasId,
  question: string,
  context: string
): Promise<AgentResponse> {
  const fromMeta = getAgentMeta(fromCanvas);
  const toMeta = getAgentMeta(toCanvas);
  const prompt = `[Cross-canvas question from ${fromMeta.name} (${fromCanvas} canvas)]

Question: ${question}

Context: ${context}

Please respond from your perspective as the ${toMeta.name}. Be concrete and actionable.`;

  return chatWithAgent(project, toCanvas, prompt);
}

export async function teamDiscuss(
  project: string,
  canvases: string[]
): Promise<Record<string, AgentResponse>> {
  // Note: for projects with custom canvases, we discuss across all canvases
  // For legacy compatibility, if no canvases provided, use the project's canvases
  if (canvases.length === 0) {
    const config = await getProjectConfig(project);
    canvases = config?.canvases || ["workspace"];
  }

  const results = await Promise.all(
    canvases.map((canvas) =>
      chatWithAgent(
        project,
        canvas,
        `[Team Discussion] The human wants the team's input on this topic.\n\nRespond from your perspective as the ${getAgentMeta(canvas).name}. Be concise (2-3 paragraphs max).`
      )
    )
  );

  return Object.fromEntries(
    canvases.map((canvas, i) => [canvas, results[i]])
  );
}

export async function convertDrawingToMermaid(
  project: string,
  canvas: CanvasId,
  imageBase64: string
): Promise<{ mermaid: string; filename: string }> {
  // Write image to a temp file so the agent can read it
  const tmpDir = os.tmpdir();
  const tmpFile = path.join(tmpDir, `mica-drawing-${Date.now()}.png`);
  fs.writeFileSync(tmpFile, Buffer.from(imageBase64, "base64"));

  // Resolve model from project config
  const micaConfig = await readMicaConfig(project);
  const model = micaConfig?.agents?.[canvas]?.model
    || micaConfig?.model
    || "claude-sonnet-4-6";

  let resultText = "";

  try {
    for await (const message of query({
      prompt: `Read the image file at ${tmpFile} and convert the hand-drawn diagram into Mermaid syntax. Output ONLY the raw mermaid code. No markdown fences, no explanation, no commentary. Just the mermaid diagram code.`,
      options: {
        allowedTools: ["Read"],
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        maxTurns: 3,
        model,
        settings: { forceLoginMethod: "claudeai" as const },
        settingSources: ["user" as const],
      } as import("@anthropic-ai/claude-agent-sdk").Options,
    })) {
      const msg = message as SDKMessage;
      if (msg.type === "result" && "result" in msg) {
        resultText = (msg as SDKResultSuccess).result || "";
      }
    }
  } finally {
    // Clean up temp file
    try { fs.unlinkSync(tmpFile); } catch {}
  }

  // Strip markdown fences if present
  let mermaidCode = resultText.trim();
  if (mermaidCode.startsWith("```")) {
    mermaidCode = mermaidCode.replace(/^```(?:mermaid)?\n?/, "").replace(/\n?```$/, "");
  }

  if (!mermaidCode) {
    throw new Error("Failed to convert drawing to mermaid");
  }

  const filename = `drawing-${Date.now()}.mmd`;
  await writeCanvasFile(project, canvas, filename, mermaidCode);
  return { mermaid: mermaidCode, filename };
}

export function resetCanvas(project: string, canvas: CanvasId) {
  const sKey = sessionKey(project, canvas);
  canvasSessions[sKey] = undefined;
}

export function resetAll() {
  for (const key of Object.keys(canvasSessions)) {
    canvasSessions[key] = undefined;
  }
}
