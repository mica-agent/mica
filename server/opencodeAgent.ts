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
  micaDir,
  listCanvasFiles,
  readProjectFile,
  readCanvasConfig,
  BINARY_EXTS,
  isLikelyBinary,
  CONTEXT_SOFT_CAP_CHARS,
  getCardClassMeta,
  readChatCursor,
  writeChatCursor,
  DEFAULT_CANVAS_ROOT,
} from "./files.js";
import type { ChannelHandler, SessionContext } from "./channelManager.js";
import type { FileWatcher } from "./fileWatcher.js";
import { markAgentWrite } from "./writeSource.js";
import { loadProjectSubagents } from "./subagents.js";
import { getPendingValidatorErrors } from "./validatorErrorBuffer.js";
import { flushProjectPendingErrors } from "./cardErrorBuffer.js";
import { markProjectActivity } from "./projectActivity.js";
import { setLastActiveOpencodeProject } from "./agentTools/registry.js";
import { buildAgentToolsPrelude } from "./agentTools/promptPrelude.js";
import { writeSnapshot } from "./turnSnapshots.js";
import { getOpencodeServer } from "./opencodeServer.js";
import type { Event, Part } from "@opencode-ai/sdk";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  agent?: string;
  turn_id?: string;
}

const MAX_HISTORY = 50;
// opencode is provider-agnostic; the model picked at session time defines the
// real context window. 200K is a generous default that fits Claude 3.5 Sonnet
// (the most common opencode default) and OpenAI o1; the gauge will be
// approximate for other models.
const OPENCODE_CTX_WINDOW = 200_000;
// No per-turn timeout. Earlier versions had a soft timeout that gave up
// after N minutes, fetched whatever was in the session, and surfaced a
// "Mica stopped waiting" note — but the agent loop kept running on
// opencode's side and any subsequent events went nowhere. That's worse
// than just waiting: the user couldn't see the eventual answer.
//
// Architecture now: we wait for `session.idle` indefinitely (or
// `session.error`), or for a user-initiated interrupt via the Stop
// button. Same as how the .chat / .claude cards behave. If the model
// genuinely hangs the user can hit Stop. opencode's persistent session
// also means a backend restart preserves the conversation: on reload,
// the chat card reattaches to the same opencode session and any
// pending events flow through normally.

export function setActiveProject(_project: string | null) { void _project; }

function getProjectDir(project: string | null) {
  return project ? join(WORKSPACE_DIR, project) : WORKSPACE_DIR;
}
function getMicaDir(project: string | null) { return micaDir(project || undefined); }

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

