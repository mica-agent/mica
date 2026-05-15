// micaAgent.ts -- Qwen Code agent channel handler.
// Uses @qwen-code/sdk to provide an agentic coding assistant.
// Registered as a ChannelManager handler for .chat files.

import { readFile, writeFile, mkdir, readdir } from "fs/promises";
import { join } from "path";
import { randomUUID } from "crypto";
import { WORKSPACE_DIR, micaDir, listCanvasFiles, readProjectFile, readCardSettings, readOpenRouterKey, readOpenAICompatConfig, readCanvasConfig, BINARY_EXTS, isLikelyBinary, CONTEXT_SOFT_CAP_CHARS, getCardClassMeta, readChatCursor, writeChatCursor, DEFAULT_CANVAS_ROOT, loadChatQueue, saveChatQueue } from "./files.js";
import { loadValidator, extensionFromWriteInput, contentFromWriteInput, pathFromWriteInput, pathFromReadInput, checkCardClassPrecondition, checkCardClassMetadataConsistency, checkLibraryDiscoveryPrecondition, checkProtectedPathPrecondition } from "./cardValidators.js";
import type { ChannelHandler, SessionContext } from "./channelManager.js";
import type { FileWatcher } from "./fileWatcher.js";
import { markAgentWrite } from "./writeSource.js";
import { SentenceFanout } from "./voiceStreaming.js";
import { getTtsUrl, getVoiceServerStatus } from "./voiceServers.js";
// buildCardClassMcpServer retired — its tools (mica_create_class,
// mica_edit_class_file, mica_list_classes, mica_create_card_instance,
// mica_delete_class, mica_delete_card_instance) now live in the unified
// mica-builtins server (server/agentTools/cardClass.ts). The cardClassTools
// module is kept for its impl + schema exports, used by the new wrappers.
import { buildCliMcpServer, bindSdk as bindCliMcpSdk } from "./plugins/cliMcp.js";
import {
  loadProjectSubagents,
  configureConcurrency,
  canStartSubagentTask,
  beginSubagentTask,
  endSubagentTask,
  getConcurrencyStatus,
} from "./subagents.js";
import { markProjectActivity } from "./projectActivity.js";
import { recordTurn, recordSubagent } from "./metrics.js";
import { writeSnapshot } from "./turnSnapshots.js";
import { getFreshPendingValidatorErrors } from "./validatorErrorBuffer.js";
import { recordSkillInvocation } from "./skillInvocationTracker.js";
import { flushProjectPendingErrors } from "./cardErrorBuffer.js";
import { resetRenderCaptureCount } from "./renderCaptureCounter.js";
import { captureCard } from "./screenshot.js";
import { readFile as fsReadFile } from "fs/promises";
import { buildAgentToolsMcpServer } from "./agentTools/sdkMcpBuilder.js";
import { buildAgentToolsPrelude } from "./agentTools/promptPrelude.js";
import { z } from "zod";

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
const LOCAL_CTX_WINDOW = parseInt(process.env.LLAMA_CTX_SIZE || "131072", 10);

/** Per-file size cap above which an intent doc is demoted from inlined-in-
 *  baseline to listing-only-with-abstract. Scales proportionally with the
 *  context window: bigger windows allow bigger inlined docs without crowding
 *  tool I/O. The 32KB hard ceiling reflects cognitive density, not budget —
 *  past ~8K tokens of one doc, model attention dilutes regardless of slot
 *  size, so even a 1M-context model reads better with focused docs.
 *
 *  Math: ~4 chars/token × 4% of window = bytes that one inlined doc may
 *  consume. At 65K context: ~10KB. At 128K: ~20KB. At 256K+: 32KB ceiling.
 *  Paired with the task-decomposer's split-monolith rule which keeps docs
 *  ≤ this cap so they remain eligible for inlining when relevant.
 *
 *  Computed once at module load (LOCAL_CTX_WINDOW is env-driven, set at
 *  process start). If the user changes LLAMA_CTX_SIZE they'll need to
 *  restart, same as for any context-size change. */
function intentInlineCapBytes(contextWindowTokens: number): number {
  return Math.min(32768, Math.floor(contextWindowTokens * 0.04 * 4));
}

/** Per-subagent dispatch budgets. A subagent (component-coder, etc.) runs
 *  in its own context slot of the same size as the parent. After overhead
 *  (system prompt + task prompt + thinking + assistant output across ~10
 *  iterations), the subagent has roughly (ctx - 25K) tokens of fresh I/O
 *  budget. Convert to bytes at 4 chars/token for human-readable file-size
 *  caps. Three derived caps:
 *
 *    totalIO    — total reads + writes the subagent's task should imply.
 *                 Above this, the task is too large for one slot.
 *    perInput   — per-file cap for any single file the subagent reads.
 *                 Larger files require offset/limit partial reads.
 *    perOutput  — per-file cap for any single file the subagent writes.
 *                 Larger output files mean the next dispatch (which may
 *                 read this file) overflows; split the work across files.
 *
 *  At 65K context: totalIO ≈ 160KB, perInput ≈ 16KB, perOutput ≈ 10KB.
 *  At 128K: totalIO ≈ 412KB, perInput ≈ 32KB, perOutput ≈ 20KB.
 *  At 256K+: hard ceilings clamp to keep cognitive load manageable. */
function subagentBudgetBytes(contextWindowTokens: number): {
  totalIO: number;
  perInput: number;
  perOutput: number;
} {
  // Tokens left after the fixed subagent overhead. ~25K covers system
  // prompt (~12K) + task prompt (~2K) + ~10K of thinking + assistant
  // responses across a typical 10-iteration tool loop.
  const ioTokens = Math.max(8192, contextWindowTokens - 25000);
  return {
    totalIO: Math.min(524288, ioTokens * 4),                // 512KB hard ceiling
    perInput: Math.min(65536, intentInlineCapBytes(contextWindowTokens) * 2),  // 64KB ceiling, 2× the inline cap
    perOutput: intentInlineCapBytes(contextWindowTokens),   // matches inline cap (~10KB at 65K)
  };
}

/** Format byte counts for prompt text — KB rounded to one decimal. */
function fmtKB(bytes: number): string {
  const kb = bytes / 1024;
  return kb >= 100 ? `${Math.round(kb)}KB` : `${kb.toFixed(1)}KB`;
}

/** Runtime detection banner injected at the top of both the parent's context
 *  AND each subagent's canvas baseline. Surfaces the model + context budgets
 *  the runtime actually has, so prompts that would otherwise hardcode
 *  assumptions for a specific model class can read these numbers instead.
 *
 *  This is what lets the same canvas-back / skills produce different behavior
 *  on Qwen-30B vs Claude-via-OpenRouter without forking templates: the
 *  agent reads the banner, then applies the rules-of-thumb in canvas-back
 *  in light of what's actually running. See task-decomposer.md and
 *  decompose-task/SKILL.md for the readers. */
