// opencodeAgent.ts — channel handler for the .opencode chat card.
//
// Talks to a single, lazy-spawned opencode HTTP server (see opencodeServer.ts)
// over the @opencode-ai/sdk client. Per-card state:
//   - chatId (Mica's per-file UUID)        — keys persisted history + cursor
//   - ocSessionId (opencode's session ID)  — keys server-side session
//
// Per turn:
//   1. Build Mica's standard prompt prefix: canvas-back + skills + project
//      files + subagents + danger banner + validator-error buffer.
//   2. POST /session/{id}/message with body.parts = [{type:"text", text:userMsg}]
//      and body.system = prefix. Synchronous: resolves when the session goes
//      idle (turn complete).
//   3. In parallel, an SSE subscription to /event filters by ocSessionId and
//      translates opencode events into Mica broadcasts:
//        message.part.updated (ToolPart) → progress
//        message.part.updated (TextPart) → (assistant text accumulates)
//        permission.updated              → auto-approve via REST
//        session.error                   → error broadcast
//        session.idle                    → resolve the in-flight prompt
//
// What this DOES NOT do (deferred from claudeAgent.ts for v1 simplicity):
//   - Subagent visibility broadcasts (no subagent_started/event/finished events
//     to the card; the chat card's strip just shows nothing).
//   - Image attachment (no FilePartInput in send path).
//   - Per-turn metrics writes (recordTurn / recordSubagent).
//   - File-watcher coalescing for between-turn auto-prompts.
// These can be folded in once v1 is shaken out.

import { readFile, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { randomUUID } from "crypto";
import {
  WORKSPACE_DIR,
  getEffectiveWorkspaceDir,
  micaDir,
  listCanvasFiles,
  readProjectFile,
  readCanvasConfig,
  readCardSettings,
  resolveDefaultProvider,
  resolveDefaultModel,
  readOpenAICompatConfig,
  BINARY_EXTS,
  isLikelyBinary,
  CONTEXT_SOFT_CAP_CHARS,
  getCardClassMeta,
  readChatCursor,
  writeChatCursor,
  DEFAULT_CANVAS_ROOT,
} from "./files.js";
import { probeModelEndpoint } from "./modelHealth.js";
import type { ChannelHandler, SessionContext } from "./channelManager.js";
import type { FileWatcher } from "./fileWatcher.js";
import { markAgentWrite } from "./writeSource.js";
import { recordUserMessage } from "./userMessageTracker.js";
import { recordSkillInvocation } from "./skillInvocationTracker.js";
import {
  attachReactiveCoalesce,
  registerReactiveSession,
  type ReactiveSessionHandle,
} from "./reactiveCoalesce.js";
import { buildHandlerContractsBaseline } from "./handlerBaselineInjection.js";
import { loadProjectSubagents } from "./subagents.js";
import { getFreshPendingValidatorErrors, getRecentlyClearedFlaps } from "./validatorErrorBuffer.js";
import { flushProjectPendingErrors } from "./cardErrorBuffer.js";
import { resetRenderCaptureCount } from "./renderCaptureCounter.js";
import { markProjectActivity } from "./projectActivity.js";
import {
  setLastActiveOpencodeProject,
  setLastActiveOpencodeChatFilename,
  registerOpencodeSession,
  unregisterOpencodeSession,
} from "./agentTools/registry.js";
import { buildAgentToolsPrelude } from "./agentTools/promptPrelude.js";
import { writeSnapshot } from "./turnSnapshots.js";
import { getOpencodeServer } from "./opencodeServer.js";
import { getCurrentTenant, runWithTenant } from "./tenantContext.js";
import { captureCard } from "./screenshot.js";
import { readFile as fsReadFile } from "fs/promises";
import { resolveCtxWindow } from "./contextWindow.js";
import { estimateTurnCost } from "./costEstimator.js";
import { getModelCalibration, type ModelCalibration } from "./modelCalibration.js";
import { buildRuntimeBanner } from "./micaAgent.js";
import type { Event, Part } from "@opencode-ai/sdk";

interface TurnTokens {
  input: number;            // billed sum across steps
  output: number;           // sum across steps
  peak: number;              // max single step.input (capacity-relevant)
  reasoning: number;        // sum of thinking tokens (Claude/o1/deepseek-r1/etc.)
  cache_read: number;       // sum of cached input reads (cheap)
  cache_write: number;      // sum of cache writes
  ctx: number;              // effective context window for this turn
  duration_ms: number;      // wall-clock turn duration
  tool_calls?: Record<string, number>;  // tool name → call count
  files_changed?: boolean;
}

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  agent?: string;
  turn_id?: string;
  tokens?: TurnTokens;       // populated for assistant turns; used by card's chevron footer
}

const MAX_HISTORY = 50;
// Context window is resolved per-turn via resolveCtxWindow (see
// contextWindow.ts) — OpenRouter catalog lookup, openai-compat /v1/models
// probe, local LLAMA_CTX_SIZE env, or 200K fallback for unknown providers.
const OPENCODE_CTX_WINDOW_FALLBACK = 200_000;
// No per-turn timeout. Earlier versions had a soft timeout that gave up
// after N minutes, fetched whatever was in the session, and surfaced a
// "Mica stopped waiting" note — but the agent loop kept running on
// opencode's side and any subsequent events went nowhere. That's worse
// than just waiting: the user couldn't see the eventual answer.
//
// Architecture now: we wait for `session.idle` indefinitely (or
// `session.error`), or for a user-initiated interrupt via the Stop
// button. Same as how the .qwen / .claude cards behave. If the model
// genuinely hangs the user can hit Stop. opencode's persistent session
// also means a backend restart preserves the conversation: on reload,
// the chat card reattaches to the same opencode session and any
// pending events flow through normally.

export function setActiveProject(_project: string | null) { void _project; }

function getProjectDir(project: string | null) {
  return project ? join(getEffectiveWorkspaceDir(), project) : getEffectiveWorkspaceDir();
}
function getMicaDir(project: string | null) { return micaDir(project || undefined); }

/** Cache the first served model id from Mica's local LLM endpoint
 *  briefly so per-prompt resolution doesn't fan out into a /v1/models
 *  call every turn. 10s TTL — long enough to amortize a chat burst,
 *  short enough to pick up a fresh container in normal user time. */
let _localModelCache: { ts: number; id: string | null } | null = null;
const LOCAL_MODEL_TTL_MS = 10_000;

async function firstLocalModelId(): Promise<string | null> {
  if (_localModelCache && Date.now() - _localModelCache.ts < LOCAL_MODEL_TTL_MS) {
    return _localModelCache.id;
  }
  const baseUrl = (process.env.LLAMA_URL || "http://127.0.0.1:8012").replace(/\/+$/, "");
  let id: string | null = null;
  try {
    const res = await fetch(`${baseUrl}/v1/models`, { signal: AbortSignal.timeout(1000) });
    if (res.ok) {
      const data = await res.json() as { data?: Array<{ id?: string }> };
      const first = (data.data ?? [])
        .map((m) => m?.id)
        .find((x): x is string => typeof x === "string" && x.length > 0);
      id = first ?? null;
    }
  } catch {
    // Probe failed (endpoint down) — leave id null. The caller skips
    // the override; opencode falls through to its own default which at
    // least produces an actionable session.error rather than hanging.
  }
  _localModelCache = { ts: Date.now(), id };
  return id;
}

// ── History persistence ──────────────────────────────────────────

async function loadHistory(chatId: string, project: string | null): Promise<ChatMessage[]> {
  try {
    const raw = await readFile(join(getMicaDir(project), "chats", `${chatId}.json`), "utf-8");
    return JSON.parse(raw);
  } catch { return []; }
}

async function saveHistory(chatId: string, messages: ChatMessage[], project: string | null): Promise<void> {
  const dir = join(getMicaDir(project), "chats");
  await mkdir(dir, { recursive: true });
  const trimmed = messages.length > MAX_HISTORY ? messages.slice(-MAX_HISTORY) : messages;
  await writeFile(join(dir, `${chatId}.json`), JSON.stringify(trimmed, null, 2), "utf-8");
}

// Per-card sidecar: stores the opencode session ID so the same conversation
// resumes across reloads. Lives next to the chat history.
interface OpencodeSidecar { sessionID: string; }

async function loadSidecar(chatId: string, project: string | null): Promise<OpencodeSidecar | null> {
  try {
    const raw = await readFile(join(getMicaDir(project), "chats", `${chatId}.opencode.json`), "utf-8");
    const parsed = JSON.parse(raw) as OpencodeSidecar;
    if (parsed && typeof parsed.sessionID === "string") return parsed;
    return null;
  } catch { return null; }
}

