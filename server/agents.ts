// Mica AI Team — Layer-Specialized Agents (Claude Agent SDK)
// Uses Claude Code subscription auth — no API key needed.

// Allow nested Claude Code sessions (we're running inside Claude Code's terminal)
delete process.env.CLAUDECODE;

import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import type { SDKMessage, SDKResultSuccess } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod/v4";

// ── Types ──────────────────────────────────────────────────

export type LayerId =
  | "mission"
  | "experience"
  | "architecture"
  | "implementation";

export interface AgentResponse {
  layer: LayerId;
  message: string;
  artifacts?: ArtifactSuggestion[];
  escalation?: Escalation | null;
  cost?: number;
}

export interface ArtifactSuggestion {
  title: string;
  type: string;
  summary: string;
  detail?: string;
}

export interface Escalation {
  targetLayer: LayerId;
  question: string;
  context: string;
}

// ── Shared project context ─────────────────────────────────

const PROJECT_CONTEXT = `
You are part of the Mica AI Team working on "Inbox Intelligence" — a product that helps users answer quantitative questions about their email data (spending by category, travel expenses, vendor summaries, subscriptions).

Current project state:
- Product brief: Complete. Target user is Alex, a freelance consultant tracking expenses.
- UX: Core user flow defined (Ask → Categorize → Answer → Drill-down → Source). Wireframes partial.
- Architecture: Local-first with SQLite + WASM ML. Gmail API ingestion pipeline complete.
- Implementation: Sprint 3. Ingestion complete, extraction at 82% accuracy (below 90% target), classification in progress.

Key constraints: Local-first (zero cloud), Gmail API only, 8-week MVP, $0 infrastructure cost.
Open decisions: Shared accounts (deferred to v2), extraction accuracy gap (correction UI proposed).
`;

// ── Agent system prompts ───────────────────────────────────

const SYSTEM_PROMPTS: Record<LayerId, string> = {
  mission: `You are the Mission Strategist — the AI agent for the Mission layer in Mica.
Your expertise: Product strategy, user research, problem definition, personas, constraints, success criteria.
Your style: Strategic, empathetic, focused on "why" and "for whom". Challenge vague thinking with specific questions.
When unsure about technical feasibility, suggest escalating to Architecture. When unsure about UX, suggest escalating to Experience.

IMPORTANT: You have access to tools for creating artifacts, escalating to other layers, and updating context quality. Use them when appropriate — don't just describe what you'd do, actually invoke the tools.

${PROJECT_CONTEXT}`,

  experience: `You are the Experience Designer — the AI agent for the Experience layer in Mica.
Your expertise: UX design, information architecture, interaction patterns, user flows, wireframing, accessibility.
Your style: Visual and empathetic. Describe interfaces concretely. Catch missing states. Think in terms of what the user sees, does, and feels.
Progress artifacts through: sketch → wireframe → mockup → prototype.
When you need clarity on who the user is, suggest escalating to Mission. When you need to know technical limits, suggest escalating to Architecture.

IMPORTANT: You have access to tools for creating artifacts, escalating to other layers, and updating context quality. Use them when appropriate.

${PROJECT_CONTEXT}`,

  architecture: `You are the System Architect — the AI agent for the Architecture layer in Mica.
Your expertise: System design, component architecture, API contracts, data modeling, tech selection, trade-off analysis.
Your style: Precise and analytical. Think in components, interfaces, data flows. Name trade-offs explicitly.
When you need user context, suggest escalating to Mission. When you need UX flows, suggest escalating to Experience. When you need implementation feasibility, suggest escalating to Implementation.

IMPORTANT: You have access to tools for creating artifacts, escalating to other layers, and updating context quality. Use them when appropriate.

${PROJECT_CONTEXT}`,

  implementation: `You are the Implementation Engineer — the AI agent for the Implementation layer in Mica.
Your expertise: Software engineering, testing, CI/CD, performance, sprint planning.
Your style: Practical and precise. Think in code, tests, deployment steps. Surface blockers early.
When architecture doesn't work in practice, suggest escalating to Architecture. When you discover UX issues, suggest escalating to Experience.

IMPORTANT: You have access to tools for creating artifacts, escalating to other layers, and updating context quality. Use them when appropriate.

${PROJECT_CONTEXT}`,
};

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

