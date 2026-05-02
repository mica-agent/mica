// claudeAgent.ts -- Claude Code agent channel handler.
// Uses @anthropic-ai/claude-agent-sdk for cloud-model agentic coding.
// Registered as a ChannelManager handler for .claude files.
// Auth: inherits from ~/.claude/.credentials.json (bind-mounted by devcontainer).

import { readFile, writeFile, mkdir, readdir } from "fs/promises";
import { join } from "path";
import { randomUUID } from "crypto";
import { WORKSPACE_DIR, micaDir, listCanvasFiles, readProjectFile, readCanvasConfig, BINARY_EXTS, isLikelyBinary, CONTEXT_SOFT_CAP_CHARS, getCardClassMeta, readChatCursor, writeChatCursor, DEFAULT_CANVAS_ROOT } from "./files.js";
import { buildSubagentCanvasContext } from "./micaAgent.js";
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
import { recordTurn, recordSubagent } from "./metrics.js";
import { writeSnapshot } from "./turnSnapshots.js";
import { getPendingValidatorErrors } from "./validatorErrorBuffer.js";
import { markProjectActivity } from "./projectActivity.js";

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
  /** Stable turn UUID set when the assistant message is persisted at turn
   *  end. Joins this history bubble to its `TurnRecord` and rendered-prompt
   *  snapshot. Optional for back-compat with chats predating the per-turn
   *  footer feature. */
  turn_id?: string;
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

  // Validator errors that fired since the agent's last response — see the
  // micaAgent.ts equivalent for the full rationale. Closes the feedback loop
  // between Mica's runtime validators and the agent's prompt context, so a
  // malformed file the validator already diagnosed reaches the agent on its
  // very next turn instead of waiting for the user to re-prompt.
  if (project) {
    const pendingErrors = getPendingValidatorErrors(project);
    if (pendingErrors.length > 0) {
      // Direct evidence of agent receiving validator/runtime errors. See
      // micaAgent.ts comment at the same site — buffer→prompt path is
      // otherwise unobservable, so we log per-error for auditability.
      const filenames = pendingErrors.map((e) => e.filename).join(", ");
      const previews = pendingErrors.map((e) => `${e.filename}: ${e.error.slice(0, 80).replace(/\n/g, " ")}`).join(" | ");
      console.log(`[buildContext:${project}] (claude) injected ${pendingErrors.length} validator/runtime error(s) into next-turn prompt: ${filenames}`);
      console.log(`[buildContext:${project}] (claude) error previews: ${previews}`);
      const errorLines = pendingErrors.map((e) =>
        `### \`${e.filename}\`\n\n${e.error}`
      );
      parts.push(
        `## Validator errors needing your attention\n\n` +
        `The following file(s) failed validation since your last response. ` +
        `These errors are from Mica's runtime validators (path/schema/lint/dependency-reachability) — ` +
        `the user has ALREADY seen them in the chat card UI. ` +
        `Fix each by rewriting the named file with the corrections the error message describes; ` +
        `each rewrite re-runs the validator, so the buffer self-clears once the file is valid.\n\n` +
        errorLines.join("\n\n"),
      );
    }
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

  // Available subagents — see micaAgent.ts for rationale. Claude SDK names
  // the delegation tool "Task" (per the AgentInfo type docstring); the
  // input shape is { subagent_type: "<name>", prompt: "..." }.
  //
  // Resolve canvasRoot once — used both in the delegation cheat sheet
  // and the "File Locations" block below. Default matches initProject's
  // DEFAULT_CANVAS_ROOT.
  let canvasRoot = DEFAULT_CANVAS_ROOT;
  try {
    const cfg = JSON.parse(await readFile(join(getMicaDir(project), "config.json"), "utf-8"));
    canvasRoot = cfg.canvasRoot || cfg.docsDir || DEFAULT_CANVAS_ROOT;
  } catch { /* use default */ }

  try {
    const agents = await loadProjectSubagents(project, "claude");
    if (agents.length > 0) {
      const lines: string[] = [
        `## Available Subagents`,
        ``,
        `You have specialized Subagents. Delegating to one is HOW you implement multi-file work without exhausting your context window — each Subagent runs in its own session and returns only a short summary.`,
        ``,
        `**Invoke via the \`Agent\` tool** (also called \`Task\` in older docs — both names work). The input shape:`,
        `\`\`\``,
        `Agent({ subagent_type: "<name>", description: "<short label>", prompt: "Implement <file>. See ${canvasRoot}/spec.md § X and ${canvasRoot}/interfaces.md § Y. Upstream: ... Downstream: ... Done when: ..." })`,
        `\`\`\``,
        ``,
        `You can also explicitly request a Subagent by name in plain language inside your reply, e.g. "Use the component-coder agent to implement src/email_monitor.py per ${canvasRoot}/spec.md § Email Monitor."`,
        ``,
        `Available Subagents:`,
      ];
      for (const a of agents) {
        lines.push(`- **${a.name}**: ${a.description}`);
      }
      lines.push(
        ``,
        `WHEN to delegate:`,
        `- Plan produces **>2 files of new code**: delegate each coherent unit.`,
        `- A single component spans **>200 lines**: delegate.`,
        `- Independent components in parallel.`,
        ``,
        `Concurrency is capped per-project. **BEFORE delegating**, write or update \`${canvasRoot}/interfaces.md\` with shared contracts — Subagents have fresh context and cannot see each other's in-flight work.`,
      );
      parts.push(lines.join("\n"));
    }
  } catch { /* ignore */ }

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

  parts.push(`## Skills
This project's skills are bundled by its template and live under \`.claude/skills/<name>/SKILL.md\`. The Claude Code SDK auto-discovers them and surfaces each skill's \`description:\` to you. When a user request matches a skill's trigger words, load that skill (read its SKILL.md) and follow it. If a \`participate-fully\` skill is present, read it at the start of every turn — it tells you how to handle the \`## Since your last turn\` section above.

## Asking the user a question

When you need information from the user — a clarification, a design decision, an approval — invoke the \`AskUserQuestion\` tool. Do NOT write a question into a plain-text response and rely on the user to read and reply.

Why: \`AskUserQuestion\` renders an interactive dialog in the chat card. The user clicks an option (or types a free answer) and Mica routes the response back deterministically. A question in plain text becomes a message the user has to read, scroll back to, and answer free-form — slower for them and ambiguous for you.

Rules:
- **Use \`AskUserQuestion\` for ANY question requiring a user reply.** Clarifications, approvals, choices.
- **Provide \`options\` when the answer space is finite.** Two-to-five options; each is a complete, self-contained answer.
- **Omit \`options\` for open-ended questions.** Still use the tool — the dialog signals "I'm waiting" clearly.
- **One invocation can carry multiple questions** via the \`questions\` array.
- **End your turn after invoking.** Mica returns a deny-message; the user's next chat message is the answer.

The only time it's OK to ask in plain text is rhetorical or framing-level ("This raises the question of whether..."), where no user reply is actually needed.

## Arc completion marker
When a coherent arc of work ends — the user's task is done, or the conversation has reached a natural stopping point where starting fresh would not lose anything important — emit the literal marker \`<thread-state>arc-complete</thread-state>\` as the last line of your response. This is Mica's signal that the chat can reset its context cursor. Use it sparingly and only at genuine breaks (task finished, question answered, plan ratified). Do NOT emit it mid-task, after tool errors, or when the user is still iterating.

## Keep chat cards topic-scoped
Each chat card on the canvas is meant to hold one ongoing conversation about one topic. When the user opens a distinctly different topic in an existing card, acknowledge briefly but suggest spawning a new chat card scoped to the new topic. One sentence is enough — do not pressure. This keeps each card focused and prevents context-overflow on long-running cards.`);

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
  // Strip MCP server prefix if present.
  const bareName = name.replace(/^mcp__[^_]+(?:-[^_]+)*__/, "");
  const n = bareName.toLowerCase().replace(/[_-]/g, "");
  const filePath = String(input.file_path || input.filePath || input.path || input.file || "");
  const fileName = filePath.split("/").pop() || "";
  const cmd = String(input.command || input.cmd || input.script || "");

  // Skill — surface which skill is being invoked.
  if (n === "skill") {
    const skill = String(input.skill || input.name || "");
    return skill ? `skill: ${skill}` : "skill";
  }
  // Subagent dispatch (Claude SDK uses "Task" or "Agent").
  if (bareName === "Task" || bareName === "Agent" || bareName === "agent" || bareName === "task") {
    const subagent = String(input.subagent_type || input.agent || "");
    const desc = String(input.description || "").slice(0, 60);
    if (subagent && desc) return `subagent: ${subagent} (${desc})`;
    if (subagent) return `subagent: ${subagent}`;
    if (desc) return `subagent: ${desc}`;
    return "subagent dispatch";
  }
  // Web fetch / search.
  if (n === "webfetch" || n === "fetch") {
    const url = String(input.url || input.link || "");
    return url ? `web_fetch: ${url.slice(0, 100)}` : "web_fetch";
  }
  if (n === "websearch") {
    const q = String(input.query || input.q || "");
    return q ? `web_search: ${q.slice(0, 80)}` : "web_search";
  }
  // Mica card-class tools.
  if (n === "micacreateclass") return `create class: ${String(input.name || "")}`.trim();
  if (n === "micaeditclassfile") {
    const cls = String(input.class || "");
    const file = String(input.file || "");
    return cls && file ? `edit class: ${cls}/${file}` : cls ? `edit class: ${cls}` : "edit class file";
  }
  if (n === "micacreatecardinstance") {
    const ext = String(input.class_extension || "");
    const fn = String(input.filename || "");
    return ext && fn ? `create instance: ${fn}${ext}` : "create card instance";
  }
  if (n === "micadeleteclass") return `delete class: ${String(input.name || "")}`.trim();
  if (n === "micadeletecardinstance") return `delete instance: ${String(input.filename || "")}`.trim();
  if (n === "micalistclasses") return "list card classes";
  // Render capture.
  if (n === "rendercapture") {
    const fn = String(input.filename || "");
    return fn ? `screenshot: ${fn}` : "screenshot";
  }
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
    // Track current Claude SDK query handle so interrupt/destroy paths can
    // call q.interrupt() + q.close() — the canonical lifecycle methods.
    // Same rationale as micaAgent.ts: abort alone leaves the SDK CLI
    // subprocess alive holding state. See micaAgent comment for details.
    let activeQuery: { interrupt: () => Promise<void>; close: () => Promise<void>; isClosed: () => boolean } | null = null;

    // Per-turn ephemeral-event buffer. See micaAgent.ts for the full rationale —
    // mirrors the same pattern: intercept ctx.broadcast, push replayable events
    // to a buffer, auto-clear on `assistant`/`error` (turn end). onAttach below
    // replays the buffer to each newly-attached client after sending history.
    // Late-joiners mid-turn see the in-flight events and reach the correct UI
    // state; late-joiners between turns get history alone (buffer empty).
    const currentTurnEvents: unknown[] = [];
    const _origBroadcast = ctx.broadcast.bind(ctx);
    function isReplayable(event: unknown): boolean {
      if (typeof event !== "object" || event === null) return false;
      const type = (event as { type?: string }).type;
      return type === "thinking" || type === "progress" ||
             type === "user_question" || type === "error";
    }
    ctx.broadcast = (data: unknown): void => {
      _origBroadcast(data);
      if (isReplayable(data)) currentTurnEvents.push(data);
      const t = (data as { type?: string } | null)?.type;
      if (t === "assistant" || t === "error") currentTurnEvents.length = 0;
    };

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
      markProjectActivity(sessionProject, +1);
      console.log(`[claude-agent] processMessage START: ${message.slice(0, 60)}`);

      // Per-turn read tracking — see micaAgent.ts for rationale.
      const readFilesThisTurn = new Set<string>();

      // Per-turn metrics state. Emitted at each termination path. See
      // server/metrics.ts for the schema.
      const turnId = randomUUID();
      const tsStart = Date.now();
      let firstTokenTs: number | null = null;
      const toolCallCounts: Record<string, number> = {};
      const subagentStarts = new Map<string, { name: string; tsStart: number }>();
      let subagentCount = 0;
      // Names of skills explicitly invoked via the SDK's `Skill` tool. The
      // chat card's per-turn footer surfaces these by name.
      const skillsInvoked: string[] = [];

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

        // Surface validator/runtime errors entering this turn as a step in
        // the chat-card progress feed (see micaAgent.ts comment at the same
        // site for full rationale).
        if (sessionProject) {
          const incomingErrors = getPendingValidatorErrors(sessionProject);
          if (incomingErrors.length > 0) {
            const files = Array.from(new Set(incomingErrors.map((e) => e.filename)));
            const desc = incomingErrors.length === 1
              ? `Received error from ${files[0]}`
              : `Received ${incomingErrors.length} errors from ${files.length === 1 ? files[0] : `${files.length} files`}`;
            ctx.broadcast({
              type: "progress",
              tool: "validator-errors",
              description: desc,
            });
          }
        }

        const context = await buildContext(ctx.filename, sessionProject, since);
        // Capture rendered system-prompt snapshot for the per-turn footer's
        // "view snapshot" link. Sidecar at .mica/chats/<chatId>/snapshots/
        // <turnId>.txt; fire-and-forget.
        void writeSnapshot(sessionProject, chatId, turnId, context);

        // Inject recent chat history into the prompt so the agent has conversational
        // continuity. Without this, each turn is a goldfish — the SDK's `query()`
        // call only sees the current user message. Include up to ~6 prior turn-pairs
        // (12 messages), capped at ~6K chars total so the system prompt + history
        // comfortably fit in ctx=65536. Skip the most recent entry (it's the user
        // message we just pushed above and will send as the actual prompt).
        //
        // Cursor-aware: messages before `cursor` belong to an earlier arc the
        // agent has been released from (via arc-complete + capacity trigger or
        // an explicit Clear). The user still sees full scroll in the UI.
        const cursor = await readChatCursor(chatId, sessionProject);
        const priorHistory = history.slice(cursor, -1);
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
        // Per-turn nudge: prepended above the user message because the model
        // pays attention to text adjacent to the user input more reliably than
        // to buried system-prompt rules. ~30-token cost per turn.
        const TURN_NUDGE = `[Turn discipline reminder, apply BEFORE coding]
1. If this turn will edit non-doc files (card.js/html/css, .ts, .py, .json), the relevant describing doc(s) must already describe the change — update them FIRST in this same turn, even if the user's intent feels obvious. The framework cannot detect doc/code drift after the fact.
2. If \`participate-fully\` is in your skills list, invoke it before any other tool call to assess what changed.

`;
        const promptWithHistory = TURN_NUDGE + historyBlock + message;

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
        //
        // We deliberately DO NOT forward `tools` from the agent file to the
        // Claude AgentDefinition: the shared agent files (component-coder.md
        // etc.) ship Qwen-style snake_case tool names (read_file, write_file)
        // which Claude doesn't recognize. Passing them would silently strip
        // the subagent's tool access. Omitting `tools` makes the Claude
        // subagent inherit the parent's tool set, which is what we want for
        // the heavy-lifter `component-coder` use case anyway.
        const parsedAgents: ParsedSubagent[] = await loadProjectSubagents(sessionProject, "claude");
        // Prepend canvas baseline to each subagent's prompt so the subagent
        // starts with the same project awareness as the parent. See
        // micaAgent.ts:buildSubagentCanvasContext for rationale.
        const subagentBaseline = parsedAgents.length > 0
          ? await buildSubagentCanvasContext(sessionProject)
          : "";
        const agentsRecord: Record<string, { description: string; tools?: string[]; prompt: string; model?: string }> = {};
        for (const a of parsedAgents) {
          const fullPrompt = subagentBaseline
            ? `${a.systemPrompt}\n\n---\n\n# Canvas baseline (shared with parent agent)\n\n${subagentBaseline}`
            : a.systemPrompt;
          agentsRecord[a.name] = {
            description: a.description,
            prompt: fullPrompt,
            ...(a.modelConfig?.model ? { model: a.modelConfig.model } : {}),
          };
        }
        if (parsedAgents.length > 0) {
          console.log(`[claude-agent] subagents: ${parsedAgents.map((a) => a.name).join(", ")} (canvas baseline: ${subagentBaseline.length} chars)`);
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

          // Subagent concurrency for Claude. SDK type docs reference both
          // "Task" (AgentInfo doc) and "Agent" (AgentDefinition doc) as the
          // delegation tool name; accept either to be robust to SDK version.
          if ((toolName === "Task" || toolName === "Agent") && sessionProject) {
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
            // Per Claude Agent SDK docs: the Agent tool MUST be in allowedTools
            // for subagent invocation to be available to the model. We set the
            // full Claude Code default tool set explicitly so Agent is included.
            // (Without allowedTools, behaviour is the SDK default — which
            // doesn't appear to advertise Agent to the model in our setup.)
            // "Task" is included for compat: Claude renamed Task → Agent in
            // v2.1.63 but older SDKs / some surfaces still emit "Task".
            allowedTools: [
              "Read", "Write", "Edit", "MultiEdit", "NotebookEdit",
              "Bash", "BashOutput", "KillBash",
              "Glob", "Grep",
              "WebFetch", "WebSearch",
              "TodoWrite",
              "Agent", "Task",
            ],
            // Clear CLAUDECODE — if Mica is launched from inside a Claude Code shell
            // the SDK would otherwise refuse ("cannot launch inside another session").
            env: { ...process.env, CLAUDECODE: "" } as NodeJS.ProcessEnv,
            // Surface claude subprocess stderr so real errors aren't swallowed.
            stderr: (line: string) => {
              if (line.trim()) console.error(`[claude-agent stderr] ${line}`);
            },
          },
        }) as AsyncIterable<Record<string, unknown>>;
        // Track query handle for interrupt/close. Same lifecycle pattern
        // as micaAgent.ts. Claude Agent SDK's Query type exposes the same
        // interrupt/close/isClosed shape.
        activeQuery = q as unknown as { interrupt: () => Promise<void>; close: () => Promise<void>; isClosed: () => boolean };

        let resultText = "";
        let filesChanged = false;
        // Final turn usage from the SDK's `result` event. CUMULATIVE across
        // every LLM call in the tool loop — NOT the last-request prompt size.
        // For the gauge use peakIterationInput (tracked per assistant event).
        let usage: Record<string, unknown> | null = null;
        // Per-iteration peak prompt size (max input_tokens across assistant events).
        let peakIterationInput = 0;

        // Track in-flight subagent invocations by tool_use_id for concurrency
        // accounting (see micaAgent.ts for matching logic / rationale).
        const outstandingSubagentTasks = new Set<string>();

        for await (const evt of q) {
          const evtType = evt.type as string;

          if (evtType === "assistant" && evt.message) {
            // First assistant event = proxy for time-to-first-token (prefill done).
            if (firstTokenTs === null) firstTokenTs = Date.now();
            // Per-iteration prompt size — running max becomes the gauge reading.
            const msgUsage = (evt.message as { usage?: { input_tokens?: number } }).usage;
            if (msgUsage && typeof msgUsage.input_tokens === "number" && msgUsage.input_tokens > peakIterationInput) {
              peakIterationInput = msgUsage.input_tokens;
            }
            const msg = evt.message as { content?: Array<{ type: string; name?: string; text?: string; input?: Record<string, unknown>; id?: string }> };
            if (msg.content) {
              for (const block of msg.content) {
                if (block.type === "tool_use" && block.name) {
                  console.log(`[claude-agent] tool_use: ${block.name} input=${JSON.stringify(block.input || {}).slice(0, 200)}`);
                  toolCallCounts[block.name] = (toolCallCounts[block.name] || 0) + 1;
                  if ((block.name === "Task" || block.name === "Agent") && block.id) {
                    outstandingSubagentTasks.add(block.id);
                    subagentCount++;
                    const input = block.input || {};
                    const subName = String(
                      (input as Record<string, unknown>).subagent_type ||
                      (input as Record<string, unknown>).agent_type ||
                      (input as Record<string, unknown>).name ||
                      "unknown"
                    );
                    subagentStarts.set(block.id, { name: subName, tsStart: Date.now() });
                  }
                  // Capture skill name when the SDK's `Skill` tool fires.
                  // Defensive multi-key extraction — Claude Code SDK uses
                  // `skill` or `name`; if zero ever shows up consistently,
                  // log block.input once for `block.name === "Skill"`.
                  if (block.name === "Skill") {
                    const input = (block.input as Record<string, unknown>) || {};
                    const skillName = String(
                      input.skill_name ?? input.skill ?? input.name ?? ""
                    );
                    if (skillName) skillsInvoked.push(skillName);
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
                  const start = subagentStarts.get(block.tool_use_id);
                  if (start) {
                    subagentStarts.delete(block.tool_use_id);
                    const tsEnd = Date.now();
                    void recordSubagent(sessionProject, {
                      turn_id: turnId,
                      tool_use_id: block.tool_use_id,
                      subagent_name: start.name,
                      ts_start: start.tsStart,
                      ts_end: tsEnd,
                      duration_ms: tsEnd - start.tsStart,
                    });
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
        if (activeQuery) {
          const q = activeQuery;
          activeQuery = null;
          try { if (!q.isClosed()) void q.close().catch(() => {}); } catch {}
        }

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

        // Detect the arc-complete marker and advance the cursor at natural
        // breaks when capacity is tight. Claude's default models run with very
        // large context windows (200K+) so the capacity trigger rarely fires
        // here — arc-complete stays meaningful mainly as a user-visible horizon
        // marker and a signal for explicit "Clear the card" actions. The
        // threshold (0.80) matches micaAgent for consistency.
        const ARC_COMPLETE_RE = /<thread-state>\s*arc-complete\s*<\/thread-state>/i;
        const arcComplete = ARC_COMPLETE_RE.test(resultText);
        if (arcComplete) resultText = resultText.replace(ARC_COMPLETE_RE, "").trim();

        // Peak prompt pressure across the turn = max(per-iteration input_tokens),
        // captured from each `assistant` SDK event above. The result event's
        // usage.input_tokens is CUMULATIVE across iterations and would read
        // 200%+ on multi-tool-round turns; the gauge needs the per-iteration peak.
        const CLAUDE_CTX_WINDOW = 200000;
        const inputTokens = peakIterationInput > 0
          ? peakIterationInput
          : (usage && typeof (usage as { input_tokens?: unknown }).input_tokens === "number"
              ? (usage as { input_tokens: number }).input_tokens
              : 0);
        const capacity = inputTokens / CLAUDE_CTX_WINDOW;
        let cursorAdvanced = false;
        let newCursor = cursor;

        const updatedHistory = await loadHistory(chatId, sessionProject);
        updatedHistory.push({ role: "assistant", content: resultText, agent: "Claude", turn_id: turnId });
        await saveHistory(chatId, updatedHistory, sessionProject);

        if (arcComplete && capacity > 0.80) {
          newCursor = updatedHistory.length;
          await writeChatCursor(chatId, sessionProject, newCursor, updatedHistory.length);
          cursorAdvanced = true;
          console.log(`[claude-agent] cursor advanced to ${newCursor} (capacity ${Math.round(capacity * 100)}%, arc-complete)`);
        }

        const tsEnd = Date.now();
        const durationMs = tsEnd - tsStart;
        const ttftMs = firstTokenTs !== null ? firstTokenTs - tsStart : null;

        console.log(`[claude-agent] broadcasting assistant (success path) for: ${message.slice(0, 60)} (peak ${inputTokens} / ${CLAUDE_CTX_WINDOW})`);
        ctx.broadcast({
          type: "assistant",
          content: resultText,
          agent: "Claude",
          filesChanged,
          ...(usage ? { usage } : {}),
          contextWindow: CLAUDE_CTX_WINDOW,
          // baselineTokens kept for back-compat with card.js readers; inputTokens
          // is the canonical "turn high-water mark" both agents now emit.
          baselineTokens: inputTokens,
          inputTokens,
          arcComplete,
          capacity,
          cursor: newCursor,
          cursorAdvanced,
          durationMs,
          ...(ttftMs !== null ? { ttftMs } : {}),
          turn_id: turnId,
        });

        void recordTurn(sessionProject, {
          turn_id: turnId,
          ts_start: tsStart,
          ts_end: tsEnd,
          duration_ms: durationMs,
          ttft_ms: ttftMs,
          chat_id: chatId,
          agent: "claude",
          model: process.env.ANTHROPIC_MODEL || "claude-default",
          input_tokens: typeof (usage as { input_tokens?: unknown })?.input_tokens === "number" ? (usage as { input_tokens: number }).input_tokens : 0,
          output_tokens: typeof (usage as { output_tokens?: unknown })?.output_tokens === "number" ? (usage as { output_tokens: number }).output_tokens : 0,
          baseline_tokens: inputTokens,
          context_window: CLAUDE_CTX_WINDOW,
          capacity,
          subagent_count: subagentCount,
          tool_calls: toolCallCounts,
          skills_invoked: skillsInvoked,
          files_changed: filesChanged ? 1 : 0,
          cursor_advanced: cursorAdvanced,
          arc_complete: arcComplete,
        });

      } catch (err) {
        activeAbort = null;
        if (activeQuery) {
          const q = activeQuery;
          activeQuery = null;
          try { if (!q.isClosed()) void q.close().catch(() => {}); } catch {}
        }
        const errMsg = (err as Error).message || String(err);
        // Empty response = model had nothing to say (common for reactive events)
        if (errMsg.includes("empty response")) {
          console.log(`[claude-agent] broadcasting assistant (empty-response path) for: ${message.slice(0, 60)}`);
          ctx.broadcast({ type: "assistant", content: "No action needed.", agent: "Claude", filesChanged: false });
        } else {
          console.error(`[claude-agent] Error during ${message.slice(0, 40)}:`, errMsg);
          ctx.broadcast({ type: "error", error: errMsg });
        }
        // Minimal metric for error/empty path — fields scoped inside the try
        // aren't accessible here. Baseline analysis focuses on successful turns.
        const tsEnd = Date.now();
        void recordTurn(sessionProject, {
          turn_id: turnId,
          ts_start: tsStart,
          ts_end: tsEnd,
          duration_ms: tsEnd - tsStart,
          ttft_ms: firstTokenTs !== null ? firstTokenTs - tsStart : null,
          chat_id: chatId,
          agent: "claude",
          model: process.env.ANTHROPIC_MODEL || "claude-default",
          input_tokens: 0,
          output_tokens: 0,
          baseline_tokens: 0,
          context_window: 0,
          capacity: 0,
          subagent_count: subagentCount,
          tool_calls: toolCallCounts,
          skills_invoked: skillsInvoked,
          files_changed: 0,
          cursor_advanced: false,
          arc_complete: false,
        });
      } finally {
        recordTurnEnd(ctx.filename);
        markProjectActivity(sessionProject, -1);
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
        // Send history (plus cursor) to newly attached client.
        Promise.all([
          loadHistory(chatId, sessionProject),
          readChatCursor(chatId, sessionProject),
        ]).then(([messages, cursor]) => {
          ctx.sendTo(clientId, { type: "history", messages, cursor });

          // Replay current-turn ephemeral events if a turn is in flight.
          // Same pattern as micaAgent.ts onAttach.
          for (const event of currentTurnEvents) {
            ctx.sendTo(clientId, event);
          }

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
          // SDK lifecycle methods — see micaAgent.ts comment for the full
          // rationale. Same pattern: q.interrupt() (graceful) + queued
          // q.close() (force teardown of CLI subprocess).
          if (activeQuery) {
            const q = activeQuery;
            q.interrupt().catch(() => {});
            setTimeout(() => {
              try { if (!q.isClosed()) q.close().catch(() => {}); } catch {}
            }, 1000);
          }
          // Drop messages typed while the agent was busy. Otherwise the
          // finally block dequeues and fires the next turn after stop —
          // surprising given that "stop" naturally means "stop everything."
          if (queue.length > 0) {
            console.log(`[claude-agent] interrupt: dropping ${queue.length} queued message(s)`);
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
        if (activeQuery) {
          const q = activeQuery;
          activeQuery = null;
          try { if (!q.isClosed()) void q.close().catch(() => {}); } catch {}
        }
        if (sessionState.coalesceTimer) clearTimeout(sessionState.coalesceTimer);
        activeSessions.delete(ctx.filename);
      },
    };
  };
}
