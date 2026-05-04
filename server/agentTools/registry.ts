// Agent-tools registry — single source of truth for Mica-internal tools
// available to ALL agents (qwen, Claude, opencode) under a shared shape.
//
// Architecture:
//   Each tool is described once here as an `AgentToolDef` (name, prose,
//   zod input schema, REST path, handler). Three thin per-SDK adapters
//   iterate this registry and register the tool with their respective
//   SDKs:
//     - qwen-code SDK   → SDK-embedded MCP via createSdkMcpServer
//                         (built by sdkMcpBuilder.ts; called from micaAgent.ts)
//     - Claude Agent SDK → same shape — that SDK exports the same
//                         createSdkMcpServer/tool helpers
//     - opencode-serve  → an external stdio MCP child process
//                         (opencodeBridge.mjs) that fetches the REST
//                         endpoints below; registered via Config.mcp
//
//   The handler runs SERVER-SIDE in this Node process via an internal
//   REST POST (the SDK-MCP adapters fetch from localhost; the opencode
//   bridge fetches from the same URL via stdio). Single source of truth
//   for the actual logic; the SDK plumbing is just transport.
//
// Adding a new tool:
//   1. Create server/agentTools/<toolName>.ts that exports an AgentToolDef.
//   2. Import it here and add to AGENT_TOOLS.
//   3. Add a paragraph to promptPrelude.ts so all three agents know it exists.
//   No per-agent code changes required.

import { z } from "zod";
import { randomBytes } from "crypto";
import { renderCaptureTool } from "./renderCapture.js";
import {
  createClassTool,
  editClassFileTool,
  createInstanceTool,
  deleteInstanceTool,
  deleteClassTool,
  listClassesTool,
} from "./cardClass.js";
import { installSkillsTool } from "./installSkills.js";

// Per-backend startup secret. Agents include this in the
// `x-mica-agent-auth` header on every /api/tools/* request. Browser cards
// run JS but cannot reach this secret (it's never sent to the client),
// so cards cannot reach the tool API. Regenerated on every backend
// restart — no persistence.
export const AGENT_TOOL_AUTH_SECRET = randomBytes(32).toString("hex");
export const AGENT_TOOL_AUTH_HEADER = "x-mica-agent-auth";
export const AGENT_TOOL_PROJECT_HEADER = "x-mica-project";

// Tool handler return shape. text becomes the textual content of the
// tool result; isError flips the result to an error result that the
// model sees as such.
export interface AgentToolResult {
  text: string;
  isError?: boolean;
}

export interface AgentToolDef<
  TSchema extends z.ZodRawShape = z.ZodRawShape,
> {
  /** Stable lookup name — what each SDK exposes to the model. */
  name: string;
  /** Description shown to the model in the tool list. */
  description: string;
  /** Zod schema (raw shape) describing the tool's input. */
  inputSchema: TSchema;
  /** REST path the SDK adapters fetch (POST). Must start with `/api/tools/`. */
  restPath: string;
  /** Server-side implementation. Receives parsed input + session project. */
  handler: (input: z.infer<z.ZodObject<TSchema>>, ctx: { project: string | null }) => Promise<AgentToolResult>;
}

// The full tool list. Order doesn't matter; each adapter iterates the array.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const AGENT_TOOLS: AgentToolDef<any>[] = [
  renderCaptureTool,
  createClassTool,
  editClassFileTool,
  createInstanceTool,
  deleteInstanceTool,
  deleteClassTool,
  listClassesTool,
  installSkillsTool,
];

// ── Project resolution for opencode bridge ───────────────────────────
//
// opencode-serve is a single daemon shared across all .opencode card
// sessions in a backend's lifetime. The opencode MCP bridge spawns once
// (per opencode-serve, not per session) and forwards tool calls into
// /api/tools/* — but the bridge itself doesn't naturally know which
// project a particular tool call is "for" (MCP tool calls don't carry
// session context).
//
// Workaround for v1: opencodeAgent.ts publishes the project of each
// session as that session takes a turn (its `processMessage` fires).
// Mica's REST endpoints fall back to this published project when the
// X-Mica-Project header isn't on the incoming request. For typical
// 1-2 active sessions, this resolves correctly — the active session
// is the one calling the tool.
//
// For multi-session pathologies (two opencode sessions running tool
// calls concurrently), this can race and pick the wrong project. Real
// fix: propagate session ID through MCP request metadata. Defer — the
// 99% case is single-session-active.

let lastActiveOpencodeProject: string | null = null;

export function setLastActiveOpencodeProject(project: string | null): void {
  lastActiveOpencodeProject = project;
}

export function getLastActiveOpencodeProject(): string | null {
  return lastActiveOpencodeProject;
}
