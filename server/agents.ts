// Mica AI Team — Layer-Specialized Agents (Claude Agent SDK)
// Uses Claude Code subscription auth — no API key needed.

// Allow nested Claude Code sessions (we're running inside Claude Code's terminal)
delete process.env.CLAUDECODE;

import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import type { SDKMessage, SDKResultSuccess } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod/v4";
import fs from "fs";
import path from "path";
import os from "os";
import { isDockerEnabled, createDockerSpawner } from "./dockerSpawn.js";
import {
  listFiles,
  readLayerFile,
  writeLayerFile,
  deleteLayerFile,
  getAllFilesAsContext,
  getProjectConfig,
} from "./layerFiles.js";
import { readMicaConfig } from "./projectConnection.js";

// ── Helpers ────────────────────────────────────────────────

/** Build a human-readable one-liner from a tool_use block. */
function describeToolUse(name: string, input?: Record<string, unknown>): string {
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

export type LayerId = string;

export interface AgentResponse {
  layer: LayerId;
  message: string;
  consultation?: Consultation | null;
  filesChanged?: boolean;
  cost?: number;
}

export interface Consultation {
  targetLayer: LayerId;
  question: string;
  context: string;
}

// ── Agent system prompts ───────────────────────────────────

function getAgentIdentity(layer: string): string {
  // Generic identity — layer-specific personality comes from _brief.md
  return `You are the AI agent for the "${layer}" workspace in Mica.`;
}

const TOOL_INSTRUCTIONS = `
You have access to tools for managing files on the shared whiteboard, reading other layers, and cross-layer collaboration.

## Your Layer's Whiteboard
- list_files: See what files exist on your whiteboard
- read_file: Read a specific file's content
- write_file: Create or update a file (this is how you create artifacts)
- delete_file: Remove a file

When creating files, use kebab-case names with descriptive titles:
- .md for rich content (personas, briefs, analyses, decisions)
- .mmd for mermaid diagrams (flowcharts, architecture, sequences)
- .html for interactive widgets, styled documents, or visual layouts
- .txt for simple notes and lists

## Cross-Layer Awareness
- list_cross_layer: See what files exist on another layer's whiteboard
- read_cross_layer: Read a specific file from another layer

USE THESE PROACTIVELY. Before making decisions, check what other layers have decided.

## Cross-Layer Collaboration
- consult_layer: Ask another layer's agent a question. Response comes back immediately.
  Decision record saved to both whiteboards as _decision-*.md.

Both directions are normal and expected. Don't wait to be asked — if you discover
something that affects another layer, consult them proactively.

## Decision Files (_decision-*.md)
These are the connective tissue between layers. They capture:
- What was asked and why
- What the other layer responded
- The resulting decision

When you see _decision-*.md files on your whiteboard, READ THEM — they contain agreements with other layers that constrain your work.

## Shell Execution
- You have access to Bash for running shell commands (install packages, run scripts, execute code, etc.)
- Use this when tasks require code execution, data processing, or system commands
- Working directory is the project root
- Keep commands focused and safe — avoid destructive operations unless explicitly asked

## Custom Widgets
- To create a new interactive widget card class, first read the docs: \`cat card-classes/CREATING_WIDGETS.md\`
- Project-specific card classes go in \`.mica/_card-classes/<classname>/render.py\` (inside the project's .mica directory, NOT inside a layer)
- The project root is your working directory — card classes live at .mica/_card-classes/
- Then create a \`_<classname>.md\` file in the layer to use it

IMPORTANT: Actually use the tools when appropriate — don't just describe what you'd do.

ACTIVITY LOG: When you write or delete files, provide a clear summary/reason — this is automatically logged to _log.md so the human can see what you did and why, even when they weren't watching. This is critical for async collaboration.
`;

const GOAL_INSTRUCTIONS = `
## Goal-Driven Collaboration

You are a COLLABORATOR, not just a chatbot. Your behavior is driven by the layer's _goal.md file.

### How to use _goal.md:
1. READ IT on every conversation turn to understand what "done" looks like for this layer.
2. ASSESS PROGRESS: After each interaction, mentally evaluate which checklist items are satisfied by the current whiteboard files and which still have gaps.
3. SURFACE GAPS: Proactively tell the human what's missing or weak. Don't wait to be asked.
4. SUGGEST NEXT STEPS: End your responses with a concrete suggestion for what to work on next, based on the goal checklist.
5. UPDATE THE GOAL: When a checklist item is clearly satisfied, update _goal.md to check it off ([x]). When new risks or questions emerge, add them.

### How to use _todo.md:
_todo.md is the shared commitment tracker between you and the human. It has three sections: Active, Blocked, Done.

FORMAT for items:
- [ ] @agent Draft the API contract — **priority: high**
- [ ] @human Review persona assumptions — **priority: medium**
- [x] @agent Write initial product brief — **done: 2026-03-13**

RULES:
- Prefix every item with @agent or @human to show who owns it.
- When you spot a gap from _goal.md that needs action, ADD it to _todo.md.
- **CRITICAL: When you complete a task, IMMEDIATELY update _todo.md** — move the item to the Done section with [x] and a date. Do this in the SAME turn as completing the work, not later. The human sees the todo card on the whiteboard and uses it to track what's done.
- When something is blocked on another layer or a human decision, move it to Blocked with a note about what it's waiting on.
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

export function getAgentMeta(layer: string): { name: string; role: string } {
  const label = layer
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
  return {
    name: `${label} Agent`,
    role: `AI collaborator for the ${label} workspace`,
  };
}

// ── Activity log helper ─────────────────────────────────────

async function appendToLog(project: string, layer: LayerId, entry: string) {
  const timestamp = new Date().toISOString().replace("T", " ").slice(0, 16);
  const line = `- **${timestamp}** — ${entry}\n`;
  try {
    const existing = await readLayerFile(project, layer, "_log.md");
    await writeLayerFile(project, layer, "_log.md", existing.content + line);
  } catch {
    // No log yet — create it
    await writeLayerFile(project, layer, "_log.md", `# Activity Log\n\n${line}`);
  }
}