function buildRuntimeBanner(opts: {
  modelName: string | null;
  contextWindowTokens: number;
}): string {
  const ctxK = Math.round(opts.contextWindowTokens / 1024);
  const subagentBudget = subagentBudgetBytes(opts.contextWindowTokens);
  const inlineCap = intentInlineCapBytes(opts.contextWindowTokens);
  // Parent's spare for fresh tool I/O after baseline (canvas-back + skills +
  // file listing + history). ~25K tokens of overhead is the same accounting
  // used in subagentBudgetBytes; convert remaining tokens to bytes at 4 chars/tok.
  const parentSpareTokens = Math.max(8192, opts.contextWindowTokens - 25000);
  const parentSpareBytes = parentSpareTokens * 4;
  const modelLabel = opts.modelName?.trim() || "configured per chat card (see settings)";
  return [
    `## Detected runtime`,
    ``,
    `Model: ${modelLabel}`,
    `Context window: ${ctxK}K tokens`,
    `Parent inline I/O budget after baseline: ≈${fmtKB(parentSpareBytes)}`,
    `Per-subagent slot total I/O: ${fmtKB(subagentBudget.totalIO)}`,
    `Per-doc inline cap (intent docs): ${fmtKB(inlineCap)}`,
    ``,
    `Treat the guidance below in light of these numbers. Where canvas-back or skill files give rules of thumb tuned for a specific model class (e.g. "lacks long reasoning", "produces silently incomplete code on large asks", "decompose at 7th–10th file"), the runtime numbers above are AUTHORITATIVE — read them before applying any threshold. A strong model on a generous slot should not be treated as a 30B local model with 65K context just because canvas-back was originally written for that profile.`,
  ].join("\n");
}
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
  // The agent runs INSIDE the Mica backend's process tree. stop.sh/restart.sh
  // SIGTERM the backend, which kills the agent before the script's start
  // phase can run — backend dies, agent dies, no recovery. Card classes are
  // hot-reloaded by the file watcher; the agent never needs to restart Mica.
  { re: /\bscripts\/(stop|restart)\.sh\b/, reason: "Never run scripts/stop.sh or scripts/restart.sh from inside the agent — you run inside the backend, the script will SIGTERM you mid-tool-call and the restart will not complete. Card classes hot-reload via the file watcher; if a class seems missing, query mica.cardClasses.list() from a card or check that the directory is at .mica/card-classes/<name>/ with metadata.json." },
  { re: /\bscripts\/start\.sh\b/, reason: "scripts/start.sh would spawn a duplicate backend on a port already held by the running one. If you genuinely need a restart, ask the user — they're outside your process tree." },
  // Card-class file placement: cp/mv/rsync targeting `card-classes/<name>` at
  // the project root (without the `.mica/` prefix) is the canonical mistake.
  // Card classes MUST live at `.mica/card-classes/<name>/`. The Mica resolver
  // only finds them there; files at `<project>/card-classes/<name>/` are
  // invisible to the canvas and instances render as plain TXT. This pre-block
  // catches the cp/mv shape before it executes (zero burned turns); the
  // file-watcher's wrong-location sub catches the same mistake one tool-call
  // later if the agent gets there via direct write_file. The negative
  // lookahead exempts commands that already include `.mica/card-classes/`
  // somewhere — the self-fix `mv <project>/card-classes/X .mica/card-classes/X`
  // and any cp/mv WITHIN `.mica/card-classes/` pass through unblocked.
  { re: /\b(?:cp|mv|rsync)\b(?!.*\.mica\/card-classes\/).*\bcard-classes\/[^\/\s]+/, reason: "Card classes must live at `.mica/card-classes/<name>/` (with the leading dot — `.mica` is project-scoped). The Mica resolver only finds card classes there; `<project>/card-classes/<name>/` is invisible to the canvas. Use `cp -r <source> .mica/card-classes/<name>` instead. (Mica's built-in card classes live at `card-classes/` inside the Mica repo itself — not inside your project.)" },
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
 * Check whether a tool call attempts to write a path that's owned by a
 * Mica-structured tool. If yes, deny with a message routing the agent to
 * the correct tool.
 *
 * Closes the bypass route observed in the world7 build: the agent invokes
 * discover-dependency and skips both the spec gate AND the
 * `mica_create_class` handbook gate by using `write_file` directly on
 * metadata.json. Each Mica-structured tool runs schema validation,
 * pre-write lint, AND the toolPrerequisites.ts predicate framework — none
 * of which fire for plain `write_file`. The agent that's compressed the
 * develop flow in working memory takes the path of least resistance
 * (write_file) and silently bypasses the architecture.
 *
 * This check restores ordering: blocking write_file/edit on the protected
 * paths leaves the agent with only the structured tools, which then fire
 * the predicate gates that enforce spec → handbook → build sequence.
 *
 * Returns a deny result with self-teaching guidance (which tool to use,
 * what that tool does that write_file doesn't); the agent's tool-result
 * loop reads it and retries with the correct tool.
 */
function checkProtectedPath(toolName: string, input: Record<string, unknown>): { behavior: "deny"; message: string } | null {
  // Only intercept generic file-write tools. The structured Mica tools
  // (mica_create_class, mica_edit_class_file, mica_create_card_instance,
  // mica_delete_*) are the RIGHT path for these files — they go to their
  // own handlers, not through this check.
  if (toolName !== "write_file" && toolName !== "edit" && toolName !== "Edit") return null;

  const rawPath = (input.file_path as string) || (input.path as string) || "";
  if (!rawPath) return null;
  // Normalize: strip leading absolute-path prefix so the regex matches on
  // the canonical relative shape regardless of how the agent expressed it.
  const normalized = rawPath.replace(/\\/g, "/");

  // Card-class source files: <...>.mica/card-classes/<name>/<file>
  const classFile = normalized.match(/\.mica\/card-classes\/[^/]+\/(metadata\.json|card\.html|card\.js|card\.css)$/);
  if (classFile) {
    const file = classFile[1];
    if (file === "metadata.json") {
      return {
        behavior: "deny",
        message:
          `Refused: ${rawPath} is a Mica card-class metadata file. ` +
          `Use \`mica_create_class\` instead — it serializes the metadata ` +
          `from typed inputs, validates the schema, runs the pre-write lint, ` +
          `and triggers the predicate gates (spec must exist, ` +
          `\`skill('card-class-handbook')\` must be invoked). Re-call with ` +
          `the same \`name\` + \`extension\` to UPDATE metadata in place — ` +
          `card.html/js/css are preserved unless you pass them. \`write_file\` ` +
          `bypasses all of this and routinely produces files the validators ` +
          `auto-fix or reject.`,
      };
    }
    // card.html / card.js / card.css
    return {
      behavior: "deny",
      message:
        `Refused: ${rawPath} is a card-class source file. ` +
        `Use \`mica_edit_class_file\` instead — it runs the pre-write lint ` +
        `(catches CARD_SHIM-globals redeclaration, ESM \`import\`/\`export\`, ` +
        `IIFE wrappers, etc. before the file is written) and supports two ` +
        `edit modes: partial (\`old_string\` + \`new_string\`) preserves all ` +
        `surrounding code untouched, full replace (\`content=\`) overwrites ` +
        `the whole file. \`write_file\` bypasses the lint AND, in full-replace ` +
        `mode, repeatedly regresses working code (e.g. drops a texture-loader ` +
        `block from a Three.js card.js).`,
    };
  }

  // .mica/layout.json — runtime state owned by the canvas card class.
  if (/\.mica\/layout\.json$/.test(normalized)) {
    return {
      behavior: "deny",
      message:
        `Refused: ${rawPath} is runtime layout state owned by the canvas ` +
        `card class. Don't write it directly — layout changes happen when ` +
        `the user drags/resizes cards on the canvas. If you're trying to ` +
        `position a new card on the canvas, use \`mica_create_card_instance\` ` +
        `and the canvas will pick a position automatically.`,
    };
  }

  return null;
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
  /** Stable turn UUID, set when the assistant message is persisted at turn
   *  end. Joins this history bubble to its `TurnRecord` and rendered-prompt
   *  snapshot. Optional for back-compat with chats predating the per-turn
   *  footer feature — old bubbles render with no chevron. */
  turn_id?: string;
}

// Lazy-load the SDK
let _query: ((config: unknown) => AsyncIterable<unknown>) | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _tool: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _createSdkMcpServer: any = null;
async function getQuery() {
  if (!_query) {
    try {
      const mod = await import("@qwen-code/sdk");
      _query = (mod as { query: typeof _query }).query;
      _tool = (mod as { tool: unknown }).tool;
      _createSdkMcpServer = (mod as { createSdkMcpServer: unknown }).createSdkMcpServer;
      // The card-class CRUD tools now live in the unified registry
      // (server/agentTools/cardClass.ts) and reach Mica via REST loopback —
      // they don't need SDK injection any more. Only the cli-mcp adapter
      // (project-scoped third-party tools, driven by <project>/.mica/tools.json)
      // still uses the per-SDK MCP wrapper because its tools are dynamic
      // per-project (the unified registry shape is a static set).
      bindCliMcpSdk(_tool, _createSdkMcpServer);
    } catch (err) {
      console.error("[mica-agent] Failed to load @qwen-code/sdk:", (err as Error).message);
      throw new Error("@qwen-code/sdk not available");
    }
  }
  return _query!;
}

/** Build the mica-tools MCP server for the qwen-code SDK. Tools live in
 *  server/agentTools/registry.ts; this just wires them through the
 *  qwen SDK's createSdkMcpServer + tool helpers. The actual work
 *  (captureCard, vision caption, etc.) runs server-side via /api/tools/*
 *  loopback so qwen, Claude, and opencode all share the same impl.
 *  Replaces the in-process render_capture handler that lived here. */
function buildMicaToolsMcpServer(sessionProject: string | null, sessionChatFilename: string | null): unknown | null {
  if (!sessionProject || !_tool || !_createSdkMcpServer) return null;
  return buildAgentToolsMcpServer({
    toolFn: _tool,
    createServerFn: _createSdkMcpServer,
    sessionProject,
    sessionChatFilename,
    // Match Claude + opencode: same server name across all three agents
    // means tool calls show up consistently in logs (mcp__mica-builtins__X)
    // and the agent system prompt's prose stays accurate.
    serverName: "mica-builtins",
  });
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

/** Pull a one-line "what is this doc about" abstract from a markdown / .todo
 *  file: H1 title + first non-blank paragraph after it (or before, if no H1).
 *  Used to enrich listing-only entries in the canvas baseline so the
 *  orchestrator can decide whether to read a doc without paying the full
 *  token cost upfront.
 *
 *  Returns null when the file is unreadable, empty, or has no extractable
 *  shape (e.g. binary, all blank). Truncates the abstract to ~120 chars
 *  so a single doc can't dominate the listing.
 *
 *  Why "first paragraph after H1": markdown convention — the first
 *  paragraph of a well-written doc is its lede. Authors who don't write a
 *  lede still get the H1 as the title hint, which on its own already
 *  improves orchestrator awareness vs. just "(20K bytes)". */
async function extractDocAbstract(
  filename: string,
  project: string | undefined,
): Promise<{ title: string; abstract: string } | null> {
  try {
    const file = await readProjectFile(filename, project);
    const text = file.content;
    if (!text || isLikelyBinary(filename, text)) return null;
    const lines = text.split(/\r?\n/);
    let title = "";
    let i = 0;
    // Find the first non-blank line. If it's an H1/H2, use its text as title.
    for (; i < lines.length; i++) {
      const l = lines[i].trim();
      if (!l) continue;
      const headingMatch = l.match(/^#{1,2}\s+(.+)$/);
      if (headingMatch) {
        title = headingMatch[1].trim();
        i++;
        break;
      }
      // First non-blank line isn't a heading — bail; we'll grab it as the
      // abstract anchor. Reset i so the abstract loop sees this line.
      break;
    }
    // Find the first prose paragraph by skipping past blanks, sub-headings,
    // and frontmatter delimiters. Many specs write
    //   # Title
    //   ## Overview
    //   <lede paragraph>
    // — the lede lives under the first H2, not directly under the H1. Stop
    // at the first blank line after we've started capturing content.
    const buf: string[] = [];
    let started = false;
    for (; i < lines.length; i++) {
      const l = lines[i].trim();
      if (!l) {
        if (started && buf.length > 0) break;
        continue;
      }
      if (l.startsWith("#")) {
        // Skip sub-headings encountered before we've found prose. After
        // we've started collecting, a heading boundary stops us.
        if (started) break;
        continue;
      }
      if (l === "---" && !started) continue; // YAML frontmatter delimiter
      started = true;
      buf.push(l);
      if (buf.join(" ").length > 240) break;
    }
    const abstract = buf.join(" ").replace(/\s+/g, " ").slice(0, 120).trim();
    if (!title && !abstract) return null;
    return { title, abstract };
  } catch {
    return null;
  }
}

/** Format a listing entry's `${name} (${size})` line with the optional
 *  title + abstract suffix. Centralized so buildContext and
 *  buildSubagentCanvasContext stay consistent. */
function formatListingEntry(name: string, sizeBytes: number, meta: { title: string; abstract: string } | null, extraNote?: string): string {
  const sizeStr = `${sizeBytes} bytes`;
  let suffix = "";
  if (meta) {
    if (meta.title) suffix += ` — "${meta.title}"`;
    if (meta.abstract) suffix += ` — ${meta.abstract}`;
  }
  if (extraNote) suffix += ` — ${extraNote}`;
  return `- \`${name}\` (${sizeStr})${suffix}`;
}

/** Authoritative mica.* API surface, injected into BOTH the parent's
 *  buildContext AND every subagent's buildSubagentCanvasContext. Single
 *  source of truth so the parent (when doing inline work) and the
 *  subagents (when implementing under the parent's task prompt) see
 *  the same primitive set, channel-handler registry, and anti-patterns.
 *
 *  Earlier this block lived inline in buildSubagentCanvasContext only —
 *  meaning the parent had to dispatch a subagent to surface it. When
 *  the parent did inline work (e.g. "review and revise spec.md"), it
 *  reverted to its prior knowledge of mica.*, which is incomplete and
 *  often wrong (defaults to browser primitives). Now both contexts get
 *  the same string. ~700 token cost on the parent's baseline; fixes
 *  the spec-generation failure mode where the parent would write a spec
 *  that has the card calling LLM endpoints directly. */
const MICA_API_REFERENCE_BLOCK =
  `## Mica APIs — discover, don't memorize\n\n` +
  `Cards run inside a CARD_SHIM that injects \`mica.*\` (files, openChannel, on, fetch, getContent, onDestroy, etc.) and \`container\` (the root DOM node). Specs and card.js code that bypass this — \`fetch('/api/files/...')\`, \`localStorage\`, direct calls to llama-server / OpenRouter — are wrong. Cards NEVER own LLM endpoints; LLM access is server-side via channel handlers reached through \`mica.openChannel\`.\n\n` +
  `**Before writing any spec or card.js:** invoke the \`card-class-handbook\` skill. Its body is the canonical reference for the \`mica.*\` surface (parameter shapes, edge cases, anti-patterns). Don't paraphrase from memory.\n\n` +
  `**Before writing any LLM-driven card class:** \`curl http://localhost:3002/api/handlers\` returns the live registry of reusable channel handlers (llm-direct, llm-agent, plus any others) with their \`name\`, \`whenToUse\`, \`argsSchema\`, and example card.js. Pick by \`whenToUse\`, declare \`"handler": "<name>"\` in your card class metadata.json, pass args via \`mica.openChannel\`. No server plugin required; agents do not write server code.`;

/** Canvas baseline injected into every subagent's systemPrompt so the
 *  subagent starts with the same project awareness as the parent (canvas-back,
 *  spec/design files, file locations, container danger notes). Without this,
 *  subagents only see their own role description + the parent's task prompt
 *  string — they don't know what the project IS, what files are on canvas,
 *  what the canvas root is, or where to write files. Path confusion and
 *  missing-context wandering are common symptoms.
 *
 *  Excluded vs the parent's full buildContext: per-card behavior instructions,
 *  since-last-turn diffs (subagents have no last turn), available-subagents
 *  guidance (subagents can't delegate further), chat history. */
export async function buildSubagentCanvasContext(
  project: string | null,
  modelName?: string | null,
  contextWindowTokens?: number,
): Promise<string> {
  const parts: string[] = [];
  const ctxTokens = contextWindowTokens ?? LOCAL_CTX_WINDOW;

  // Runtime detection banner — model + budget numbers above all other
  // guidance so subagents reading the canvas baseline calibrate to what's
  // actually running, not to canvas-back's hardcoded assumptions.
  parts.push(buildRuntimeBanner({ modelName: modelName ?? null, contextWindowTokens: ctxTokens }));

  // Authoritative budget block — the role-specific systemPrompt (component-
  // coder.md, etc.) refers back to these numbers rather than hardcoding,
  // so they scale automatically when LLAMA_CTX_SIZE changes.
  const budget = subagentBudgetBytes(ctxTokens);
  parts.push(
    `## Your context budget\n\n` +
    `Your slot is ${ctxTokens} tokens. After system prompt + task prompt + thinking + assistant output across a typical 10-iteration tool loop, you have approximately the following budget for fresh tool I/O (reads + your own write echoes):\n\n` +
    `- **Total I/O budget: ${fmtKB(budget.totalIO)}** — total bytes of reads + writes your task should imply. If your task implies more, it's too big for one slot.\n` +
    `- **Per-input cap: ${fmtKB(budget.perInput)}** — any single file read above this should use \`read_file\` with \`offset:\` + \`limit:\` for a partial read, not a full read.\n` +
    `- **Per-output cap: ${fmtKB(budget.perOutput)}** — any single file you \`write_file\` above this size will overflow the next dispatch that needs to read it.\n\n` +
    `Estimate before reading. \`run_shell_command\` with \`wc -c <file1> <file2> ...\` is the cheapest check. If your task scope exceeds the total I/O budget, return \`failed: scope too large (<N>KB total, budget ${fmtKB(budget.totalIO)})\` with a recommended split — the parent will re-decompose. Silently overflowing wastes the slot AND the user's time.\n\n` +
    `These numbers scale automatically with the runtime context size — you don't recompute them, you just respect the values stated above.`,
  );

  // Available mica.* APIs — auto-injected so subagents (task-decomposer,
  // component-coder, etc.) know what primitives the runtime provides
  // BEFORE writing specs or implementing card classes. Without this,
  // generated specs reach for browser-direct APIs (`fetch`, `indexedDB`,
  // `localStorage`) and the resulting card class loses Mica's
  // affordances: SSRF protection, canvas-native persistence,
  // cross-window sync, channel pubsub, lifecycle hooks. Tight summary
  // here; full reference lives in the `card-class-handbook` skill body
  // (which subagents can `read_file` if they need details).
  parts.push(MICA_API_REFERENCE_BLOCK);

  // Project context (canvas-back)
  try {
    const canvasBack = await readFile(join(getMicaDir(project), "canvas-back.md"), "utf-8");
    if (canvasBack.trim()) parts.push(`## Project Context\n${canvasBack.trim()}`);
  } catch { /* no canvas-back */ }

  // Files on canvas — listing only, no content. The parent's task prompt
  // names the specific files the subagent should read; anything else is
  // discoverable via this list + `read_file`. Broadcasting full content
  // here duplicates the parent's canvas baseline into EVERY subagent's
  // systemPrompt, blowing past slot limits in multi-tool-call turns
  // (observed: 49K chars × N subagents = ~25K tokens of redundancy per
  // request). The subagent's role spec (component-coder.md et al.)
  // tells it to read on demand.
  try {
    const files = await listCanvasFiles(project || undefined);
    if (files.length > 0) {
      const lines: string[] = [`## Files on canvas`];
      lines.push(`Use \`read_file\` to pull content for the files you need — they are NOT pre-loaded below. Your task prompt should name the relevant ones.`);
      lines.push(``);
      for (const f of files) {
        const ext = f.name.substring(f.name.lastIndexOf(".")).toLowerCase();
        const cmeta = await getCardClassMeta(ext, project);
        if (cmeta.meta) continue;
        if (BINARY_EXTS.has(ext)) {
          lines.push(`- \`${f.name}\` (${f.size} bytes, binary)`);
          continue;
        }
        // Pull title+abstract for markdown-shaped intent docs so subagents
        // can pick what to read without re-listing themselves. Code/config
        // files stay as bare name+size — their "abstract" would need
        // language-specific parsing and adds little signal.
        const isIntent = ext === ".md" || ext === ".todo";
        const docMeta = isIntent ? await extractDocAbstract(f.name, project || undefined) : null;
        lines.push(formatListingEntry(f.name, f.size, docMeta));
      }
      if (lines.length > 3) parts.push(lines.join("\n"));
    }
  } catch { /* ignore */ }

  // File location rules. Default matches initProject's DEFAULT_CANVAS_ROOT
  // — a missing / unreadable config falls back to the new default, not the
  // legacy "docs" name.
  let canvasRoot = DEFAULT_CANVAS_ROOT;
  try {
    const cfg = JSON.parse(await readFile(join(getMicaDir(project), "config.json"), "utf-8"));
    canvasRoot = cfg.canvasRoot || cfg.docsDir || DEFAULT_CANVAS_ROOT;
  } catch { /* use default */ }
  parts.push(
    `## File Locations\n` +
    `- The canvas directory is \`${canvasRoot}/\` — canvas-visible cards live here.\n` +
    `- The project root is your working directory. Use absolute or full project-relative paths in tool calls (e.g. \`podcast-automation/src/config.py\` not just \`src/config.py\`) so paths resolve unambiguously.\n` +
    `- NEVER write to \`.mica/\` — that directory is Mica-internal metadata.\n` +
    `\n` +
    `## Calling \`run_shell_command\` — REQUIRED parameters\n` +
    `The \`is_background\` parameter is **REQUIRED** on every \`run_shell_command\` call. Forgetting it deadlocks the SDK silently.\n` +
    `- One-shot commands (\`mkdir\`, \`npx tsc --noEmit\`, \`python -m py_compile\`, \`bash -n\`, \`npm test\`, \`git status\`): pass \`is_background: false\`.\n` +
    `- Long-running processes (\`npm run dev\`, \`python -m http.server\`, \`mongod\`): pass \`is_background: true\`. ALSO redirect stdout/stderr (\`>logs/server.log 2>&1\`) so the process doesn't die when its file descriptors close.\n` +
    `Always include \`is_background\`. No exceptions.\n` +
    `\n` +
    `## DANGER: You Run Inside The Mica Container\n` +
    `Do not touch processes on ports 5173 (vite), 3002 (Mica backend), 8012 / 8013 (vLLM). Do not kill anything matching \`vite\`, \`tsx server/index.ts\`, \`vllm\`, \`npm run dev\`, or under \`/workspaces/mica/\`. If you need to launch a test web app, use a different port (9000, 9090).`,
  );

  return parts.join("\n\n");
}

/** Read each `.qwen/skills/<name>/SKILL.md` frontmatter and emit a directive
 *  block listing them with names + descriptions. Restores the explicit
 *  per-skill trigger guidance that was removed in commit 8c87ba1 (replaced
 *  by abstract auto-discovery prose that local Qwen MoE doesn't honor).
 *
 *  This complements (doesn't duplicate) the SDK's own skill-tool description:
 *  the SDK lists skills inside the Skill tool's <available_skills> block,
 *  but local models reliably ignore that. Putting the same information
 *  in the chat agent's own systemPrompt with explicit "match → invoke"
 *  language is what made skill triggering work pre-8c87ba1. */
async function buildAvailableSkillsPrompt(project: string | null): Promise<string> {
  const skillsDir = join(getProjectDir(project), ".qwen", "skills");
  const entries: Array<{ name: string; description: string }> = [];
  try {
    const dirents = await readdir(skillsDir, { withFileTypes: true });
    for (const dirent of dirents) {
      if (!dirent.isDirectory()) continue; // skip flat reference files like _conventions.md
      const skillFile = join(skillsDir, dirent.name, "SKILL.md");
      try {
        const content = await readFile(skillFile, "utf-8");
        // Frontmatter is `---\n<yaml>\n---` at file start. Simple regex parse —
        // we only need `name` and `description`, both single-line strings.
        const m = content.match(/^---\n([\s\S]*?)\n---/);
        if (!m) continue;
        const fm = m[1];
        const nameMatch = fm.match(/^name:\s*(.+)$/m);
        const descMatch = fm.match(/^description:\s*(.+(?:\n[ ]+.+)*)/m);
        if (!nameMatch || !descMatch) continue;
        const name = nameMatch[1].trim().replace(/^["']|["']$/g, "");
        // Multi-line description support: YAML continuation lines start with
        // 2+ spaces. Collapse those into a single-line string.
        const description = descMatch[1]
          .replace(/\n[ ]+/g, " ")
          .trim()
          .replace(/^["']|["']$/g, "");
        entries.push({ name, description });
      } catch {
        // skill file missing or unreadable — skip silently
      }
    }
  } catch {
    return ""; // skills directory doesn't exist (e.g. project without template)
  }

  if (entries.length === 0) return "";

  const skillLines = entries
    .map((s) => `- **${s.name}** — ${s.description}`)
    .join("\n");

  // Compact skill listing — names + one-line descriptions. The
  // qwen-code SDK's `skill` tool also surfaces these to the model;
  // this block is the system-prompt redundancy that reinforces it
  // for the local Qwen prior, which sometimes ignores tool listings.
  // Kept short to limit prompt density (the previous "mandatory when
  // matched" preamble + "match liberally" trailer added ~150 tokens
  // of prescriptive prose; the agent gets the same signal from the
  // tool description).
  return `## Available skills

Invoke matching skills via the \`skill\` tool before related work:

${skillLines}`;
}

export async function buildContext(
  agentFilename: string,
  project: string | null,
  since?: number,
  modelName?: string | null,
  contextWindowTokens?: number,
): Promise<string> {
  const parts: string[] = [];
  const ctxTokens = contextWindowTokens ?? LOCAL_CTX_WINDOW;

  // Runtime detection banner — model + budget numbers above all other
  // guidance so the agent calibrates to what's actually running, not to
  // canvas-back's hardcoded model-class assumptions.
  parts.push(buildRuntimeBanner({ modelName: modelName ?? null, contextWindowTokens: ctxTokens }));

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

  // Validator errors that fired since the agent's last response. These come
  // from `enforceCardClassPath` / `enforceCardClassMetadata` / `enforceCardJsLint`
  // / `enforceDecompositionConsistency` / `enforceDependenciesReachable` —
  // server/cardValidators.ts via the buffer in server/validatorErrorBuffer.ts.
  // Without this section the agent would write a malformed file (e.g. wrong
  // metadata.json schema), the validator would broadcast a card-error to the
  // chat card frontend, the user would see it, but the agent — running inside
  // the same turn — would NEVER see it. Result: agent declares "fix complete"
  // while the validator's actionable diagnosis goes unread. Surfacing it here
  // closes that feedback loop. Errors persist in the buffer until the file is
  // rewritten (validator silence on the next save automatically clears).
  if (project) {
    const { fresh: pendingErrors, filteredStale } = getFreshPendingValidatorErrors(project, getProjectDir(project));
    if (filteredStale.length > 0) {
      // Stale entries — class files were edited after the error was recorded,
      // so the browser hasn't yet POSTed /ok (to clear) or /error (to refresh
      // ts). Logging without injecting keeps the path auditable without
      // dispatching the agent to debug a phantom (see Plan: stale-error
      // reactivity loop).
      const staleNames = filteredStale.map((e) => e.filename).join(", ");
      console.log(`[buildContext:${project}] filtered ${filteredStale.length} stale validator/runtime error(s) (class edited after error): ${staleNames}`);
    }
    if (pendingErrors.length > 0) {
      // Direct evidence of agent receiving validator/runtime errors. The
      // buffer→prompt path is otherwise unobservable (the assembled system
      // prompt isn't logged) and we'd have to infer agent awareness from
      // behavior. Log per-error so the path "card-error broadcast → buffer
      // → next-turn prompt" can be audited end-to-end.
      const filenames = pendingErrors.map((e) => e.filename).join(", ");
      const previews = pendingErrors.map((e) => `${e.filename}: ${e.error.slice(0, 80).replace(/\n/g, " ")}`).join(" | ");
      console.log(`[buildContext:${project}] injected ${pendingErrors.length} validator/runtime error(s) into next-turn prompt: ${filenames}`);
      console.log(`[buildContext:${project}] error previews: ${previews}`);
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

  // Project files — list all, read text content for context.
  // Custom card-class instances (e.g. `.sheet`, `.solar`, `.kanban`, `.stopwatch`)
  // are almost always text (JSON, YAML, TOML), so we don't gate on a hardcoded
  // text-extension allowlist — instead we attempt a UTF-8 read and fall back
  // to "<binary, N bytes>" if the file isn't decodable cleanly. Hardcoded BINARY_EXTS
  // for the common known-binary cases (images, archives, executables) avoid wasting
  // a read attempt.
  // Project files — split into INTENT docs (full content) and EVERYTHING
  // ELSE (listing only). The orchestrator's job is delegation; it needs
  // the project's intent (specs, plans, contracts) inline but reads
  // implementation files on demand or delegates them to subagents.
  //
  // Why split: every canvas file's full content used to land in baseline.
  // For projects with several large files (taxomatic: 24K-token baseline)
  // the parent overflows the 65K context slot before doing useful work.
  // Listing-only for code/config files drops baseline by ~80% on heavy
  // projects while still giving the agent the file map it needs to
  // route reads. Subagents already use the same shape via
  // buildSubagentCanvasContext — this aligns parent + subagent baselines.
  //
  // INTENT extensions get full content: .md (specs, design docs, notes),
  // .todo (plans / task lists). Everything else (.js, .ts, .py, .html,
  // .css, .json, .yaml, custom card classes) gets a one-line listing
  // entry so the agent knows what's there without paying the token cost.
  //
  // Per-file size cap on intent inlining: even an INTENT-classified file
  // gets demoted to listing-only if it exceeds the cap. A 30KB
  // architectural spec.md is reference material best read on demand; a
  // 1KB questions.md or 2KB todo file genuinely belongs in baseline.
  // The cap scales with LOCAL_CTX_WINDOW (see intentInlineCapBytes),
  // so relaxing context lets bigger docs stay inlined automatically.
  const INTENT_EXTS = new Set([".md", ".todo"]);
  const INTENT_INLINE_SIZE_CAP = intentInlineCapBytes(LOCAL_CTX_WINDOW);
  try {
    const files = await listCanvasFiles(project || undefined);
    if (files.length > 0) {
      const intentEntries: string[] = [];
      const listingEntries: string[] = [];
      for (const f of files) {
        const ext = f.name.substring(f.name.lastIndexOf(".")).toLowerCase();
        // Skip meta cards (canvas-back, skills, etc.). Their on-disk file is
        // a shell; their real content is surfaced through other sections of
        // this prompt (e.g. canvas-back.md is already emitted as "## Project
        // Context" above).
        const meta = await getCardClassMeta(ext, project);
        if (meta.meta) continue;

        if (BINARY_EXTS.has(ext)) {
          listingEntries.push(`- \`${f.name}\` (${f.size} bytes, binary)`);
          continue;
        }
        if (!INTENT_EXTS.has(ext)) {
          // Listing-only: code, config, data, custom card classes. Agent
          // reads on demand (or delegates to a subagent that reads). No
          // abstract — code-file abstracts would need language-specific
          // parsing and add little signal vs. the orchestrator just
          // checking the file's role from its name + extension.
          listingEntries.push(`- \`${f.name}\` (${f.size} bytes)`);
          continue;
        }
        if (f.size > INTENT_INLINE_SIZE_CAP) {
          // Big intent doc — extract H1 title + first paragraph so the
          // orchestrator knows what the doc is about and can decide
          // whether to read it on this turn. The bare "20K bytes" is
          // useless for routing decisions; "Authentication: login,
          // logout, session storage" is enough to choose.
          const docMeta = await extractDocAbstract(f.name, project || undefined);
          listingEntries.push(
            formatListingEntry(f.name, f.size, docMeta, "large doc, read with `read_file` when relevant"),
          );
          continue;
        }
        // Intent doc, small enough to inline — emit with full content.
        try {
          const file = await readProjectFile(f.name, project || undefined);
          if (isLikelyBinary(f.name, file.content)) {
            listingEntries.push(`- \`${f.name}\` (${f.size} bytes, binary)`);
          } else if (file.content.length === 0) {
            intentEntries.push(`### ${f.name} (empty — intentional shell or placeholder)`);
          } else {
            intentEntries.push(`### ${f.name}\n${file.content}`);
          }
        } catch {
          listingEntries.push(`- \`${f.name}\` (${f.size} bytes, unreadable)`);
        }
      }
      if (intentEntries.length > 0) {
        parts.push(`## Project Files (intent docs — full content)`);
        for (const e of intentEntries) parts.push(e);
      }
      if (listingEntries.length > 0) {
        parts.push(
          `## Project Files (other — listing only)\n\n` +
          `Use \`read_file\` to pull any of these when you need their content. They are NOT pre-loaded — keeping them out of baseline lets the parent turn handle long sessions without overflow.\n\n` +
          listingEntries.join("\n"),
        );
      }
    }
  } catch { /* ignore */ }

  // Resolve canvasRoot once — both the delegation cheat sheet and the
  // "File Locations" block below need it. Default matches initProject's
  // DEFAULT_CANVAS_ROOT so a missing config doesn't dump stale "docs"
  // references into the agent's prompt.
  let canvasRoot = DEFAULT_CANVAS_ROOT;
  try {
    const cfg = JSON.parse(await readFile(join(getMicaDir(project), "config.json"), "utf-8"));
    canvasRoot = cfg.canvasRoot || cfg.docsDir || DEFAULT_CANVAS_ROOT;
  } catch { /* use default */ }

  // Available subagents + orchestrator mode — injected every turn.
  // Skills (including decompose-task) only fire when the user's message
  // pattern-matches their description, which local Qwen often misses. This
  // section gives the agent unconditional awareness of its delegation options
  // and teaches the orchestrator workflow that keeps multi-file builds
  // structurally below the context-overflow line.
  try {
    const agents = await loadProjectSubagents(project, "qwen");
    if (agents.length > 0) {
      const hasDecomposer = agents.some((a) => a.name === "task-decomposer");
      const hasComponentCoder = agents.some((a) => a.name === "component-coder");
      const lines: string[] = [
        `## Subagents available for delegation`,
        ``,
      ];
      for (const a of agents) {
        lines.push(`- **${a.name}**: ${a.description}`);
      }
      if (hasDecomposer && hasComponentCoder) {
        // Thin pointer to the full orchestrator workflow, which lives in the
        // decompose-task skill body. Saves ~1.5K prompt tokens vs inlining the
        // workflow on every turn — the model only loads it when it actually
        // enters orchestrator mode. The trigger guidance + skip rules are kept
        // here at prompt level because the model needs them to decide whether
        // to invoke the skill in the first place.
        lines.push(
          ``,
          `**For non-trivial multi-file or planning-shaped work — your FIRST tool call MUST be the \`decompose-task\` skill.** Its body has the full orchestrator workflow: gates (tenets 12 & 14), dispatch shape, per-item \`[ ]\`→\`[~]\`→\`[x]\` lifecycle, failure-mode handling, and verification stages. Don't read project files inline first; the decomposer reads what it needs in its own slot. Reading 10 files inline burns the budget the decomposer should spend for you.`,
          ``,
          `Triggers: build / implement / create / refactor / restructure / review / design / audit / "figure out next steps" / "plan how we'd add Z" / "assess the codebase" — even when paired with file references ("the spec", "the design docs"). The temptation to read-first on these is the failure mode.`,
          ``,
          `Skip ONLY for: typo fixes, single-config tweaks, or narrow Q&A about one function. Spec / interfaces / canvas-back revisions are NOT skip-eligible — they're planning-shaped because they affect every downstream subagent. Multi-section edits in one file are NOT "single-file edits". If the user explicitly says "just do it directly", respect that.`,
        );
      } else {
        // Fallback: project doesn't have the orchestrator subagents installed.
        // Tell the agent to do the lighter inline-decomposition pattern.
        lines.push(
          `(This project doesn't have the \`task-decomposer\` and \`component-coder\` subagents installed for the full orchestrator pattern. Use lighter inline decomposition instead:)`,
          ``,
          `- Plan produces **>2 files of new code**: delegate each unit to a Subagent.`,
          `- Single component spans **>200 lines of new code**: delegate.`,
          `- Independent components can run in parallel: name multiple Subagents in one response.`,
          ``,
          `**BEFORE delegating**, write or update \`${canvasRoot}/interfaces.md\` with any shared types / function signatures / data shapes. Subagents have fresh context and cannot see each other's in-flight work — contracts MUST live on canvas first.`,
        );
      }
      const subBudget = subagentBudgetBytes(LOCAL_CTX_WINDOW);
      lines.push(
        ``,
        `## Subagent context budget (when sizing dispatches)`,
        ``,
        `Each subagent runs in its own ${LOCAL_CTX_WINDOW}-token slot, with the following I/O budget after overhead:`,
        ``,
        `- Total I/O per dispatch: ${fmtKB(subBudget.totalIO)}`,
        `- Per-input file cap: ${fmtKB(subBudget.perInput)} (above this, dispatch must use offset/limit reads)`,
        `- Per-output file cap: ${fmtKB(subBudget.perOutput)} (above this, the next dispatch reading it overflows)`,
        ``,
        `When you dispatch \`component-coder\` (or other executor) for a plan item, mentally cost the reads + writes that item implies. If a single item would blow these budgets, ask the \`task-decomposer\` to refactor — split the item, split the target file, or scope to partial reads via \`offset:\` + \`limit:\`. Cheaper to refactor the plan than to overflow a subagent and lose the dispatch.`,
        ``,
        `Concurrency is capped per-project (default 3 concurrent local, 4 OpenRouter). If you dispatch more, the extras queue.`,
      );
      parts.push(lines.join("\n"));
    }
  } catch { /* no subagents available — skip section */ }

  // mica.* API reference — same block subagents see, so the parent has the
  // surface in front of it whether it's dispatching or doing inline work.
  // Earlier this lived in the subagent baseline only; the parent reverted to
  // its prior on inline tasks (e.g. "review and revise spec.md") and produced
  // specs that had cards calling LLM endpoints directly. Adding here closes
  // that gap. ~700 token cost on the parent's baseline.
  parts.push(MICA_API_REFERENCE_BLOCK);

  parts.push(`## File Locations
- The canvas directory is \`${canvasRoot}/\` — this is where everything visible on the canvas lives
- ALL cards you create (.chat, .todo, .terminal, .mmd, .md, etc.) MUST go in \`${canvasRoot}/\`
- ALL planning files (specs, decisions, notes) MUST go in \`${canvasRoot}/\`
- Files OUTSIDE \`${canvasRoot}/\` are not on the canvas by default — the user can pin them via the filebrowser if they want them visible
- NEVER write files to .mica/ — that directory is managed by Mica internally
- The .mica/ directory contains metadata only (layout, config, AI context). Do not read or write it directly.

## Calling \`run_shell_command\` — REQUIRED parameters
The \`is_background\` parameter is **REQUIRED** on every \`run_shell_command\` call. Forgetting it deadlocks the SDK silently — the call hangs and no tool_result comes back.
- One-shot commands (\`mkdir\`, \`npx tsc --noEmit\`, \`python -m py_compile\`, \`bash -n\`, \`npm test\`, \`git status\`): pass \`is_background: false\`.
- Long-running processes (\`npm run dev\`, \`python -m http.server\`, \`mongod\`): pass \`is_background: true\`. ALSO redirect stdout/stderr (\`>logs/server.log 2>&1\`) so the process doesn't die when its file descriptors close.
Always include \`is_background\`. No exceptions.

## DANGER: You Run Inside The Mica Container
You execute shell commands inside the same container that runs Mica itself. These processes belong to Mica and must NOT be touched:
- **Port 5173** — Mica's frontend (vite dev server). NEVER \`pkill vite\` or kill this port.
- **Port 3002** — Mica's backend API. NEVER kill this.
- **Port 8012, 8013** — vLLM inference servers. NEVER kill these.
- Any process matching \`vite\`, \`tsx server/index.ts\`, \`vllm\`, \`npm run dev\`, or under \`/workspaces/mica/\` is Mica. Leave it alone.

If you need to test a web app the user is building, launch it on a DIFFERENT port (e.g. 9000, 9090) — don't use 5173 or 3002. If a port conflict happens, use a different port rather than killing anything.`);

  // Vision capability declaration. The underlying model is Qwen3.6-35B-A3B
  // multimodal with mmproj-F16 loaded by llama-server — vision IS active on
  // this runtime. Without this explicit note, the model's prior pulls it
  // toward saying "I can't view images" even when an image IS attached to
  // a tool result (confirmed by curl tests that show the same model
  // correctly describes image content when called directly, while the
  // agent flow self-reports as blind). The note nudges the prior.
  parts.push(`## Vision

This runtime is multimodal (Qwen3.6-35B-A3B with mmproj). When a user message or tool result includes an image, describe what's actually visible — don't fall back to "I can't view images."`);

  // Unified Mica tools prelude — same prose qwen, Claude, and opencode get.
  parts.push(buildAgentToolsPrelude());

  parts.push(`## Asking the user a question

When you need information from the user — a clarification, a design decision, an approval — invoke the \`ask_user_question\` tool. Do NOT write a question into a plain-text response and rely on the user to read and reply.

Why: \`ask_user_question\` renders an interactive dialog in the chat card. The user clicks an option (or types a free answer) and Mica routes the response back deterministically. A question in plain text becomes a message the user has to read, scroll back to, and answer free-form — slower for them and ambiguous for you (their reply might address the question OR something else).

Rules:
- **Use \`ask_user_question\` for ANY question requiring a user reply.** This includes "Should I proceed?", "Which option do you prefer?", "Is X what you meant?", clarifications about ambiguous requests, approval gates before destructive actions.
- **Provide \`options\` when the answer space is finite.** Two-to-five options is ideal; the user clicks. Each option should be a complete, self-contained answer ("Use Three.js OrbitControls" not just "Yes").
- **Omit \`options\` for genuinely open-ended questions.** The user types a free response. Still use the tool — the dialog signals "I'm waiting for your input" clearly.
- **One \`ask_user_question\` invocation can carry multiple questions** via the \`questions\` array. Use this when you have several related decisions to gather at once. Don't fire serial tools.
- **After invoking, end your turn.** Mica returns a deny-message confirming the question was shown; do NOT call additional tools after that. The user's next chat message IS the answer.

The only time it's OK to ask in plain text is rhetorical or framing-level ("This raises the question of whether we should..."), where you don't actually need the user to reply.

## Arc completion marker
When a coherent arc of work ends — the user's task is done, or the conversation has reached a natural stopping point where starting fresh would not lose anything important — emit the literal marker \`<thread-state>arc-complete</thread-state>\` as the last line of your response. This is Mica's signal that the chat can reset its context cursor. Use it sparingly and only at genuine breaks (task finished, question answered, plan ratified). Do NOT emit it mid-task, after tool errors, or when the user is still iterating.

## Keep chat cards topic-scoped
Each chat card on the canvas is meant to hold one ongoing conversation about one topic. When the user opens a distinctly different topic in an existing card, acknowledge briefly but suggest spawning a new chat card scoped to the new topic. One sentence is enough — do not pressure. This keeps each card focused and prevents context-overflow on long-running cards.`);

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

// Append "…" whenever displayed text omits content. truncDots handles plain
// length truncation; firstLineDots handles "show first line of a multi-line
// command" where dropped subsequent lines also count as truncation.
function truncDots(s: string, n: number): string {
  if (!s || s.length <= n) return s;
  return s.slice(0, n) + "…";
}

function firstLineDots(s: string, n: number): string {
  if (!s) return s;
  const first = s.split("\n")[0];
  const truncated = first.length > n || s.length > first.length;
  return truncated ? first.slice(0, n) + "…" : first;
}

function describeToolUse(name: string, input: Record<string, unknown>): string {
  if (!input) return name;
  // Strip MCP server prefix (e.g. `mcp__mica-card-class__mica_create_class`
  // → `mica_create_class`) so name-matching logic below sees the bare name.
  const bareName = name.replace(/^mcp__[^_]+(?:-[^_]+)*__/, "");
  const n = bareName.toLowerCase().replace(/[_-]/g, "");
  // Was this an MCP-prefixed tool? If so, the substring heuristics below
  // (n.includes("search"), n.includes("read"), etc.) over-match — e.g. an
  // mcp tool named google_books_search would get labeled "Search: ..."
  // even though it's an HTTP API call, not a filesystem search. Skip those
  // heuristics for MCP-prefixed tools and let them fall through to the
  // generic "<bareName>: <hint>" fallback. Specific MCP tools (mica_create_class
  // etc.) still match their explicit rules above the heuristic block.
  const isMcp = name.startsWith("mcp__");
  const filePath = String(input.file_path || input.filePath || input.path || input.file || "");
  const fileName = filePath.split("/").pop() || "";
  const cmd = String(input.command || input.cmd || input.script || "");

  // Skill tool — surface which skill is being invoked.
  if (n === "skill") {
    const skill = String(input.skill || input.name || "");
    return skill ? `📚 skill: ${skill}` : "📚 skill";
  }
  // Subagent dispatch — surface the subagent name + short description.
  if (bareName === "agent" || bareName === "task" || bareName === "Task" || bareName === "Agent") {
    const subagent = String(input.subagent_type || input.agent || "");
    const desc = truncDots(String(input.description || ""), 60);
    if (subagent && desc) return `🤖 subagent: ${subagent} (${desc})`;
    if (subagent) return `🤖 subagent: ${subagent}`;
    if (desc) return `🤖 subagent: ${desc}`;
    return "🤖 subagent dispatch";
  }
  // Web fetch — surface the URL (truncated).
  if (n === "webfetch" || n === "fetch") {
    const url = String(input.url || input.link || "");
    return url ? `🌐 web_fetch: ${truncDots(url, 100)}` : "🌐 web_fetch";
  }
  // Web search — surface the query.
  if (n === "websearch") {
    const q = String(input.query || input.q || "");
    return q ? `🔍 web_search: ${truncDots(q, 80)}` : "🔍 web_search";
  }
  // Mica card-class tools — surface the class name + file when relevant.
  if (n === "micacreateclass") {
    const cls = String(input.name || "");
    return cls ? `🆕 create class: ${cls}` : "🆕 create class";
  }
  if (n === "micaeditclassfile") {
    const cls = String(input.class || "");
    const file = String(input.file || "");
    return cls && file ? `📝 edit class: ${cls}/${file}` : cls ? `📝 edit class: ${cls}` : "📝 edit class file";
  }
  if (n === "micacreatecardinstance") {
    const ext = String(input.class_extension || "");
    const fn = String(input.filename || "");
    return ext && fn ? `🃏 create instance: ${fn}${ext}` : "🃏 create card instance";
  }
  if (n === "micadeleteclass") {
    return `🗑 delete class: ${String(input.name || "")}`.trim();
  }
  if (n === "micadeletecardinstance") {
    return `🗑 delete instance: ${String(input.filename || "")}`.trim();
  }
  if (n === "micalistclasses") {
    return "📋 list card classes";
  }
  // Render capture — surface which card.
  if (n === "rendercapture") {
    const fn = String(input.filename || "");
    return fn ? `📸 screenshot: ${fn}` : "📸 screenshot";
  }
  // URL inspection (mica_inspect_url) — server-side dependency-URL probe.
  if (n === "micainspectururl" || n === "inspecturl") {
    const url = String(input.url || "");
    return url ? `🔬 inspect URL: ${truncDots(url, 100)}` : "🔬 inspect URL";
  }
  // Skill-package discovery + install.
  if (n === "micalistskillpackages") {
    const q = String(input.query || "");
    return q ? `📦 list skill packs: ${q}` : "📦 list skill packs";
  }
  if (n === "micainstallskills") {
    const src = String(input.source || "");
    return src ? `📥 install skills: ${src}` : "📥 install skills";
  }
  // Tavily web tools — same shape as web_fetch / web_search, but registered
  // under MCP so they skip the heuristic block below. Match by stripped name.
  if (n === "tavilysearch") {
    const q = String(input.query || "");
    return q ? `🔍 tavily search: ${truncDots(q, 80)}` : "🔍 tavily search";
  }
  if (n === "tavilyextract") {
    const url = String(input.url || (Array.isArray(input.urls) ? input.urls[0] : "") || "");
    return url ? `🌐 tavily extract: ${truncDots(String(url), 100)}` : "🌐 tavily extract";
  }
  if (n === "tavilycrawl") {
    const url = String(input.url || "");
    return url ? `🕸 tavily crawl: ${truncDots(url, 100)}` : "🕸 tavily crawl";
  }
  if (n === "tavilymap") {
    const url = String(input.url || "");
    return url ? `🗺 tavily map: ${truncDots(url, 100)}` : "🗺 tavily map";
  }
  // Shell/bash
  // The substring heuristics below apply to SDK BUILT-IN tools (read_file,
  // write_file, grep_search, glob, etc.). MCP-prefixed tools skip them and
  // fall through to the generic fallback — they have arbitrary names like
  // google_books_search that shouldn't be conflated with filesystem search.
  if (!isMcp) {
    if (n.includes("bash") || n.includes("shell") || n === "executecommand" || n === "runcmd") {
      const firstLine = firstLineDots(cmd, 120);
      return firstLine ? `💻 $ ${firstLine}` : `💻 Running command`;
    }
    // File read
    if (n.includes("read") || n === "cat" || n === "viewfile") {
      return `📖 Read ${fileName || "file"}`;
    }
    // File write
    if (n.includes("write") || n.includes("create") || n === "savefile") {
      return `💾 Write ${fileName || "file"}`;
    }
    // File edit
    if (n.includes("edit") || n.includes("patch") || n.includes("replace")) {
      return `✏️ Edit ${fileName || "file"}`;
    }
    // Search/grep
    if (n.includes("grep") || n.includes("search") || n.includes("glob") || n.includes("find")) {
      const pattern = String(input.pattern || input.query || input.regex || "");
      return pattern ? `🔎 Search: ${truncDots(pattern, 60)}` : `🔎 Searching files`;
    }
    // List files
    if (n.includes("list") || n === "ls") {
      return `📂 List ${filePath || "files"}`;
    }
  }
  // Todo write (qwen built-in)
  if (n === "todowrite") {
    const todos = (input.todos as Array<{ content?: string }> | undefined) || [];
    if (todos.length > 0) {
      const inProgress = todos.find((t) => (t as { status?: string }).status === "in_progress");
      if (inProgress?.content) return `✅ todo: ${truncDots(inProgress.content, 80)}`;
      return `✅ todo (${todos.length} item${todos.length === 1 ? "" : "s"})`;
    }
    return "✅ todo update";
  }
  // Fallback — show tool name + any useful input. For MCP tools that
  // didn't match a specific rule above, fall back to the first string-
  // valued input field as a hint (typically a query, url, or similar
  // identifier that's more informative than just the tool name).
  let hint = cmd ? `: ${firstLineDots(cmd, 60)}` : fileName ? `: ${fileName}` : "";
  if (!hint) {
    for (const [, v] of Object.entries(input)) {
      if (typeof v === "string" && v.length > 0 && v.length <= 200) {
        hint = `: ${truncDots(v, 60)}`;
        break;
      }
    }
  }
  return `${bareName}${hint}`;
}

// -- Channel handler factory --

const USER_IDLE_BEFORE_AGENT_MS = 60000; // Wait 60s of quiet before delivering file events to the agent.
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
    canvasRoot: string;        // e.g. "canvas" — files outside this (and not pinned) don't trigger reactive turns
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
    args: Record<string, unknown>,
    ctx: SessionContext
  ): Promise<ChannelHandler> {
    // Capture project at session creation. All file ops in this closure
    // use sessionProject — the user can switch projects without redirecting
    // this session's writes to the wrong .mica/chats directory.
    const sessionProject = ctx.project;
    // Speech rendering moved out of the chat agent: per CLAUDE.md tenet 3
    // (pipes, not policy), chat cards are pure text. If a .voice card is
    // on the canvas, Mica's voice agent subscribes to this chat agent's
    // broadcasts and announces replies via Kokoro. Chat agent never emits
    // assistant_speech frames anymore.
    let voicePref = args && typeof args.voice === "string" ? (args.voice as string) : undefined;
    // Chat history is keyed by the session's stable UUID (the file's per-card
    // sidecar id). Stable across renames; isolated per file even if two
    // projects share the same filename.
    const chatId = ctx.sessionId;
    let busy = false;
    // Queue carries plain strings for text turns, or {text, attach} for
    // image-bearing turns. The drain handler below branches on shape.
    // Queued messages waiting for the current turn to finish. Items are
    // structured (vs. the bare-string-or-tuple shape this used to be) so
    // the chat card can show source attribution + per-item cancellation.
    // The full text lives here; broadcasts truncate to ~160 chars for
    // wire transport.
    interface QueuedItem {
      id: string;
      text: string;
      attach?: string;
      source: "user" | "voice" | "file-changes" | "recovery";
      queuedAt: number;
    }
    let queue: QueuedItem[] = [];

    // Restore the persisted queue from disk so anything queued before a
    // server restart resumes processing. Done synchronously-from-async
    // before any new messages can land via onData (handler factory hasn't
    // returned yet). The in-flight turn at restart-time is gone — its
    // message was shifted out before processing began — so we only
    // recover what was queued behind it.
    queue = await loadChatQueue<QueuedItem>(chatId, sessionProject);
    if (queue.length > 0) {
      console.log(`[mica-agent] restored ${queue.length}-item queue from .mica/chats/${chatId}.queue.json`);
    }

    /** Persist + broadcast the queue. Called after every push/shift/cancel/clear. */
    async function commitQueue(): Promise<void> {
      try {
        await saveChatQueue(chatId, queue, sessionProject);
      } catch (err) {
        console.warn(`[mica-agent] queue persist failed: ${(err as Error).message}`);
      }
      // Broadcast a slim version (truncated text, ordered list) so all
      // attached clients can render the queue panel.
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

    /** Push a fresh item onto the queue. Source is inferred from the
     *  channel onData call site. */
    function enqueueMessage(text: string, source: QueuedItem["source"], attach?: string): QueuedItem {
      const item: QueuedItem = {
        id: randomUUID(),
        text,
        source,
        queuedAt: Date.now(),
        ...(attach ? { attach } : {}),
      };
      queue.push(item);
      void commitQueue();
      return item;
    }

    /** Pop the next queued item and persist. Returns undefined if empty. */
    function dequeueNext(): QueuedItem | undefined {
      const next = queue.shift();
      if (next) void commitQueue();
      return next;
    }

    let activeAbort: AbortController | null = null;
    // The current turn's SDK query handle. Tracked so the interrupt
    // path (user clicks stop, or session destroy) can call q.interrupt()
    // + q.close() — the canonical lifecycle methods per
    // node_modules/@qwen-code/sdk/README.md "Query Handle Methods".
    // Without this, only abortController.abort() was being called, which
    // triggers SIGTERM-only via the SDK's killChildProcess. Empirically
    // insufficient: SDK CLI subprocesses survived stop clicks and kept
    // pumping requests to llama-server, with no SIGKILL escalation. See
    // 2026-05-02 incident — orphan PID 1705048 with active TCP connection
    // to :8012 hours after the user clicked stop.
    let activeQuery: { interrupt: () => Promise<void>; close: () => Promise<void>; isClosed: () => boolean } | null = null;

    // Per-turn ephemeral-event buffer. A client joining mid-turn (second tab,
    // refresh) gets the persisted chat history via onAttach, but the live
    // events of the in-flight turn (thinking, progress, user_question, error)
    // are emitted via ctx.broadcast and would otherwise be invisible to the
    // late-joiner — the new tab would sit in "Ready" state until the agent
    // finally lands an `assistant` event minutes later.
    //
    // Fix: intercept ctx.broadcast, mirror the call to live clients (via the
    // captured original) AND push replayable events to a per-session buffer.
    // Auto-clear on `assistant`/`error` (turn end) so the buffer is non-empty
    // ONLY while a turn is in flight — late-joiners between turns get history
    // alone, exactly as before. onAttach below replays the buffer to each
    // newly-attached client after sending history.
    //
    // Filter: `user`/`assistant` are persisted to chat history; replaying
    // them would dup the message bubbles. Only events without a chat-history
    // counterpart are buffered.
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
        ? "Review what changed and respond proportionally. Short acknowledgement " +
          "for small or incidental edits; for substantive changes (spec, plan, " +
          "decisions, doc updates) read the relevant file(s), engage with what " +
          "you noticed, and offer next steps. Do NOT take destructive or " +
          "build-shaped actions (creating cards, writing code, deleting files) " +
          "without explicit user confirmation — propose first."
        : "Files were deleted. Respond with a brief acknowledgement; no action.";

      const message = `[File activity] These files changed since your last reply:\n${lines.join("\n")}\n\n${tail}`;

      if (busy) {
        enqueueMessage(message, "file-changes");
      } else {
        processMessage(message);
      }
    }

    sessionState.deliverFn = deliverCoalescedEvents;

    async function processMessage(message: string, source: QueuedItem["source"] = "user") {
      // Guard against concurrent invocations. If another processMessage is
      // mid-flight, queue this one instead of racing. Caller should have
      // checked busy already and gone through enqueueMessage with proper
      // source attribution; this defensive push preserves whatever source
      // the caller intended.
      if (busy) {
        console.log(`[mica-agent] processMessage called while busy — queueing: ${message.slice(0, 60)}`);
        enqueueMessage(message, source);
        return;
      }
      // Capture the source so the turn-end assistant broadcast can include
      // it. Voice's broadcast listener uses this to decide whether to
      // read the reply in full (voice-dispatched, the user is on voice
      // and wants to hear it all) or just summarize (background ambient).
      const turnSource = source;
      busy = true; sessionState.busy = true;
      markProjectActivity(sessionProject, +1);
      console.log(`[mica-agent] processMessage START: ${message.slice(0, 60)}`);
      // Reset the per-turn render_capture cap. Fresh user message ⇒ fresh
      // budget for screenshot verifications. Without this the cap leaks
      // across turns and a single project would only ever get the first 5
      // captures before being refused forever.
      resetRenderCaptureCount(sessionProject);

      // Per-turn read tracking. Used by checkCardClassPrecondition to refuse
      // card-class authoring writes until the agent has read the card-class-handbook
      // skill in this same turn. Reset each processMessage so the requirement
      // is per-turn rather than per-session (skills fall out of context as
      // history scrolls; safer to require a fresh read).
      const readFilesThisTurn = new Set<string>();

      // Per-turn working-set map: tracks read_file calls so we can dedup
      // re-reads of the same path with unchanged mtime. The SDK accumulates
      // every tool_result block in the running prompt — re-reading a file
      // re-injects its full content into the next iteration's prompt, even
      // though the prior content is still in context. This map intercepts
      // the second read in canUseTool and returns a brief "already in your
      // working set" stub, saving N×fileSize tokens of prompt growth.
      //
      // Map key: absolute file path (resolved). Value: { mtime, iter, full }.
      // mtime mismatch → re-allow (file edited since prior read).
      // Partial read with offset/limit → currently NOT deduped (different
      // ranges legitimately request different bytes).
      // After write_file/edit on the path, the entry is removed so the next
      // read sees the post-write content.
      const workingSetReads = new Map<string, { mtime: number; iter: number; full: boolean }>();
      let canUseToolIter = 0;

      // Per-turn direct-write cap. After this many direct file writes, further
      // write attempts are denied with a hint that REDIRECTS the agent to the
      // `task` tool (delegation). This is the hard enforcement layer behind
      // the soft "## Available Subagents" guidance in buildContext.
      //
      // Cap is intentionally low (2) so the agent can't quietly bypass
      // delegation by directly writing a half-dozen files before the cap
      // bites. Two free writes accommodates small bootstrapping (e.g. interfaces.md
      // + a tiny stub) before everything else routes through subagents.
      //
      // Subagent-originated writes do NOT count against this cap (they run in
      // a separate session and don't re-enter the parent's canUseTool).
      const MAX_WRITES_PER_TURN = 2;
      let writesThisTurn = 0;

      // Per-turn metrics state. Emitted at each termination path so we capture
      // successful turns, empty-response turns, and error turns. See
      // server/metrics.ts for the schema.
      const turnId = randomUUID();
      const tsStart = Date.now();
      let firstTokenTs: number | null = null;
      const toolCallCounts: Record<string, number> = {};
      const subagentStarts = new Map<string, { name: string; tsStart: number }>();
      let subagentCount = 0;
      // Names of skills explicitly invoked via the SDK's `skill` tool. The
      // chat card's per-turn footer surfaces these by name (not just count).
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
        // Per-card provider routing. Read fresh each turn so settings changes
        // take effect on the next message without restarting the session.
        // Resolved BEFORE buildContext so the runtime banner can include the
        // actual model name — that's how skills tell whether we're on Qwen-30B
        // or Claude-via-OpenRouter and calibrate their thresholds.
        const cardSettings = await readCardSettings(sessionProject || undefined, ctx.filename);
        // Provider allowlist: anything unknown falls back to local. The
        // PUT endpoint does the same — defense in depth in case a stale
        // sidecar JSON pre-dates this provider value.
        let provider: "local" | "openrouter" | "openai-compat";
        if (cardSettings.provider === "openrouter") provider = "openrouter";
        else if (cardSettings.provider === "openai-compat") provider = "openai-compat";
        else provider = "local";
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
          // Default model resolution: per-card gear setting > OPENROUTER_DEFAULT_MODEL
          // env var (from .env) > built-in fallback.
          modelName = cardSettings.model || process.env.OPENROUTER_DEFAULT_MODEL || "anthropic/claude-3.5-sonnet";
        } else if (provider === "openai-compat") {
          // Generic OpenAI-compatible endpoint: user-supplied baseUrl +
          // key (api.openai.com, Together, Groq, self-hosted vLLM, etc.).
          // Stored per-project alongside OpenRouter creds. The Qwen SDK
          // speaks OpenAI protocol natively — we just point it at a
          // different baseUrl + key.
          const cfg = await readOpenAICompatConfig(sessionProject || undefined);
          if (!cfg.baseUrl) {
            ctx.broadcast({
              type: "error",
              error: "OpenAI-compatible provider selected but no base URL set. Open the gear icon and add the endpoint URL.",
            });
            return;
          }
          if (!cfg.key) {
            ctx.broadcast({
              type: "error",
              error: "OpenAI-compatible provider selected but no API key set. Open the gear icon and add a key.",
            });
            return;
          }
          // Normalize: ensure baseUrl ends with /v1 (the SDK expects an
          // OpenAI-shaped path). Most providers expose /v1; if the user
          // pasted the host root we add it.
          baseUrl = cfg.baseUrl.replace(/\/+$/, "");
          if (!/\/v\d+$/.test(baseUrl)) baseUrl = baseUrl + "/v1";
          apiKey = cfg.key;
          // Model: gear-setting-only. No env-var default — the user's
          // endpoint catalog is unique to their provider.
          modelName = cardSettings.model || "gpt-4o-mini";
        } else {
          baseUrl = LLAMA_URL.replace(/\/v1$/, "") + "/v1";
          apiKey = "dummy";
          // The qwen-code SDK gates image modality off the model name via a
          // hardcoded regex: `/^qwen3-vl-/` → enables `{ image: true,
          // video: true }`. Any other name strips image content to
          // "[Unsupported modality]" text BEFORE sending to the model — which
          // breaks render_capture tool-result delivery and any image-bearing
          // input. So the SDK-facing alias MUST start with `qwen3-vl-`.
          //
          // Naming convention (see scripts/start.sh for the canonical list):
          //   - SDK callers (here, plugins/llmAgent.ts): use `qwen3-vl-local`.
          //     The `qwen3-vl-` prefix is load-bearing; do NOT rename to
          //     `qwen-vl` here without first removing the SDK regex constraint.
          //   - Direct vLLM callers (renderCapture.ts, etc.): use `qwen-vl`.
          //     Semantic name; not subject to the SDK regex.
          //   - Voice callers: use `qwen-voice`.
          // vLLM serves all three names from the same Qwen3.6-35B-A3B-NVFP4
          // container today.
          modelName = cardSettings.model || "qwen3-vl-local";
        }
        console.log(`[mica-agent] provider=${provider} model=${modelName} baseUrl=${baseUrl}`);

        const since = getLastTurnAt(ctx.filename);

        // Surface validator/runtime errors entering this turn as a step in
        // the chat-card's progress feed. The errors flow through the buffer
        // into the agent's prompt below; this broadcast just makes the
        // injection visible to the user — they see "[N] Received X
        // validator/runtime errors" in the step list, confirming the agent
        // received the same errors that surfaced in the bubble UI without
        // the user needing to manually escalate.
        if (sessionProject) {
          // Match the buildContext injection: count only fresh errors so the
          // UI agrees with what the agent actually sees this turn. Stale
          // entries (class edited after error, pending browser re-verify)
          // are deliberately suppressed and shouldn't surface as "Received
          // N errors" in the progress feed.
          const { fresh: incomingErrors } = getFreshPendingValidatorErrors(sessionProject, getProjectDir(sessionProject));
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

        const context = await buildContext(ctx.filename, sessionProject, since, modelName);
        // Capture the rendered system-prompt context for this turn so the chat
        // card's per-turn footer can surface a "view snapshot" link. Sidecar
        // file at `.mica/chats/<chatId>/snapshots/<turnId>.txt`. Fire-and-forget;
        // failures are swallowed (snapshots are an observability nice-to-have).
        void writeSnapshot(sessionProject, chatId, turnId, context);

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
        //
        // Prepend the canvas baseline (canvas-back + project files + file
        // location rules) to each subagent's systemPrompt. Without this,
        // subagents start with only their role description + the parent's
        // task prompt — they don't know what the project IS or what files
        // exist on canvas, leading to path confusion and wandering reads.
        const subagentsRaw = await loadProjectSubagents(sessionProject, "qwen");
        const subagentBaseline = subagentsRaw.length > 0
          ? await buildSubagentCanvasContext(sessionProject, modelName)
          : "";
        const subagents = subagentsRaw.map((a) => ({
          ...a,
          systemPrompt: subagentBaseline
            ? `${a.systemPrompt}\n\n---\n\n# Canvas baseline (shared with parent agent)\n\n${subagentBaseline}`
            : a.systemPrompt,
        }));
        if (subagents.length > 0) {
          const names = subagents.map((s) => s.name).join(", ");
          console.log(`[mica-agent] subagents: ${names} (canvas baseline: ${subagentBaseline.length} chars)`);
        }

        // Inject recent chat history into the prompt so the agent has conversational
        // continuity. Without this, each turn is a goldfish — the SDK's `query()`
        // call only sees the current user message. Include up to ~6 prior turn-pairs
        // (12 messages), capped at ~6K chars total so the system prompt + history
        // comfortably fit in ctx=65536. Skip the most recent entry (it's the user
        // message we just pushed above and will send as the actual prompt).
        //
        // Cursor-aware: messages before `cursor` belong to an earlier arc the
        // agent has been released from. Only slice from cursor onward. The user
        // still sees full scroll in the UI; the agent's view is bounded.
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
        // reliably ignores buried system-prompt rules but pays attention to
        // text adjacent to the actual user input. Same lever pattern we use
        // for participate-fully compliance — fresh text wins over distant
        // directives. ~30-token cost per turn; cheap insurance.
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
          const t0 = Date.now();
          const debugTag = `[canUseTool:${toolName}]`;
          console.log(`${debugTag} ENTRY input.file_path=${(input.file_path as string) || "-"} writes=${writesThisTurn}/${MAX_WRITES_PER_TURN}`);
          try {
            const r = await canUseToolInner(toolName, input);
            console.log(`${debugTag} EXIT ${r.behavior} elapsed=${Date.now() - t0}ms${"message" in r ? ` msg=${r.message.slice(0, 80)}` : ""}`);
            return r;
          } catch (err) {
            console.error(`${debugTag} THREW elapsed=${Date.now() - t0}ms err=${(err as Error).message}`);
            throw err;
          }
        }

        async function canUseToolInner(toolName: string, input: Record<string, unknown>) {
          const safety = await guardTool(toolName, input);
          if (safety.behavior === "deny") return safety;

          // write_file requires file_path. Qwen has been observed calling
          // it with only `content` (file_path omitted); the SDK then
          // returns a generic error and the agent often abandons the
          // write — most visibly after the develop skill where the spec
          // composition lives in the agent's context but never reaches
          // disk. Catch this at the boundary with a same-turn structured
          // hint so the agent retries with the right argument.
          if (toolName === "write_file" || toolName === "Write") {
            const fp = (input as { file_path?: unknown }).file_path;
            if (typeof fp !== "string" || fp.length === 0) {
              return {
                behavior: "deny" as const,
                message:
                  `${toolName} requires a non-empty 'file_path' argument; you passed only 'content'. ` +
                  `Retry with file_path specified — e.g. for a spec: ` +
                  `${toolName}({ file_path: 'canvas/<name>-spec.md', content: '...' }). ` +
                  `Do not announce the spec as drafted until the file exists.`,
              };
            }
          }

          // Protected-path check — blocks write_file / edit on paths owned
          // by Mica-structured tools (mica_create_class for metadata.json,
          // mica_edit_class_file for card.{js,html,css}, .mica/layout.json
          // not writable at all). The agent's tool-result loop reads the
          // structured rejection and retries with the correct tool, which
          // then fires its own predicate gates (spec must exist, handbook
          // must be invoked) — restoring the develop flow's ordering.
          const protectedCheck = checkProtectedPath(toolName, input);
          if (protectedCheck) {
            console.log(`[protected-path] ${toolName} blocked: ${(input.file_path as string) || (input.path as string) || ""}`);
            return protectedCheck;
          }

          // Track which files the agent has read this turn (for precondition checks).
          if (toolName === "read_file" || toolName === "Read") {
            const p = pathFromReadInput(input);
            if (p) readFilesThisTurn.add(p);
          } else if (toolName === "read_many_files") {
            const paths = (input.paths as string[]) || [];
            for (const p of paths) if (p) readFilesThisTurn.add(p);
          }

          // Working-set dedup for read_file. If the agent calls read_file on
          // a path it already read this turn AND the file's mtime hasn't
          // changed since, deny with a stub pointing at the prior tool_result.
          // The prior content is still in context — re-reading just bloats the
          // running prompt with a duplicate copy. Saves K×fileSize tokens
          // per re-read.
          //
          // Skipped when:
          //   - offset/limit specified (different range = legitimately new content)
          //   - file mtime changed since the recorded read (file was edited)
          //   - prior entry was a partial read (full read should be allowed)
          //   - stat fails (file deleted / permissions) — let the read proceed
          //     and surface its own error
          canUseToolIter++;
          if (toolName === "read_file" || toolName === "Read") {
            const rawPath = pathFromReadInput(input);
            const offset = (input as { offset?: unknown }).offset;
            const limit = (input as { limit?: unknown }).limit;
            const isPartial = typeof offset === "number" || typeof limit === "number";
            if (rawPath && !isPartial) {
              try {
                const { stat } = await import("fs/promises");
                const { resolve } = await import("path");
                const abs = resolve(rawPath);
                const s = await stat(abs);
                const prior = workingSetReads.get(abs);
                if (prior && prior.full && prior.mtime === s.mtimeMs) {
                  return {
                    behavior: "deny" as const,
                    message:
                      `"${abs}" is already in your working set (read at iteration ${prior.iter}, ` +
                      `mtime unchanged since). The prior tool_result for this read is still in your ` +
                      `context — refer to that content rather than re-reading. Re-reads are only ` +
                      `useful after a write_file/edit on this path; otherwise the prior content is ` +
                      `the current truth. To force a fresh read pass an offset/limit (different range).`,
                  };
                }
                // Allow + record. We don't know yet if the read will succeed,
                // but the file exists per the stat above; record proactively.
                workingSetReads.set(abs, { mtime: s.mtimeMs, iter: canUseToolIter, full: true });
              } catch { /* stat failed — let the read proceed and produce its own error */ }
            }
          }
          // Invalidate working-set entry on writes so subsequent reads of the
          // post-write content are allowed. write_file (full replacement) and
          // edit (partial mutation) both change the file's mtime.
          if (toolName === "write_file" || toolName === "edit" || toolName === "Write" || toolName === "Edit") {
            const wp = (input as { file_path?: unknown }).file_path;
            if (typeof wp === "string") {
              try {
                const { resolve } = await import("path");
                workingSetReads.delete(resolve(wp));
              } catch { /* ignore */ }
            }
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
          // The Qwen SDK names the subagent-invocation tool "agent" (lowercase
          // singular). Older docs said "task" — accept both for forward/back
          // compat. Confirmed in production via:
          //   [mica-agent] tool_use: agent input={"description":"...","prompt":"..."}
          if ((toolName === "agent" || toolName === "task") && sessionProject) {
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
                  `Direct-write cap hit (${writesThisTurn}/${MAX_WRITES_PER_TURN} this turn). ` +
                  `Do NOT call write_file/edit again from this turn — those payloads stay in your context for the rest of the turn and will balloon it.` +
                  `\n\n` +
                  `For the remaining work, delegate to the component-coder Subagent using natural-language phrasing in your response. Example: ` +
                  `\n` +
                  `"Have the component-coder Subagent implement <path/to/file> per docs/spec.md § <section>." ` +
                  `\n\n` +
                  `Each delegation runs in a separate context and returns only a short summary, so this turn stays small. ` +
                  `If the remaining work is just a single tiny edit you genuinely cannot delegate, end this turn instead with a plain-text summary of what you wrote and what's next. The user will reply 'continue'.`,
              };
            }

            if (["write_file", "write_to_file", "create_file"].includes(toolName)) {
              const filePath = pathFromWriteInput(input);
              const protReason = checkProtectedPathPrecondition(filePath);
              if (protReason) return { behavior: "deny" as const, message: protReason };

              const preReason = checkCardClassPrecondition(filePath, readFilesThisTurn);
              if (preReason) return { behavior: "deny" as const, message: preReason };

              const libReason = checkLibraryDiscoveryPrecondition(filePath, readFilesThisTurn);
              if (libReason) return { behavior: "deny" as const, message: libReason };

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
            // LSP integration removed 2026-05-01. Previously routed through
            // scripts/qwen-lsp-wrapper.mjs to inject `--experimental-lsp` and
            // surface LSP tools (goToDefinition, findReferences, diagnostics,
            // workspaceDiagnostics, codeActions, etc.) into the agent's tool
            // set. Removed because the agent never invoked any LSP tool across
            // observed sessions (e.g. moon3: 0 LSP calls out of 82 tool uses)
            // — the ~200 prompt tokens advertising the LSP surface were paid
            // every turn for zero ROI. Syntax checks for card.js are handled
            // by the subagent's `node -e vm.compileFunction(...)` step, which
            // catches the same parse-level errors LSP would.
            //
            // Revive (~15 min, restore wrapper from git + add this line back)
            // if any of:
            //   - a cross-file refactor task underperforms grep+edit and
            //     `findReferences` / `codeActions` would clearly do better
            //   - we ship a card-classes globals shim (e.g. `mica.d.ts`
            //     declaring `mica` and `container`) so LSP diagnostics on
            //     card.js stop being noise
            //   - a server-side TS workflow wants push-style
            //     `workspaceDiagnostics` instead of `tsc --noEmit`
            // Without the shim, do NOT revive for card.js — false positives on
            // every `mica.*` reference make the signal unusable.
            //
            // Forward CLI stderr to our log. Independent of LSP — useful for
            // any qwen-side error surfaced via stderr.
            stderr: (msg: string) => {
              const trimmed = msg.trim();
              if (trimmed) console.log(`[qwen-stderr] ${trimmed.slice(0, 600)}`);
            },
            // For local llama-server the model name is informational (server uses
            // the model loaded at startup). The legacy "openai:local" magic string
            // worked because llama-server ignores model. OpenRouter validates strictly,
            // so we send the bare id (e.g. "anthropic/claude-3.5-sonnet"). The
            // openai-compatible provider is selected via authType, not via prefix.
            model: provider === "local" ? `openai:${modelName}` : modelName,
            authType: "openai" as const,
            // Hard step cap. The SDK loops user→tool_use→tool_result→…→
            // assistant; each round counts as one "turn" in qwen-code's
            // sense (see node_modules/@qwen-code/sdk/dist/index.d.ts:663-667
            // "A turn consists of a user message and an assistant response").
            // Default is unset → SDK uses its built-in 50 ceiling, which we
            // hit in pathological cases (the task_stop fabrication loop that
            // ate 50 turns to exit-53). 30 leaves headroom for legitimate
            // multi-tool builds (typical card-class build: 4-8 tool calls;
            // task decomposition with verification: 12-20) while catching
            // runaway loops earlier. Mica's per-card render_capture cap (5),
            // direct-write cap (2), and skill-followthrough recovery all
            // also bound the same surface — this is the outermost rail.
            maxSessionTurns: 30,
            // "yolo" auto-approves ALL tools. canUseTool is never invoked.
            //
            // Why not "default" (where canUseTool would actually fire):
            // subagent-initiated tool calls hang the SDK under every non-
            // yolo mode. Verified against @qwen-code/sdk 0.1.6 with
            // `scripts/probe-canusetool.ts`:
            //   - default + parent write/shell: canUseTool fires in ~40ms ✓
            //   - default + subagent write: tool_use observed, canUseTool
            //     never fires, SDK waits forever (60s+ timeout)
            //   - auto-edit + subagent shell: same hang
            //   - yolo: works everywhere (no gating)
            // The SDK has a canUseTool-in-subagent-session bug (tracked
            // upstream as anthropic/claude-code#27203 for Claude; same
            // pattern in the Qwen SDK). Until fixed upstream, non-yolo
            // modes are unusable for any session that delegates.
            //
            // Consequence: everything in canUseToolInner below is dead
            // code. The guard moves elsewhere:
            //   - metadata consistency: enforced post-write in index.ts
            //     via enforceCardClassMetadata (self-heals missing
            //     extension, surfaces mismatches as card-error).
            //   - shell safety, write caps, precondition checks, etc.:
            //     still todo; relocate to the tool_use event observer
            //     below (can detect + abort the turn via activeAbort,
            //     though can't prevent the in-flight tool call).
            permissionMode: "yolo" as const,
            // Drop the SDK's background-task tools from the agent's surface.
            // They ship as a triple (`agent` launches, `send_message` posts,
            // `task_stop` cancels) intended for async tasks the agent monitors
            // over multiple turns. Mica calls `agent` synchronously — the
            // subagent runs inline and returns its result — so there is never
            // a background task to message or cancel. Leaving them advertised
            // tempts the model into hallucinating task IDs and burning turns
            // (observed: 13 task_stop calls on fabricated IDs in one session,
            // each returning TASK_STOP_NOT_FOUND, contributing to a 50-turn
            // cap exhaustion / FatalTurnLimitedError exit-53). `agent` stays;
            // only the async-management peers are excluded.
            // NOTE: do not add `web_fetch` here. The Qwen SDK's
            // extractShellOperations translates `curl <URL>` into a virtual
            // web_fetch(domain) operation, and excludeTools entries are
            // merged into permissionsDeny (see SDK getPermissionsDeny). So
            // denying web_fetch also denies every curl call — agents lose
            // URL verification, npm registry lookups, and the entire
            // discover-dependency smoke-test path. The web_fetch deterrent
            // stays in the prelude prose only.
            excludeTools: ["task_stop", "send_message"],
            canUseTool: canUseToolWithQuestionIntercept,
            abortController: activeAbort,
            systemPrompt: { type: "preset", preset: "qwen_code", append: context },
            // Project-defined subagents. Parent delegates heavy single-component
            // work (e.g. "implement src/email_monitor.py") via the SDK's `task`
            // tool, keeping the parent's context small. See plan:
            // /home/vscode/.claude/plans/joyful-honking-hinton.md
            ...(subagents.length > 0 ? { agents: subagents } : {}),
            // MCP servers registered with the agent:
            //
            //   - "mica-render": SDK-hosted, exposes `render_capture`.
            //     buildRenderMcpServer returns what createSdkMcpServer()
            //     produces — { type: "sdk", name, instance }. Use it
            //     directly; wrapping again produces `{ instance: <config> }`
            //     which the SDK .connect()'s and fails with "i.connect is
            //     not a function". Tool result returns the PNG inline (MCP
            //     ImageContent) so the next LLM call sees it via Qwen3.6-35B-A3B's
            //     vision (mmproj-F16 loaded by llama-server). Skipped when
            //     project is unset or SDK exports are missing.
            //
            // Third-party MCP servers (tavily, etc.) are NOT registered here —
            // they live in `<project>/.qwen/settings.json` `mcpServers` and
            // are merged in by the qwen SDK at session start (cli.js
            // newSessionConfig). Policy: mica registers only framework
            // primitives (server-name prefix `mica-`) that depend on mica's
            // runtime context. Anything else is project configuration the
            // user can edit/disable/swap. The migrate-out of tavily happened
            // 2026-05-02 — see template at
            // templates/dgx-spark-local/.qwen/settings.json.
            ...(() => {
              const servers: Record<string, unknown> = {};
              // mica-builtins: unified hub for Mica-internal tools that
              // reach /api/tools/* via REST. Shared across qwen, Claude,
              // opencode. Tool defs live in server/agentTools/registry.ts.
              // Currently exposes: render_capture, mica_create_class,
              // mica_edit_class_file, mica_create_card_instance,
              // mica_delete_card_instance, mica_delete_class,
              // mica_list_classes. The previous standalone mica-card-class
              // SDK MCP was retired in favor of this unified surface.
              const builtinsServer = buildMicaToolsMcpServer(sessionProject, ctx.filename);
              if (builtinsServer) servers["mica-builtins"] = builtinsServer;
              // mica-tools: project-scoped third-party CLI tools, declared in
              // <project>/.mica/tools.json. Each tool there becomes a callable
              // mcp__mica-tools__<server>_<op>. See server/plugins/cliMcp.ts
              // and the add-third-party-tool skill.
              const cliMcpServer = buildCliMcpServer(sessionProject);
              if (cliMcpServer) servers["mica-tools"] = cliMcpServer;
              return Object.keys(servers).length > 0 ? { mcpServers: servers } : {};
            })(),
            env: {
              OPENAI_API_KEY: apiKey,
              OPENAI_BASE_URL: baseUrl,
            },
          },
        }) as AsyncIterable<Record<string, unknown>>;
        // Track the query handle so the interrupt path can call q.interrupt()
        // + q.close() — the SDK's canonical lifecycle methods. The SDK
        // returns an iterable that's also a Query handle with these methods;
        // see node_modules/@qwen-code/sdk/dist/index.d.ts:839-876.
        activeQuery = q as unknown as { interrupt: () => Promise<void>; close: () => Promise<void>; isClosed: () => boolean };

        let resultText = "";
        let filesChanged = false;
        // Final turn usage from the SDK's `result` event. Shape: { input_tokens, output_tokens, ... }.
        // CRITICAL: input_tokens here is CUMULATIVE across every LLM call in the
        // tool loop (20 tool rounds = 20 prompt sends summed). It is NOT the
        // last-request prompt size and must NOT be used for the fuel gauge —
        // a 20-iteration turn easily reads "300% of context window" if we do.
        // For the gauge we track peakIterationInput separately below.
        let usage: Record<string, unknown> | null = null;
        // Per-iteration input_tokens, captured from each `assistant` SDK event's
        // message.usage. The SDK emits assistant messages between tool rounds;
        // each carries the prompt size of THAT iteration's request. The running
        // max across the turn is the true "peak prompt pressure" — the number
        // the gauge should display.
        let peakIterationInput = 0;
        // Local llama-server: known fixed context. Remote providers
        // (openrouter, openai-compat): unknown until the SDK reports
        // it via modelUsage on first turn — start at 0 and let the
        // SDK fill it in.
        let contextWindow: number = provider === "local" ? LOCAL_CTX_WINDOW : 0;
        // SDK error result detection: when llama-server / OpenRouter returns a
        // 400 (e.g. context overflow), the SDK emits a result event with
        // `is_error: true, subtype: "error_during_execution", error: { message }`
        // — not a thrown exception. Without inspecting these fields the result
        // text stays empty, the success path runs, and the chat card sees a
        // bland "Done." instead of the error → its overflow detector never
        // fires, no Clear/Spawn affordance appears. Capture the message here
        // and route through the error broadcast below.
        let sdkResultError: string | null = null;

        // Thinking-only termination guard. Qwen3.6 can emit a final assistant
        // event whose only block is `thinking` (no `text`, no `tool_use`),
        // after which the SDK signals `result +0ms` and the turn ends with
        // no visible output. We flip this flag per parent-context assistant
        // event so the post-loop check below can detect that pattern and
        // trigger a one-shot recovery re-prompt. Defaults true so a turn
        // with no assistant events (early error, abort) doesn't get flagged.
        let lastAssistantHadAction = true;

        // Skill follow-through guard. The qwen-code SDK has a `skill` tool
        // that loads instruction text into the model's context — the model
        // is then expected to follow the instructions with its NEXT tool
        // call (e.g., `decompose-task` skill demands a `task` call to the
        // task-decomposer subagent). Observed failure: model loads the
        // skill, narrates "I'm dispatching..." in text, then ends the
        // turn without ever firing the demanded tool. We mirror that
        // failure shape into `pendingSkillFollowup`: set when a skill
        // tool_use fires in parent context, cleared on any other parent-
        // context tool_use. If the turn ends with this still set, the
        // model loaded the skill but never acted on it — re-prompt once.
        let pendingSkillFollowup: string | null = null;

        // Track in-flight subagent task invocations (tool_use_id → nothing,
        // Set is sufficient). beginSubagentTask was called in canUseTool; we
        // call endSubagentTask when the matching tool_result arrives so the
        // concurrency counter drains naturally. Turn-end cleanup handles any
        // stragglers (SDK error, abort) so the counter never drifts across
        // turns.
        const outstandingSubagentTasks = new Set<string>();

        let _evtSeq = 0;
        let _lastEvtAt = Date.now();
        for await (const evt of q) {
          const evtType = evt.type as string;
          _evtSeq++;
          const now = Date.now();
          const gap = now - _lastEvtAt;
          _lastEvtAt = now;
          // Compact event trace: type, parent_tool_use_id (so we can see when
          // a subagent is the source), gap from previous event. Helps narrow
          // down where the SDK loop stalls when nothing reaches us for a long
          // time after a tool call. Hidden from broadcast — server log only.
          const ptid = (evt as { parent_tool_use_id?: string | null }).parent_tool_use_id || "";
          console.log(`[mica-agent:evt#${_evtSeq}] ${evtType}${ptid ? ` parent=${ptid.slice(0, 8)}` : ""} +${gap}ms`);

          if (evtType === "assistant" && evt.message) {
            // First assistant event = proxy for time-to-first-token (prefill done).
            if (firstTokenTs === null) firstTokenTs = Date.now();
            // Per-iteration prompt size — track the running max so the post-turn
            // gauge reads peak prompt pressure (not the cumulative sum that
            // result.usage.input_tokens carries).
            const msgUsage = (evt.message as { usage?: { input_tokens?: number } }).usage;
            if (msgUsage && typeof msgUsage.input_tokens === "number" && msgUsage.input_tokens > peakIterationInput) {
              peakIterationInput = msgUsage.input_tokens;
            }
            const msg = evt.message as { content?: Array<{ type: string; name?: string; text?: string; thinking?: string; input?: Record<string, unknown> }> };
            if (msg.content) {
              for (const block of msg.content) {
                if (block.type === "thinking") {
                  const t = block.thinking || "";
                  console.log(`[mica-agent] THINKING block (${t.length} chars): ${t.slice(0, 120).replace(/\n/g, " ")}...`);
                  // Parent-context thinking → progress event so the chat card's
                  // detail panel shows the agent's reasoning between tool calls.
                  // Without this, the panel sits at "Starting..." for the 5-30s
                  // the agent thinks before its first tool call, giving the user
                  // no signal that the system is working. 💭 prefix distinguishes
                  // reasoning from tool calls (which carry no prefix or ⚠ for errors).
                  if (!ptid && t) {
                    ctx.broadcast({
                      type: "progress",
                      tool: "thinking",
                      description: "💭 " + truncDots(t.replace(/\n/g, " "), 100),
                    });
                  }
                  // Subagent-context thinking → strip the live activity line
                  // for the matching panel. Truncate to 80 chars; display-only.
                  if (ptid && t) {
                    ctx.broadcast({
                      type: "subagent_event",
                      tool_use_id: ptid,
                      kind: "thinking",
                      summary: truncDots(t.replace(/\n/g, " "), 80),
                    });
                  }
                }
                if (block.type === "tool_use" && block.name) {
                  console.log(`[mica-agent] tool_use: ${block.name} input=${JSON.stringify(block.input || {}).slice(0, 200)}`);
                  toolCallCounts[block.name] = (toolCallCounts[block.name] || 0) + 1;
                  // Skill-invocation observer — records which skills the agent
                  // has invoked in this chat session so predicate gates in
                  // toolPrerequisites.ts can ask "has the agent read the
                  // handbook yet?" (etc.) without baking the same knowledge
                  // into prose the model compresses across turns.
                  if (block.name === "skill") {
                    const skillArg = (block.input as { skill?: string } | undefined)?.skill;
                    if (typeof skillArg === "string" && skillArg) {
                      recordSkillInvocation(sessionProject, ctx.filename, skillArg);
                    }
                  }
                  // Parent-context tool_use → progress event (drives the chat
                  // card's live status line + step count). Subagent-context
                  // tool_use (ptid non-empty) → subagent_event ONLY (drives
                  // the strip). Without the !ptid guard, every subagent tool
                  // call counted toward the parent's stepCount and painted
                  // the parent's status line, producing visible duplication
                  // ("Write decomposition.md" appearing in both the top
                  // status row AND the subagent strip; "7 steps" reflecting
                  // subagent calls that didn't belong to the parent's count).
                  if (!ptid) {
                    ctx.broadcast({
                      type: "progress",
                      tool: block.name,
                      description: describeToolUse(block.name, block.input || {}),
                    });
                  }
                  // Subagent-context tool_use → broadcast subagent_event so
                  // the chat card's strip can show "X is running tavily_search".
                  if (ptid) {
                    ctx.broadcast({
                      type: "subagent_event",
                      tool_use_id: ptid,
                      kind: "tool_use",
                      description: describeToolUse(block.name, block.input || {}),
                    });
                  }
                  // Track outstanding subagent tasks so the concurrency counter
                  // decrements when they finish. SDK tags each tool_use with an
                  // `id` we'll match against the tool_result. Qwen's tool name
                  // is "agent" (confirmed at runtime); "task" kept for
                  // forward/back compat with older SDK builds.
                  if (block.name === "agent" || block.name === "task") {
                    const taskId = String((block as { id?: unknown }).id || "");
                    if (taskId) {
                      outstandingSubagentTasks.add(taskId);
                      subagentCount++;
                      const input = block.input || {};
                      const subName = String(
                        (input as Record<string, unknown>).subagent_type ||
                        (input as Record<string, unknown>).agent_type ||
                        (input as Record<string, unknown>).name ||
                        "unknown"
                      );
                      subagentStarts.set(taskId, { name: subName, tsStart: Date.now() });
                      // Subagent visibility broadcast (server side of the chat
                      // card's strip + status badge). Pairs with subagent_event
                      // (per parent_tool_use_id'd message) and subagent_finished
                      // (on tool_result OR drain). See plan: "Subagent visibility".
                      const desc = String((input as Record<string, unknown>).description || "");
                      ctx.broadcast({
                        type: "subagent_started",
                        tool_use_id: taskId,
                        agent_type: subName,
                        description: desc,
                      });
                    }
                  }
                  // Capture skill name when the SDK's `skill` tool fires.
                  // Defensive multi-key extraction — exact key varies across
                  // SDK versions. If the chip ever shows zero, log block.input
                  // once and adjust the lookup.
                  if (block.name === "skill") {
                    const input = (block.input as Record<string, unknown>) || {};
                    const skillName = String(
                      input.skill_name ?? input.skill ?? input.name ?? ""
                    );
                    if (skillName) skillsInvoked.push(skillName);
                  }
                  // Skill follow-through: set on skill load, clear on any
                  // other parent-context tool. See declaration above.
                  if (!ptid) {
                    if (block.name === "skill") {
                      const input = (block.input as Record<string, unknown>) || {};
                      const skillName = String(
                        input.skill_name ?? input.skill ?? input.name ?? ""
                      );
                      pendingSkillFollowup = skillName || "(unknown)";
                    } else {
                      pendingSkillFollowup = null;
                    }
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
              // Parent-context only: did this event produce any visible action?
              // Subagent thinking-only events are the subagent's concern; our
              // guard fires on parent-turn termination.
              if (!ptid) {
                const hasToolUse = msg.content.some(
                  (b) => b.type === "tool_use" && b.name,
                );
                lastAssistantHadAction = Boolean(turnText) || hasToolUse;
              }
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
                  // Emit per-subagent metric when the matching start is known.
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
                    // Subagent visibility: matched a known start → broadcast
                    // finished with the result text as summary. Status is
                    // "failed" if the SDK marked the result as is_error,
                    // else "done". Truncate summary to 120 chars for the
                    // strip; the full text is in the chat card's transcript
                    // already (the parent's tool_result block).
                    const isErr = Boolean((block as { is_error?: boolean }).is_error);
                    const resultContent = (block as { content?: unknown }).content;
                    let summary = "";
                    if (typeof resultContent === "string") {
                      summary = resultContent;
                    } else if (Array.isArray(resultContent)) {
                      const first = resultContent.find((c) => (c as { type?: string }).type === "text") as { text?: string } | undefined;
                      summary = first?.text || "";
                    }
                    ctx.broadcast({
                      type: "subagent_finished",
                      tool_use_id: block.tool_use_id,
                      status: isErr ? "failed" : "done",
                      summary: summary.slice(0, 120).replace(/\n/g, " "),
                    });
                  }
                }
              }
            }
          }

          if (evtType === "result") {
            const result = evt.result as { text?: string } | undefined;
            if (result?.text) resultText = result.text;
            // SDK signals provider-side errors via is_error + error.message
            // on the result event. See server/cli.js: buildResultMessage.
            if ((evt as { is_error?: boolean }).is_error) {
              const errInfo = (evt as { error?: { message?: string } }).error;
              const raw = errInfo?.message?.trim() || "Provider returned an error";
              const subtype = String(evt.subtype || "");
              // Friendly message when the maxSessionTurns hard cap fired.
              // SDK signals this via subtype="error_max_turns" (and historically
              // FatalTurnLimitedError exit-53). User-facing message points at
              // the likely cause and the recovery action — they need to know
              // their next message restarts the budget.
              if (/turn.*limit|max.*turn|FatalTurnLimited/i.test(raw) || subtype === "error_max_turns") {
                sdkResultError =
                  "Agent hit the per-message step cap (30 tool rounds). This usually means a tool loop — render_capture re-captures, repeated retries, or a subagent that didn't settle. Send another message to continue; partial work is preserved.";
              } else {
                sdkResultError = raw;
              }
              console.log(`[mica-agent] SDK result is_error subtype=${subtype} message=${raw.slice(0, 200)}`);
            }
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
        // Tear down the SDK transport explicitly. The for-await drain
        // doesn't always trigger the SDK's child-process cleanup; q.close()
        // is the canonical end-of-session signal. SIGTERM, then SIGKILL
        // after timeout. Without this, even a normally-ended turn could
        // leave the qwen-code CLI subprocess alive holding a llama-server
        // slot until the next backend restart.
        if (activeQuery) {
          const q = activeQuery;
          activeQuery = null;
          try { if (!q.isClosed()) void q.close().catch(() => {}); } catch {}
        }

        // Drain any outstanding subagent tasks from the concurrency counter.
        // Normal flow decrements per-task as tool_results arrive; this covers
        // the SDK-error / abort path where some tasks never got their result.
        // Also broadcast subagent_finished:failed for each so the chat card's
        // strip transitions out of the "running" state instead of spinning
        // forever after a parent abort.
        if (sessionProject && outstandingSubagentTasks.size > 0) {
          for (const id of outstandingSubagentTasks) {
            endSubagentTask(sessionProject);
            ctx.broadcast({
              type: "subagent_finished",
              tool_use_id: id,
              status: "failed",
              summary: "(parent turn aborted before subagent returned)",
            });
            subagentStarts.delete(id);
          }
          outstandingSubagentTasks.clear();
        }

        // Thinking-only termination guard. When the model's final assistant
        // event was a thinking block with no text or tool_use, the SDK ended
        // the turn but the user sees nothing. Re-prompt once with a synthetic
        // continuation so the agent gets a chance to actually write the
        // reply or fire the next tool. Cap at one retry per real user turn —
        // source === "recovery" means we're already inside the retry; if it
        // recurs there, give up rather than loop.
        // Fires when the LAST assistant event was thinking-only — no text,
        // no tool_use. The trustworthy signal is lastAssistantHadAction —
        // it tracks whether the LATEST assistant event produced visible
        // output. We deliberately do NOT also require !resultText.trim():
        // earlier events in the turn may have produced text + tool calls,
        // landing partial work and partial prose; if the final event was
        // 100% thinking, the model believed it was about to do more work
        // but didn't ship it. Observed failure: 21k-char THINKING block
        // after a render_capture tool_result, with no follow-up edit —
        // model "saw what was wrong, planned the fix in its head, ran out
        // of output tokens or hit the SDK's step cap before emitting the
        // fix as a tool call." Recovery re-prompts so the actual fix
        // ships in the next turn.
        const thinkingOnlyTermination =
          !lastAssistantHadAction && !sdkResultError;
        if (thinkingOnlyTermination && source !== "recovery") {
          console.log(
            `[mica-agent] thinking-only turn detected; enqueueing recovery re-prompt for: ${message.slice(0, 60)}`,
          );
          ctx.broadcast({
            type: "progress",
            tool: "thinking-only-recovery",
            description: "⚠ Reasoning-only after tool calls — auto-continuing.",
          });
          // Preserve earlier visible text if any (the user already saw it);
          // append a note. If nothing visible at all, fall back to the
          // generic placeholder so the chat bubble isn't empty.
          if (resultText.trim()) {
            resultText = `${resultText}\n\n_(Reasoning-only after that — continuing.)_`;
          } else {
            resultText = "_(Reasoning-only turn — continuing.)_";
          }
          enqueueMessage(
            "Your previous turn ended with a long internal-reasoning block but " +
              "produced no follow-up action — no further visible text, no tool " +
              "call. If you said 'let me fix X' or 'let me check Y' or were " +
              "planning an edit, execute the concrete tool call now (write_file, " +
              "edit, mica_edit_class_file, render_capture, etc.). Internal " +
              "reasoning is invisible to the user — only the tool_use blocks and " +
              "the user-visible text count as 'doing the work.'",
            "recovery",
          );
        } else if (thinkingOnlyTermination && source === "recovery") {
          console.log(`[mica-agent] thinking-only recurred on recovery — giving up`);
          ctx.broadcast({
            type: "progress",
            tool: "thinking-only-recovery",
            description: "⚠ Recovery turn ended without visible output — giving up.",
          });
          resultText = "_(The agent ended without a visible reply. Try rephrasing your question.)_";
        } else if (pendingSkillFollowup && source !== "recovery") {
          // Skill-follow-through recovery. Model loaded a skill but the
          // turn ended without the action tool the skill demands (e.g.,
          // loaded `decompose-task` but never fired `task` for the
          // task-decomposer subagent; loaded `card-class-handbook` but
          // never called `mica_create_class` / `mica_edit_class_file`).
          // The model narrated the action in text; saying it is not
          // doing it. Inject one re-prompt that names the loaded skill
          // and demands the tool call this turn. Cap at one retry per
          // user turn — `source === "recovery"` already inside it.
          console.log(
            `[mica-agent] skill-follow-through gap: loaded "${pendingSkillFollowup}" with no action tool — enqueueing recovery for: ${message.slice(0, 60)}`,
          );
          ctx.broadcast({
            type: "progress",
            tool: "skill-followthrough-recovery",
            description: `⚠ Loaded ${pendingSkillFollowup} but didn't act — auto-continuing.`,
          });
          enqueueMessage(
            `Your previous turn loaded the \`${pendingSkillFollowup}\` skill but didn't take ` +
              `the action it specified. Re-read what that skill told you to do, then emit the ` +
              `concrete tool call now (most skills demand a \`task\` dispatch, a \`write_file\`, ` +
              `or one of the \`mica_*\` tools — not more prose). Narrating "I'm dispatching ` +
              `to X" is not the same as dispatching; only the tool_use block counts. ` +
              `Do not load another skill on this turn — execute the pending action.`,
            "recovery",
          );
        } else if (!resultText.trim()) {
          resultText = filesChanged ? "Done -- I made changes." : "Done.";
        }

        // If the agent tried to ask the user via AskUserQuestion, surface those
        // questions in the chat reply so they actually reach the user.
        if (pendingQuestionText) {
          resultText = (resultText.trim() && resultText.trim() !== "Done.") ? `${resultText}\n\n${pendingQuestionText}` : pendingQuestionText;
        }

        // Detect the arc-complete marker emitted by the agent at natural
        // stopping points. Strip it from the user-visible text so chat
        // bubbles stay clean; keep the signal for cursor-advance below.
        const ARC_COMPLETE_RE = /<thread-state>\s*arc-complete\s*<\/thread-state>/i;
        const arcComplete = ARC_COMPLETE_RE.test(resultText);
        if (arcComplete) resultText = resultText.replace(ARC_COMPLETE_RE, "").trim();

        // Peak prompt pressure across the turn = max(per-iteration input_tokens)
        // captured from each `assistant` SDK event above. NOT the cumulative
        // sum that result.usage.input_tokens reports. Falls back to baseline
        // if no assistant events carried usage (early errors, abort).
        const peakTokens = peakIterationInput > 0 ? peakIterationInput : baselineTokens;

        // Decide whether to advance the cursor. We advance only at genuine arc
        // breaks AND when capacity is tight enough (>80%) that the next turn
        // would benefit. Below 80% the cache-invalidation cost of advancing
        // isn't justified. Mid-arc advances never happen silently — those
        // surface as Clear/Spawn prompts in the UI at >95%.
        const capacity = contextWindow > 0 ? peakTokens / contextWindow : 0;
        let cursorAdvanced = false;
        let newCursor = cursor;

        const updatedHistory = await loadHistory(chatId, sessionProject);
        updatedHistory.push({ role: "assistant", content: resultText, agent: "Qwen", turn_id: turnId });
        await saveHistory(chatId, updatedHistory, sessionProject);

        if (arcComplete && capacity > 0.80) {
          newCursor = updatedHistory.length;
          await writeChatCursor(chatId, sessionProject, newCursor, updatedHistory.length);
          cursorAdvanced = true;
          console.log(`[mica-agent] cursor advanced to ${newCursor} (capacity ${Math.round(capacity * 100)}%, arc-complete)`);
        }

        const tsEnd = Date.now();
        const durationMs = tsEnd - tsStart;
        const ttftMs = firstTokenTs !== null ? firstTokenTs - tsStart : null;

        // If the SDK reported a provider-side error on the result event
        // (most commonly llama-server 400 for context overflow), broadcast
        // it as an error so the chat card's overflow detector at
        // card-classes/chat/card.js:719 can pattern-match the message and
        // surface the Clear/Spawn affordance. Skip the success-path
        // broadcast and the metric record; the catch-block path below
        // already handles its own metric for failed turns.
        if (sdkResultError) {
          console.log(`[mica-agent] broadcasting error (sdk-result path) for: ${message.slice(0, 60)}: ${sdkResultError.slice(0, 100)}`);
          ctx.broadcast({ type: "error", error: sdkResultError });
          void recordTurn(sessionProject, {
            turn_id: turnId,
            ts_start: tsStart,
            ts_end: tsEnd,
            duration_ms: durationMs,
            ttft_ms: ttftMs,
            chat_id: chatId,
            agent: "qwen",
            model: modelName,
            input_tokens: typeof (usage as { input_tokens?: unknown })?.input_tokens === "number" ? (usage as { input_tokens: number }).input_tokens : 0,
            output_tokens: typeof (usage as { output_tokens?: unknown })?.output_tokens === "number" ? (usage as { output_tokens: number }).output_tokens : 0,
            baseline_tokens: baselineTokens,
            context_window: contextWindow,
            capacity,
            subagent_count: subagentCount,
            tool_calls: toolCallCounts,
            skills_invoked: skillsInvoked,
            files_changed: filesChanged ? 1 : 0,
            cursor_advanced: false,
            arc_complete: false,
          });
          return;
        }

        console.log(`[mica-agent] broadcasting assistant (success path) for: ${message.slice(0, 60)} (peak ${peakTokens} / ${contextWindow}) source=${turnSource}`);
        ctx.broadcast({
          type: "assistant",
          content: resultText,
          agent: "Qwen",
          filesChanged,
          ...(usage ? { usage } : {}),
          ...(contextWindow > 0 ? { contextWindow } : {}),
          baselineTokens,
          // Peak prompt-size during the turn (last tool-loop iteration). The
          // chat card's fuel gauge prefers this over baselineTokens because
          // baseline is the turn-START reading; this is the turn's high-water
          // mark. Falls back to baseline if the SDK didn't report usage.
          inputTokens: peakTokens,
          arcComplete,
          capacity,
          cursor: newCursor,
          cursorAdvanced,
          durationMs,
          ...(ttftMs !== null ? { ttftMs } : {}),
          turn_id: turnId,
          // Source attribution surfaced to listeners. voiceAgent uses this
          // to decide whether to read this reply aloud in full (voice
          // dispatched the request, user is on voice and wants the answer)
          // vs the default ambient summary.
          source: turnSource,
          viaVoice: turnSource === "voice",
        });

        // (Speech rendering moved to the .voice card. The chat agent emits
        // only `assistant` broadcasts; the voice agent listens and renders
        // ambient TTS via Kokoro.)

        void recordTurn(sessionProject, {
          turn_id: turnId,
          ts_start: tsStart,
          ts_end: tsEnd,
          duration_ms: durationMs,
          ttft_ms: ttftMs,
          chat_id: chatId,
          agent: "qwen",
          model: modelName,
          input_tokens: typeof (usage as { input_tokens?: unknown })?.input_tokens === "number" ? (usage as { input_tokens: number }).input_tokens : 0,
          output_tokens: typeof (usage as { output_tokens?: unknown })?.output_tokens === "number" ? (usage as { output_tokens: number }).output_tokens : 0,
          baseline_tokens: baselineTokens,
          context_window: contextWindow,
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
        // Same SDK transport teardown as the success path. The catch fires
        // on AbortError (user clicked stop), provider errors, or SDK
        // protocol failures — in any case, close the query so the CLI
        // subprocess doesn't outlive this turn.
        if (activeQuery) {
          const q = activeQuery;
          activeQuery = null;
          try { if (!q.isClosed()) void q.close().catch(() => {}); } catch {}
        }
        const errMsg = (err as Error).message || String(err);
        // Empty response = model had nothing to say (common for reactive events)
        if (errMsg.includes("empty response")) {
          console.log(`[mica-agent] broadcasting assistant (empty-response path) for: ${message.slice(0, 60)}`);
          ctx.broadcast({ type: "assistant", content: "No action needed.", agent: "Qwen", filesChanged: false });
        } else {
          console.error(`[mica-agent] Error during ${message.slice(0, 40)}:`, errMsg);
          ctx.broadcast({ type: "error", error: errMsg });
        }
        // Minimal metric for the error/empty path. Fields scoped inside the try
        // (modelName, baselineTokens, usage) aren't accessible here; baseline
        // analysis focuses on successful turns anyway.
        const tsEnd = Date.now();
        void recordTurn(sessionProject, {
          turn_id: turnId,
          ts_start: tsStart,
          ts_end: tsEnd,
          duration_ms: tsEnd - tsStart,
          ttft_ms: firstTokenTs !== null ? firstTokenTs - tsStart : null,
          chat_id: chatId,
          agent: "qwen",
          model: "",
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
        // Surface any card-errors that survived the turn (i.e. agent didn't
        // self-heal). Errors POSTed mid-turn are held in cardErrorBuffer and
        // released here — milestone, not timer. Errors the agent fixed via
        // /ok are already cleared from the buffer; the flush is a no-op
        // for those.
        if (sessionProject) flushProjectPendingErrors(sessionProject);
        console.log(`[mica-agent] processMessage DONE: ${message.slice(0, 60)} | queue depth: ${queue.length}`);
        // Hand off to next queued message WITHOUT releasing busy outside this
        // synchronous block. setImmediate's callback briefly clears busy then
        // re-enters processMessage atomically (JS event loop is cooperative,
        // so no other handler can squeeze in between the two statements).
        const next = dequeueNext();
        if (next) {
          setImmediate(() => {
            busy = false; sessionState.busy = false;
            if (next.attach) processImageMessage(next.text, next.attach, next.source);
            else processMessage(next.text, next.source);
          });
        } else {
          busy = false; sessionState.busy = false;
          if (sessionState.coalesceBuffer.size > 0) {
            setImmediate(() => deliverCoalescedEvents());
          }
        }
      }
    }

    // Image-attached user turn. Bypasses the Qwen SDK entirely because the
    // SDK's `prompt: string` parameter can't carry image content, and the
    // tool-result image-delivery path (via `render_capture` MCP tool) is
    // fragile across chat-template + modality boundaries. Calling
    // llama-server directly with user-role image_url content is the
    // well-trodden vision path — confirmed working via curl tests.
    //
    // Trade-off: this turn has no tool-use. It's a one-shot "describe /
    // inspect this card" query. Agent-triggered verification during
    // card authoring continues to use the MCP render_capture tool.
    async function processImageMessage(text: string, attachmentFilename: string, source: QueuedItem["source"] = "user") {
      if (busy) {
        enqueueMessage(text, source, attachmentFilename);
        return;
      }
      busy = true; sessionState.busy = true;
      markProjectActivity(sessionProject, +1);
      console.log(`[mica-agent] processImageMessage START: ${text.slice(0, 60)} [attach=${attachmentFilename}]`);

      const turnId = randomUUID();
      const tsStart = Date.now();

      // Broadcast the user message with attachment marker so the chat card
      // can render a little 📷 indicator on the bubble.
      ctx.broadcast({ type: "user", content: text, attachmentFilename });

      // Persist user turn to history. Stash attachment info in the content so
      // it shows up in transcripts / agent re-reads; not pretty but honest.
      const history = await loadHistory(chatId, sessionProject);
      history.push({ role: "user", content: `${text}\n\n[📷 attached: ${attachmentFilename}]` });
      await saveHistory(chatId, history, sessionProject);

      ctx.broadcast({ type: "thinking" });

      try {
        if (!sessionProject) throw new Error("No active project");

        const capture = await captureCard(sessionProject, attachmentFilename);
        const pngBuffer = await fsReadFile(capture.path);
        const base64 = pngBuffer.toString("base64");

        // Bring along a short tail of text-only prior history so the model
        // has conversational continuity. Cursor-aware: skip messages the
        // user has "released" with a Clear.
        const cursor = await readChatCursor(chatId, sessionProject);
        const prior = history.slice(cursor, -1);
        const HISTORY_MSG_CAP = 6;
        const recent = prior.slice(-HISTORY_MSG_CAP);

        const llmMessages: Array<Record<string, unknown>> = [
          {
            role: "system",
            content:
              "You are inspecting a card rendered in the Mica canvas app. An image of the rendered card is attached to the user's latest message. Look at the attached image and answer the user's question directly based on what you see — colors, layout, visible text and numbers, any regions that look clipped, broken, overlapping, or wrong. Do not describe what the card SHOULD show based on source code. Describe what is actually in the image.",
          },
          ...recent.map((m) => ({ role: m.role, content: m.content })),
          {
            role: "user",
            content: [
              {
                type: "text",
                text: text || `Describe what you see in the attached screenshot of ${attachmentFilename}.`,
              },
              { type: "image_url", image_url: { url: `data:image/png;base64,${base64}` } },
            ],
          },
        ];

        const firstTokenAt = { t: null as number | null };
        const requestStart = Date.now();
        const res = await fetch(`${LLAMA_URL.replace(/\/v1$/, "")}/v1/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            // Direct vLLM call — uses the semantic `qwen-vl` alias (not the
            // SDK-required `qwen3-vl-local`). See ~line 1620 for the naming
            // convention.
            model: "qwen-vl",
            messages: llmMessages,
            max_tokens: 1024,
          }),
        });
        firstTokenAt.t = Date.now(); // non-streaming: approximate TTFT as full response receipt

        if (!res.ok) {
          const errBody = await res.text().catch(() => "");
          throw new Error(`llama-server ${res.status}: ${errBody.slice(0, 300)}`);
        }
        const data = await res.json() as {
          choices?: Array<{ message?: { content?: string } }>;
          usage?: Record<string, unknown>;
        };
        const reply = data.choices?.[0]?.message?.content || "(no response)";

        const tsEnd = Date.now();

        console.log(`[mica-agent] broadcasting assistant (image-path) for: ${text.slice(0, 60)} source=${source}`);
        ctx.broadcast({
          type: "assistant",
          content: reply,
          agent: "Qwen",
          filesChanged: false,
          ...(data.usage ? { usage: data.usage } : {}),
          contextWindow: LOCAL_CTX_WINDOW,
          baselineTokens: 0,
          arcComplete: false,
          capacity: 0,
          cursor,
          source,
          viaVoice: source === "voice",
          cursorAdvanced: false,
          durationMs: tsEnd - tsStart,
          ttftMs: firstTokenAt.t !== null ? firstTokenAt.t - requestStart : null,
          turn_id: turnId,
        });

        const updatedHistory = await loadHistory(chatId, sessionProject);
        updatedHistory.push({ role: "assistant", content: reply, agent: "Qwen", turn_id: turnId });
        await saveHistory(chatId, updatedHistory, sessionProject);

        const usageObj = (data.usage ?? {}) as { prompt_tokens?: unknown; completion_tokens?: unknown };
        void recordTurn(sessionProject, {
          turn_id: turnId,
          ts_start: tsStart,
          ts_end: tsEnd,
          duration_ms: tsEnd - tsStart,
          ttft_ms: firstTokenAt.t !== null ? firstTokenAt.t - requestStart : null,
          chat_id: chatId,
          agent: "qwen",
          model: "qwen-vl",
          input_tokens: typeof usageObj.prompt_tokens === "number" ? usageObj.prompt_tokens : 0,
          output_tokens: typeof usageObj.completion_tokens === "number" ? usageObj.completion_tokens : 0,
          baseline_tokens: 0,
          context_window: LOCAL_CTX_WINDOW,
          capacity: 0,
          subagent_count: 0,
          tool_calls: { attach_image: 1 },
          skills_invoked: [],
          files_changed: 0,
          cursor_advanced: false,
          arc_complete: false,
        });
      } catch (err) {
        const errMsg = (err as Error).message || String(err);
        console.error(`[mica-agent] processImageMessage error: ${errMsg}`);
        ctx.broadcast({ type: "error", error: errMsg });
      } finally {
        recordTurnEnd(ctx.filename);
        markProjectActivity(sessionProject, -1);
        console.log(`[mica-agent] processImageMessage DONE | queue depth: ${queue.length}`);
        const next = dequeueNext();
        if (next) {
          setImmediate(() => {
            busy = false; sessionState.busy = false;
            if (next.attach) processImageMessage(next.text, next.attach, next.source);
            else processMessage(next.text, next.source);
          });
        } else {
          busy = false; sessionState.busy = false;
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

          // Send the current queue snapshot so a screen joining mid-queue
          // sees pending items immediately. Without this, late-joiners
          // wait for the next push/cancel/clear before the panel renders.
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

          // Replay current-turn ephemeral events if a turn is in flight.
          // The chat card's existing case handlers process replayed events
          // identically to live ones — late-joiner transitions from "Ready"
          // through "Thinking..." / progress / etc. to current state, then
          // continues receiving live events as the turn proceeds.
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
              else enqueueMessage(scanMessage, "user");
            }, 2000);
          }
        });
      },

      onData(clientId, data) {
        const msg = data as {
          type?: string;
          message?: string;
          attachmentFilename?: string;
          voice?: string;
          id?: string;            // for cancel_queued
          _voiceMeta?: { onQueued?: (depth: number) => void };
        };

        if (typeof msg.voice === "string") voicePref = msg.voice;

        if (msg.type === "interrupt") {
          if (activeAbort) {
            try { activeAbort.abort(); } catch { /* ignore */ }
          }
          // Use the SDK's canonical interrupt + close lifecycle methods.
          // abortController.abort() alone triggers the SDK's killChildProcess
          // (SIGTERM only, no SIGKILL escalation); empirically the qwen-code
          // CLI subprocess does NOT exit on SIGTERM mid-llama-server-request,
          // leaving an orphan with an active TCP connection to :8012 that
          // keeps pumping requests after the user stopped. q.interrupt()
          // sends a control message via stdin asking for graceful cancel;
          // q.close() then tears down the transport (SIGTERM, then SIGKILL
          // after timeout). See SDK docs README.md "Query Handle Methods".
          if (activeQuery) {
            const q = activeQuery;
            q.interrupt().catch(() => { /* CLI may already be torn down */ });
            // Hard-close after a 1s grace so q.interrupt() has a chance to
            // land cleanly. If interrupt did its job, q.close() is a no-op
            // (isClosed guard skips it); otherwise it forces SIGTERM/SIGKILL.
            setTimeout(() => {
              try { if (!q.isClosed()) q.close().catch(() => {}); } catch {}
            }, 1000);
          }
          // Drop any messages the user typed while the agent was busy.
          // Without this, "stop" aborts the current turn but the next
          // queued message fires automatically in the finally block —
          // surprising behavior given that "stop" naturally reads as
          // "stop everything." The user can re-send if they actually
          // wanted that message processed.
          if (queue.length > 0) {
            console.log(`[mica-agent] interrupt: dropping ${queue.length} queued message(s)`);
            queue.length = 0;
            void commitQueue();
          }
          return;
        }

        if (msg.type === "cancel_queued") {
          // Light-weight per-item cancel from the chat card UI. Splice
          // out the matching id; no-op if it already drained (race).
          const id = typeof msg.id === "string" ? msg.id : "";
          const idx = id ? queue.findIndex((q) => q.id === id) : -1;
          if (idx >= 0) {
            const removed = queue.splice(idx, 1)[0];
            console.log(`[mica-agent] queue cancelled item ${removed.id} (queue depth: ${queue.length})`);
            void commitQueue();
          }
          return;
        }

        if (msg.type === "replace_queued") {
          // Mutate an existing queued item's text in place. Used by the
          // voice agent when the user revises a pending request rather
          // than piling a new one on top. Preserves id, source,
          // queuedAt, and position — only the text changes. No-op if
          // the id already drained (race).
          const id = typeof msg.id === "string" ? msg.id : "";
          const text = typeof msg.text === "string" ? msg.text : "";
          if (!id || !text) return;
          const idx = queue.findIndex((q) => q.id === id);
          if (idx >= 0) {
            queue[idx] = { ...queue[idx], text };
            console.log(`[mica-agent] queue replaced item ${id} (queue depth: ${queue.length})`);
            void commitQueue();
          }
          return;
        }

        if (msg.type === "clear_queue") {
          // Empty the queue without touching the in-flight turn. The
          // distinction from interrupt: clear_queue lets the current
          // turn finish, just stops anything stacked behind it.
          if (queue.length > 0) {
            console.log(`[mica-agent] clear_queue: dropping ${queue.length} queued message(s)`);
            queue.length = 0;
            void commitQueue();
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

        // Source attribution: the synthetic clientId "voice-dispatch"
        // (set by ChannelManager.dispatchToFilename) tells us this came
        // from the .voice card; everything else is a normal user send.
        const source: QueuedItem["source"] = clientId === "voice-dispatch" ? "voice" : "user";

        if (busy) {
          enqueueMessage(message, source, msg.attachmentFilename);
          // Voice expects the queue depth so it can speak "queued behind N".
          // The dispatched payload may carry a synchronous callback for
          // this — invoke it before returning.
          msg._voiceMeta?.onQueued?.(queue.length);
          return;
        }

        // Voice cares whether its dispatch landed immediately (depth=0) too.
        msg._voiceMeta?.onQueued?.(0);

        // Image-bearing turns bypass the Qwen SDK entirely. See
        // processImageMessage below for rationale — the SDK can't carry
        // images through its `prompt: string` parameter, and tool-result
        // delivery was unreliable across chat-template/modality boundaries.
        if (msg.attachmentFilename) {
          processImageMessage(message, msg.attachmentFilename, source);
        } else {
          processMessage(message, source);
        }
      },

      onDestroy() {
        if (activeAbort) {
          try { activeAbort.abort(); } catch { /* ignore */ }
        }
        // Force-close the SDK transport on session destroy (file deleted,
        // channel torn down). Same reasoning as the interrupt path: abort
        // alone leaves the CLI subprocess running.
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
