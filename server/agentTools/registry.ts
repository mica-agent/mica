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
import { renderInspectTool } from "./renderInspect.js";
import {
  createClassTool,
  editClassFileTool,
  createInstanceTool,
  deleteInstanceTool,
  deleteClassTool,
  listClassesTool,
} from "./cardClass.js";
import { installSkillsTool } from "./installSkills.js";
import { listSkillPackagesTool } from "./listSkillPackages.js";
import { micaShellTool } from "./micaShell.js";
import { inspectUrlTool } from "./inspectUrl.js";
import { inspectPythonPackageTool } from "./inspectPythonPackage.js";
import { listHandlersTool } from "./listHandlers.js";
import { restartSidecarTool } from "./restartSidecar.js";
import { sidecarLogTool } from "./sidecarLog.js";
import { verifySidecarTool } from "./verifySidecar.js";
import { verifySpecConformanceTool } from "./verifySpecConformance.js";
import { listSharedDocsTool, pinSharedDocTool } from "./sharedDocs.js";
import { proposeChangesTool } from "./proposeChanges.js";

// Per-backend startup secret. Agents include this in the
// `x-mica-agent-auth` header on every /api/tools/* request. Browser cards
// run JS but cannot reach this secret (it's never sent to the client),
// so cards cannot reach the tool API. Regenerated on every backend
// restart — no persistence.
export const AGENT_TOOL_AUTH_SECRET = randomBytes(32).toString("hex");
export const AGENT_TOOL_AUTH_HEADER = "x-mica-agent-auth";
export const AGENT_TOOL_PROJECT_HEADER = "x-mica-project";
// Chat-card filename of the agent session that originated the call.
// Used by predicate gates (toolPrerequisites.ts) that need session
// scope — e.g. "has skill('card-class-handbook') been invoked in this
// chat session?". Optional: tools that don't care about session can
// ignore it, and SDK adapters that can't supply it (e.g. opencode's
// shared bridge) leave it blank.
export const AGENT_TOOL_CHAT_FILENAME_HEADER = "x-mica-chat-filename";

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
  /** Server-side implementation. Receives parsed input + session project +
   *  chat-card filename when the call originated from an agent session
   *  (used by predicate gates that need session scope; null for callers
   *  outside an agent session). */
  handler: (
    input: z.infer<z.ZodObject<TSchema>>,
    ctx: { project: string | null; chatFilename: string | null },
  ) => Promise<AgentToolResult>;
}

// The full tool list. Order doesn't matter; each adapter iterates the array.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const AGENT_TOOLS: AgentToolDef<any>[] = [
  renderCaptureTool,
  renderInspectTool,
  createClassTool,
  editClassFileTool,
  createInstanceTool,
  deleteInstanceTool,
  deleteClassTool,
  listClassesTool,
  installSkillsTool,
  listSkillPackagesTool,
  inspectUrlTool,
  inspectPythonPackageTool,
  listHandlersTool,
  micaShellTool,
  restartSidecarTool,
  sidecarLogTool,
  verifySidecarTool,
  verifySpecConformanceTool,
  listSharedDocsTool,
  pinSharedDocTool,
  proposeChangesTool,
];

// ── Project resolution for opencode bridge ───────────────────────────
//
// opencode-serve is a single daemon shared across all .opencode card
// sessions in a backend's lifetime, and the mica-builtins MCP bridge
// (opencodeBridge.mjs) is one child process serving all of them.
// Naïvely the bridge can't tell which session originated a tool call —
// opencode 1.15.5 doesn't propagate session context through MCP _meta
// (verified empirically; see upstream issue #15117).
//
// Fix: server/agentTools/opencodePlugin.mjs is loaded into opencode-
// serve at startup via config.plugin. Its `tool.execute.before` hook
// fires per tool call WITH the calling sessionID, and stamps it onto
// the tool's args. The bridge reads that stamp off, removes it, and
// forwards it as the `x-mica-opencode-session-id` header. This
// `opencodeSessionProjects` map (populated by opencodeAgent.ts as
// sessions attach) lets the REST handler map that ID back to a
// project — per-call, no race, full concurrency.
//
// The legacy `lastActiveOpencodeProject` global is kept as a fallback
// for: (a) the plugin failing to load, (b) non-opencode callers, and
// (c) graceful migration. resolveOpencodeProject() prefers the per-
// session map and only falls back to the global when no mapping exists.

interface OpencodeSessionInfo {
  project: string;
  /** Canvas-relative path of the originating .opencode card file (e.g.
   *  "canvas/agent.opencode"). Lets session-scoped predicate gates run for
   *  opencode-routed tool calls (the bridge can't supply the
   *  x-mica-chat-filename header directly; restRoutes.ts falls back to this). */
  chatFilename: string;
}
const opencodeSessions = new Map<string, OpencodeSessionInfo>();

/** Map an opencode session ID to the Mica project + the .opencode card
 *  filename it belongs to. Idempotent. Called by opencodeAgent.ts on
 *  session attach. chatFilename enables the spec-approval-gate predicate
 *  (and any other session-scoped gate) to run for opencode-routed calls. */
export function registerOpencodeSession(sessionId: string, project: string | null, chatFilename: string | null): void {
  if (!sessionId || !project) return;
  opencodeSessions.set(sessionId, { project, chatFilename: chatFilename ?? "" });
}

/** Remove a session's mapping. Called by opencodeAgent.ts in onDestroy
 *  to keep the map bounded across long-lived backends. */
export function unregisterOpencodeSession(sessionId: string): void {
  if (!sessionId) return;
  opencodeSessions.delete(sessionId);
}

/** Look up the project for an opencode session ID. Returns null when
 *  the session isn't registered (e.g. the session was created before
 *  this backend started, or the agent hasn't attached yet). */
export function getOpencodeSessionProject(sessionId: string | null | undefined): string | null {
  if (!sessionId) return null;
  return opencodeSessions.get(sessionId)?.project ?? null;
}

/** Look up the chat-card filename for an opencode session ID. Returns null
 *  when the session isn't registered or has no filename. restRoutes.ts
 *  uses this as a fallback when the x-mica-chat-filename header is missing
 *  (opencode bridge can't set headers per-call). */
export function getOpencodeSessionChatFilename(sessionId: string | null | undefined): string | null {
  if (!sessionId) return null;
  const info = opencodeSessions.get(sessionId);
  if (!info || !info.chatFilename) return null;
  return info.chatFilename;
}

let lastActiveOpencodeProject: string | null = null;

export function setLastActiveOpencodeProject(project: string | null): void {
  lastActiveOpencodeProject = project;
}

export function getLastActiveOpencodeProject(): string | null {
  return lastActiveOpencodeProject;
}

// Parallel fallback for the originating .opencode card filename — same role
// as lastActiveOpencodeProject, for when the per-call session header doesn't
// resolve a chatFilename (e.g. render_capture's captioner routing needs the
// card's {provider, model} to caption with the card's own vision model
// instead of silently falling back to local vLLM). Single-active-session
// caveat is identical to the project fallback's.
let lastActiveOpencodeChatFilename: string | null = null;

export function setLastActiveOpencodeChatFilename(chatFilename: string | null): void {
  lastActiveOpencodeChatFilename = chatFilename;
}

export function getLastActiveOpencodeChatFilename(): string | null {
  return lastActiveOpencodeChatFilename;
}