async function saveSidecar(chatId: string, project: string | null, sidecar: OpencodeSidecar): Promise<void> {
  const dir = join(getMicaDir(project), "chats");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${chatId}.opencode.json`), JSON.stringify(sidecar, null, 2), "utf-8");
}

// ── Context builder ─────────────────────────────────────────────
// Mirrors claudeAgent.buildContext but without the SDK-specific subagent
// delegation cheat sheet (opencode discovers agents via Config.agent and
// surfaces them through its built-in `task` tool, not by name in our prefix).

const lastTurnAt = new Map<string, number>();
export function recordTurnEnd(chatFilename: string): void { lastTurnAt.set(chatFilename, Date.now()); }
export function getLastTurnAt(chatFilename: string): number | undefined { return lastTurnAt.get(chatFilename); }

export async function buildContext(
  agentFilename: string,
  project: string | null,
  since?: number,
  modelName?: string | null,
  contextWindowTokens?: number,
  calibration?: ModelCalibration | null,
): Promise<string> {
  const parts: string[] = [];

  // Runtime banner FIRST — model + context-window numbers + the calibration
  // self-awareness block, authoritative over any model-class rule of thumb in
  // canvas-back / skills. Mirrors micaAgent.buildContext (tenet 4, one
  // mechanism — same buildRuntimeBanner). 200K matches resolveCtxWindow's
  // own unknown-model fallback; only hit when a caller omits the window
  // (e.g. the non-prompt buildContext call).
  parts.push(buildRuntimeBanner({
    modelName: modelName ?? null,
    contextWindowTokens: contextWindowTokens ?? 200_000,
    calibration,
  }));

  if (since) {
    try {
      const allFiles = await listCanvasFiles(project || undefined);
      const changed = allFiles
        .filter((f) => {
          const m = f.modifiedAt ? new Date(f.modifiedAt).getTime() : 0;
          return m > since && f.name !== agentFilename;
        })
        .sort((a, b) => {
          const ma = a.modifiedAt ? new Date(a.modifiedAt).getTime() : 0;
          const mb = b.modifiedAt ? new Date(b.modifiedAt).getTime() : 0;
          return mb - ma;
        });
      if (changed.length > 0) {
        const cap = 20;
        const lines = changed.slice(0, cap).map((f) => `- \`${f.name}\` (modified)`);
        const more = changed.length > cap ? `\n- ... and ${changed.length - cap} more` : "";
        parts.push(
          `## Since your last turn\n\nThe following files were modified between your previous response and now:\n\n${lines.join("\n")}${more}`,
        );
      }
    } catch { /* ignore */ }
  }

  if (project) {
    const { fresh: pendingErrors, filteredStale } = getFreshPendingValidatorErrors(project, getProjectDir(project));
    if (filteredStale.length > 0) {
      const staleNames = filteredStale.map((e) => e.filename).join(", ");
      console.log(`[buildContext:${project}] (opencode) filtered ${filteredStale.length} stale validator/runtime error(s) (class edited after error): ${staleNames}`);
    }
    if (pendingErrors.length > 0) {
      const filenames = pendingErrors.map((e) => e.filename).join(", ");
      console.log(`[buildContext:${project}] (opencode) injected ${pendingErrors.length} validator error(s): ${filenames}`);
      const errorLines = pendingErrors.map((e) => `### \`${e.filename}\`\n\n${e.error}`);
      parts.push(
        `## Validator errors needing your attention\n\n` +
        `The following file(s) failed validation since your last response. Fix each by rewriting the named file with the corrections the error message describes.\n\n` +
        errorLines.join("\n\n"),
      );
    }

    // Flap advisory: errors that briefly cleared but reappeared. The
    // /ok-then-/error cycle empties the active buffer between turns, so a
    // genuinely-broken card with a transient clean mount looks "fixed" to
    // buildContext on the next turn. Flap entries persist across the clear
    // and surface here as a softer signal — "you may have suppressed the
    // symptom; recheck root cause."
    const pendingNames = new Set(pendingErrors.map((e) => e.filename));
    const flaps = getRecentlyClearedFlaps(project).filter((f) => !pendingNames.has(f.filename));
    if (flaps.length > 0) {
      const flapNames = flaps.map((f) => `${f.filename} (×${f.flapCount})`).join(", ");
      console.log(`[buildContext:${project}] (opencode) flap advisory: ${flapNames}`);
      const flapLines = flaps.map((f) => {
        const ageSec = Math.max(1, Math.round((Date.now() - f.firstSeen) / 1000));
        return `### \`${f.filename}\` (flapped ${f.flapCount}× over the last ${ageSec}s, currently clearing)\n\n${f.error}`;
      });
      parts.push(
        `## Recently flapping errors\n\n` +
        `The following file(s) errored, briefly stopped erroring after an edit, and errored again — that's the pattern of a fix that suppresses the symptom rather than solving the root cause. Inspect each file and check that your edit addresses the underlying problem (not just the path that throws). If you believe the file is now genuinely fixed, ignore this section.\n\n` +
        flapLines.join("\n\n"),
      );
    }
  }

  // Instance-level AI context
  try {
    const contextKey = agentFilename.replace(/\//g, "_");
    const instanceContext = await readFile(join(getMicaDir(project), "cards", contextKey + ".context.md"), "utf-8");
    if (instanceContext.trim()) parts.push(`## Your Behavior Instructions\n${instanceContext.trim()}`);
  } catch { /* none */ }

  // Class-level context
  try {
    const ext = agentFilename.split(".").pop() || "";
    const CARD_CLASSES_DIR = join(process.cwd(), "card-classes");
    let classContext = "";
    try {
      classContext = await readFile(join(getMicaDir(project), "card-classes", ext, "context.md"), "utf-8");
    } catch {
      try { classContext = await readFile(join(CARD_CLASSES_DIR, ext, "context.md"), "utf-8"); } catch { /* none */ }
    }
    if (classContext.trim()) parts.push(`## Card Class Context\n${classContext.trim()}`);
  } catch { /* ignore */ }

  // canvas-back
  try {
    const canvasBack = await readFile(join(getMicaDir(project), "canvas-back.md"), "utf-8");
    if (canvasBack.trim()) parts.push(`## Project Context\n${canvasBack.trim()}`);
  } catch { /* ignore */ }

  // Project files (full content of canvas-visible cards)
  try {
    const files = await listCanvasFiles(project || undefined);
    if (files.length > 0) {
      const emitted: string[] = [];
      for (const f of files) {
        const ext = f.name.substring(f.name.lastIndexOf(".")).toLowerCase();
        const meta = await getCardClassMeta(ext, project);
        if (meta.meta) continue;
        if (BINARY_EXTS.has(ext)) { emitted.push(`### ${f.name} (${f.size} bytes, binary)`); continue; }
        try {
          const file = await readProjectFile(f.name, project || undefined);
          if (isLikelyBinary(f.name, file.content)) emitted.push(`### ${f.name} (${f.size} bytes, binary)`);
          else if (file.content.length === 0) emitted.push(`### ${f.name} (empty — intentional shell or placeholder)`);
          else emitted.push(`### ${f.name}\n${file.content}`);
        } catch { emitted.push(`### ${f.name} (${f.size} bytes, unreadable)`); }
      }
      if (emitted.length > 0) {
        parts.push(`## Project Files`);
        for (const e of emitted) parts.push(e);
      }
    }
  } catch { /* ignore */ }

  // Channel handler contracts — auto-inject card.js skeleton for any handler
  // declared in spec or metadata. See handlerBaselineInjection.ts.
  try {
    const handlerBlock = await buildHandlerContractsBaseline(project);
    if (handlerBlock) parts.push(handlerBlock);
  } catch { /* best-effort */ }

  let canvasRoot = DEFAULT_CANVAS_ROOT;
  try {
    const cfg = JSON.parse(await readFile(join(getMicaDir(project), "config.json"), "utf-8"));
    canvasRoot = cfg.canvasRoot || cfg.docsDir || DEFAULT_CANVAS_ROOT;
  } catch { /* default */ }

  // Available agents (opencode's `task` tool)
  try {
    const agents = await loadProjectSubagents(project, "qwen");
    if (agents.length > 0) {
      const lines = [
        `## Available Subagents`,
        ``,
        `You have specialized subagents you can delegate to via opencode's \`task\` tool. The input shape:`,
        `\`\`\``,
        `task({ description: "<short label>", prompt: "Implement <file>. See ${canvasRoot}/spec.md § X. Done when: ...", subagent_type: "<name>" })`,
        `\`\`\``,
        ``,
        `Available subagents:`,
      ];
      for (const a of agents) lines.push(`- **${a.name}**: ${a.description}`);
      lines.push(
        ``,
        `Delegate when: plan implies >2 files of new code, or a single component spans >200 lines, or work splits cleanly into independent components.`,
      );
      parts.push(lines.join("\n"));
    }
  } catch { /* ignore */ }

  parts.push(`## File Locations
- The canvas directory is \`${canvasRoot}/\` — everything visible on the canvas lives there.
- ALL cards you create (.qwen, .todo, .terminal, .mmd, .md, etc.) MUST go in \`${canvasRoot}/\`.
- ALL planning files (specs, decisions, notes) MUST go in \`${canvasRoot}/\`.
- NEVER write files to \`.mica/\` — that directory is Mica-managed metadata.

## DANGER: You Run Inside The Mica Container
You execute shell commands inside the same container that runs Mica itself. These processes belong to Mica and must NOT be touched:
- **Port 5173** — Mica's frontend (vite). NEVER kill this.
- **Port 3002** — Mica's backend API. NEVER kill this.
- **Port 8012** — chat vLLM inference. NEVER kill this.
- **Ports 8013, 8014** — voice sidecars (Parakeet STT, Kokoro TTS). NEVER kill these.
- Any process matching \`vite\`, \`tsx server/index.ts\`, \`vllm\`, \`npm run dev\`, or under \`/workspaces/mica/\` is Mica. Leave it alone.
If you need to launch a test web app, use a different port (9000, 9090).`);

  // Unified Mica tools prelude — same prose qwen, Claude, and opencode get.
  parts.push(buildAgentToolsPrelude());

  parts.push(`## Asking the user a question

When you need information from the user, write the question into your reply as a direct, plain-language ask. End your turn after asking. The user's next chat message is the answer.

## Arc completion marker

When a coherent arc of work ends, emit the literal marker \`<thread-state>arc-complete</thread-state>\` as the last line of your response. This is Mica's signal that the chat can reset its context cursor at a natural break.

## Keep chat cards topic-scoped

Each chat card holds one ongoing conversation about one topic. When the user opens a distinctly different topic in an existing card, suggest spawning a new chat card scoped to the new topic.`);

  const assembled = parts.join("\n\n");
  if (assembled.length > CONTEXT_SOFT_CAP_CHARS) {
    console.warn(
      `[opencode-agent] OVERSIZED context: ${assembled.length} chars (cap ${CONTEXT_SOFT_CAP_CHARS}). project=${project ?? "-"} chat=${agentFilename}.`,
    );
  }
  return assembled;
}

// ── Tool-use description ────────────────────────────────────────
// Translates an opencode ToolPart into a one-line "progress" description.
// Keep close to claudeAgent.describeToolUse so the chat card UI is uniform.
function describeOpencodeTool(toolName: string, input: Record<string, unknown>): string {
  if (!input) return toolName;
  const n = toolName.toLowerCase().replace(/[_-]/g, "");
  const isMcp = toolName.startsWith("mcp__");
  const filePath = String(input.file_path || input.filePath || input.path || input.file || input.target_file || "");
  const fileName = filePath.split("/").pop() || "";
  const cmd = String(input.command || input.cmd || input.script || "");

  if (n === "task" || n === "agent") {
    const sub = String(input.subagent_type || input.agent || "");
    const desc = String(input.description || "").slice(0, 60);
    if (sub && desc) return `🤖 subagent: ${sub} (${desc})`;
    if (sub) return `🤖 subagent: ${sub}`;
    if (desc) return `🤖 subagent: ${desc}`;
    return "🤖 subagent dispatch";
  }
  if (n === "webfetch" || n === "fetch") {
    const url = String(input.url || input.link || "");
    return url ? `🌐 web_fetch: ${url.slice(0, 100)}` : "🌐 web_fetch";
  }
  if (n === "websearch") {
    const q = String(input.query || input.q || "");
    return q ? `🔍 web_search: ${q.slice(0, 80)}` : "🔍 web_search";
  }
  if (n === "skill") {
    // opencode's skill tool surfaces the skill name in `name` (per its
    // docstring); be tolerant to alternative key names.
    const skill = String(input.name || input.skill || input.skill_name || "");
    return skill ? `📚 skill: ${skill}` : "📚 skill";
  }
  if (n === "todowrite") {
    // input shape: { todos: Todo[] }. Show count instead of dumping JSON.
    const todos = Array.isArray((input as { todos?: unknown }).todos)
      ? (input.todos as unknown[]).length
      : 0;
    return todos > 0 ? `✅ todos: ${todos} item${todos === 1 ? "" : "s"}` : "✅ todowrite";
  }
  if (n === "applypatch") {
    return `🩹 Patch ${fileName || "file"}`;
  }
  if (!isMcp) {
    if (n.includes("bash") || n.includes("shell")) {
      const firstLine = cmd.split("\n")[0].slice(0, 120);
      return firstLine ? `💻 $ ${firstLine}` : "💻 Running command";
    }
    if (n === "read") return `📖 Read ${fileName || "file"}`;
    if (n === "write") return `💾 Write ${fileName || "file"}`;
    if (n === "edit") return `✏️ Edit ${fileName || "file"}`;
    if (n === "glob" || n === "grep") {
      const p = String(input.pattern || input.query || "");
      return p ? `🔎 Search: ${p.slice(0, 60)}` : "🔎 Searching files";
    }
  }
  // MCP / unknown — surface name + first useful field
  let hint = "";
  if (cmd) hint = `: ${cmd.split("\n")[0].slice(0, 60)}`;
  else if (fileName) hint = `: ${fileName}`;
  else {
    for (const v of Object.values(input)) {
      if (typeof v === "string" && v.length > 0 && v.length <= 200) { hint = `: ${v.slice(0, 60)}`; break; }
    }
  }
  return `${toolName}${hint}`;
}

