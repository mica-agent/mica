// micaAgent.ts -- Qwen Code agent channel handler.
// Uses @qwen-code/sdk to provide an agentic coding assistant.
// Registered as a ChannelManager handler for .chat files.

import { readFile, writeFile, mkdir, readdir } from "fs/promises";
import { join } from "path";
import { WORKSPACE_DIR, micaDir, listCanvasFiles, readProjectFile, readCardSettings, readOpenRouterKey, readCanvasConfig, BINARY_EXTS, isLikelyBinary, CONTEXT_SOFT_CAP_CHARS } from "./files.js";
import { loadValidator, extensionFromWriteInput, contentFromWriteInput, pathFromWriteInput, pathFromReadInput, checkCardClassPrecondition, checkCardClassMetadataConsistency } from "./cardValidators.js";
import type { ChannelHandler, SessionContext } from "./channelManager.js";
import type { FileWatcher } from "./fileWatcher.js";
import { markAgentWrite } from "./writeSource.js";
import {
  loadProjectSubagents,
  configureConcurrency,
  canStartSubagentTask,
  beginSubagentTask,
  endSubagentTask,
  getConcurrencyStatus,
} from "./subagents.js";

// Tool names (normalized to lowercase) that mutate a file and therefore should
// tag the write as agent-originated. Covers the Qwen/OpenRouter dialect
// (snake_case: write_file, edit, patch_file, ...) and the Claude Code SDK
// dialect (PascalCase: Write, Edit, MultiEdit, NotebookEdit). Anything else
// with a `file_path` input is assumed read-only.
const WRITE_TOOL_NAMES = new Set([
  "write", "edit", "multiedit", "notebookedit",
  "write_file", "write_to_file", "edit_file", "create_file",
  "patch_file", "patch", "str_replace", "str_replace_editor",
]);

// Project tracking moved per-session: each handler captures ctx.project at
// creation. setActiveProject is preserved as a no-op for compatibility with
// the project-open endpoint, but no longer drives this module.
export function setActiveProject(_project: string | null) { void _project; }
function getProjectDir(project: string | null) {
  return project ? join(WORKSPACE_DIR, project) : WORKSPACE_DIR;
}
function getMicaDir(project: string | null) { return micaDir(project || undefined); }

const LLAMA_URL = process.env.LLAMA_URL || "http://127.0.0.1:8012";
// Context window the local llama-server is configured for. Mirrors CTX_SIZE in
// llamaServer.ts. Passed to the chat card so it can render a live context-usage
// footer — OpenRouter cards get the per-model value from SDK result.modelUsage
// when present, falling back to this constant otherwise.
const LOCAL_CTX_WINDOW = parseInt(process.env.LLAMA_CTX_SIZE || "65536", 10);
const MAX_HISTORY = 50;

// Patterns that would disrupt Mica itself. Block these before the shell runs them.
const DANGEROUS_BASH_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: /\bpkill\b.*\bvite\b/i, reason: "pkill vite would kill Mica's own frontend dev server" },
  { re: /\bpkill\b.*\btsx\b/i, reason: "pkill tsx would kill Mica's own backend server" },
  { re: /\bpkill\b.*\bvllm\b/i, reason: "pkill vllm would kill Mica's LLM inference server" },
  { re: /\bpkill\b.*\bnode\b/i, reason: "pkill node would kill Mica's own processes" },
  { re: /\bkillall\b.*\b(vite|tsx|vllm|node)\b/i, reason: "killall would kill Mica's processes" },
  { re: /\bkill\s+(-\w+\s+)?-?(5173|3002|8012|8013)\b/, reason: "Never kill Mica's ports (5173/3002/8012/8013)" },
  { re: /\bfuser\s.*\b(5173|3002|8012|8013)/, reason: "fuser would kill Mica's ports" },
  { re: /\brm\s+-rf\s+\/workspaces\/mica\b/, reason: "Refusing to delete the Mica install" },
  { re: /\brm\s+-rf\s+\/\s*(?:$|[^\w])/, reason: "Refusing rm -rf / (destructive)" },
];

/**
 * Detects `cmd &` (background) without stdout/stderr redirect. Such a process
 * inherits the tool-call shell's stdio; when the shell exits, the process
 * loses its streams and dies (broken pipe / SIGHUP). Agents hit this when
 * launching long-lived services like `python -m http.server &`. Force them
 * to redirect or use is_background.
 */
function isBackgroundWithoutRedirect(cmd: string): boolean {
  const trimmed = cmd.trim();
  // End of command ends with a lone `&` (the last char) — not `&&` (logical AND).
  // (?<!&) lookbehind prevents matching the second `&` of `&&`.
  if (!/(?<!&)&\s*$/.test(trimmed)) return false;
  // Any stdout/stderr redirect anywhere in the command is good enough — conservative.
  if (/>\s*\S|>&|&>/.test(trimmed)) return false;
  // Wrappers that detach stdio cleanly.
  if (/\b(nohup|setsid|disown)\b/.test(trimmed)) return false;
  return true;
}