// ── MCP Tools for layer operations ─────────────────────────

// Track which project+layer the current query is operating on
let currentProject: string = "";
let currentLayer: LayerId = "workspace";
let pendingConsultation: Consultation | null = null;
let filesWereChanged = false;

const listFilesTool = tool(
  "list_files",
  "List all files on the current layer's whiteboard.",
  {},
  async () => {
    const files = await listFiles(currentProject, currentLayer);
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
    const file = await readLayerFile(currentProject, currentLayer, args.filename);
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
  "Create or update a file on the whiteboard. Use .md for rich content, .mmd for mermaid diagrams, .txt for simple notes.",
  {
    filename: z
      .string()
      .describe(
        "Filename with extension (e.g., user-persona.md, system-flow.mmd, notes.txt)"
      ),
    content: z.string().describe("The file content"),
    summary: z.string().describe("One-line summary of what you did and why (for the activity log)"),
  },
  async (args) => {
    await writeLayerFile(currentProject, currentLayer, args.filename, args.content);
    filesWereChanged = true;
    // Append to activity log (skip if writing the log itself)
    if (args.filename !== "_log.md") {
      await appendToLog(currentProject, currentLayer, `Updated **${args.filename}**: ${args.summary}`);
    }
    return {
      content: [
        {
          type: "text" as const,
          text: `File "${args.filename}" written to ${currentLayer} whiteboard.`,
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
    await deleteLayerFile(currentProject, currentLayer, args.filename);
    filesWereChanged = true;
    await appendToLog(currentProject, currentLayer, `Deleted **${args.filename}**: ${args.reason}`);
    return {
      content: [
        {
          type: "text" as const,
          text: `File "${args.filename}" deleted from ${currentLayer} whiteboard.`,
        },
      ],
    };
  }
);

// ── Cross-layer tools ─────────────────────────────────────

const readCrossLayerTool = tool(
  "read_cross_layer",
  "Read a file from another layer's whiteboard. Use this to check what decisions, constraints, or artifacts exist in other layers before making your own decisions.",
  {
    layer: z
      .string()
      .describe("Which layer to read from (e.g., 'workspace', 'mission', etc.)"),
    filename: z.string().describe("The filename to read (e.g., _goal.md, product-brief.md)"),
  },
  async (args) => {
    try {
      const file = await readLayerFile(currentProject, args.layer, args.filename);
      return {
        content: [
          {
            type: "text" as const,
            text: `[From ${args.layer} layer — ${args.filename}]\n\n${file.content}`,
          },
        ],
      };
    } catch {
      return {
        content: [
          {
            type: "text" as const,
            text: `File "${args.filename}" not found in ${args.layer} layer.`,
          },
        ],
      };
    }
  }
);

const listCrossLayerTool = tool(
  "list_cross_layer",
  "List files on another layer's whiteboard. Use this to discover what artifacts and decisions exist in other layers.",
  {
    layer: z
      .string()
      .describe("Which layer to list files from (e.g., 'workspace', 'mission', etc.)"),
  },
  async (args) => {
    const files = await listFiles(currentProject, args.layer);
    const listing = files
      .map((f) => `${f.name} (${f.type}, modified ${f.modifiedAt})`)
      .join("\n");
    return {
      content: [
        {
          type: "text" as const,
          text: `[${args.layer} layer files]\n${listing || "(No files yet)"}`,
        },
      ],
    };
  }
);

const consultLayerTool = tool(
  "consult_layer",
  "Consult another layer's agent — ask a question and get their response. Use for decisions that need another perspective. The Q&A is saved as a decision record on both whiteboards.",
  {
    target_layer: z
      .string()
      .describe("Which layer agent to ask (e.g., 'workspace', 'mission', etc.)"),
    question: z.string().describe("The question or decision needed"),
    context: z.string().describe("Relevant context for the target agent"),
  },
  async (args) => {
    const targetLayer = args.target_layer;
    const fromMeta = getAgentMeta(currentLayer);
    const toMeta = getAgentMeta(targetLayer);

    // Call the target agent directly (synchronous consultation)
    const response = await chatWithAgent(
      currentProject,
      targetLayer,
      `[Cross-layer question from ${fromMeta.name} (${currentLayer} layer)]\n\nQuestion: ${args.question}\n\nContext: ${args.context}\n\nPlease respond from your perspective as the ${toMeta.name}. Be concrete and actionable. If this leads to a decision, state it clearly.`
    );

    const responseText = response.message || "(No response)";

    // Write decision record to both layers
    const timestamp = new Date().toISOString().slice(0, 10);
    const slug = args.question
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .slice(0, 40)
      .replace(/-$/, "");
    const decisionFilename = `_decision-${slug}.md`;
    const decisionContent = `# Cross-Layer Decision\n\n**Date:** ${timestamp}\n**From:** ${fromMeta.name} (${currentLayer})\n**To:** ${toMeta.name} (${targetLayer})\n\n## Question\n${args.question}\n\n## Context\n${args.context}\n\n## Response from ${toMeta.name}\n${responseText}\n`;

    // Save to originating layer
    await writeLayerFile(currentProject, currentLayer, decisionFilename, decisionContent);
    await appendToLog(currentProject, currentLayer, `Cross-layer decision with ${targetLayer}: "${args.question}" → saved to **${decisionFilename}**`);

    // Save to target layer
    await writeLayerFile(currentProject, targetLayer, decisionFilename, decisionContent);
    await appendToLog(currentProject, targetLayer, `Responded to ${currentLayer} layer: "${args.question}" → saved to **${decisionFilename}**`);

    filesWereChanged = true;

    return {
      content: [
        {
          type: "text" as const,
          text: `[Response from ${toMeta.name} (${targetLayer} layer)]\n\n${responseText}\n\n---\nDecision saved to ${decisionFilename} on both whiteboards.`,
        },
      ],
    };
  }
);

// Create a fresh MCP server per call to avoid "Already connected to a transport" errors.
function createMicaToolServer() {
  return createSdkMcpServer({
    name: "mica-tools",
    tools: [listFilesTool, readFileTool, writeFileTool, deleteFileTool, readCrossLayerTool, listCrossLayerTool, consultLayerTool],
  });
}

// ── Session tracking per project/layer ─────────────────────

const layerSessions: Record<string, string | undefined> = {};

function sessionKey(project: string, layer: string): string {
  return `${project}/${layer}`;
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
  layer: LayerId,
  userMessage: string,
  _imageBase64?: string,
  onProgress?: ProgressCallback
): Promise<AgentResponse> {
  // Set current project+layer for tool callbacks
  currentProject = project;
  currentLayer = layer;
  pendingConsultation = null;
  filesWereChanged = false;

  // Build system prompt with current file context
  const fileContext = await getAllFilesAsContext(project, layer);

  // Read _brief.md for layer-specific instructions (user-editable)
  let briefContent = "";
  try {
    const brief = await readLayerFile(project, layer, "_brief.md");
    briefContent = `\n## Layer Brief (from _brief.md)\n\n${brief.content}\n`;
  } catch {
    // No _brief.md yet — that's fine, use defaults
  }

  const systemPrompt = `${getAgentIdentity(layer)}
${briefContent}
${TOOL_INSTRUCTIONS}
${GOAL_INSTRUCTIONS}

## Current Whiteboard Files (${layer} layer)

${fileContext}`;

  let resultText = "";
  let cost = 0;
  let sessionId: string | undefined;
  const sKey = sessionKey(project, layer);

  // Resolve model: per-agent config > project default > fallback
  const micaConfig = await readMicaConfig(project);
  const model = micaConfig?.agents?.[layer]?.model
    || micaConfig?.model
    || "claude-sonnet-4-6";

  const options: Record<string, unknown> = {
    systemPrompt,
    mcpServers: { "mica-tools": createMicaToolServer() },
    tools: ["Bash"], // enable shell execution for code generation
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    persistSession: true,
    maxTurns: 5,
    model,
    settings: { forceLoginMethod: "claudeai" as const },
    settingSources: ["user" as const],
  };

  // Resume existing session for this layer if we have one
  if (layerSessions[sKey]) {
    options.resume = layerSessions[sKey];
  }

  // PROD mode: sandbox Bash execution in Docker container
  if (await isDockerEnabled(project)) {
    options.spawnClaudeCodeProcess = await createDockerSpawner(project, layer);
  }

  // Emit initial "thinking" event so the UI knows we're active immediately
  onProgress?.({ type: "thinking", description: "Thinking..." });

  for await (const message of query({
    prompt: userMessage,
    options: options as import("@anthropic-ai/claude-agent-sdk").Options,
  })) {
    const msg = message as SDKMessage;

    if (msg.type === "system" && "subtype" in msg && msg.subtype === "init") {
      sessionId = msg.session_id;
    }

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
    }
  }

  // Save session for continuity
  if (sessionId) {
    layerSessions[sKey] = sessionId;
  }

  return {
    layer,
    message: resultText,
    consultation: pendingConsultation ? { ...pendingConsultation } : null,
    filesChanged: filesWereChanged,
    cost,
  };
}

// consultLayer is now handled inline by the consult_layer tool.
// Kept as a convenience for the team discuss flow.
export async function consultLayer(
  project: string,
  fromLayer: LayerId,
  toLayer: LayerId,
  question: string,
  context: string
): Promise<AgentResponse> {
  const fromMeta = getAgentMeta(fromLayer);
  const toMeta = getAgentMeta(toLayer);
  const prompt = `[Cross-layer question from ${fromMeta.name} (${fromLayer} layer)]

Question: ${question}

Context: ${context}

Please respond from your perspective as the ${toMeta.name}. Be concrete and actionable.`;

  return chatWithAgent(project, toLayer, prompt);
}

export async function teamDiscuss(
  project: string,
  layers: string[]
): Promise<Record<string, AgentResponse>> {
  // Note: for projects with custom layers, we discuss across all layers
  // For legacy compatibility, if no layers provided, use the project's layers
  if (layers.length === 0) {
    const config = await getProjectConfig(project);
    layers = config?.layers || ["workspace"];
  }

  const results = await Promise.all(
    layers.map((layer) =>
      chatWithAgent(
        project,
        layer,
        `[Team Discussion] The human wants the team's input on this topic.\n\nRespond from your perspective as the ${getAgentMeta(layer).name}. Be concise (2-3 paragraphs max).`
      )
    )
  );

  return Object.fromEntries(
    layers.map((layer, i) => [layer, results[i]])
  );
}

export async function convertDrawingToMermaid(
  project: string,
  layer: LayerId,
  imageBase64: string
): Promise<{ mermaid: string; filename: string }> {
  // Write image to a temp file so the agent can read it
  const tmpDir = os.tmpdir();
  const tmpFile = path.join(tmpDir, `mica-drawing-${Date.now()}.png`);
  fs.writeFileSync(tmpFile, Buffer.from(imageBase64, "base64"));

  // Resolve model from project config
  const micaConfig = await readMicaConfig(project);
  const model = micaConfig?.agents?.[layer]?.model
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
  await writeLayerFile(project, layer, filename, mermaidCode);
  return { mermaid: mermaidCode, filename };
}

export function resetLayer(project: string, layer: LayerId) {
  const sKey = sessionKey(project, layer);
  layerSessions[sKey] = undefined;
}

export function resetAll() {
  for (const key of Object.keys(layerSessions)) {
    layerSessions[key] = undefined;
  }
}
