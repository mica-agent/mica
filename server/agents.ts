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
import {
  listFiles,
  readLayerFile,
  writeLayerFile,
  deleteLayerFile,
  getAllFilesAsContext,
} from "./layerFiles.js";

// ── Types ──────────────────────────────────────────────────

export type LayerId =
  | "mission"
  | "experience"
  | "architecture"
  | "implementation";

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

// Minimal identity lines — the real instructions come from _brief.md on the whiteboard
const AGENT_IDENTITY: Record<LayerId, string> = {
  mission: `You are the Mission Strategist — the AI agent for the Mission layer in Mica.`,
  experience: `You are the Experience Designer — the AI agent for the Experience layer in Mica.`,
  architecture: `You are the System Architect — the AI agent for the Architecture layer in Mica.`,
  implementation: `You are the Implementation Engineer — the AI agent for the Implementation layer in Mica.`,
};

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
- .txt for simple notes and lists

## Cross-Layer Awareness
- list_cross_layer: See what files exist on another layer's whiteboard
- read_cross_layer: Read a specific file from another layer

USE THESE PROACTIVELY. Before making decisions, check what upstream layers have decided:
- Architecture should read Mission's _goal.md and product brief before designing
- Experience should read Mission's persona and value prop before designing flows
- Implementation should read Architecture's technical decisions before coding

## Cross-Layer Collaboration
- consult_layer: Ask another layer's agent a question. Response comes back immediately.
  Decision record saved to both whiteboards as _decision-*.md.

Typical flow directions:
- DOWNWARD (push decisions): Mission → Experience → Architecture → Implementation
  "Here's what we decided — design/build accordingly"
- UPWARD (surface constraints): Implementation → Architecture → Experience → Mission
  "We discovered X — does this change the plan?"

Both directions are normal and expected. Don't wait to be asked — if you discover
something that affects another layer, consult them proactively.

## Decision Files (_decision-*.md)
These are the connective tissue between layers. They capture:
- What was asked and why
- What the other layer responded
- The resulting decision

When you see _decision-*.md files on your whiteboard, READ THEM — they contain agreements with other layers that constrain your work.

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
- When you complete a task, move it to the Done section with [x] and a date.
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

export const AGENT_META: Record<LayerId, { name: string; role: string }> = {
  mission: {
    name: "Mission Strategist",
    role: "Product strategy, user research, and scope definition",
  },
  experience: {
    name: "Experience Designer",
    role: "UX flows, wireframes, interaction design, and user journeys",
  },
  architecture: {
    name: "System Architect",
    role: "Technical design, component architecture, API contracts, and trade-offs",
  },
  implementation: {
    name: "Implementation Engineer",
    role: "Code, testing, deployment, and sprint execution",
  },
};

// ── Activity log helper ─────────────────────────────────────

async function appendToLog(layer: LayerId, entry: string) {
  const timestamp = new Date().toISOString().replace("T", " ").slice(0, 16);
  const line = `- **${timestamp}** — ${entry}\n`;
  try {
    const existing = await readLayerFile(layer, "_log.md");
    await writeLayerFile(layer, "_log.md", existing.content + line);
  } catch {
    // No log yet — create it
    await writeLayerFile(layer, "_log.md", `# Activity Log\n\n${line}`);
  }
}

// ── MCP Tools for layer operations ─────────────────────────

// Track which layer the current query is operating on
let currentLayer: LayerId = "mission";
let pendingConsultation: Consultation | null = null;
let filesWereChanged = false;