/**
 * Guards the agent's tool use. Blocks Bash commands that would kill Mica itself.
 * Everything else is auto-approved (yolo behavior preserved).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function guardTool(toolName: string, input: Record<string, unknown>): Promise<any> {
  if (toolName === "Bash" || toolName === "bash" || toolName === "run_shell_command") {
    const cmd = String(input.command || input.cmd || "");
    for (const { re, reason } of DANGEROUS_BASH_PATTERNS) {
      if (re.test(cmd)) {
        console.warn(`[mica-agent] BLOCKED shell command: "${cmd.slice(0, 120)}" — ${reason}`);
        return {
          behavior: "deny" as const,
          message: `Refused: ${reason}. Command: ${cmd.slice(0, 120)}`,
        };
      }
    }
    if (isBackgroundWithoutRedirect(cmd)) {
      console.warn(`[mica-agent] BLOCKED background-without-redirect: "${cmd.slice(0, 120)}"`);
      return {
        behavior: "deny" as const,
        message:
          "Backgrounded command (ends in `&`) has no stdout/stderr redirect. When this tool call returns, the shell exits and the process dies (SIGHUP / broken pipe). Pick one:\n" +
          "  1. Redirect both streams to a file:\n" +
          "     python -m http.server > /tmp/server.log 2>&1 &\n" +
          "  2. Use nohup + redirect:\n" +
          "     nohup python -m http.server > /tmp/server.log 2>&1 &\n" +
          "  3. Best for long-running services: set `is_background: true` on the run_shell_command tool and DROP the trailing `&` — the SDK manages the process lifecycle, stdio, and cleanup.",
      };
    }
  }
  return { behavior: "allow" as const, updatedInput: input };
}

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  agent?: string;
}

// Lazy-load the SDK
let _query: ((config: unknown) => AsyncIterable<unknown>) | null = null;
async function getQuery() {
  if (!_query) {
    try {
      const mod = await import("@qwen-code/sdk");
      _query = (mod as { query: typeof _query }).query;
    } catch (err) {
      console.error("[mica-agent] Failed to load @qwen-code/sdk:", (err as Error).message);
      throw new Error("@qwen-code/sdk not available");
    }
  }
  return _query!;
}

// -- History persistence --

async function loadHistory(chatId: string, project: string | null): Promise<ChatMessage[]> {
  try {
    const raw = await readFile(join(getMicaDir(project), "chats", `${chatId}.json`), "utf-8");
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

async function saveHistory(chatId: string, messages: ChatMessage[], project: string | null): Promise<void> {
  const dir = join(getMicaDir(project), "chats");
  await mkdir(dir, { recursive: true });
  const trimmed = messages.length > MAX_HISTORY ? messages.slice(-MAX_HISTORY) : messages;
  await writeFile(join(dir, `${chatId}.json`), JSON.stringify(trimmed, null, 2), "utf-8");
}

// -- Context builder --

/** Timestamp (ms) of the end of each chat card's last agent turn.
 *  Keyed by the chat card's filename. Used to compute "since your last turn"
 *  file diffs for the participate-fully skill. */
const lastTurnAt = new Map<string, number>();
export function recordTurnEnd(chatFilename: string): void {
  lastTurnAt.set(chatFilename, Date.now());
}
export function getLastTurnAt(chatFilename: string): number | undefined {
  return lastTurnAt.get(chatFilename);
}