export async function buildContext(agentFilename: string, project: string | null, since?: number): Promise<string> {
  const parts: string[] = [];

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
    const pendingErrors = getPendingValidatorErrors(project);
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
- ALL cards you create (.chat, .todo, .terminal, .mmd, .md, etc.) MUST go in \`${canvasRoot}/\`.
- ALL planning files (specs, decisions, notes) MUST go in \`${canvasRoot}/\`.
- NEVER write files to \`.mica/\` — that directory is Mica-managed metadata.

## DANGER: You Run Inside The Mica Container
You execute shell commands inside the same container that runs Mica itself. These processes belong to Mica and must NOT be touched:
- **Port 5173** — Mica's frontend (vite). NEVER kill this.
- **Port 3002** — Mica's backend API. NEVER kill this.
- **Ports 8012, 8013** — vLLM inference. NEVER kill these.
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
    if (sub && desc) return `subagent: ${sub} (${desc})`;
    if (sub) return `subagent: ${sub}`;
    if (desc) return `subagent: ${desc}`;
    return "subagent dispatch";
  }
  if (n === "webfetch" || n === "fetch") {
    const url = String(input.url || input.link || "");
    return url ? `web_fetch: ${url.slice(0, 100)}` : "web_fetch";
  }
  if (n === "websearch") {
    const q = String(input.query || input.q || "");
    return q ? `web_search: ${q.slice(0, 80)}` : "web_search";
  }
  if (n === "skill") {
    // opencode's skill tool surfaces the skill name in `name` (per its
    // docstring); be tolerant to alternative key names.
    const skill = String(input.name || input.skill || input.skill_name || "");
    return skill ? `skill: ${skill}` : "skill";
  }
  if (n === "todowrite") {
    // input shape: { todos: Todo[] }. Show count instead of dumping JSON.
    const todos = Array.isArray((input as { todos?: unknown }).todos)
      ? (input.todos as unknown[]).length
      : 0;
    return todos > 0 ? `todos: ${todos} item${todos === 1 ? "" : "s"}` : "todowrite";
  }
  if (n === "applypatch") {
    return `Patch ${fileName || "file"}`;
  }
  if (!isMcp) {
    if (n.includes("bash") || n.includes("shell")) {
      const firstLine = cmd.split("\n")[0].slice(0, 120);
      return firstLine ? `$ ${firstLine}` : "Running command";
    }
    if (n === "read") return `Read ${fileName || "file"}`;
    if (n === "write") return `Write ${fileName || "file"}`;
    if (n === "edit") return `Edit ${fileName || "file"}`;
    if (n === "glob" || n === "grep") {
      const p = String(input.pattern || input.query || "");
      return p ? `Search: ${p.slice(0, 60)}` : "Searching files";
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

export function createOpencodeAgentHandler(_fileWatcher: FileWatcher) {
  void _fileWatcher;  // file-watcher coalescing not yet wired — see top-of-file note

  return async function opencodeHandlerFactory(
    _content: string,
    _args: Record<string, unknown>,
    ctx: SessionContext,
  ): Promise<ChannelHandler> {
    const sessionProject = ctx.project;
    const chatId = ctx.sessionId;

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
    let peakInputTokens = 0;
    // Card-side error captured from session.error events; surfaced as the
    // assistant reply if non-empty when the turn ends.
    let sessionErrorMsg = "";

    let busy = false;
    interface QueuedMsg { text: string; source: "user" | "voice" | "file-changes" }
    let queue: QueuedMsg[] = [];
    // Tracks the in-flight prompt so onData (interrupt) can abort it. Same
    // pattern as activeAbort in claudeAgent.ts.
    let activePromptAbort: AbortController | null = null;

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

    async function ensureOpencodeSession(): Promise<string> {
      if (ocSessionId) return ocSessionId;
      const sidecar = await loadSidecar(chatId, sessionProject);
      const { client } = await getOpencodeServer();
      if (sidecar) {
        // Validate that the opencode server still has this session (it
        // would NOT after a backend restart since opencode runs in this
        // backend's process). If gone, fall through to fresh-create.
        try {
          const got = await client.session.get({ path: { id: sidecar.sessionID } });
          if (got && (got.data || got.error === undefined)) {
            ocSessionId = sidecar.sessionID;
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
      await saveSidecar(chatId, sessionProject, { sessionID: newId });
      console.log(`[opencode-agent] created session ${newId.slice(0, 8)} for ${ctx.filename}`);
      return newId;
    }

    // ── SSE event loop ──────────────────────────────────────────
    async function startEventLoop(): Promise<void> {
      if (sseStarted) return;
      sseStarted = true;
      sseAbort = new AbortController();
      const { client } = await getOpencodeServer();

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
          const { client } = await getOpencodeServer();
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
        const { client } = await getOpencodeServer();
        // Body shape: { id, sessionID, answers: string[] }. The id + sessionID
        // route opencode's response back to the queued question tool call.
        await client.tui.control.response({
          body: { id: q.id, sessionID: q.sessionID, answers: [answerText] },
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
      const now = Date.now();
      if (now - lastEventTypeLog > 5000) {
        lastEventTypeLog = now;
        console.log(`[opencode-agent] event counts so far: ${JSON.stringify(eventTypeCounts)}`);
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
          // Dedupe by callID: opencode re-emits message.part.updated multiple
          // times for the same tool as state transitions and metadata fill in.
          // Once we've broadcast progress for a callID, ignore further updates
          // until completion/error (we don't currently broadcast on those).
          if (tp.state.status === "running" && !broadcastedToolCalls.has(tp.callID)) {
            broadcastedToolCalls.add(tp.callID);
            const tool = tp.tool;
            turnToolCalls[tool] = (turnToolCalls[tool] || 0) + 1;
            console.log(`[opencode-agent] progress: ${tool} (${describeOpencodeTool(tool, tp.state.input || {}).slice(0, 80)})`);
            ctx.broadcast({
              type: "progress",
              tool,
              description: describeOpencodeTool(tool, tp.state.input || {}),
            });
            // Mark file writes for the canvas glow + ignore-self file-watcher.
            // opencode write tools: write, edit, apply_patch.
            const lower = tool.toLowerCase();
            if (lower === "write" || lower === "edit" || lower === "apply_patch") {
              const fp = String((tp.state.input as Record<string, unknown>)?.file_path || (tp.state.input as Record<string, unknown>)?.filePath || "");
              if (fp) {
                const projRoot = sessionProject ? join(WORKSPACE_DIR, sessionProject) : "";
                const rel = projRoot && fp.startsWith(projRoot + "/") ? fp.slice(projRoot.length + 1) : fp;
                markAgentWrite(rel);
              }
            }
          }
        } else if (part.type === "step-finish") {
          const sf = part as Extract<Part, { type: "step-finish" }>;
          if (sf.tokens?.input && sf.tokens.input > peakInputTokens) {
            peakInputTokens = sf.tokens.input;
          }
        }
      } else if (t === "todo.updated") {
        // opencode's todowrite tool publishes the full todo list on each
        // change. Surface it as a `progress` event so the chat card shows
        // the current in-progress task — same surface the .chat / .claude
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
        // Auto-approve all permission requests (yolo) — matches the .chat
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
        const props = ev.properties as { error?: { name?: string; data?: unknown; message?: string } };
        const e = props.error;
        const msg = e ? (e.message || e.name || JSON.stringify(e.data ?? "")) : "session error (no detail)";
        sessionErrorMsg = String(msg).slice(0, 1000);
        console.warn(`[opencode-agent] session.error: ${sessionErrorMsg.slice(0, 200)}`);
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
      const { client } = await getOpencodeServer();
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

    async function processMessage(message: string, source: QueuedMsg["source"] = "user"): Promise<void> {
      if (busy) { queue.push({ text: message, source }); return; }
      const turnSource = source;
      busy = true;
      markProjectActivity(sessionProject, +1);
      // Publish this session's project as the last-active opencode project.
      // The mica-builtins MCP bridge runs once per opencode-serve and can't
      // pass session-scoped headers; Mica's /api/tools/* endpoints fall back
      // to this when X-Mica-Project is absent. See server/agentTools/registry.ts.
      setLastActiveOpencodeProject(sessionProject);

      // Reset per-turn collectors
      Object.keys(turnToolCalls).forEach((k) => delete turnToolCalls[k]);
      broadcastedToolCalls.clear();
      peakInputTokens = 0;
      sessionErrorMsg = "";

      const turnId = randomUUID();
      const tsStart = Date.now();
      let firstTokenTs: number | null = null;
      void firstTokenTs;  // not yet measured per-event; reserved

      ctx.broadcast({ type: "user", content: message });

      const history = await loadHistory(chatId, sessionProject);
      history.push({ role: "user", content: message });
      await saveHistory(chatId, history, sessionProject);

      ctx.broadcast({ type: "thinking" });

      try {
        const since = getLastTurnAt(ctx.filename);

        if (sessionProject) {
          const incoming = getPendingValidatorErrors(sessionProject);
          if (incoming.length > 0) {
            const files = Array.from(new Set(incoming.map((e) => e.filename)));
            const desc = incoming.length === 1
              ? `Received error from ${files[0]}`
              : `Received ${incoming.length} errors from ${files.length === 1 ? files[0] : `${files.length} files`}`;
            ctx.broadcast({ type: "progress", tool: "validator-errors", description: desc });
          }
        }

        const context = await buildContext(ctx.filename, sessionProject, since);
        void writeSnapshot(sessionProject, chatId, turnId, context);

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
        if (!(await hasUsableProvider())) {
          throw new Error(
            "OpenCode has no usable provider — either run `opencode providers login` " +
            "to add a cloud credential (Anthropic / OpenAI / OpenRouter / Claude Pro), " +
            "or configure a local provider in ~/.config/opencode/opencode.jsonc " +
            "(e.g. llama-server pointing at localhost:8012).",
          );
        }

        const idlePromise = new Promise<void>((resolve) => { idleResolver = resolve; });

        const { client } = await getOpencodeServer();
        // Per-prompt abort — flipped only by user-initiated interrupt.
        const promptAbort = new AbortController();
        activePromptAbort = promptAbort;

        // Use promptAsync (fire-and-return) instead of prompt (which streams
        // its body until session.idle and hangs the SDK fetch's await chain).
        // After the POST returns, we watch SSE for session.idle / session.error
        // and then fetch the final session messages to assemble the assistant
        // text. This is the canonical opencode flow per
        // https://opencode.ai/docs/integration: post → watch → fetch.
        const sendResult = await client.session.promptAsync({
          path: { id: sid },
          body: {
            parts: [{ type: "text", text: message }],
            system: context,
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
        let assistantTokens: { input?: number } | undefined;
        for (let i = allMessages.length - 1; i >= 0; i--) {
          const msg = allMessages[i];
          if (msg.info.role === "assistant") {
            for (const p of msg.parts) {
              if (p.type === "text" && (p as { synthetic?: boolean }).synthetic !== true) {
                resultText += (p as { text: string }).text;
              }
            }
            assistantTokens = (msg.info as { tokens?: { input?: number } }).tokens;
            break;
          }
        }

        // Token peak — prefer SSE step-finish observation; fall back to the
        // assistant message's own usage block.
        let inputTokens = peakInputTokens;
        if (inputTokens === 0 && assistantTokens?.input) {
          inputTokens = assistantTokens.input;
        }

        if (sessionErrorMsg && !resultText.trim()) {
          resultText = `[opencode error] ${sessionErrorMsg}`;
        }

        const filesChanged = !!turnToolCalls["write"] || !!turnToolCalls["edit"] || !!turnToolCalls["apply_patch"];
        if (!resultText.trim()) resultText = filesChanged ? "Done — I made changes." : "Done.";

        // Arc-complete cursor advance, mirrors claudeAgent.
        const ARC_COMPLETE_RE = /<thread-state>\s*arc-complete\s*<\/thread-state>/i;
        const arcComplete = ARC_COMPLETE_RE.test(resultText);
        if (arcComplete) resultText = resultText.replace(ARC_COMPLETE_RE, "").trim();

        const capacity = inputTokens / OPENCODE_CTX_WINDOW;
        const cursor = await readChatCursor(chatId, sessionProject);
        let cursorAdvanced = false;
        let newCursor = cursor;

        const updated = await loadHistory(chatId, sessionProject);
        updated.push({ role: "assistant", content: resultText, agent: "OpenCode", turn_id: turnId });
        await saveHistory(chatId, updated, sessionProject);

        if (arcComplete && capacity > 0.80) {
          newCursor = updated.length;
          await writeChatCursor(chatId, sessionProject, newCursor, updated.length);
          cursorAdvanced = true;
        }

        const tsEnd = Date.now();
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
          contextWindow: OPENCODE_CTX_WINDOW,
          baselineTokens: inputTokens,
          inputTokens,
          arcComplete,
          capacity,
          cursor: newCursor,
          cursorAdvanced,
          durationMs: tsEnd - tsStart,
          turn_id: turnId,
        });
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
        if (queue.length > 0) {
          const next = queue.shift()!;
          setImmediate(() => processMessage(next.text, next.source));
        }
      }
    }

    // ── Channel lifecycle ───────────────────────────────────────

    let initialScanDone = false;

    return {
      onAttach(clientId, _args) {
        Promise.all([
          loadHistory(chatId, sessionProject),
          readChatCursor(chatId, sessionProject),
        ]).then(([messages, cursor]) => {
          ctx.sendTo(clientId, { type: "history", messages, cursor });
          for (const event of currentTurnEvents) ctx.sendTo(clientId, event);

          if (!initialScanDone && messages.length === 0) {
            initialScanDone = true;
            const scanMessage = "This is a new project session. Read your behavior instructions (from your card back) and execute the 'On Project Open' actions. Scan the project files, set up context, and report what you found.";
            setTimeout(() => {
              if (!busy) processMessage(scanMessage, "user");
              else queue.push({ text: scanMessage, source: "user" });
            }, 2000);
          }
        });
      },

      onData(clientId, data) {
        const msg = data as { type?: string; message?: string };

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
                const { client } = await getOpencodeServer();
                await client.session.abort({ path: { id: ocSessionId! } });
              } catch (err) {
                console.warn(`[opencode-agent] abort failed: ${(err as Error).message}`);
              }
            })();
          }
          if (queue.length > 0) {
            console.log(`[opencode-agent] interrupt: dropping ${queue.length} queued message(s)`);
            queue.length = 0;
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

        if (busy) { queue.push({ text: message, source: turnSource }); return; }
        processMessage(message, turnSource);
      },

      onDestroy() {
        if (sseAbort) {
          try { sseAbort.abort(); } catch { /* ignore */ }
        }
        if (tuiAbort) {
          try { tuiAbort.abort(); } catch { /* ignore */ }
        }
        // Best-effort: abort any in-flight prompt. The session itself stays
        // on the opencode server (so reload reuses it via sidecar); we only
        // tear down OUR subscription + active turn.
        if (ocSessionId) {
          (async () => {
            try {
              const { client } = await getOpencodeServer();
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
async function hasUsableProvider(): Promise<boolean> {
  try {
    const { client } = await getOpencodeServer();
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