const listFilesTool = tool(
  "list_files",
  "List all files on the current layer's whiteboard.",
  {},
  async () => {
    const files = await listFiles(currentLayer);
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
    const file = await readLayerFile(currentLayer, args.filename);
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
    await writeLayerFile(currentLayer, args.filename, args.content);
    filesWereChanged = true;
    // Append to activity log (skip if writing the log itself)
    if (args.filename !== "_log.md") {
      await appendToLog(currentLayer, `Updated **${args.filename}**: ${args.summary}`);
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
    await deleteLayerFile(currentLayer, args.filename);
    filesWereChanged = true;
    await appendToLog(currentLayer, `Deleted **${args.filename}**: ${args.reason}`);
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
      .enum(["mission", "experience", "architecture", "implementation"])
      .describe("Which layer to read from"),
    filename: z.string().describe("The filename to read (e.g., _goal.md, product-brief.md)"),
  },
  async (args) => {
    try {
      const file = await readLayerFile(args.layer as LayerId, args.filename);
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
      .enum(["mission", "experience", "architecture", "implementation"])
      .describe("Which layer to list files from"),
  },
  async (args) => {
    const files = await listFiles(args.layer as LayerId);
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
      .enum(["mission", "experience", "architecture", "implementation"])
      .describe("Which layer agent to ask"),
    question: z.string().describe("The question or decision needed"),
    context: z.string().describe("Relevant context for the target agent"),
  },
  async (args) => {
    const targetLayer = args.target_layer as LayerId;
    const fromName = AGENT_META[currentLayer].name;
    const toName = AGENT_META[targetLayer].name;

    // Call the target agent directly (synchronous consultation)
    const response = await chatWithAgent(
      targetLayer,
      `[Cross-layer question from ${fromName} (${currentLayer} layer)]\n\nQuestion: ${args.question}\n\nContext: ${args.context}\n\nPlease respond from your perspective as the ${toName}. Be concrete and actionable. If this leads to a decision, state it clearly.`
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
    const decisionContent = `# Cross-Layer Decision\n\n**Date:** ${timestamp}\n**From:** ${fromName} (${currentLayer})\n**To:** ${toName} (${targetLayer})\n\n## Question\n${args.question}\n\n## Context\n${args.context}\n\n## Response from ${toName}\n${responseText}\n`;

    // Save to originating layer
    await writeLayerFile(currentLayer, decisionFilename, decisionContent);
    await appendToLog(currentLayer, `Cross-layer decision with ${targetLayer}: "${args.question}" → saved to **${decisionFilename}**`);

    // Save to target layer
    await writeLayerFile(targetLayer, decisionFilename, decisionContent);
    await appendToLog(targetLayer, `Responded to ${currentLayer} layer: "${args.question}" → saved to **${decisionFilename}**`);

    filesWereChanged = true;

    return {
      content: [
        {
          type: "text" as const,
          text: `[Response from ${toName} (${targetLayer} layer)]\n\n${responseText}\n\n---\nDecision saved to ${decisionFilename} on both whiteboards.`,
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

// ── Session tracking per layer ─────────────────────────────

const layerSessions: Record<LayerId, string | undefined> = {
  mission: undefined,
  experience: undefined,
  architecture: undefined,
  implementation: undefined,
};

// ── Agent Runner ───────────────────────────────────────────

export async function chatWithAgent(
  layer: LayerId,
  userMessage: string,
  _imageBase64?: string
): Promise<AgentResponse> {
  // Set current layer for tool callbacks
  currentLayer = layer;
  pendingConsultation = null;
  filesWereChanged = false;

  // Build system prompt with current file context
  const fileContext = await getAllFilesAsContext(layer);

  // Read _brief.md for layer-specific instructions (user-editable)
  let briefContent = "";
  try {
    const brief = await readLayerFile(layer, "_brief.md");
    briefContent = `\n## Layer Brief (from _brief.md)\n\n${brief.content}\n`;
  } catch {
    // No _brief.md yet — that's fine, use defaults
  }

  const systemPrompt = `${AGENT_IDENTITY[layer]}
${briefContent}
${TOOL_INSTRUCTIONS}
${GOAL_INSTRUCTIONS}

## Current Whiteboard Files (${layer} layer)

${fileContext}`;

  let resultText = "";
  let cost = 0;
  let sessionId: string | undefined;

  const options: Record<string, unknown> = {
    systemPrompt,
    mcpServers: { "mica-tools": createMicaToolServer() },
    tools: [] as string[], // disable built-in file tools
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    persistSession: true,
    maxTurns: 5,
    model: "claude-sonnet-4-6",
    settings: { forceLoginMethod: "claudeai" as const },
    settingSources: ["user" as const],
  };

  // Resume existing session for this layer if we have one
  if (layerSessions[layer]) {
    options.resume = layerSessions[layer];
  }

  for await (const message of query({
    prompt: userMessage,
    options: options as import("@anthropic-ai/claude-agent-sdk").Options,
  })) {
    const msg = message as SDKMessage;

    if (msg.type === "system" && "subtype" in msg && msg.subtype === "init") {
      sessionId = msg.session_id;
    }

    if (msg.type === "assistant" && msg.message?.content) {
      for (const block of msg.message.content) {
        if ("type" in block && block.type === "text" && "text" in block) {
          resultText += (block as { text: string }).text;
        }
      }
    }

    if (msg.type === "result" && "result" in msg) {
      const result = msg as SDKResultSuccess;
      resultText = result.result || resultText;
      cost = result.total_cost_usd || 0;
    }
  }

  // Save session for continuity
  if (sessionId) {
    layerSessions[layer] = sessionId;
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
  fromLayer: LayerId,
  toLayer: LayerId,
  question: string,
  context: string
): Promise<AgentResponse> {
  const fromName = AGENT_META[fromLayer].name;
  const prompt = `[Cross-layer question from ${fromName} (${fromLayer} layer)]

Question: ${question}

Context: ${context}

Please respond from your perspective as the ${AGENT_META[toLayer].name}. Be concrete and actionable.`;

  return chatWithAgent(toLayer, prompt);
}

export async function teamDiscuss(
  topic: string
): Promise<Record<LayerId, AgentResponse>> {
  const layers: LayerId[] = [
    "mission",
    "experience",
    "architecture",
    "implementation",
  ];

  const results = await Promise.all(
    layers.map((layer) =>
      chatWithAgent(
        layer,
        `[Team Discussion] The human wants the team's input on: ${topic}\n\nRespond from your perspective as the ${AGENT_META[layer].name}. Be concise (2-3 paragraphs max).`
      )
    )
  );

  return Object.fromEntries(
    layers.map((layer, i) => [layer, results[i]])
  ) as Record<LayerId, AgentResponse>;
}

export async function convertDrawingToMermaid(
  layer: LayerId,
  imageBase64: string
): Promise<{ mermaid: string; filename: string }> {
  // Write image to a temp file so the agent can read it
  const tmpDir = os.tmpdir();
  const tmpFile = path.join(tmpDir, `mica-drawing-${Date.now()}.png`);
  fs.writeFileSync(tmpFile, Buffer.from(imageBase64, "base64"));

  let resultText = "";

  try {
    for await (const message of query({
      prompt: `Read the image file at ${tmpFile} and convert the hand-drawn diagram into Mermaid syntax. Output ONLY the raw mermaid code. No markdown fences, no explanation, no commentary. Just the mermaid diagram code.`,
      options: {
        allowedTools: ["Read"],
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        maxTurns: 3,
        model: "claude-sonnet-4-6",
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
  await writeLayerFile(layer, filename, mermaidCode);
  return { mermaid: mermaidCode, filename };
}

export function resetLayer(layer: LayerId) {
  layerSessions[layer] = undefined;
}

export function resetAll() {
  for (const layer of Object.keys(layerSessions) as LayerId[]) {
    layerSessions[layer] = undefined;
  }
}