// ── Channel handler factory ─────────────────────────────────────

export function createOpencodeAgentHandler(fileWatcher: FileWatcher) {
  attachReactiveCoalesce(fileWatcher);

  return async function opencodeHandlerFactory(
    _content: string,
    _args: Record<string, unknown>,
    ctx: SessionContext,
  ): Promise<ChannelHandler> {
    const sessionProject = ctx.project;
    // Owning tenant (multi-tenant fork). Read from ctx.tenant — threaded
    // explicitly by channelManager from the WS connection's tenant at channel
    // creation — NOT from ambient getCurrentTenant(), which doesn't reliably
    // propagate into handler creation (and would capture undefined, dropping
    // writes into the bare workspace root). Each turn re-binds it via
    // runWithTenant. Undefined in single-tenant main → wrapping below skipped.
    const sessionTenant = ctx.tenant ?? getCurrentTenant();
    const chatId = ctx.sessionId;
    // Reactive-coalesce session handle. Same mechanism qwen + Claude use;
    // gives opencode chat cards file-edit reactivity for free. Onset is
    // the next 60s-idle after any user edit in canvas scope.
    // True once the user has explicitly started the session (clicked Get
    // Started, which fires the initialize scan, or sent a first message).
    // Until then nothing runs — no auto-initialize turn and no reactive
    // turn — so the user can pick a model in the gear before any turn spends
    // tokens on the default. Set true for reopened sessions (history present)
    // in onAttach. See plan: defer on-open auto-start behind Get Started.
    let sessionStarted = false;

    const reactiveCfg = await readCanvasConfig(sessionProject || undefined);
    const reactive: ReactiveSessionHandle = registerReactiveSession({
      project: sessionProject,
      sessionFilename: ctx.filename,
      canvasRoot: reactiveCfg.canvasRoot,
      pinnedFiles: reactiveCfg.pinned,
      onDeliver: (message, source) => {
        // Don't let file-edit reactivity start a turn before the user has
        // started the session — that would run on the default model unprompted.
        if (!sessionStarted) return;
        if (busy) enqueueMessage(message, source);
        else void processMessage(message, source);
      },
    });

    // Per-card SSE subscription state. Started lazily on first turn (not at
    // session create) so cards that mount but never send a message don't
    // each open a long-lived /event stream against the opencode server.
    let sseStarted = false;
    let sseAbort: AbortController | null = null;
    // Promise resolved by session.idle event — populated each turn so the
    // run-loop knows when to declare the turn finished.
    let idleResolver: (() => void) | null = null;
    // Tools observed during the current turn (for the assistant broadcast).
    const turnToolCalls: Record<string, number> = {};
    // Tool callIDs we've already broadcast progress for. opencode fires
    // message.part.updated multiple times per tool (pending → running, then
    // again when title / metadata fills in), so a naive "broadcast on every
    // running event" emits the same line 2-3×.
    const broadcastedToolCalls = new Set<string>();
    // Per-turn token tracking. step-finish events fire once per LLM-call
    // step within a turn (one model call per tool-call cycle); each
    // carries that step's input + output token counts.
    //   - turnInputTokens / turnOutputTokens: SUM across all steps. Each
    //     step's input redundantly includes the conversation history, so
    //     SUM tracks billable tokens (and cache pressure) — NOT working-set
    //     size. Surfaced in the 5s heartbeat and as the user-facing
    //     "tokens spent this turn" number.
    //   - peakInputTokens: MAX(step.input). That's the actual working-set
    //     size — the largest context the model held in a single call —
    //     and the only one that maps to the model's context window for
    //     capacity math and the proactive-compaction trigger.
    // Both reset at turn start.
    let turnInputTokens = 0;
    let turnOutputTokens = 0;
    let peakInputTokens = 0;
    let turnReasoningTokens = 0;   // sum of thinking tokens (Claude extended, o1/o3, deepseek-r1)
    let turnCacheReadTokens = 0;   // sum of cache reads (cheap input, ~10% normal price)
    let turnCacheWriteTokens = 0;  // sum of cache writes
    // Upstream-reported per-turn cost. step-finish events on OpenRouter carry
    // `cost` (USD) for that step; summed across steps to get the turn total.
    // When > 0 the costEstimator uses it directly (matches the bill) instead
    // of falling back to the catalog-pricing estimate.
    let turnReportedCost = 0;
    // Effective context window for the current turn — resolved per-turn from
    // the user's (provider, model) settings (see processMessage). Cached at
    // session scope so the 5s event-heartbeat log can include it without
    // re-resolving. Falls back to OPENCODE_CTX_WINDOW_FALLBACK when no turn
    // has run yet.
    let sessionCtxWindow = OPENCODE_CTX_WINDOW_FALLBACK;
    // Card-side error captured from session.error events; surfaced as the
    // assistant reply if non-empty when the turn ends.
    let sessionErrorMsg = "";

    let busy = false;
    // QueuedMsg carries an id + queuedAt so the card's queue panel can show
    // each pending message with a cancel button (`cancel_queued` by id) and an
    // age stamp. Mirrors the qwen QueuedItem shape so the card UI is uniform.
    // In-memory only for now (qwen persists via loadChatQueue/saveChatQueue;
    // opencode v1 doesn't — a backend restart drops the opencode queue, same
    // as the in-flight turn).
    interface QueuedMsg { id: string; text: string; source: "user" | "voice" | "file-changes"; attach?: string; queuedAt: number }
    let queue: QueuedMsg[] = [];

    /** Broadcast the current queue snapshot to all attached clients. Sent on
     *  every push/shift/cancel/clear so the panel re-renders. Slim payload —
     *  truncated text, ordered. Card-side `case "queue"` is single source of
     *  truth for what the user sees. */
    function broadcastQueue(): void {
      ctx.broadcast({
        type: "queue",
        items: queue.map((q) => ({
          id: q.id,
          text: q.text.length > 160 ? q.text.slice(0, 160) + "…" : q.text,
          source: q.source,
          queuedAt: q.queuedAt,
          attach: q.attach || undefined,
        })),
      });
    }

    /** Push a fresh item onto the queue + broadcast. Source is inferred at
     *  the call site (user vs voice vs file-changes). */
    function enqueueMessage(text: string, source: QueuedMsg["source"], attach?: string): QueuedMsg {
      const item: QueuedMsg = {
        id: randomUUID(),
        text,
        source,
        queuedAt: Date.now(),
        ...(attach ? { attach } : {}),
      };
      queue.push(item);
      broadcastQueue();
      return item;
    }

    /** Shift the next queued item and broadcast the update. */
    function dequeueNext(): QueuedMsg | undefined {
      const next = queue.shift();
      if (next) broadcastQueue();
      return next;
    }
    // Tracks the in-flight prompt so onData (interrupt) can abort it. Same
    // pattern as activeAbort in claudeAgent.ts.
    let activePromptAbort: AbortController | null = null;
    // Last per-prompt model override forwarded to opencode. Captured here
    // (vs computed only in processMessage scope) so the SSE session.error
    // handler can pass the SAME provider/model to session.summarize on a
    // ContextOverflowError recovery — summarizing against the WRONG model
    // (e.g. the empty default after openrouter-routed turns) silently
    // produces no compaction.
    let lastModelOverride: { providerID: string; modelID: string } | null = null;

    // ── TUI control bridge state ────────────────────────────────
    // opencode's `question` tool delivers requests via /tui/control/next
    // and expects answers via /tui/control/response. This is the same
    // queue the opencode TUI/web client polls. We long-poll it on a
    // dedicated loop so the agent's question tool resolves; without
    // this, the tool call hangs and the loop stalls indefinitely.
    let tuiLoopStarted = false;
    let tuiAbort: AbortController | null = null;
    // Pending question metadata for the current chat card. The next user
    // chat message becomes the answer payload (free-text label or the
    // option label the user clicked). The pendingQuestion is cleared when
    // the user replies — at which point we POST /tui/control/response.
    // Captured from the question.asked SSE event payload, which inlines
    // the full question shape (no /tui/control/next round-trip needed).
    let pendingQuestion: { id: string; sessionID: string } | null = null;

    // ── Per-turn ephemeral event buffer ─────────────────────────
    // Same pattern as claudeAgent.ts. A late-joining client gets persisted
    // history from onAttach + the in-flight events from this buffer.
    const currentTurnEvents: unknown[] = [];
    const _origBroadcast = ctx.broadcast.bind(ctx);
    function isReplayable(event: unknown): boolean {
      if (typeof event !== "object" || event === null) return false;
      const t = (event as { type?: string }).type;
      return t === "thinking" || t === "progress" || t === "user_question" || t === "error";
    }
    ctx.broadcast = (data: unknown): void => {
      _origBroadcast(data);
      if (isReplayable(data)) currentTurnEvents.push(data);
      const t = (data as { type?: string } | null)?.type;
      if (t === "assistant" || t === "error") currentTurnEvents.length = 0;
    };

    // ── Lazy resolution of opencode sessionID ───────────────────
    // The Mica chat history may already exist (card was reloaded), in which
    // case we re-use the persisted opencode sessionID. Otherwise create a
    // fresh one and persist it.
    let ocSessionId: string | null = null;
    // The daemon generation ocSessionId was created against. If the daemon
    // re-spawns (credentials changed), the cached id is stale on the new daemon,
    // so we re-resolve/recreate rather than short-circuit.
    let ocSessionGeneration = -1;

    async function ensureOpencodeSession(): Promise<string> {
      const server = await getOpencodeServer(sessionTenant, sessionProject || undefined);
      const { client } = server;
      if (ocSessionId && ocSessionGeneration === server.generation) {
        // Already resolved against the current daemon; ensure the map mirrors
        // current state in case sessionProject changed (it shouldn't).
        registerOpencodeSession(ocSessionId, sessionProject, ctx.filename, sessionTenant);
        return ocSessionId;
      }
      // First turn, or the daemon re-spawned under us — (re)resolve the session.
      ocSessionId = null;
      const sidecar = await loadSidecar(chatId, sessionProject);
      if (sidecar) {
        // Validate that the opencode server still has this session (it
        // would NOT after a backend restart since opencode runs in this
        // backend's process). If gone, fall through to fresh-create.
        try {
          const got = await client.session.get({ path: { id: sidecar.sessionID } });
          if (got && (got.data || got.error === undefined)) {
            ocSessionId = sidecar.sessionID;
            ocSessionGeneration = server.generation;
            // Map this session ID to its project so per-tool-call routing
            // works as soon as the bridge sends the first call.
            registerOpencodeSession(ocSessionId, sessionProject, ctx.filename, sessionTenant);
            return ocSessionId;
          }
        } catch {
          // not-found / 404 — fall through to fresh
        }
      }
      const created = await client.session.create({
        body: { title: ctx.filename },
        query: { directory: getProjectDir(sessionProject) },
      });
      const newId = created.data?.id;
      if (!newId) {
        const errBody = JSON.stringify(created.error ?? "(unknown)").slice(0, 200);
        throw new Error(`opencode session.create returned no id: ${errBody}`);
      }
      ocSessionId = newId;
      ocSessionGeneration = server.generation;
      registerOpencodeSession(ocSessionId, sessionProject, ctx.filename, sessionTenant);
      await saveSidecar(chatId, sessionProject, { sessionID: newId });
      console.log(`[opencode-agent] created session ${newId.slice(0, 8)} for ${ctx.filename}`);
      return newId;
    }

    // ── SSE event loop ──────────────────────────────────────────
    async function startEventLoop(): Promise<void> {
      if (sseStarted) return;
      sseStarted = true;
      sseAbort = new AbortController();
      const { client } = await getOpencodeServer(sessionTenant, sessionProject || undefined);

      let result;
      try {
        // /global/event (NOT /event) — streams all events from all projects.
        // /event scopes to a single directory and, when no directory is
        // supplied, only delivers `server.*` events (heartbeat etc.) — the
        // session-level events we actually need (message.part.updated,
        // session.idle, permission.updated) get filtered out. /global/event
        // wraps each Event as { directory, payload }; we unwrap and filter
        // by ocSessionId in handleEvent.
        result = await client.global.event({ signal: sseAbort.signal });
      } catch (err) {
        if (sseAbort?.signal.aborted) return;
        console.error(`[opencode-agent] global.event subscribe failed: ${(err as Error).message}`);
        sseStarted = false;
        return;
      }
      console.log(`[opencode-agent] SSE subscription active for ${ctx.filename}`);

      (async () => {
        let count = 0;
        try {
          for await (const wrapped of result.stream) {
            if (sseAbort?.signal.aborted) break;
            count++;
            // /global/event wraps as { directory, payload }; /event would
            // emit Event directly. Be permissive: unwrap if wrapped.
            const ev = (wrapped as { payload?: Event; type?: string }).payload
              ?? (wrapped as Event);
            if (count <= 3) {
              console.log(`[opencode-agent] SSE event #${count}: ${(ev as { type?: string })?.type ?? "(no-type)"}`);
            }
            handleEvent(ev as Event);
          }
          console.log(`[opencode-agent] SSE stream ended after ${count} events for ${ctx.filename}`);
        } catch (err) {
          if (!sseAbort?.signal.aborted) {
            console.error(`[opencode-agent] event stream errored after ${count} events: ${(err as Error).message}`);
          }
        } finally {
          sseStarted = false;
        }
      })();
    }

    // ── TUI control bridge ──────────────────────────────────────
    // Bridges opencode's `question` tool to Mica's chat card. opencode's
    // model: the agent enqueues a TUI-control request (path + body), the
    // UI polls GET /tui/control/next to dequeue, and POSTs the answer to
    // /tui/control/response.
    //
    // We DON'T long-poll continuously — undici's 5-minute headersTimeout
    // killed the connection between question events, and we'd race to
    // re-establish before the next question. Instead we trigger ONE
    // /tui/control/next fetch when SSE delivers a `question.asked` event:
    // since something's already queued, the GET returns immediately. We
    // also set tuiLoopStarted to true so we don't spin up redundant
    // listeners — but it's a one-shot per question, not a long-poll.
    async function startTuiControlLoop(): Promise<void> {
      if (tuiLoopStarted) return;
      tuiLoopStarted = true;
      tuiAbort = new AbortController();
      console.log(`[opencode-agent] TUI control bridge ready for ${ctx.filename} (event-driven)`);
    }

    // Kept as a documented fallback path. We don't currently call it: the
    // question.asked SSE event already carries the full question payload
    // inline (id, sessionID, questions[]) so we render straight from the
    // event. If a future opencode version stops inlining the payload, fall
    // back to this draining call when question.asked fires.
    void handleTuiRequest;
    void tuiAbort;

    function handleTuiRequest(path: string, body: unknown): void {
      // The path field tells us what kind of TUI request this is. Question
      // requests have shape mirroring the question tool's input — see
      // /experimental/tool description for `question`. Other path values
      // (model picker, theme picker, etc.) we don't need to surface in
      // Mica's chat card; ack with a benign default response so opencode
      // doesn't sit waiting on us.
      console.log(`[opencode-agent] tui request path=${path} body=${JSON.stringify(body).slice(0, 200)}`);

      // Heuristic: question requests come on a path containing "question",
      // and their body has a `questions` array. Match either signal.
      const b = body as { questions?: Array<{ question: string; header?: string; options?: Array<{ label: string; description?: string }>; multiple?: boolean; custom?: boolean }> } | undefined;
      const looksLikeQuestion = path.toLowerCase().includes("question")
        || (Array.isArray(b?.questions) && b.questions.length > 0);

      if (looksLikeQuestion && Array.isArray(b?.questions)) {
        // Translate opencode's question shape to Mica's user_question shape
        // (the chat card already renders this). Mica's chat card uses
        // `multiSelect`; opencode uses `multiple`. Same semantics.
        const normalized = b.questions.map((q) => ({
          question: q.question,
          options: q.options,
          multiSelect: q.multiple ?? false,
        }));
        pendingQuestion = { path, rawBody: body };
        ctx.broadcast({ type: "user_question", questions: normalized });
        console.log(`[opencode-agent] surfaced question (${normalized.length} prompt(s)) — waiting for user reply`);
        return;
      }

      // Unknown TUI request — ack with a "no" / null response so the agent
      // doesn't hang. Keep the path in logs so we can teach the bridge to
      // handle new request types as they arise.
      console.warn(`[opencode-agent] unknown TUI request path=${path}; sending null response`);
      void (async () => {
        try {
          const { client } = await getOpencodeServer(sessionTenant, sessionProject || undefined);
          await client.tui.control.response({ body: null });
        } catch (err) {
          console.warn(`[opencode-agent] tui.control.response (null) failed: ${(err as Error).message}`);
        }
      })();
    }

    /** Send a user message back as an answer to a pending TUI question.
     *  opencode's question tool docstring says "Answers are returned as
     *  arrays of labels". For free-text from Mica (where the user typed
     *  prose), we wrap as a single-element array. The question ID we
     *  captured from question.asked is included so opencode matches the
     *  response to the right pending tool call. */
    async function sendTuiAnswer(answerText: string): Promise<void> {
      if (!pendingQuestion) return;
      const q = pendingQuestion;
      pendingQuestion = null;
      try {
        const { client } = await getOpencodeServer(sessionTenant, sessionProject || undefined);
        // Body shape: { id, sessionID, answers: string[][] } — answers is
        // an array of PER-QUESTION arrays, each holding the selected label(s).
        // opencode does `answers.map(n => [...n])`, so a FLAT `[answerText]`
        // gets the answer STRING spread into individual characters → the
        // option never matches → the question tool never resolves → the turn
        // hangs. One question + one answer → `[[answerText]]`. (Verified
        // against opencode's bundle: `answers: Array(Array(Answer))`.)
        await client.tui.control.response({
          body: { id: q.id, sessionID: q.sessionID, answers: [[answerText]] } as never,
        });
        console.log(`[opencode-agent] sent TUI answer for ${q.id.slice(0, 12)}: ${answerText.slice(0, 80)}`);
      } catch (err) {
        console.warn(`[opencode-agent] tui.control.response failed: ${(err as Error).message}`);
      }
    }

    function eventSessionId(ev: Event): string | undefined {
      // Different event types put sessionID in different paths; collapse into one.
      const props = (ev as { properties?: Record<string, unknown> }).properties;
      if (!props) return undefined;
      if (typeof props.sessionID === "string") return props.sessionID;
      const info = props.info as { sessionID?: string; id?: string } | undefined;
      if (info && typeof info.sessionID === "string") return info.sessionID;
      // For session.* events, properties.info.id is the session id itself
      if (info && typeof info.id === "string") return info.id;
      const part = props.part as { sessionID?: string } | undefined;
      if (part && typeof part.sessionID === "string") return part.sessionID;
      return undefined;
    }

    // Lightweight per-type counter so we can verify which event types are
    // arriving without flooding the log with per-event lines.
    const eventTypeCounts: Record<string, number> = {};
    let lastEventTypeLog = 0;

    function handleEvent(ev: Event): void {
      const t = ev.type;
      eventTypeCounts[t] = (eventTypeCounts[t] || 0) + 1;
      // Periodic summary so we can see what's flowing without log spam.
      // Token line piggybacks on the same 5s heartbeat so a single grep
      // surfaces both event flow and context pressure.
      const now = Date.now();
      if (now - lastEventTypeLog > 5000) {
        lastEventTypeLog = now;
        // Two numbers because they answer two questions. `in` (sum) is
        // "how many input tokens have you billed this turn" — grows with
        // every tool cycle. `peak` (max single step) is "how full did
        // context get at its worst" — the number that maps to ctx for
        // overflow risk. peak/ctx% is the meaningful capacity ratio.
        const reasoningPart = turnReasoningTokens > 0 ? ` reasoning=${turnReasoningTokens}` : "";
        const cachePart = (turnCacheReadTokens > 0 || turnCacheWriteTokens > 0)
          ? ` cache_r=${turnCacheReadTokens} cache_w=${turnCacheWriteTokens}`
          : "";
        const tokenSummary = (turnInputTokens > 0 || turnOutputTokens > 0)
          ? ` turn_tokens: in=${turnInputTokens} out=${turnOutputTokens}${reasoningPart}${cachePart} peak_in=${peakInputTokens} ctx=${sessionCtxWindow} peak/ctx=${Math.round((peakInputTokens / sessionCtxWindow) * 100)}%`
          : "";
        console.log(`[opencode-agent:${sessionProject ?? "-"}/${ctx.filename}] event counts so far: ${JSON.stringify(eventTypeCounts)}${tokenSummary}`);
      }

      // Fast filter: only events for OUR session matter.
      const sid = eventSessionId(ev);
      if (sid && ocSessionId && sid !== ocSessionId) {
        // Cross-session event (would happen if multiple .opencode cards share
        // the daemon). Counted above; not handled here.
        return;
      }
      if (t === "message.part.updated") {
        const part = (ev.properties as { part: Part }).part;
        if (part.type === "tool") {
          const tp = part as Extract<Part, { type: "tool" }>;
          // Warn-log tavily MCP failures so silent throttle/quota failures
          // stop looking identical to skipped searches. Fires on the error
          // state transition; callID dedupes inside broadcastedToolCalls
          // are for `running`, so we observe the error path independently.
          if (tp.state.status === "error" && tp.tool.startsWith("mcp__tavily__")) {
            const query = String((tp.state.input as Record<string, unknown>)?.query || "");
            const reason = (tp.state.error || "(no detail)").slice(0, 200);
            console.warn(`[tavily:${sessionProject ?? "-"}:${chatId}] non-success result for query="${query.slice(0, 80)}" — ${reason}`);
          }
          // Dedupe by callID: opencode re-emits message.part.updated multiple
          // times for the same tool as state transitions and metadata fill in.
          // Once we've broadcast progress for a callID, ignore further updates
          // until completion/error (we don't currently broadcast on those).
          if (tp.state.status === "running" && !broadcastedToolCalls.has(tp.callID)) {
            broadcastedToolCalls.add(tp.callID);
            const tool = tp.tool;
            turnToolCalls[tool] = (turnToolCalls[tool] || 0) + 1;
            console.log(`[opencode-agent] progress: ${tool} (${describeOpencodeTool(tool, tp.state.input || {}).slice(0, 80)})`);
            // `details` is the full tool input (pretty-printed JSON) for the
            // card UI's hover tooltip on the corresponding detail-log line.
            // `description` stays the compact emoji-prefixed status string;
            // hover shows the full args (file paths, URLs, command lines,
            // tool-specific payload). Bounded at 4KB to keep DOM nodes sane
            // for huge inputs (e.g. a big read patch).
            let details: string | undefined;
            try {
              const json = JSON.stringify(tp.state.input ?? {}, null, 2);
              details = json && json !== "{}" ? json.slice(0, 4096) : undefined;
            } catch { /* unserializable input — skip details */ }
            ctx.broadcast({
              type: "progress",
              tool,
              description: describeOpencodeTool(tool, tp.state.input || {}),
              ...(details ? { details } : {}),
            });
            // Mark file writes for the canvas glow + ignore-self file-watcher.
            // opencode write tools: write, edit, apply_patch.
            const lower = tool.toLowerCase();
            if (lower === "write" || lower === "edit" || lower === "apply_patch") {
              const fp = String((tp.state.input as Record<string, unknown>)?.file_path || (tp.state.input as Record<string, unknown>)?.filePath || "");
              if (fp) {
                const projRoot = sessionProject ? join(getEffectiveWorkspaceDir(), sessionProject) : "";
                const rel = projRoot && fp.startsWith(projRoot + "/") ? fp.slice(projRoot.length + 1) : fp;
                markAgentWrite(rel);
                reactive.markAgentWrite(rel);
              }
            }
            // Record skill invocations so session-scoped predicate gates
            // (toolPrerequisites.ts: session-has-card-class-handbook) can be
            // SATISFIED on the opencode path — the SDK-side recorder lives in
            // micaAgent.ts and never ran for opencode. The gate fail-opens when
            // chatFilename is null, so this was masked until chatFilename began
            // resolving reliably; once it does, an unrecorded skill makes the
            // gate block card creation. opencode's skill tool carries the name
            // under `name` (per describeOpencodeTool); tolerate alternates.
            if (lower.replace(/[_-]/g, "") === "skill" && sessionProject) {
              const si = tp.state.input as Record<string, unknown> | undefined;
              const skillName = String(si?.name || si?.skill || si?.skill_name || "");
              if (skillName) recordSkillInvocation(sessionProject, ctx.filename, skillName);
            }
          }
        } else if (part.type === "step-finish") {
          const sf = part as Extract<Part, { type: "step-finish" }>;
          if (sf.tokens?.input) {
            turnInputTokens += sf.tokens.input;
            if (sf.tokens.input > peakInputTokens) peakInputTokens = sf.tokens.input;
          }
          if (sf.tokens?.output) turnOutputTokens += sf.tokens.output;
          if (sf.tokens?.reasoning) turnReasoningTokens += sf.tokens.reasoning;
          if (sf.tokens?.cache?.read) turnCacheReadTokens += sf.tokens.cache.read;
          if (sf.tokens?.cache?.write) turnCacheWriteTokens += sf.tokens.cache.write;
          // Upstream cost (OpenRouter / openai-compat servers that forward
          // `usage.cost`). Some providers emit this per step; opencode persists
          // it on the step-finish part. Sum across steps for the turn total.
          const sfCost = (sf as { cost?: number }).cost;
          if (typeof sfCost === "number" && isFinite(sfCost) && sfCost > 0) {
            turnReportedCost += sfCost;
          }
        }
      } else if (t === "todo.updated") {
        // opencode's todowrite tool publishes the full todo list on each
        // change. Surface it as a `progress` event so the chat card shows
        // the current in-progress task — same surface the .qwen / .claude
        // cards use for tool calls. Pick the in_progress item if any,
        // else the first pending one, else summarize done count.
        const props = ev.properties as { todos?: Array<{ content: string; status: string; priority?: string }> };
        const todos = props?.todos ?? [];
        if (todos.length > 0) {
          const inProgress = todos.find((td) => td.status === "in_progress");
          const pending = todos.find((td) => td.status === "pending");
          const completed = todos.filter((td) => td.status === "completed").length;
          let desc: string;
          if (inProgress) {
            desc = `→ ${inProgress.content.slice(0, 80)} (${completed}/${todos.length})`;
          } else if (pending) {
            desc = `next: ${pending.content.slice(0, 80)} (${completed}/${todos.length})`;
          } else if (completed === todos.length) {
            desc = `all done (${todos.length}/${todos.length})`;
          } else {
            desc = `${completed}/${todos.length} done`;
          }
          ctx.broadcast({ type: "progress", tool: "todowrite", description: desc });
        }
      } else if ((t as string) === "question.asked") {
        // opencode publishes question.asked with the full question payload
        // inline: { id, sessionID, questions: [{ question, header, options:
        // [{ label, description }] }] }. We can render straight from the
        // event — no need to /tui/control/next.
        const props = (ev as { properties?: { id?: string; sessionID?: string; questions?: Array<{ question: string; header?: string; options?: Array<{ label: string; description?: string }>; multiple?: boolean }> } }).properties;
        if (props?.id && props?.sessionID && Array.isArray(props.questions)) {
          pendingQuestion = { id: props.id, sessionID: props.sessionID };
          // Translate to Mica's user_question shape: opencode uses `multiple`,
          // Mica uses `multiSelect`. Same semantics.
          const normalized = props.questions.map((q) => ({
            question: q.question,
            options: q.options,
            multiSelect: q.multiple ?? false,
          }));
          ctx.broadcast({ type: "user_question", questions: normalized });
          console.log(`[opencode-agent] surfaced question ${props.id.slice(0, 12)} (${normalized.length} prompt${normalized.length === 1 ? "" : "s"}) — waiting for user reply`);
        } else {
          console.warn(`[opencode-agent] question.asked event missing expected fields: ${JSON.stringify(props).slice(0, 200)}`);
        }
      } else if (t === "permission.updated" || (t as string) === "permission.asked") {
        // Auto-approve all permission requests (yolo) — matches the .qwen
        // and .claude trust model. opencode emits both "permission.asked"
        // (newer name, what 1.14 actually sends) and "permission.updated"
        // (the original name in the SDK type union); handle both. If we
        // miss this, the agent loop blocks forever on permissioned tools
        // (write, bash, webfetch, ...).
        const perm = ev.properties as { id: string; sessionID: string };
        if (perm?.id && perm?.sessionID) {
          console.log(`[opencode-agent] auto-approving permission ${perm.id.slice(0, 12)}`);
          autoApprovePermission(perm.sessionID, perm.id).catch((err) => {
            console.warn(`[opencode-agent] permission auto-approve failed: ${(err as Error).message}`);
          });
        }
      } else if (t === "session.error") {
        // opencode wraps each error type with a discriminated `name` and
        // a `data` payload (NOT a flat `.message` on the error object —
        // the previous extraction collapsed everything to the bare name
        // like "ContextOverflowError" with zero context). Drill into
        // data.message + data.responseBody so the user sees the real
        // reason. See @opencode-ai/sdk types.gen.d.ts: ContextOverflowError,
        // ProviderAuthError, UnknownError, ApiError all share the
        // `{ name, data: { message, ... } }` shape.
        const props = ev.properties as {
          error?: {
            name?: string;
            data?: { message?: string; responseBody?: string; statusCode?: number };
            message?: string;
          };
        };
        const e = props.error;
        const inner = e?.data?.message;
        const rawMsg = inner || e?.message || e?.name || "session error (no detail)";
        const errorName = e?.name ?? "Error";
        const responseBody = e?.data?.responseBody;
        // Build a user-facing message that opens with the error class
        // (ContextOverflowError / ProviderAuthError / etc.) followed by
        // the actual reason — gives the user enough to know what failed
        // AND what to try next.
        let surfaceMsg: string;
        if (errorName === "ContextOverflowError") {
          surfaceMsg =
            `Context window full. The session history exceeded the model's input limit. ` +
            `Attempting automatic compaction — once it finishes, retry your message. ` +
            `(Detail: ${rawMsg.slice(0, 200)})`;
          // Fire-and-forget: compress the session so the next user prompt fits.
          // The user re-sends manually because opencode's session-prompt API
          // is request/response per turn and we don't have the original
          // text in scope here. The card.js UI sees the surfaceMsg and the
          // user can hit Send again — the compacted history fits the next
          // prompt. If summarize itself fails (rare), the next prompt
          // overflows again with the same surfaceMsg; user can clear/spawn.
          (async () => {
            if (!sid) return;
            try {
              const { client } = await getOpencodeServer(sessionTenant, sessionProject || undefined);
              // session.summarize requires explicit providerID + modelID
              // (the SDK doesn't infer from the session's last-used model).
              // Reuse the override captured for the LAST prompt — that's
              // the model that just overflowed; using a different one
              // here would either fail (provider not configured) or
              // silently produce nothing.
              if (!lastModelOverride) {
                console.warn(`[opencode-agent] session.summarize skipped: no lastModelOverride (session may have been on opencode's default provider)`);
                return;
              }
              const result = await client.session.summarize({
                path: { id: sid },
                body: lastModelOverride,
                query: { directory: getProjectDir(sessionProject) },
              });
              if (result.error) {
                console.warn(`[opencode-agent] session.summarize error: ${JSON.stringify(result.error).slice(0, 200)}`);
              } else {
                console.log(`[opencode-agent] session.summarize OK for ${sid?.slice(0, 8)} (model=${lastModelOverride.providerID}/${lastModelOverride.modelID}) — user can retry`);
              }
            } catch (err) {
              console.warn(`[opencode-agent] session.summarize threw: ${(err as Error).message}`);
            }
          })();
        } else if (errorName === "ProviderAuthError") {
          surfaceMsg = `Provider auth failed: ${rawMsg.slice(0, 300)}. Check the API key in the gear panel and retry.`;
        } else {
          surfaceMsg = responseBody
            ? `${errorName}: ${rawMsg.slice(0, 300)} (response: ${responseBody.slice(0, 200)})`
            : `${errorName}: ${rawMsg.slice(0, 500)}`;
        }
        sessionErrorMsg = surfaceMsg.slice(0, 1000);
        console.warn(`[opencode-agent] session.error: ${errorName} — ${rawMsg.slice(0, 200)}`);
        // Wake the awaiter so we surface the error rather than waiting for an
        // idle that may never come.
        if (idleResolver) { idleResolver(); idleResolver = null; }
      } else if (t === "session.idle") {
        // Turn complete — wake up the awaiter.
        console.log(`[opencode-agent] session.idle for ${sid?.slice(0, 8)}`);
        if (idleResolver) { idleResolver(); idleResolver = null; }
      }
    }

    async function autoApprovePermission(sid: string, permissionId: string): Promise<void> {
      const { client } = await getOpencodeServer(sessionTenant, sessionProject || undefined);
      // The per-permission API takes "once" | "always" | "reject" — NOT
      // "allow" (which is the value the Config.permission defaults use).
      // We send "always" so opencode caches the approval at the (tool,
      // pattern) level: subsequent tool runs in this session don't re-ask.
      // postSessionIdPermissionsPermissionId is the auto-generated method
      // name from the openapi spec.
      await client.postSessionIdPermissionsPermissionId({
        path: { id: sid, permissionID: permissionId },
        body: { response: "always" },
      });
    }

    // ── Per-turn process ────────────────────────────────────────

    // Bind the captured tenant around the whole turn so session.create's
    // directory, buildContext file reads, and any getEffectiveWorkspaceDir path
    // resolution scope to THIS card's tenant — even though the turn runs detached
    // from the channel-open async context. runWithTenant gives proper context
    // isolation (no cross-tenant leak under the shared daemon). No-op wrap when
    // single-tenant (sessionTenant undefined).
    async function processMessage(message: string, source: QueuedMsg["source"] = "user", attachmentFilename?: string): Promise<void> {
      if (!sessionTenant) return processMessageInner(message, source, attachmentFilename);
      return runWithTenant(sessionTenant, () => processMessageInner(message, source, attachmentFilename));
    }
    async function processMessageInner(message: string, source: QueuedMsg["source"] = "user", attachmentFilename?: string): Promise<void> {
      if (busy) { enqueueMessage(message, source, attachmentFilename); return; }
      const turnSource = source;
      // Record real-user messages so toolPrerequisites' spec-approval-gate
      // predicate can compare spec mtime to the last-approval timestamp.
      // "file-changes" and "recovery" are Mica-injected and don't count.
      // Mirrors the same pattern in micaAgent.ts (qwen) and claudeAgent.ts.
      if (source === "user" || source === "voice") {
        recordUserMessage(sessionProject, ctx.filename);
        // A real user turn (Get Started's initialize scan, or a typed first
        // message) marks the session started — unlocks reactive turns.
        sessionStarted = true;
      }
      busy = true;
      reactive.setBusy(true);
      markProjectActivity(sessionProject, +1);
      // Reset the per-turn render_capture cap. Fresh user message ⇒ fresh
      // budget for screenshot verifications. See renderCaptureCounter.ts.
      resetRenderCaptureCount(sessionProject);
      // Publish this session's project as the last-active opencode project.
      // The mica-builtins MCP bridge runs once per opencode-serve and can't
      // pass session-scoped headers; Mica's /api/tools/* endpoints fall back
      // to this when X-Mica-Project is absent. See server/agentTools/registry.ts.
      setLastActiveOpencodeProject(sessionProject);
      // Same publish for the chat filename — lets render_capture's captioner
      // routing resolve THIS card's {provider, model} (so it captions with the
      // card's own vision model) when the per-call session header doesn't
      // carry a chatFilename. Mirrors the project fallback above.
      setLastActiveOpencodeChatFilename(ctx.filename);

      // Reset per-turn collectors
      Object.keys(turnToolCalls).forEach((k) => delete turnToolCalls[k]);
      broadcastedToolCalls.clear();
      turnInputTokens = 0;
      turnOutputTokens = 0;
      peakInputTokens = 0;
      turnReasoningTokens = 0;
      turnCacheReadTokens = 0;
      turnCacheWriteTokens = 0;
      turnReportedCost = 0;
      sessionErrorMsg = "";

      const turnId = randomUUID();
      const tsStart = Date.now();
      let firstTokenTs: number | null = null;
      void firstTokenTs;  // not yet measured per-event; reserved

      ctx.broadcast({ type: "user", content: message, ...(attachmentFilename ? { attachmentFilename } : {}) });

      const history = await loadHistory(chatId, sessionProject);
      history.push({
        role: "user",
        content: attachmentFilename ? `${message}\n\n[📷 attached: ${attachmentFilename}]` : message,
      });
      await saveHistory(chatId, history, sessionProject);

      ctx.broadcast({ type: "thinking" });

      try {
        const since = getLastTurnAt(ctx.filename);

        if (sessionProject) {
          // Match buildContext: count only fresh errors so the UI matches
          // what the agent actually sees this turn.
          const { fresh: incoming } = getFreshPendingValidatorErrors(sessionProject, getProjectDir(sessionProject));
          if (incoming.length > 0) {
            const files = Array.from(new Set(incoming.map((e) => e.filename)));
            const desc = incoming.length === 1
              ? `Received error from ${files[0]}`
              : `Received ${incoming.length} errors from ${files.length === 1 ? files[0] : `${files.length} files`}`;
            ctx.broadcast({ type: "progress", tool: "validator-errors", description: desc });
          }
        }

        // NB: buildContext is called AFTER the per-turn model/context-window
        // resolution below, so the runtime banner carries the resolved model
        // + calibration. (Nothing between here and there reads `context`.)

        // History injection — opencode's session keeps its own conversation
        // memory server-side (it's stateful), so we ONLY include the current
        // user message in `parts`. Mica's chat-history file is kept in lockstep
        // for our own UI / cursor advance, but is NOT re-sent.
        //
        // Cursor-advance still works: our local history slice [0, cursor) is
        // hidden from the Mica UI, but opencode's session retains everything.
        // If the user explicitly clears (cursor advance → opencode session
        // delete), that's a separate path — for v1, cursor advance only
        // hides Mica-side; opencode keeps its full thread.

        // Ensure session + start SSE + start TUI control loop before first
        // prompt. The TUI loop must be running BEFORE the agent invokes
        // `question`, since /tui/control/next is a long-poll: opencode
        // queues the request once the tool is called and we drain it.
        const sid = await ensureOpencodeSession();
        await startEventLoop();
        await startTuiControlLoop();
        // Surface "no usable provider" as an immediate error so the chat
        // card doesn't sit in "thinking" until the timeout fires. Asks
        // opencode itself which providers can serve a prompt — covers
        // both cloud auth and locally-configured providers (llama-server,
        // ollama-cloud, etc.).
        if (!(await hasUsableProvider(sessionTenant, sessionProject || undefined))) {
          throw new Error(
            "OpenCode has no usable provider — either run `opencode providers login` " +
            "to add a cloud credential (Anthropic / OpenAI / OpenRouter / Claude Pro), " +
            "or configure a local provider in ~/.config/opencode/opencode.jsonc " +
            "(e.g. llama-server pointing at localhost:8012).",
          );
        }

        const idlePromise = new Promise<void>((resolve) => { idleResolver = resolve; });

        const { client } = await getOpencodeServer(sessionTenant, sessionProject || undefined);
        // Per-prompt abort — flipped only by user-initiated interrupt.
        const promptAbort = new AbortController();
        activePromptAbort = promptAbort;

        // Per-card model override. The opencode card's settings panel
        // mirrors the chat card's `{provider, model}` shape — same UX
        // (Local / OpenRouter / OpenAI-compat radios, OR model search,
        // key validation). Mapping to opencode's `body.model = { providerID,
        // modelID }`:
        //   - provider: "local"           → providerID: "mica-local"
        //                                   (a custom provider opencode-
        //                                   Config injects at spawn time
        //                                   pointing at LLAMA_URL). The
        //                                   modelID is either the user's
        //                                   pick or the first model vLLM
        //                                   is currently serving.
        //   - provider: "openrouter"      → providerID: "openrouter".
        //                                   Requires OPENROUTER_API_KEY in
        //                                   opencode's env (plumbed at
        //                                   spawn time by opencodeServer).
        //   - provider: "openai-compat"   → providerID: "openai".
        //                                   Requires OPENAI_API_KEY +
        //                                   OPENAI_BASE_URL in opencode's
        //                                   env (plumbed at spawn time).
        // Read per-prompt (not cached) so a settings change applies on the
        // very next turn without a card reopen.
        const settings = await readCardSettings(sessionProject || undefined, ctx.filename);
        let modelOverride: { providerID: string; modelID: string } | undefined;
        // Unset → MICA_DEFAULT_PROVIDER; an explicit provider (incl. "local")
        // is honored (`??` only catches undefined).
        const provider = settings.provider ?? resolveDefaultProvider();
        // Default model resolution per provider: per-card gear setting >
        // <PROVIDER>_DEFAULT_MODEL env (from .env) > built-in fallback. Env
        // defaults let a deployment pin a model without editing every card —
        // previously a card with no model pinned passed `undefined` here and
        // fell back to opencode's own (unconfigurable) default.
        if (provider === "openrouter") {
          // resolveDefaultModel is the shared per-provider default (env >
          // fallback) that the gear UI placeholder also reads.
          const modelID = settings.model || resolveDefaultModel("openrouter");
          modelOverride = { providerID: "openrouter", modelID };
        } else if (provider === "openai-compat") {
          const modelID = settings.model || resolveDefaultModel("openai-compat");
          // When openai-compat resolves to Google's Gemini endpoint (the
          // one-key fallback in readOpenAICompatConfig), route to the custom
          // `gemini` provider opencodeConfig registers (@ai-sdk/openai-compatible
          // → chat/completions). The builtin `openai` providerID can't be used
          // for Gemini — opencode forces OpenAI's Responses API there, which
          // Gemini doesn't implement. Real OpenAI/other endpoints stay on
          // "openai".
          const oc = await readOpenAICompatConfig(sessionProject || undefined);
          const providerID = oc.baseUrl && oc.baseUrl.includes("generativelanguage.googleapis.com") ? "gemini" : "openai";
          modelOverride = { providerID, modelID };
        } else if (provider === "local") {
          // Pick the user's chosen model when present, then the LOCAL_DEFAULT_MODEL
          // env, otherwise probe the local endpoint for its served set and take
          // the first id. Probing per-prompt is fine — local /v1/models is
          // sub-ms and honest about "what the server is actually loaded with
          // right now" (the user could have hot-swapped containers). NB: we keep
          // the firstLocalModelId() fallback here rather than resolveDefaultModel
          // so an unset env still auto-discovers the served model.
          const modelID = settings.model || process.env.LOCAL_DEFAULT_MODEL || (await firstLocalModelId());
          if (modelID) {
            modelOverride = { providerID: "mica-local", modelID };
          }
        }
        if (modelOverride) {
          console.log(`[opencode-agent] prompt model override: ${modelOverride.providerID}/${modelOverride.modelID}`);
          lastModelOverride = modelOverride;
        }

        // Resolve the effective context window for this turn (provider-aware).
        // OpenRouter looks up the model's contextLength in our cached catalog;
        // openai-compat probes <baseUrl>/models for vLLM/llama.cpp-style
        // context fields; local uses LLAMA_CTX_SIZE env. Falls back to 200K
        // for anything unknown.
        let openaiBaseUrl: string | undefined;
        if (provider === "openai-compat") {
          try {
            const cfg = await readOpenAICompatConfig(sessionProject || undefined);
            if (cfg.baseUrl) openaiBaseUrl = cfg.baseUrl;
          } catch { /* ignore — falls through to default */ }
        }
        const effectiveCtxWindow = await resolveCtxWindow({
          provider,
          modelId: settings.model || undefined,
          baseUrl: openaiBaseUrl,
        });
        sessionCtxWindow = effectiveCtxWindow;
        console.log(`[opencode-agent:${sessionProject ?? "-"}/${ctx.filename}] effective context window: ${effectiveCtxWindow} (provider=${provider}, model=${settings.model || "(default)"}, ocSession=${ocSessionId?.slice(0, 8) ?? "?"})`);

        // Model calibration for this turn's resolved (provider, model). Fed
        // into the runtime banner (via buildContext) so the agent gets its
        // self-awareness block — same mechanism micaAgent uses. Cached 1h,
        // keyed provider:model, so a per-turn call for an unchanged model is a
        // map lookup, not a network fetch.
        const modelName = modelOverride?.modelID ?? null;
        const calBaseUrl =
          provider === "local" ? (process.env.LLAMA_URL || "http://127.0.0.1:8012")
          : provider === "openai-compat" ? openaiBaseUrl
          : undefined; // openrouter derives the HF id from the org/model slug
        const calibration = await getModelCalibration({ provider, modelName: modelName ?? "", baseUrl: calBaseUrl });
        console.log(`[opencode-agent:${sessionProject ?? "-"}/${ctx.filename}] calibration: class="${calibration.identity.class}" arch=${calibration.knownFacts.architecture ?? "?"} assetUrlPaths=${calibration.recallProfile.assetUrlPaths}`);

        const context = await buildContext(ctx.filename, sessionProject, since, modelName, effectiveCtxWindow, calibration);
        void writeSnapshot(sessionProject, chatId, turnId, context);

        // Build message parts. Text always present. When the user attached a
        // screenshot via the 📷 picker, capture the rendered card from the
        // browser and inline it as a FilePartInput with a data URL — opencode
        // routes this to whichever provider/model the user picked. For
        // multimodal models (Claude, GPT-4o, gemini, qwen-vl) it lands as
        // image content; non-multimodal providers will either error visibly
        // or downgrade to text-only, which the user can correct in settings.
        const parts: Array<{ type: "text"; text: string } | { type: "file"; mime: string; url: string; filename?: string }> = [
          { type: "text", text: message },
        ];
        if (attachmentFilename) {
          try {
            const capture = await captureCard(sessionProject || "", attachmentFilename);
            const pngBuffer = await fsReadFile(capture.path);
            const base64 = pngBuffer.toString("base64");
            parts.push({
              type: "file",
              mime: "image/png",
              filename: attachmentFilename,
              url: `data:image/png;base64,${base64}`,
            });
            console.log(`[opencode-agent] attached screenshot of ${attachmentFilename} (${capture.bytes} bytes)`);
          } catch (err) {
            const errMsg = (err as Error).message || String(err);
            console.warn(`[opencode-agent] screenshot capture failed for ${attachmentFilename}: ${errMsg}`);
            parts[0] = {
              type: "text",
              text: `${message}\n\n(Screenshot of ${attachmentFilename} was requested but capture failed: ${errMsg})`,
            };
          }
        }

        // Use promptAsync (fire-and-return) instead of prompt (which streams
        // its body until session.idle and hangs the SDK fetch's await chain).
        // After the POST returns, we watch SSE for session.idle / session.error
        // and then fetch the final session messages to assemble the assistant
        // text. This is the canonical opencode flow per
        // https://opencode.ai/docs/integration: post → watch → fetch.
        const sendResult = await client.session.promptAsync({
          path: { id: sid },
          body: {
            parts,
            system: context,
            ...(modelOverride ? { model: modelOverride } : {}),
          },
          query: { directory: getProjectDir(sessionProject) },
          signal: promptAbort.signal,
        });
        if (sendResult.error) {
          activePromptAbort = null;
          throw new Error(`opencode promptAsync error: ${JSON.stringify(sendResult.error).slice(0, 300)}`);
        }

        // Wait indefinitely for session.idle (success), session.error, or
        // a user-initiated abort via the Stop button. No timeout — long
        // local-model turns regularly run 30+ minutes; we trust opencode
        // to finish or the user to stop.
        try {
          await Promise.race([
            idlePromise,
            new Promise<void>((_, reject) => {
              const onAbort = () => reject(new Error("turn aborted"));
              promptAbort.signal.addEventListener("abort", onAbort, { once: true });
            }),
          ]);
        } finally {
          activePromptAbort = null;
        }

        // Drain any final events (last tool_use → progress, etc.) before fetch.
        await new Promise<void>((r) => setTimeout(r, 250));

        // Now fetch the session messages to assemble the assistant text. The
        // last assistant message in the list is THIS turn's response. opencode
        // appends user/assistant pairs to the same session, so we take from the
        // tail.
        const msgsRes = await client.session.messages({ path: { id: sid } });
        if (msgsRes.error) {
          throw new Error(`opencode session.messages error: ${JSON.stringify(msgsRes.error).slice(0, 300)}`);
        }
        const allMessages = msgsRes.data ?? [];
        // Find the last assistant message
        let resultText = "";
        let lastReasoningText = "";   // surfaced by the empty-output diagnostic below
        let assistantTokens: { input?: number } | undefined;
        for (let i = allMessages.length - 1; i >= 0; i--) {
          const msg = allMessages[i];
          if (msg.info.role === "assistant") {
            for (const p of msg.parts) {
              if (p.type === "text" && (p as { synthetic?: boolean }).synthetic !== true) {
                resultText += (p as { text: string }).text;
              } else if (p.type === "reasoning") {
                // Concatenate every reasoning chunk for this assistant message.
                // OpenRouter streams the trace token-by-token (reasoning_details[].text),
                // and opencode persists each chunk as its own part — so we may see
                // many short reasoning parts. The empty-output diagnostic below
                // surfaces this when the model produced reasoning but no text or
                // tool_call (see GH opencode-ai/opencode #7185, #24316, #27210).
                const txt = (p as { text?: string }).text;
                if (typeof txt === "string") lastReasoningText += txt;
              }
            }
            assistantTokens = (msg.info as { tokens?: { input?: number } }).tokens;
            break;
          }
        }

        // Two distinct measures from step-finish events:
        //   - billed input (sum across steps): what the user pays for /
        //     what cache pressure looks like
        //   - peak input (max single step): the largest context the model
        //     held in one call — what the window cap actually constrains
        // Capacity math + the proactive-compaction trigger use peak. The
        // user-facing total is surfaced separately. Fall back to the
        // assistant message's reported usage if step-finish never fired
        // (rare; opencode emits step-finish for every model step).
        let billedInputTokens = turnInputTokens;
        let peakInput = peakInputTokens;
        if (billedInputTokens === 0 && assistantTokens?.input) {
          billedInputTokens = assistantTokens.input;
          peakInput = assistantTokens.input;
        }
        // Reference name for downstream code that previously used
        // `inputTokens` to mean "the number worth comparing against ctx".
        const inputTokens = peakInput;

        if (sessionErrorMsg && !resultText.trim()) {
          resultText = `[opencode error] ${sessionErrorMsg}`;
        }

        const filesChanged = !!turnToolCalls["write"] || !!turnToolCalls["edit"] || !!turnToolCalls["apply_patch"];
        if (!resultText.trim()) {
          // Empty-output failure mode for reasoning models on OpenRouter / vLLM:
          // the model emits its intended tool call inside the reasoning channel
          // instead of as a structured `tool_calls` event, so opencode-serve sees
          // no callable tool and closes the turn with finish=stop, output=0.
          // Documented in opencode-ai/opencode #7185, #24316, #27210, #14716,
          // #24190 — all open, no upstream fix. Surface what actually happened
          // (the reasoning content the model produced) instead of masking it
          // with "Done.", which sent the user chasing phantom progress on two
          // separate test runs before we caught it.
          const noToolCalls = Object.keys(turnToolCalls).length === 0;
          const emptyOutputBug = turnReasoningTokens > 0 && noToolCalls && !filesChanged;
          if (emptyOutputBug) {
            const trimmed = lastReasoningText.trim();
            const preview = trimmed.length > 800 ? trimmed.slice(0, 800) + "…" : trimmed;
            resultText =
              "[empty-output] The model produced reasoning but no response text and no structured tool call. " +
              "This is a known opencode-serve issue with reasoning models on OpenRouter / vLLM — the intended " +
              "tool call ends up in the reasoning channel instead of as a callable function. Tracking issues: " +
              "opencode-ai/opencode #7185, #24316, #27210.\n\n" +
              "What the model was thinking:\n" +
              (preview || "(reasoning content was empty — try again, or pick a non-reasoning model in the gear)") +
              "\n\nWorkarounds: re-send the same prompt (often transient), or switch the model in the gear to " +
              "a non-reasoning variant (e.g. anthropic/claude-sonnet-4.5, openai/gpt-4o, qwen/qwen3-coder-plus).";
          } else {
            resultText = filesChanged ? "Done — I made changes." : "Done.";
          }
        }

        // Arc-complete cursor advance, mirrors claudeAgent.
        const ARC_COMPLETE_RE = /<thread-state>\s*arc-complete\s*<\/thread-state>/i;
        const arcComplete = ARC_COMPLETE_RE.test(resultText);
        if (arcComplete) resultText = resultText.replace(ARC_COMPLETE_RE, "").trim();

        const capacity = inputTokens / effectiveCtxWindow;
        const cursor = await readChatCursor(chatId, sessionProject);
        let cursorAdvanced = false;
        let newCursor = cursor;

        const tsEndForTokens = Date.now();
        const turnTokens: TurnTokens = {
          input: billedInputTokens,
          output: turnOutputTokens,
          peak: peakInput,
          reasoning: turnReasoningTokens,
          cache_read: turnCacheReadTokens,
          cache_write: turnCacheWriteTokens,
          ctx: effectiveCtxWindow,
          duration_ms: tsEndForTokens - tsStart,
          tool_calls: { ...turnToolCalls },
          files_changed: filesChanged,
        };

        // Per-turn cost estimate. Cards display this in the topbar (always
        // visible) and the per-turn chevron footer (drilldown). Local turns
        // resolve to $0 explicitly; openai-compat returns null (no public
        // rate card to multiply against). Reasoning tokens are billed as
        // output by every provider we route to, so they're folded into the
        // `output` argument here.
        const cost = await estimateTurnCost({
          provider,
          modelId: modelOverride?.modelID,
          billedInput: billedInputTokens,
          output: turnOutputTokens + turnReasoningTokens,
          // OpenRouter (and openai-compat servers that implement it) returns
          // the exact USD on each step-finish via `usage.cost`; we sum it
          // across steps. When > 0 the estimator uses it instead of the
          // catalog-pricing approximation. Zero falls back to catalog.
          reportedCost: turnReportedCost > 0 ? turnReportedCost : undefined,
        });

        const updated = await loadHistory(chatId, sessionProject);
        updated.push({ role: "assistant", content: resultText, agent: "OpenCode", turn_id: turnId, tokens: turnTokens });
        await saveHistory(chatId, updated, sessionProject);

        if (arcComplete && capacity > 0.80) {
          newCursor = updated.length;
          await writeChatCursor(chatId, sessionProject, newCursor, updated.length);
          cursorAdvanced = true;
        }

        const tsEnd = Date.now();
        console.log(`[opencode-agent:${sessionProject ?? "-"}/${ctx.filename}] broadcasting assistant: contextWindow=${effectiveCtxWindow} inputTokens=${inputTokens} billed=${billedInputTokens} ocSession=${ocSessionId?.slice(0, 8) ?? "?"} clients=${ctx.clientCount?.() ?? "?"}`);
        ctx.broadcast({
          type: "assistant",
          content: resultText,
          agent: "OpenCode",
          filesChanged,
          // Source attribution surfaced to listeners. voiceAgent's
          // ambient gate uses `viaVoice` to decide whether to read
          // this reply aloud (only voice-dispatched turns get TTS).
          source: turnSource,
          viaVoice: turnSource === "voice",
          contextWindow: effectiveCtxWindow,
          baselineTokens: inputTokens,
          inputTokens,         // peak — for the capacity gauge
          billedInputTokens,   // sum across steps — for the cost view
          outputTokens: turnOutputTokens,
          tokens: turnTokens,  // full per-turn token breakdown for the chevron footer
          cost,                // per-turn USD estimate (null when no rate card)
          provider,            // surfaced so the topbar can show provider/model in the same strip
          modelId: modelOverride?.modelID,
          arcComplete,
          capacity,
          cursor: newCursor,
          cursorAdvanced,
          durationMs: tsEnd - tsStart,
          turn_id: turnId,
        });

        // Proactive compaction: when the peak input tokens approached the
        // model's context limit, trigger session.summarize before the next
        // turn fires. Threshold 0.75 sits well above normal-turn capacity
        // (typical builds peak at 0.3-0.5) but with enough headroom that
        // the NEXT turn's tool I/O fits even if it lands an unusually
        // large tool result. Reactive compaction on ContextOverflowError
        // (above, in the SSE session.error handler) stays as the safety
        // net for cases where a single turn alone overflows (e.g. a huge
        // file read mid-turn).
        //
        // Fire-and-forget: don't block this turn's completion. The
        // session.summarize call runs against the same provider/model the
        // session was using (lastModelOverride captured at prompt time)
        // and replaces history with a compact summary. opencode handles
        // ordering if the user sends a new prompt while summarize is
        // still in flight — either queues or errors with a clear msg
        // that our session.error handler now surfaces.
        const COMPACT_THRESHOLD = 0.75;
        if (capacity >= COMPACT_THRESHOLD && lastModelOverride && sid) {
          console.log(
            `[opencode-agent] proactive compaction triggered: capacity=${Math.round(capacity * 100)}% ` +
              `>= ${Math.round(COMPACT_THRESHOLD * 100)}% threshold (input=${inputTokens}, ` +
              `window=${effectiveCtxWindow})`,
          );
          ctx.broadcast({
            type: "progress",
            tool: "compact",
            description: `Compacting conversation (${Math.round(capacity * 100)}% of context used) — next turn starts fresh`,
          });
          const compactSid = sid;
          const compactModel = lastModelOverride;
          (async () => {
            try {
              const { client } = await getOpencodeServer(sessionTenant, sessionProject || undefined);
              const result = await client.session.summarize({
                path: { id: compactSid },
                body: compactModel,
                query: { directory: getProjectDir(sessionProject) },
              });
              if (result.error) {
                console.warn(
                  `[opencode-agent] proactive compaction error for ${compactSid.slice(0, 8)}: ` +
                    `${JSON.stringify(result.error).slice(0, 200)}`,
                );
              } else {
                console.log(
                  `[opencode-agent] proactive compaction OK for ${compactSid.slice(0, 8)} ` +
                    `(model=${compactModel.providerID}/${compactModel.modelID})`,
                );
              }
            } catch (err) {
              console.warn(
                `[opencode-agent] proactive compaction threw for ${compactSid.slice(0, 8)}: ` +
                  `${(err as Error).message}`,
              );
            }
          })();
        }
      } catch (err) {
        const errMsg = (err as Error).message || String(err);
        console.error(`[opencode-agent] turn error: ${errMsg}`);
        ctx.broadcast({ type: "error", error: errMsg });
      } finally {
        recordTurnEnd(ctx.filename);
        markProjectActivity(sessionProject, -1);
        // Surface any card-errors that survived the turn (agent didn't
        // self-heal). Errors POSTed mid-turn are held in cardErrorBuffer
        // and released here — milestone, not timer.
        if (sessionProject) flushProjectPendingErrors(sessionProject);
        busy = false;
        reactive.setBusy(false);
        const next = dequeueNext();
        if (next) {
          setImmediate(() => processMessage(next.text, next.source, next.attach));
        }
        // No explicit flush — setBusy(false) above arms the 30s idle
        // timer if events accumulated during the turn. flushIfPending
        // would deliver immediately and skip the post-turn idle wait.
      }
    }

    // ── Channel lifecycle ───────────────────────────────────────

    let initialScanDone = false;

    const INITIAL_SCAN_MESSAGE = "This is a new project session. Read your behavior instructions (from your card back), then scan the project files, set up context, and report what you found.";

    // Health-gate the initialize turn: probe the configured model endpoint
    // first. On failure, surface an inline actionable error (retry:true → card
    // shows a Retry button) and leave the scan pending instead of firing a turn
    // that throws deep in opencode. Fired from start_session (Get Started) and
    // retry_init — never auto-scheduled.
    async function fireInitialScanIfHealthy(): Promise<void> {
      const probe = await probeModelEndpoint(sessionProject || undefined, ctx.filename);
      if (!probe.ok) {
        ctx.broadcast({ type: "error", error: probe.reason || "Model endpoint not reachable.", retry: true });
        return;
      }
      if (initialScanDone) return;
      initialScanDone = true;
      if (!busy) processMessage(INITIAL_SCAN_MESSAGE, "user");
      else enqueueMessage(INITIAL_SCAN_MESSAGE, "user");
    }

    return {
      async onAttach(clientId, _args) {
        // Send history (plus cursor) to newly attached client. Awaited
        // so disk-read errors surface in logs instead of being swallowed
        // by a fire-and-forget .then() chain.
        let messages: ChatMessage[];
        let cursor: number;
        try {
          [messages, cursor] = await Promise.all([
            loadHistory(chatId, sessionProject),
            readChatCursor(chatId, sessionProject),
          ]);
        } catch (err) {
          console.warn(`[opencodeAgent:onAttach] history-load failed`, {
            chatId, sessionProject, error: (err as Error)?.message || err,
          });
          return;
        }
        ctx.sendTo(clientId, { type: "history", messages, cursor });
        for (const event of currentTurnEvents) ctx.sendTo(clientId, event);
        // Send current queue snapshot so the panel populates on first paint.
        // Skip when empty — the card's "queue" handler hides the panel on
        // empty list, but a no-op send is cheap; we just send unconditionally.
        ctx.sendTo(clientId, {
          type: "queue",
          items: queue.map((q) => ({
            id: q.id,
            text: q.text.length > 160 ? q.text.slice(0, 160) + "…" : q.text,
            source: q.source,
            queuedAt: q.queuedAt,
            attach: q.attach || undefined,
          })),
        });

        // Do NOT auto-start. A fresh (empty-history) session waits for the
        // user to click Get Started (→ start_session) or type a first message,
        // so they can pick a model in the gear first. A reopened session
        // (history present) is already "started" — unlock reactive turns.
        if (messages.length > 0) sessionStarted = true;
      },

      onData(clientId, data) {
        const msg = data as { type?: string; message?: string; attachmentFilename?: string };

        // Retry the health-gated initialize scan after the user fixed model
        // settings: re-probe, fire the pending scan if healthy, else re-emit
        // the actionable error.
        if (msg.type === "retry_init") {
          if (!initialScanDone) void fireInitialScanIfHealthy();
          return;
        }

        // User clicked "Get Started" on a fresh session — run the same
        // health-gated initialize scan the old 2s auto-timer used to fire.
        // (Same handler as retry_init; distinct name for log/intent clarity.)
        if (msg.type === "start_session") {
          if (!initialScanDone) void fireInitialScanIfHealthy();
          return;
        }

        if (msg.type === "interrupt") {
          // Two-step interrupt:
          //   1. Abort the in-flight HTTP prompt so the await unblocks.
          //   2. Tell opencode to stop the model — session.abort cancels
          //      provider streaming and clears the in-flight assistant
          //      message; without this, opencode continues until the model
          //      completes even after the HTTP socket closes.
          if (activePromptAbort) {
            try { activePromptAbort.abort(); } catch { /* ignore */ }
            activePromptAbort = null;
          }
          if (ocSessionId) {
            (async () => {
              try {
                const { client } = await getOpencodeServer(sessionTenant, sessionProject || undefined);
                await client.session.abort({ path: { id: ocSessionId! } });
              } catch (err) {
                console.warn(`[opencode-agent] abort failed: ${(err as Error).message}`);
              }
            })();
          }
          if (queue.length > 0) {
            console.log(`[opencode-agent] interrupt: dropping ${queue.length} queued message(s)`);
            queue.length = 0;
            broadcastQueue();
          }
          return;
        }

        // Cancel a single queued message by id (user clicked the × on the
        // queue panel row). Idempotent — unknown id is a no-op.
        if (msg.type === "cancel_queued") {
          const id = (msg as { id?: string }).id;
          if (!id) return;
          const before = queue.length;
          queue = queue.filter((q) => q.id !== id);
          if (queue.length !== before) broadcastQueue();
          return;
        }

        // Drop every queued message (user clicked "clear queued"). Distinct
        // from `interrupt`: the current turn keeps running. Same as qwen.
        if (msg.type === "clear_queue") {
          if (queue.length > 0) {
            console.log(`[opencode-agent] clear_queue: dropping ${queue.length} queued message(s)`);
            queue.length = 0;
            broadcastQueue();
          }
          return;
        }

        if (msg.type === "get_context") {
          buildContext(ctx.filename, sessionProject).then((context) => {
            ctx.sendTo(clientId, { type: "context_info", context, contextLength: context.length });
          });
          return;
        }

        const message = msg.message;
        if (!message) return;

        // If the agent asked a question via the TUI control bridge and
        // we're waiting for an answer, route this message there instead
        // of starting a new turn. opencode's question tool will resolve,
        // the agent loop resumes, and the next user message becomes a
        // fresh turn. Note: this slightly conflates "answer to pending
        // question" with "free-text message" — but that mirrors how
        // qwen/Claude handle AskUserQuestion answers (the next chat
        // message IS the answer). If the user wants to abandon the
        // question and start something else, they should hit Stop first.
        if (pendingQuestion) {
          void sendTuiAnswer(message);
          // Don't kick off a new turn. The agent loop is already running
          // server-side; it'll receive the answer and continue.
          return;
        }

        // Synthetic clientId from channelMgr.dispatchToFilename — voice
        // dispatched this turn. The eventual `assistant` broadcast will
        // be tagged with viaVoice:true so voice's ambient gate plays it.
        const turnSource: QueuedMsg["source"] = clientId === "voice-dispatch" ? "voice" : "user";

        if (busy) { enqueueMessage(message, turnSource, msg.attachmentFilename); return; }
        processMessage(message, turnSource, msg.attachmentFilename);
      },

      onDestroy() {
        reactive.destroy();
        if (sseAbort) {
          try { sseAbort.abort(); } catch { /* ignore */ }
        }
        if (tuiAbort) {
          try { tuiAbort.abort(); } catch { /* ignore */ }
        }
        // Drop this session's project mapping so the per-session map in
        // registry.ts doesn't accumulate entries for destroyed cards. The
        // opencode session itself stays on disk (reload via sidecar
        // re-registers), so this is just for the in-memory map.
        if (ocSessionId) unregisterOpencodeSession(ocSessionId);
        // Best-effort: abort any in-flight prompt. The session itself stays
        // on the opencode server (so reload reuses it via sidecar); we only
        // tear down OUR subscription + active turn.
        if (ocSessionId) {
          (async () => {
            try {
              const { client } = await getOpencodeServer(sessionTenant, sessionProject || undefined);
              await client.session.abort({ path: { id: ocSessionId! } });
            } catch { /* already gone */ }
          })();
        }
      },
    };
  };
}

/** Ask opencode whether it has a usable provider — i.e. one with at least
 *  one model that the prompt call can route to. Covers both:
 *    - Cloud providers authenticated via auth.json (Anthropic / OpenAI / OpenRouter)
 *    - Self-hosted providers configured via opencode.jsonc (e.g. llama-server
 *      pointing at localhost:8012)
 *  The earlier auth.json-only check missed the second case. config/providers
 *  is opencode's authoritative answer to "which providers can route a prompt
 *  right now," so we defer to it instead of pattern-matching on disk state. */
async function hasUsableProvider(tenant?: string, project?: string): Promise<boolean> {
  try {
    const { client } = await getOpencodeServer(tenant, project);
    const res = await client.config.providers();
    const providers = res.data?.providers ?? [];
    return providers.some((p) => p.models && Object.keys(p.models).length > 0);
  } catch (err) {
    console.warn(`[opencode-agent] provider list check failed: ${(err as Error).message}`);
    // Don't block the turn on a check failure — let session.prompt try and
    // surface whatever real error opencode returns.
    return true;
  }
}