export async function buildContext(agentFilename: string, project: string | null, since?: number): Promise<string> {
  const parts: string[] = [];

  // 0. Since your last turn — file changes between turns. Skipped on first turn.
  // Scoped to canvas + pinned files: mirrors the file-watcher's scope, and
  // keeps the prompt from ballooning past the CLI's E2BIG arg limit when the
  // user has large unrelated trees in the project (e.g. extracted SDKs).
  if (since) {
    try {
      const allFiles = await listCanvasFiles(project || undefined);
      const changed = allFiles
        .filter((f) => {
          const m = f.modifiedAt ? new Date(f.modifiedAt).getTime() : 0;
          return m > since && f.name !== agentFilename;  // ignore the chat card's own marker
        })
        .sort((a, b) => {
          const ma = a.modifiedAt ? new Date(a.modifiedAt).getTime() : 0;
          const mb = b.modifiedAt ? new Date(b.modifiedAt).getTime() : 0;
          return mb - ma;
        });
      if (changed.length > 0) {
        const cap = 20;
        const shown = changed.slice(0, cap);
        const lines = shown.map((f) => `- \`${f.name}\` (modified)`);
        const more = changed.length > cap ? `\n- ... and ${changed.length - cap} more` : "";
        parts.push(
          `## Since your last turn\n\nThe following files were modified between your previous response and now:\n\n${lines.join("\n")}${more}\n\n` +
          `Read the \`participate-fully\` skill before composing your reply. Decide whether to acknowledge, reconcile, update related docs, or invoke tools.`,
        );
      }
    } catch { /* ignore */ }
  }

  // 1. Instance-level AI context (per-card behavior instructions)
  try {
    // Sanitize filename: replace / with _ so files in subdirectories work
    const contextKey = agentFilename.replace(/\//g, "_");
    const instanceContext = await readFile(join(getMicaDir(project), "cards", contextKey + ".context.md"), "utf-8");
    if (instanceContext.trim()) parts.push(`## Your Behavior Instructions\n${instanceContext.trim()}`);
  } catch { /* no instance context */ }

  // 2. Class-level AI context (shared across all cards of this type)
  try {
    const ext = agentFilename.split(".").pop() || "";
    const CARD_CLASSES_DIR = join(process.cwd(), "card-classes");
    // Check project-scoped first, then built-in
    let classContext = "";
    try {
      classContext = await readFile(join(getMicaDir(project), "card-classes", ext, "context.md"), "utf-8");
    } catch {
      try {
        classContext = await readFile(join(CARD_CLASSES_DIR, ext, "context.md"), "utf-8");
      } catch { /* no class context */ }
    }
    if (classContext.trim()) parts.push(`## Card Class Context\n${classContext.trim()}`);
  } catch { /* ignore */ }

  // 3. Project-level AI context (canvas back)
  try {
    const canvasBack = await readFile(join(getMicaDir(project), "canvas-back.md"), "utf-8");
    if (canvasBack.trim()) parts.push(`## Project Context\n${canvasBack.trim()}`);
  } catch { /* no canvas-back */ }

  // Project files — list all, read text content for context.
  // Custom card-class instances (e.g. `.sheet`, `.solar`, `.kanban`, `.stopwatch`)
  // are almost always text (JSON, YAML, TOML), so we don't gate on a hardcoded
  // text-extension allowlist — instead we attempt a UTF-8 read and fall back
  // to "<binary, N bytes>" if the file isn't decodable cleanly. Hardcoded BINARY_EXTS
  // for the common known-binary cases (images, archives, executables) avoid wasting
  // a read attempt.
  // Project files — full content of every canvas-visible text file goes in.
  // No truncation, no per-file cap, no file-count cap: the canvas IS the
  // agent's direction. If the prompt gets too big, we flag it (see the size
  // check below) but still send — the expectation is that the user splits
  // oversized cards (divide-and-conquer), not that we silently clip.
  try {
    const files = await listCanvasFiles(project || undefined);
    if (files.length > 0) {
      parts.push(`## Project Files`);
      for (const f of files) {
        const ext = f.name.substring(f.name.lastIndexOf(".")).toLowerCase();
        if (BINARY_EXTS.has(ext)) {
          parts.push(`### ${f.name} (${f.size} bytes, binary)`);
          continue;
        }
        try {
          const file = await readProjectFile(f.name, project || undefined);
          if (isLikelyBinary(f.name, file.content)) {
            parts.push(`### ${f.name} (${f.size} bytes, binary)`);
          } else {
            parts.push(`### ${f.name}\n${file.content}`);
          }
        } catch { parts.push(`### ${f.name} (${f.size} bytes, unreadable)`); }
      }
    }
  } catch { /* ignore */ }

  // Project structure guidance
  let canvasRoot = "docs";
  try {
    const cfg = JSON.parse(await readFile(join(getMicaDir(project), "config.json"), "utf-8"));
    canvasRoot = cfg.canvasRoot || cfg.docsDir || "docs";
  } catch { /* use default */ }

  parts.push(`## File Locations
- The canvas directory is \`${canvasRoot}/\` — this is where everything visible on the canvas lives
- ALL cards you create (.chat, .todo, .terminal, .mmd, .md, etc.) MUST go in \`${canvasRoot}/\`
- ALL planning files (specs, decisions, notes) MUST go in \`${canvasRoot}/\`
- Files OUTSIDE \`${canvasRoot}/\` are not on the canvas by default — the user can pin them via the filebrowser if they want them visible
- NEVER write files to .mica/ — that directory is managed by Mica internally
- The .mica/ directory contains metadata only (layout, config, AI context). Do not read or write it directly.

## DANGER: You Run Inside The Mica Container
You execute shell commands inside the same container that runs Mica itself. These processes belong to Mica and must NOT be touched:
- **Port 5173** — Mica's frontend (vite dev server). NEVER \`pkill vite\` or kill this port.
- **Port 3002** — Mica's backend API. NEVER kill this.
- **Port 8012, 8013** — vLLM inference servers. NEVER kill these.
- Any process matching \`vite\`, \`tsx server/index.ts\`, \`vllm\`, \`npm run dev\`, or under \`/workspaces/mica/\` is Mica. Leave it alone.

If you need to test a web app the user is building, launch it on a DIFFERENT port (e.g. 9000, 9090) — don't use 5173 or 3002. If a port conflict happens, use a different port rather than killing anything.`);

  // Default behavior (if no agent card back provides instructions)
  parts.push(`## Your Role
You are a team member on this project, not a tool. You collaborate with the human — you don't just execute orders.

IMPORTANT: You MUST follow these rules. Never skip them.

1. **NEVER create files without confirming first.** Before writing ANY code or creating ANY file, describe what you plan to build, what it will and won't support, and ask "Should I go ahead?" Wait for a "yes" before writing.

2. **Flag limitations upfront.** If what the user asks for can't be fully implemented with the available APIs, say so BEFORE building. Example: "Our file API only handles text — a file uploader won't support images or binaries. Want me to build a text-only version, or should we discuss alternatives?"

3. **No incomplete implementations.** Don't build something you know is broken or incomplete. If you can't do it right, say why and ask what the user prefers instead.

4. **Explain trade-offs.** If there are multiple approaches, briefly present options and recommend one with reasoning.

5. **Flag uncertainty.** If you're unsure about something, say so. Don't guess.

6. **Use established libraries.** When building card classes, prefer well-known CDN libraries over hand-coding. Examples: Chart.js for charts, FullCalendar for calendars, Sortable.js for drag-and-drop lists, CodeMirror for code editing, Leaflet for maps. Add them via metadata.json dependencies. Don't reinvent what a library already does well.

## Default Behavior
When reacting to file changes:
- Evaluate what actions should be taken
- Check for @agent tasks in todo files
- Update dependent docs if needed
- Log decisions and actions taken to ${canvasRoot}/decisions.md
- If you have questions, add them to your chat response AND create a todo item assigned to @human

## Skills
This project's skills are bundled by its template and live under \`.qwen/skills/<name>/SKILL.md\`. The Qwen SDK auto-discovers them and surfaces each skill's \`description:\` to you. When a user request matches a skill's trigger words, load that skill (read its SKILL.md) and follow it. If a \`participate-fully\` skill is present, read it at the start of every turn — it tells you how to handle the \`## Since your last turn\` section above.`);

  const assembled = parts.join("\n\n");
  if (assembled.length > CONTEXT_SOFT_CAP_CHARS) {
    console.warn(
      `[mica-agent] OVERSIZED context: ${assembled.length} chars (cap ${CONTEXT_SOFT_CAP_CHARS}). ` +
      `project=${project ?? "-"} chat=${agentFilename}. ` +
      `Consider splitting large canvas cards; prompt still sent as-is.`,
    );
  }
  return assembled;
}

// -- Tool use description --

function describeToolUse(name: string, input: Record<string, unknown>): string {
  if (!input) return name;
  const n = name.toLowerCase().replace(/[_-]/g, "");
  const filePath = String(input.file_path || input.filePath || input.path || input.file || "");
  const fileName = filePath.split("/").pop() || "";
  const cmd = String(input.command || input.cmd || input.script || "");

  // Shell/bash
  if (n.includes("bash") || n.includes("shell") || n === "executecommand" || n === "runcmd") {
    const firstLine = cmd.split("\n")[0].slice(0, 120);
    return firstLine ? `$ ${firstLine}` : `Running command`;
  }
  // File read
  if (n.includes("read") || n === "cat" || n === "viewfile") {
    return `Read ${fileName || "file"}`;
  }
  // File write
  if (n.includes("write") || n.includes("create") || n === "savefile") {
    return `Write ${fileName || "file"}`;
  }
  // File edit
  if (n.includes("edit") || n.includes("patch") || n.includes("replace")) {
    return `Edit ${fileName || "file"}`;
  }
  // Search/grep
  if (n.includes("grep") || n.includes("search") || n.includes("glob") || n.includes("find")) {
    const pattern = String(input.pattern || input.query || input.regex || "");
    return pattern ? `Search: ${pattern.slice(0, 60)}` : `Searching files`;
  }
  // List files
  if (n.includes("list") || n === "ls") {
    return `List ${filePath || "files"}`;
  }
  // Fallback — show tool name + any useful input
  const hint = cmd ? `: ${cmd.split("\n")[0].slice(0, 60)}` : fileName ? `: ${fileName}` : "";
  return `${name}${hint}`;
}

// -- Channel handler factory --

const USER_IDLE_BEFORE_AGENT_MS = 15000; // Wait 15s of quiet before delivering file events to the agent.
// Purpose: don't react to in-progress user edits. Each incoming file-change event
// re-arms the timer, so continuous typing (and short thinking pauses within 15s)
// never fires. Broadcast to other card clients is a separate path and is unaffected —
// multi-screen live typing still works.

export function createAgentHandler(fileWatcher: FileWatcher) {
  // Single file-watcher listener shared across all agent sessions.
  // Maps filename -> session state. Prevents listener leaks from StrictMode.
  const activeSessions = new Map<string, {
    project: string | null;
    busy: boolean;
    agentWrittenFiles: Set<string>;
    coalesceBuffer: Map<string, { type: "created" | "changed" | "deleted"; count: number }>;
    coalesceTimer: ReturnType<typeof setTimeout> | null;
    deliverFn: (() => void) | null;
    canvasRoot: string;        // e.g. "docs" — files outside this (and not pinned) don't trigger reactive turns
    pinnedFiles: Set<string>;  // files explicitly pinned to the canvas regardless of folder
  }>();

  function inCanvasScope(filename: string, canvasRoot: string, pinned: Set<string>): boolean {
    if (pinned.has(filename)) return true;
    if (canvasRoot === "" || canvasRoot === ".") return !filename.includes("/");
    const prefix = canvasRoot.replace(/\/$/, "") + "/";
    return filename.startsWith(prefix);
  }

  fileWatcher.on("file-change", (event: { type: string; filename: string; project: string }) => {
    if (event.filename.startsWith(".")) return;

    for (const [sessionFile, state] of activeSessions) {
      if (state.project && state.project !== event.project) continue; // different project
      if (event.filename === sessionFile) continue; // ignore own chat file
      if (state.busy) continue; // agent is working, skip
      if (!inCanvasScope(event.filename, state.canvasRoot, state.pinnedFiles)) continue;
      if (state.agentWrittenFiles.has(event.filename)) {
        state.agentWrittenFiles.delete(event.filename);
        continue; // agent wrote this file
      }

      const existing = state.coalesceBuffer.get(event.filename);
      const newType = event.type as "created" | "changed" | "deleted";
      if (existing?.type === "created" && newType === "deleted") {
        // Created then deleted within the coalesce window: net nothing.
        state.coalesceBuffer.delete(event.filename);
      } else if (existing?.type === "deleted" && newType === "created") {
        // Deleted then recreated: net effect is a modification.
        state.coalesceBuffer.set(event.filename, { type: "changed", count: existing.count + 1 });
      } else {
        state.coalesceBuffer.set(event.filename, {
          type: newType,
          count: (existing?.count ?? 0) + 1,
        });
      }

      if (state.coalesceTimer) clearTimeout(state.coalesceTimer);
      state.coalesceTimer = setTimeout(() => {
        state.coalesceTimer = null;
        if (state.deliverFn) state.deliverFn();
      }, USER_IDLE_BEFORE_AGENT_MS);
    }
  });

  return async function agentHandlerFactory(
    _content: string,
    _args: Record<string, unknown>,
    ctx: SessionContext
  ): Promise<ChannelHandler> {
    // Capture project at session creation. All file ops in this closure
    // use sessionProject — the user can switch projects without redirecting
    // this session's writes to the wrong .mica/chats directory.
    const sessionProject = ctx.project;
    // Chat history is keyed by the session's stable UUID (the file's per-card
    // sidecar id). Stable across renames; isolated per file even if two
    // projects share the same filename.
    const chatId = ctx.sessionId;
    let busy = false;
    let queue: string[] = [];
    let activeAbort: AbortController | null = null;

    // Read once at session start. If the user reconfigures canvasRoot/pinned
    // mid-session, this stays stale until the session is recreated (acceptable
    // — those are rare config changes).
    const cfg = await readCanvasConfig(sessionProject || undefined);

    // Register this session in the shared state (replaces any previous from StrictMode)
    const sessionState = {
      project: sessionProject,
      busy: false,
      agentWrittenFiles: new Set<string>(),
      coalesceBuffer: new Map<string, { type: "created" | "changed" | "deleted"; count: number }>(),
      coalesceTimer: null as ReturnType<typeof setTimeout> | null,
      deliverFn: null as (() => void) | null,
      canvasRoot: cfg.canvasRoot,
      pinnedFiles: new Set(cfg.pinned),
    };
    activeSessions.set(ctx.filename, sessionState);

    function deliverCoalescedEvents() {
      if (sessionState.coalesceBuffer.size === 0) return;

      const label = { created: "added", changed: "modified", deleted: "deleted" } as const;
      const lines: string[] = [];
      let hasSurvivors = false;
      for (const [filename, entry] of sessionState.coalesceBuffer) {
        const suffix = entry.type !== "deleted" && entry.count > 1
          ? ` (${label[entry.type]}, ${entry.count}x)`
          : ` (${label[entry.type]})`;
        lines.push(`- ${filename}${suffix}`);
        if (entry.type !== "deleted") hasSurvivors = true;
      }
      sessionState.coalesceBuffer.clear();

      const tail = hasSurvivors
        ? "Review the canvas back context and any files that still exist. If any changes require your attention (e.g., @agent tasks in a todo, spec changes to review), respond. Otherwise, acknowledge briefly."
        : "Note the deletions above. If none require action, acknowledge briefly.";

      const message = `[File changes detected] The following files changed:\n${lines.join("\n")}\n\n${tail}`;

      if (busy) {
        queue.push(message);
      } else {
        processMessage(message);
      }
    }

    sessionState.deliverFn = deliverCoalescedEvents;

    async function processMessage(message: string) {
      // Guard against concurrent invocations. If another processMessage is
      // mid-flight, queue this one instead of racing.
      if (busy) {
        console.log(`[mica-agent] processMessage called while busy — queueing: ${message.slice(0, 60)}`);
        queue.push(message);
        return;
      }
      busy = true; sessionState.busy = true;
      console.log(`[mica-agent] processMessage START: ${message.slice(0, 60)}`);

      // Per-turn read tracking. Used by checkCardClassPrecondition to refuse
      // card-class authoring writes until the agent has read the create-card-class
      // skill in this same turn. Reset each processMessage so the requirement
      // is per-turn rather than per-session (skills fall out of context as
      // history scrolls; safer to require a fresh read).
      const readFilesThisTurn = new Set<string>();

      // Per-turn write cap. After this many files are written in a single turn,
      // further write tool calls are denied with a structured hint telling the
      // agent to stop, report, and continue next turn. Hard guard because:
      //   - soft skill guidance ("single-file-edit", "decompose-task") is often
      //     ignored by the local Qwen model on batch codegen asks
      //   - each write_file tool call carries full file content as input,
      //     which accumulates across tool rounds and blows the model's context
      //     window (observed: 30+ writes in one turn → 215K tokens vs 65K cap
      //     → llama-server rejects the request mid-turn)
      //   - user explicitly wants divide-and-conquer: one step, report, then
      //     continue on user cue
      const MAX_WRITES_PER_TURN = 5;
      let writesThisTurn = 0;

      // Send user message to browser
      ctx.broadcast({ type: "user", content: message });

      // Persist
      const history = await loadHistory(chatId, sessionProject);
      history.push({ role: "user", content: message });
      await saveHistory(chatId, history, sessionProject);

      // Show thinking state
      ctx.broadcast({ type: "thinking" });

      try {
        const since = getLastTurnAt(ctx.filename);
        const context = await buildContext(ctx.filename, sessionProject, since);

        // Per-card provider routing. Read fresh each turn so settings changes
        // take effect on the next message without restarting the session.
        const cardSettings = await readCardSettings(sessionProject || undefined, ctx.filename);
        const provider = cardSettings.provider === "openrouter" ? "openrouter" : "local";
        let baseUrl: string;
        let apiKey: string;
        let modelName: string;
        if (provider === "openrouter") {
          const key = await readOpenRouterKey(sessionProject || undefined);
          if (!key) {
            ctx.broadcast({
              type: "error",
              error: "OpenRouter selected but no API key set. Open the gear icon and add a key (saved per-project).",
            });
            return;
          }
          baseUrl = "https://openrouter.ai/api/v1";
          apiKey = key;
          modelName = cardSettings.model || "anthropic/claude-3.5-sonnet";
        } else {
          baseUrl = LLAMA_URL.replace(/\/v1$/, "") + "/v1";
          apiKey = "dummy";
          modelName = cardSettings.model || "openai:local";
        }
        console.log(`[mica-agent] provider=${provider} model=${modelName} baseUrl=${baseUrl}`);

        // Configure per-project subagent concurrency cap based on provider.
        // Local llama-server parallelism is bounded by its -np setting; OpenRouter
        // is bounded to prevent fan-out runaway. Re-run every turn so a config
        // change or provider switch takes effect without restarting.
        if (sessionProject) {
          configureConcurrency(sessionProject, provider);
        }

        // Load subagent definitions from the project (.qwen/agents/*.md) with
        // server/builtin-agents/*.md as fallbacks. Loaded fresh each turn so the
        // user can edit an agent file without restarting Mica.
        const subagents = await loadProjectSubagents(sessionProject, "qwen");
        if (subagents.length > 0) {
          const names = subagents.map((s) => s.name).join(", ");
          console.log(`[mica-agent] subagents: ${names}`);
        }

        // Inject recent chat history into the prompt so the agent has conversational
        // continuity. Without this, each turn is a goldfish — the SDK's `query()`
        // call only sees the current user message. Include up to ~6 prior turn-pairs
        // (12 messages), capped at ~6K chars total so the system prompt + history
        // comfortably fit in ctx=65536. Skip the most recent entry (it's the user
        // message we just pushed above and will send as the actual prompt).
        const priorHistory = history.slice(0, -1);
        const HISTORY_MSG_CAP = 12;
        const HISTORY_CHAR_CAP = 6000;
        const MSG_CHAR_CAP = 1200;
        const recent = priorHistory.slice(-HISTORY_MSG_CAP);
        let historyBlock = "";
        if (recent.length > 0) {
          const lines: string[] = [];
          let charsSoFar = 0;
          // Build in reverse so we keep the MOST recent messages when we hit the cap.
          for (let i = recent.length - 1; i >= 0; i--) {
            const m = recent[i];
            const role = m.role === "user" ? "USER" : "ASSISTANT";
            let c = m.content || "";
            if (c.length > MSG_CHAR_CAP) c = c.slice(0, MSG_CHAR_CAP) + "…[truncated]";
            const line = `${role}: ${c}`;
            if (charsSoFar + line.length > HISTORY_CHAR_CAP) break;
            charsSoFar += line.length + 2;
            lines.unshift(line);
          }
          if (lines.length > 0) {
            historyBlock = `Conversation so far (most recent last):\n\n${lines.join("\n\n")}\n\n---\n\nCurrent message:\n`;
          }
        }
        const promptWithHistory = historyBlock + message;

        // Baseline size of the prompt the SDK will send on the first LLM call
        // of this turn (before any tool-loop accumulation). context includes
        // canvas-back + file previews; historyBlock includes prior chat turns;
        // ~1K tokens for the Qwen preset system prompt; message is the current
        // user turn. Divide by 4 for a rough token estimate. This is the
        // "baseline" number; true usage climbs if the turn runs many tools.
        const baselineChars = context.length + historyBlock.length + message.length + 4000; // ~1K system-prompt tokens ≈ 4K chars
        const baselineTokens = Math.round(baselineChars / 4);

        console.log(`[mica-agent] Query: ${message.slice(0, 100)}... (context: ${context.length} chars, history: ${historyBlock.length} chars, baseline: ~${baselineTokens} tokens)`);

        const queryFn = await getQuery();
        activeAbort = new AbortController();

        // Captures questions that the agent emitted via AskUserQuestion. The SDK's
        // built-in tool tries to render a CLI prompt that has no surface in our
        // programmatic SDK setup, so we intercept here, deny the tool, and append
        // the question text to the agent's chat reply at the end of the turn. The
        // structured form is also broadcast so the chat card can render answer
        // buttons next to the bubble.
        let pendingQuestionText = "";

        async function canUseToolWithQuestionIntercept(toolName: string, input: Record<string, unknown>) {
          const safety = await guardTool(toolName, input);
          if (safety.behavior === "deny") return safety;

          // Track which files the agent has read this turn (for precondition checks).
          if (toolName === "read_file" || toolName === "Read") {
            const p = pathFromReadInput(input);
            if (p) readFilesThisTurn.add(p);
          } else if (toolName === "read_many_files") {
            const paths = (input.paths as string[]) || [];
            for (const p of paths) if (p) readFilesThisTurn.add(p);
          }

          // Subagent concurrency. SDK invokes subagents via the "task" tool;
          // its `input` has { agent: <name>, prompt: <string> }. Bound the
          // number of concurrent subagents per project so a burst of delegation
          // doesn't saturate the model. The semaphore's accounting is best-
          // effort here — we begin on approval and rely on the SDK's event
          // stream (handled below) to fire endSubagentTask when the tool
          // result arrives. If an error breaks that loop, the counter drifts
          // up and future starts are blocked until something clears it — that
          // fails safe rather than fails loud.
          if (toolName === "task" && sessionProject) {
            if (!canStartSubagentTask(sessionProject)) {
              const status = getConcurrencyStatus(sessionProject);
              return {
                behavior: "deny" as const,
                message:
                  `Subagent concurrency cap reached (${status?.active}/${status?.cap} in flight for this project). ` +
                  `Wait for an active subagent to finish, then retry. ` +
                  `Do NOT invoke more tools in the meantime — your next response should be plain text, ` +
                  `either summarizing work-in-progress or waiting briefly before retrying.`,
              };
            }
            beginSubagentTask(sessionProject);
            // No increment/decrement of writesThisTurn for task tool — it's a
            // delegation, not a direct write. Subagent-originated writes run
            // inside the subagent's session (distinct context) and do not
            // re-enter this canUseTool via the parent.
          }

          // Per-extension write_file validators + cross-cutting preconditions.
          // A card class can ship a validate.js that flags malformed content
          // (e.g. mmd files wrapped in markdown fences). Preconditions enforce
          // ordering — e.g. don't write card class code without reading the skill.
          // Also enforces the per-turn write cap here (see MAX_WRITES_PER_TURN
          // comment at turn-state init).
          const WRITE_TOOLS = ["write_file", "write_to_file", "create_file", "edit", "edit_file", "multiedit", "patch", "patch_file", "str_replace", "str_replace_editor", "notebookedit"];
          if (WRITE_TOOLS.includes(toolName.toLowerCase())) {
            if (writesThisTurn >= MAX_WRITES_PER_TURN) {
              return {
                behavior: "deny" as const,
                message:
                  `You have already written to ${writesThisTurn} file${writesThisTurn === 1 ? "" : "s"} ` +
                  `this turn (cap: ${MAX_WRITES_PER_TURN}). STOP now. ` +
                  `Do NOT call any more tools. ` +
                  `Your next response must be plain text: briefly list what you wrote and what remains, ` +
                  `then end the turn. The user will reply with 'continue' or direction, and you'll ` +
                  `pick up the next step on the following turn. This is the divide-and-conquer ` +
                  `protocol — one small coherent step, report, resume next turn.`,
              };
            }

            if (["write_file", "write_to_file", "create_file"].includes(toolName)) {
              const filePath = pathFromWriteInput(input);
              const preReason = checkCardClassPrecondition(filePath, readFilesThisTurn);
              if (preReason) return { behavior: "deny" as const, message: preReason };

              const content = contentFromWriteInput(input);
              if (content !== null) {
                const metaReason = checkCardClassMetadataConsistency(filePath, content);
                if (metaReason) return { behavior: "deny" as const, message: metaReason };
              }

              const ext = extensionFromWriteInput(input);
              if (ext && content !== null) {
                const validator = await loadValidator(sessionProject, ext);
                if (validator) {
                  const reason = await validator(content);
                  if (reason) {
                    return { behavior: "deny" as const, message: reason };
                  }
                }
              }
            }

            // Count only AFTER all validators pass — a denied call didn't actually write.
            writesThisTurn++;
          }

          if (toolName === "AskUserQuestion" || toolName === "ask_user_question") {
            const questions = (input.questions as Array<{
              question: string;
              header?: string;
              options?: Array<{ label: string; description?: string }>;
              multiSelect?: boolean;
            }> | undefined) || [];
            // Broadcast IMMEDIATELY as a standalone `user_question` event. The
            // old path accumulated into `pendingQuestions` and shipped at turn
            // end, but if the agent misread the deny message (common with
            // local Qwen: "The user cancelled the question. Let me just
            // proceed with a different approach.") it kept running tools and
            // the turn-end broadcast never fired — questions never reached
            // the chat card. Immediate broadcast decouples user-visible
            // buttons from the agent's turn-end behavior.
            const normalized = questions.map((q) => ({
              question: q.question,
              options: q.options,
              multiSelect: q.multiSelect,
            }));
            if (normalized.length > 0) {
              ctx.broadcast({ type: "user_question", questions: normalized });
            }
            return {
              behavior: "deny" as const,
              message: "Question was shown to the user. Their next message will be the answer. End your turn now — do not call additional tools.",
            };
          }

          return safety;
        }

        const q = queryFn({
          prompt: promptWithHistory,
          options: {
            cwd: getProjectDir(sessionProject),
            // For local llama-server the model name is informational (server uses
            // the model loaded at startup). The legacy "openai:local" magic string
            // worked because llama-server ignores model. OpenRouter validates strictly,
            // so we send the bare id (e.g. "anthropic/claude-3.5-sonnet"). The
            // openai-compatible provider is selected via authType, not via prefix.
            model: provider === "local" ? `openai:${modelName}` : modelName,
            authType: "openai" as const,
            // "default" + canUseTool gives us auto-approve with guards
            permissionMode: "default" as const,
            canUseTool: canUseToolWithQuestionIntercept,
            abortController: activeAbort,
            systemPrompt: { type: "preset", preset: "qwen_code", append: context },
            // Project-defined subagents. Parent delegates heavy single-component
            // work (e.g. "implement src/email_monitor.py") via the SDK's `task`
            // tool, keeping the parent's context small. See plan:
            // /home/vscode/.claude/plans/joyful-honking-hinton.md
            ...(subagents.length > 0 ? { agents: subagents } : {}),
            env: {
              OPENAI_API_KEY: apiKey,
              OPENAI_BASE_URL: baseUrl,
            },
          },
        }) as AsyncIterable<Record<string, unknown>>;

        let resultText = "";
        let filesChanged = false;
        // Final turn usage from the SDK's `result` event. Shape: { input_tokens, output_tokens, ... }.
        // Forwarded verbatim to the client so the chat card can compute tokens/sec from elapsed time.
        let usage: Record<string, unknown> | null = null;
        let contextWindow: number = provider === "openrouter" ? 0 : LOCAL_CTX_WINDOW;

        // Track in-flight subagent task invocations (tool_use_id → nothing,
        // Set is sufficient). beginSubagentTask was called in canUseTool; we
        // call endSubagentTask when the matching tool_result arrives so the
        // concurrency counter drains naturally. Turn-end cleanup handles any
        // stragglers (SDK error, abort) so the counter never drifts across
        // turns.
        const outstandingSubagentTasks = new Set<string>();

        for await (const evt of q) {
          const evtType = evt.type as string;

          if (evtType === "assistant" && evt.message) {
            const msg = evt.message as { content?: Array<{ type: string; name?: string; text?: string; thinking?: string; input?: Record<string, unknown> }> };
            if (msg.content) {
              for (const block of msg.content) {
                if (block.type === "thinking") {
                  const t = block.thinking || "";
                  console.log(`[mica-agent] THINKING block (${t.length} chars): ${t.slice(0, 120).replace(/\n/g, " ")}...`);
                }
                if (block.type === "tool_use" && block.name) {
                  console.log(`[mica-agent] tool_use: ${block.name} input=${JSON.stringify(block.input || {}).slice(0, 200)}`);
                  ctx.broadcast({
                    type: "progress",
                    tool: block.name,
                    description: describeToolUse(block.name, block.input || {}),
                  });
                  // Track outstanding subagent tasks so the concurrency counter
                  // decrements when they finish. SDK tags each tool_use with an
                  // `id` we'll match against the tool_result.
                  if (block.name === "task") {
                    const taskId = String((block as { id?: unknown }).id || "");
                    if (taskId) outstandingSubagentTasks.add(taskId);
                  }
                  if (WRITE_TOOL_NAMES.has(block.name.toLowerCase())) {
                    filesChanged = true;
                    // Track the file so we ignore the resulting file-changed event,
                    // and mark it so the broadcast carries source: "agent" for the
                    // client-side glow.
                    const writtenPath = String((block.input as Record<string, unknown>)?.file_path || (block.input as Record<string, unknown>)?.filePath || "");
                    if (writtenPath) {
                      const writtenFile = writtenPath.split("/").pop();
                      if (writtenFile) sessionState.agentWrittenFiles.add(writtenFile);
                      const projRoot = sessionProject ? join(WORKSPACE_DIR, sessionProject) : "";
                      const relPath = projRoot && writtenPath.startsWith(projRoot + "/")
                        ? writtenPath.slice(projRoot.length + 1)
                        : writtenFile || writtenPath;
                      markAgentWrite(relPath);
                    }
                  }
                }
              }
              let turnText = "";
              for (const block of msg.content) {
                if (block.type === "text" && block.text) turnText += block.text;
              }
              if (turnText) resultText = turnText;
            }
          }

          // Detect completed subagent tasks. SDK sends tool results back as
          // user messages containing tool_result blocks; each tool_result has
          // a `tool_use_id` pointing to the originating tool_use. When a
          // tracked task's result arrives, drain the concurrency counter.
          if (evtType === "user" && evt.message) {
            const msg = evt.message as { content?: Array<{ type: string; tool_use_id?: string }> };
            if (msg.content) {
              for (const block of msg.content) {
                if (block.type === "tool_result" && block.tool_use_id) {
                  if (outstandingSubagentTasks.delete(block.tool_use_id) && sessionProject) {
                    endSubagentTask(sessionProject);
                  }
                }
              }
            }
          }

          if (evtType === "result") {
            const result = evt.result as { text?: string } | undefined;
            if (result?.text) resultText = result.text;
            // Capture `usage` from whichever shape the SDK surfaces it on: some
            // versions put it on `evt.usage`, others nest it under `evt.result.usage`.
            const evtUsage = (evt as { usage?: unknown }).usage;
            const resultUsage = (evt.result as { usage?: unknown } | undefined)?.usage;
            if (evtUsage && typeof evtUsage === "object") usage = evtUsage as Record<string, unknown>;
            else if (resultUsage && typeof resultUsage === "object") usage = resultUsage as Record<string, unknown>;
            // Prefer per-model context window when the SDK provides it (OpenRouter
            // returns it in modelUsage); fall back to our local llama ctx.
            const modelUsage = (evt as { modelUsage?: Record<string, { contextWindow?: number }> }).modelUsage;
            if (modelUsage) {
              for (const m of Object.values(modelUsage)) {
                if (typeof m?.contextWindow === "number" && m.contextWindow > 0) {
                  contextWindow = m.contextWindow;
                  break;
                }
              }
            }
          }
        }

        activeAbort = null;

        // Drain any outstanding subagent tasks from the concurrency counter.
        // Normal flow decrements per-task as tool_results arrive; this covers
        // the SDK-error / abort path where some tasks never got their result.
        if (sessionProject && outstandingSubagentTasks.size > 0) {
          for (const _id of outstandingSubagentTasks) endSubagentTask(sessionProject);
          outstandingSubagentTasks.clear();
        }

        if (!resultText.trim()) {
          resultText = filesChanged ? "Done -- I made changes." : "Done.";
        }

        // If the agent tried to ask the user via AskUserQuestion, surface those
        // questions in the chat reply so they actually reach the user.
        if (pendingQuestionText) {
          resultText = (resultText.trim() && resultText.trim() !== "Done.") ? `${resultText}\n\n${pendingQuestionText}` : pendingQuestionText;
        }

        console.log(`[mica-agent] broadcasting assistant (success path) for: ${message.slice(0, 60)}`);
        ctx.broadcast({
          type: "assistant",
          content: resultText,
          agent: "Qwen",
          filesChanged,
          ...(usage ? { usage } : {}),
          ...(contextWindow > 0 ? { contextWindow } : {}),
          baselineTokens,
        });

        const updatedHistory = await loadHistory(chatId, sessionProject);
        updatedHistory.push({ role: "assistant", content: resultText, agent: "Qwen" });
        await saveHistory(chatId, updatedHistory, sessionProject);

      } catch (err) {
        activeAbort = null;
        const errMsg = (err as Error).message || String(err);
        // Empty response = model had nothing to say (common for reactive events)
        if (errMsg.includes("empty response")) {
          console.log(`[mica-agent] broadcasting assistant (empty-response path) for: ${message.slice(0, 60)}`);
          ctx.broadcast({ type: "assistant", content: "No action needed.", agent: "Qwen", filesChanged: false });
        } else {
          console.error(`[mica-agent] Error during ${message.slice(0, 40)}:`, errMsg);
          ctx.broadcast({ type: "error", error: errMsg });
        }
      } finally {
        recordTurnEnd(ctx.filename);
        console.log(`[mica-agent] processMessage DONE: ${message.slice(0, 60)} | queue depth: ${queue.length}`);
        // Hand off to next queued message WITHOUT releasing busy outside this
        // synchronous block. setImmediate's callback briefly clears busy then
        // re-enters processMessage atomically (JS event loop is cooperative,
        // so no other handler can squeeze in between the two statements).
        if (queue.length > 0) {
          const next = queue.shift()!;
          setImmediate(() => {
            busy = false; sessionState.busy = false;
            processMessage(next);
          });
        } else {
          busy = false; sessionState.busy = false;
          if (sessionState.coalesceBuffer.size > 0) {
            setImmediate(() => deliverCoalescedEvents());
          }
        }
      }
    }

    // Track if initial scan has been triggered
    let initialScanDone = false;

    return {
      onAttach(clientId, _args) {
        // Send history to newly attached client
        loadHistory(chatId, sessionProject).then((messages) => {
          ctx.sendTo(clientId, { type: "history", messages });

          // On first attach with no history, trigger initial project scan
          if (!initialScanDone && messages.length === 0) {
            initialScanDone = true;
            const scanMessage = "This is a new project session. Read your behavior instructions (from your card back) and execute the 'On Project Open' actions. Scan the project files, set up context, and report what you found.";
            // Delay slightly to let the UI settle
            setTimeout(() => {
              if (!busy) processMessage(scanMessage);
              else queue.push(scanMessage);
            }, 2000);
          }
        });
      },

      onData(clientId, data) {
        const msg = data as { type?: string; message?: string };

        if (msg.type === "interrupt") {
          if (activeAbort) {
            try { activeAbort.abort(); } catch { /* ignore */ }
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

        if (busy) {
          queue.push(message);
          return;
        }

        processMessage(message);
      },

      onDestroy() {
        if (activeAbort) {
          try { activeAbort.abort(); } catch { /* ignore */ }
        }
        if (sessionState.coalesceTimer) clearTimeout(sessionState.coalesceTimer);
        activeSessions.delete(ctx.filename);
      },
    };
  };
}