// ── MCP Tools for layer operations ─────────────────────────

// Artifacts proposed by agents are collected here during a query
let pendingArtifacts: ArtifactSuggestion[] = [];
let pendingEscalation: Escalation | null = null;

const createArtifactTool = tool(
  "create_artifact",
  "Create or update an artifact in the current layer. Use this when you want to propose a new artifact (persona, wireframe, component, etc.) or update an existing one.",
  {
    title: z.string().describe("Artifact title"),
    artifact_type: z
      .string()
      .describe(
        "Type: narrative, persona, constraint, criteria, flow, wireframe, journey, diagram, api, model, decision, component, tests, status"
      ),
    summary: z.string().describe("One-line summary"),
    detail: z.string().optional().describe("Detailed content"),
  },
  async (args) => {
    pendingArtifacts.push({
      title: args.title,
      type: args.artifact_type,
      summary: args.summary,
      detail: args.detail,
    });
    return {
      content: [
        {
          type: "text" as const,
          text: `Artifact "${args.title}" (${args.artifact_type}) created successfully.`,
        },
      ],
    };
  }
);

const escalateToLayerTool = tool(
  "escalate_to_layer",
  "Escalate a question or decision to another layer's agent. Use when you need input from a different perspective.",
  {
    target_layer: z
      .enum(["mission", "experience", "architecture", "implementation"])
      .describe("Which layer agent to escalate to"),
    question: z.string().describe("The question or decision needed"),
    context: z.string().describe("Relevant context for the target agent"),
  },
  async (args) => {
    pendingEscalation = {
      targetLayer: args.target_layer as LayerId,
      question: args.question,
      context: args.context,
    };
    return {
      content: [
        {
          type: "text" as const,
          text: `Escalation to ${args.target_layer} layer queued: "${args.question}"`,
        },
      ],
    };
  }
);

const updateContextTool = tool(
  "update_context_quality",
  "Update the quality indicator for a context dimension in this layer.",
  {
    label: z
      .string()
      .describe("Context dimension (e.g., 'Product brief', 'Wireframes')"),
    quality: z
      .enum(["complete", "partial", "missing"])
      .describe("New quality level"),
    reason: z.string().describe("Why the quality changed"),
  },
  async (args) => {
    return {
      content: [
        {
          type: "text" as const,
          text: `Context "${args.label}" updated to ${args.quality}: ${args.reason}`,
        },
      ],
    };
  }
);

const micaToolServer = createSdkMcpServer({
  name: "mica-tools",
  tools: [createArtifactTool, escalateToLayerTool, updateContextTool],
});

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
  userMessage: string
): Promise<AgentResponse> {
  // Reset pending state
  pendingArtifacts = [];
  pendingEscalation = null;

  let resultText = "";
  let cost = 0;
  let sessionId: string | undefined;

  const options: Record<string, unknown> = {
    systemPrompt: SYSTEM_PROMPTS[layer],
    mcpServers: { "mica-tools": micaToolServer },
    tools: [] as string[], // disable built-in file tools
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    persistSession: true,
    maxTurns: 3,
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
    artifacts: pendingArtifacts.length > 0 ? [...pendingArtifacts] : undefined,
    escalation: pendingEscalation ? { ...pendingEscalation } : null,
    cost,
  };
}

export async function escalateToAgent(
  fromLayer: LayerId,
  toLayer: LayerId,
  question: string,
  context: string
): Promise<AgentResponse> {
  const fromName = AGENT_META[fromLayer].name;
  const prompt = `[Escalation from ${fromName} (${fromLayer} layer)]

Question: ${question}

Context: ${context}

Please respond to this cross-layer question from your perspective as the ${AGENT_META[toLayer].name}.`;

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

export function resetLayer(layer: LayerId) {
  layerSessions[layer] = undefined;
}

export function resetAll() {
  for (const layer of Object.keys(layerSessions) as LayerId[]) {
    layerSessions[layer] = undefined;
  }
}
