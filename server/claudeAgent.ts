// claudeAgent.ts -- Claude Code agent channel handler.
// Uses @anthropic-ai/claude-agent-sdk for cloud-model agentic coding.
// Registered as a ChannelManager handler for .claude files.
// Auth: inherits from ~/.claude/.credentials.json (bind-mounted by devcontainer).

import { readFile, writeFile, mkdir, readdir } from "fs/promises";
import { join } from "path";
import { WORKSPACE_DIR, micaDir, listCanvasFiles, readProjectFile, readCanvasConfig, BINARY_EXTS, isLikelyBinary, CONTEXT_SOFT_CAP_CHARS, getCardClassMeta } from "./files.js";
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
  type ParsedSubagent,
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
 * Detects `cmd &` without stdio redirect — see micaAgent.ts for rationale.
 */
function isBackgroundWithoutRedirect(cmd: string): boolean {
  const trimmed = cmd.trim();
  if (!/(?<!&)&\s*$/.test(trimmed)) return false;
  if (/>\s*\S|>&|&>/.test(trimmed)) return false;
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
        console.warn(`[claude-agent] BLOCKED shell command: "${cmd.slice(0, 120)}" — ${reason}`);
        return {
          behavior: "deny" as const,
          message: `Refused: ${reason}. Command: ${cmd.slice(0, 120)}`,
        };
      }
    }
    if (isBackgroundWithoutRedirect(cmd)) {
      console.warn(`[claude-agent] BLOCKED background-without-redirect: "${cmd.slice(0, 120)}"`);
      return {
        behavior: "deny" as const,
        message:
          "Backgrounded command (ends in `&`) has no stdout/stderr redirect. When this tool call returns, the shell exits and the process dies (SIGHUP / broken pipe). Pick one:\n" +
          "  1. Redirect both streams to a file:\n" +
          "     python -m http.server > /tmp/server.log 2>&1 &\n" +
          "  2. Use nohup + redirect:\n" +
          "     nohup python -m http.server > /tmp/server.log 2>&1 &\n" +
          "  3. For long-running services you can also set `is_background: true` on the tool call and drop the trailing `&`.",
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
      const mod = await import("@anthropic-ai/claude-agent-sdk");
      _query = (mod as { query: typeof _query }).query;
    } catch (err) {
      console.error("[claude-agent] Failed to load @anthropic-ai/claude-agent-sdk:", (err as Error).message);
      throw new Error("@anthropic-ai/claude-agent-sdk not available");
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
  // user has large unrelated trees in the project.
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

  // Project files — full content of every canvas-visible text file goes in.
  // No truncation, no caps: the canvas IS the agent's direction. Oversize is
  // flagged (see below), not silently clipped. Only hard skip: known-binary
  // extensions and NUL-byte-detected binary content.
  try {
    const files = await listCanvasFiles(project || undefined);
    if (files.length > 0) {
      const emitted: string[] = [];
      for (const f of files) {
        const ext = f.name.substring(f.name.lastIndexOf(".")).toLowerCase();
        // Skip meta cards — same rationale as micaAgent.ts.
        const meta = await getCardClassMeta(ext, project);
        if (meta.meta) continue;
        if (BINARY_EXTS.has(ext)) {
          emitted.push(`### ${f.name} (${f.size} bytes, binary)`);
          continue;
        }
        try {
          const file = await readProjectFile(f.name, project || undefined);
          if (isLikelyBinary(f.name, file.content)) {
            emitted.push(`### ${f.name} (${f.size} bytes, binary)`);
          } else if (file.content.length === 0) {
            emitted.push(`### ${f.name} (empty — intentional shell or placeholder)`);
          } else {
            emitted.push(`### ${f.name}\n${file.content}`);
          }
        } catch { emitted.push(`### ${f.name} (${f.size} bytes, unreadable)`); }
      }
      if (emitted.length > 0) {
        parts.push(`## Project Files`);
        for (const e of emitted) parts.push(e);
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
This project's skills are bundled by its template and live under \`.claude/skills/<name>/SKILL.md\`. The Claude Code SDK auto-discovers them and surfaces each skill's \`description:\` to you. When a user request matches a skill's trigger words, load that skill (read its SKILL.md) and follow it. If a \`participate-fully\` skill is present, read it at the start of every turn — it tells you how to handle the \`## Since your last turn\` section above.`);

  const assembled = parts.join("\n\n");
  if (assembled.length > CONTEXT_SOFT_CAP_CHARS) {
    console.warn(
      `[claude-agent] OVERSIZED context: ${assembled.length} chars (cap ${CONTEXT_SOFT_CAP_CHARS}). ` +
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

export function createClaudeAgentHandler(fileWatcher: FileWatcher) {
  // Single file-watcher listener shared across all agent sessions.
  // Maps filename -> session state. Prevents listener leaks from StrictMode.
  const activeSessions = new Map<string, {
    project: string | null;
    busy: boolean;
    agentWrittenFiles: Set<string>;
    coalesceBuffer: Map<string, { type: "created" | "changed" | "deleted"; count: number }>;
    coalesceTimer: ReturnType<typeof setTimeout> | null;
    deliverFn: (() => void) | null;
    canvasRoot: string;
    pinnedFiles: Set<string>;
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
    // use sessionProject — switching the active project doesn't redirect
    // this session's writes to the wrong .mica/chats directory.
    const sessionProject = ctx.project;
    // Chat history is keyed by the session's stable UUID (the file's per-card
    // sidecar id). Stable across renames; isolated per file even if two
    // projects share the same filename.
    const chatId = ctx.sessionId;
    let busy = false;
    let queue: string[] = [];
    let activeAbort: AbortController | null = null;

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
        console.log(`[claude-agent] processMessage called while busy — queueing: ${message.slice(0, 60)}`);
        queue.push(message);
        return;
      }
      busy = true; sessionState.busy = true;
      console.log(`[claude-agent] processMessage START: ${message.slice(0, 60)}`);

      // Per-turn read tracking — see micaAgent.ts for rationale.
      const readFilesThisTurn = new Set<string>();

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

        console.log(`[claude-agent] Query: ${message.slice(0, 100)}... (context: ${context.length} chars, history: ${historyBlock.length} chars)`);

        // Per-project subagent concurrency cap. Claude doesn't have our local
        // GPU-slot constraint, but we still bound parallel delegations so one
        // runaway turn can't fan out indefinitely.
        if (sessionProject) {
          configureConcurrency(sessionProject, "openrouter");
        }

        // Load subagent definitions from `.claude/agents/*.md` (project) with
        // server/builtin-agents/*.md as fallbacks. Convert our ParsedSubagent
        // to Claude SDK's AgentDefinition record-keyed shape (the Claude SDK
        // uses an object-keyed-by-name, not an array).
        const parsedAgents: ParsedSubagent[] = await loadProjectSubagents(sessionProject, "claude");
        const agentsRecord: Record<string, { description: string; tools?: string[]; prompt: string; model?: string }> = {};
        for (const a of parsedAgents) {
          agentsRecord[a.name] = {
            description: a.description,
            prompt: a.systemPrompt,
            ...(a.tools ? { tools: a.tools } : {}),
            ...(a.modelConfig?.model ? { model: a.modelConfig.model } : {}),
          };
        }
        if (parsedAgents.length > 0) {
          console.log(`[claude-agent] subagents: ${parsedAgents.map((a) => a.name).join(", ")}`);
        }

        const queryFn = await getQuery();
        activeAbort = new AbortController();

        // Captures questions that the agent emitted via AskUserQuestion. The SDK's
        // built-in tool tries to render a CLI prompt that has no surface in our
        // programmatic SDK setup, so we intercept here, deny the tool, and append
        // the question text to the agent's chat reply at the end of the turn.
        let pendingQuestionText = "";

        // Claude SDK passes a 3rd `options` arg (signal, toolUseID, etc.) — we ignore it.
        async function canUseToolWithQuestionIntercept(toolName: string, input: Record<string, unknown>, _options?: unknown) {
          void _options;
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

          // Subagent concurrency for Claude. Claude SDK uses the "Agent" tool
          // (capitalized) rather than Qwen's "task". Same semaphore semantics.
          if (toolName === "Agent" && sessionProject) {
            if (!canStartSubagentTask(sessionProject)) {
              const status = getConcurrencyStatus(sessionProject);
              return {
                behavior: "deny" as const,
                message:
                  `Subagent concurrency cap reached (${status?.active}/${status?.cap} in flight). ` +
                  `Wait for an active subagent to finish, then retry.`,
              };
            }
            beginSubagentTask(sessionProject);
          }

          // Per-extension write_file validators + cross-cutting preconditions
          // (see server/cardValidators.ts).
          if (["write_file", "write_to_file", "create_file", "Write"].includes(toolName)) {
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

          if (toolName === "AskUserQuestion" || toolName === "ask_user_question") {
            const questions = (input.questions as Array<{
              question: string;
              header?: string;
              options?: Array<{ label: string; description?: string }>;
              multiSelect?: boolean;
            }> | undefined) || [];
            // Broadcast IMMEDIATELY as a standalone `user_question` event
            // (see micaAgent.ts for the rationale — local models misread
            // the deny message and keep running tools, so accumulating for
            // turn end doesn't work reliably).
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
            // Model: SDK default (Claude Code picks the configured default)
            // Auth: inherited from ~/.claude/.credentials.json — no env vars needed
            // "default" + canUseTool gives us auto-approve with guards
            permissionMode: "default" as const,
            canUseTool: canUseToolWithQuestionIntercept,
            abortController: activeAbort,
            systemPrompt: { type: "preset", preset: "claude_code", append: context },
            // Project-defined subagents (loaded from .claude/agents/*.md with
            // server/builtin-agents fallback). Parent delegates heavy single-
            // component work via the SDK's Agent tool.
            ...(Object.keys(agentsRecord).length > 0 ? { agents: agentsRecord } : {}),
            // Clear CLAUDECODE — if Mica is launched from inside a Claude Code shell
            // the SDK would otherwise refuse ("cannot launch inside another session").
            env: { ...process.env, CLAUDECODE: "" } as NodeJS.ProcessEnv,
            // Surface claude subprocess stderr so real errors aren't swallowed.
            stderr: (line: string) => {
              if (line.trim()) console.error(`[claude-agent stderr] ${line}`);
            },
          },
        }) as AsyncIterable<Record<string, unknown>>;

        let resultText = "";
        let filesChanged = false;
        // Final turn usage from the SDK's `result` event. Shape: { input_tokens, output_tokens, ... }.
        // Forwarded to the client so the chat card can compute tokens/sec from elapsed time.
        let usage: Record<string, unknown> | null = null;

        // Track in-flight subagent invocations by tool_use_id for concurrency
        // accounting (see micaAgent.ts for matching logic / rationale).
        const outstandingSubagentTasks = new Set<string>();

        for await (const evt of q) {
          const evtType = evt.type as string;

          if (evtType === "assistant" && evt.message) {
            const msg = evt.message as { content?: Array<{ type: string; name?: string; text?: string; input?: Record<string, unknown>; id?: string }> };
            if (msg.content) {
              for (const block of msg.content) {
                if (block.type === "tool_use" && block.name) {
                  console.log(`[claude-agent] tool_use: ${block.name} input=${JSON.stringify(block.input || {}).slice(0, 200)}`);
                  if (block.name === "Agent" && block.id) {
                    outstandingSubagentTasks.add(block.id);
                  }
                  ctx.broadcast({
                    type: "progress",
                    tool: block.name,
                    description: describeToolUse(block.name, block.input || {}),
                  });
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

          // Detect completed subagent (Agent-tool) invocations — tool_result
          // blocks arrive as user messages; drain the concurrency counter.
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
            // Claude SDK: evt.result is a string (success); also exposes .subtype, .total_cost_usd, .usage.
            // Qwen SDK used .result.text — don't expect that here.
            const result = evt.result;
            if (typeof result === "string" && result) resultText = result;
            // Capture usage from wherever the SDK exposes it this version.
            const evtUsage = (evt as { usage?: unknown }).usage;
            const resultUsage = typeof evt.result === "object" ? (evt.result as { usage?: unknown })?.usage : undefined;
            if (evtUsage && typeof evtUsage === "object") usage = evtUsage as Record<string, unknown>;
            else if (resultUsage && typeof resultUsage === "object") usage = resultUsage as Record<string, unknown>;
          }
        }

        activeAbort = null;

        // Drain any outstanding subagent tasks from the concurrency counter
        // (error / abort path). See micaAgent.ts for the same safety.
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

        console.log(`[claude-agent] broadcasting assistant (success path) for: ${message.slice(0, 60)}`);
        ctx.broadcast({ type: "assistant", content: resultText, agent: "Claude", filesChanged, ...(usage ? { usage } : {}) });

        const updatedHistory = await loadHistory(chatId, sessionProject);
        updatedHistory.push({ role: "assistant", content: resultText, agent: "Claude" });
        await saveHistory(chatId, updatedHistory, sessionProject);

      } catch (err) {
        activeAbort = null;
        const errMsg = (err as Error).message || String(err);
        // Empty response = model had nothing to say (common for reactive events)
        if (errMsg.includes("empty response")) {
          console.log(`[claude-agent] broadcasting assistant (empty-response path) for: ${message.slice(0, 60)}`);
          ctx.broadcast({ type: "assistant", content: "No action needed.", agent: "Claude", filesChanged: false });
        } else {
          console.error(`[claude-agent] Error during ${message.slice(0, 40)}:`, errMsg);
          ctx.broadcast({ type: "error", error: errMsg });
        }
      } finally {
        recordTurnEnd(ctx.filename);
        console.log(`[claude-agent] processMessage DONE: ${message.slice(0, 60)} | queue depth: ${queue.length}`);
        // Hand off to next queued message WITHOUT releasing busy. This avoids
        // a race where an incoming WS onData sees busy=false in the millisecond
        // before setImmediate fires, starting a parallel processMessage call.
        if (queue.length > 0) {
          const next = queue.shift()!;
          // busy stays true; the next processMessage just sets it true again (no-op)
          setImmediate(() => {
            // The guard at the top of processMessage will let this through since
            // we're transitioning the in-flight slot, not racing.
            // Temporarily release the guard so the recursive call proceeds.
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
