// micaAgent.ts -- Qwen Code agent channel handler.
// Uses @qwen-code/sdk to provide an agentic coding assistant.
// Registered as a ChannelManager handler for .chat files.

import { readFile, writeFile, mkdir, readdir } from "fs/promises";
import { join } from "path";
import { randomUUID } from "crypto";
import { WORKSPACE_DIR, micaDir, listCanvasFiles, readProjectFile, readCardSettings, readOpenRouterKey, readCanvasConfig, BINARY_EXTS, isLikelyBinary, CONTEXT_SOFT_CAP_CHARS, getCardClassMeta, readChatCursor, writeChatCursor, DEFAULT_CANVAS_ROOT } from "./files.js";
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
import { markProjectActivity } from "./projectActivity.js";
import { recordTurn, recordSubagent } from "./metrics.js";
import { captureCard } from "./screenshot.js";
import { readFile as fsReadFile } from "fs/promises";
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
const LOCAL_CTX_WINDOW = parseInt(process.env.LLAMA_CTX_SIZE || "65536", 10);

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
    } catch (err) {
      console.error("[mica-agent] Failed to load @qwen-code/sdk:", (err as Error).message);
      throw new Error("@qwen-code/sdk not available");
    }
  }
  return _query!;
}

/** Build the mica-render MCP server with the project bound in. A fresh
 *  instance per turn is cheap (it's just object construction) and binds
 *  `sessionProject` into the tool handler's closure cleanly. */
function buildRenderMcpServer(sessionProject: string | null): unknown | null {
  if (!sessionProject || !_tool || !_createSdkMcpServer) return null;
  const captureToolDef = _tool(
    "render_capture",
    "Capture a PNG screenshot of a card as it is currently rendered on the " +
    "canvas AND ATTACH THE IMAGE to the tool result so you can look at it " +
    "directly. You HAVE vision capability on this model (Qwen3.6-35B-A3B " +
    "with mmproj loaded) — when this tool returns, the screenshot is visible " +
    "to you as an image attached to the tool result. Do NOT say 'I can't " +
    "view images' after calling this; describe what you see, including " +
    "colors, layout, specific text visible in the image, and whether the " +
    "card rendered correctly. Use this after building or editing a card " +
    "class to visually verify it works. The browser tab must be open to " +
    "the project's canvas. The filename is the canvas-root-relative path " +
    "of the card instance file (e.g. 'canvas/my-widget.burndown'), not " +
    "the card class directory.",
    { filename: z.string().describe("Canvas-root-relative path of the instance file (e.g. 'canvas/my.burndown')") },
    async (args: { filename: string }) => {
      try {
        const result = await captureCard(sessionProject, args.filename);
        const png = await fsReadFile(result.path);
        const base64 = png.toString("base64");
        return {
          content: [
            {
              type: "text",
              text:
                `The screenshot is attached to this tool result as an image. ` +
                `Look at the attached image and describe what you actually see ` +
                `— colors, layout, rendered text, whether anything is clipped or broken. ` +
                `File: ${args.filename} (${result.width}×${result.height}, ${Math.round(result.bytes / 1024)} KiB, saved to ${result.relativePath}).`,
            },
            { type: "image", data: base64, mimeType: "image/png" },
          ],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: `Capture failed: ${(err as Error).message}` }],
        };
      }
    },
  );
  return _createSdkMcpServer({
    name: "mica-render",
    version: "1.0.0",
    tools: [captureToolDef],
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
  `## Available mica.* APIs — prefer these over browser-direct equivalents\n\n` +
  `When you write specs (task-decomposer) or implement card classes (component-coder), default to these Mica-provided primitives. They're injected by CARD_SHIM into every card class's runtime, alongside \`container\` (the card's root DOM node). Reach for browser globals only when no mica.* equivalent exists.\n\n` +
  `**Identity & lifecycle**\n` +
  `- \`mica.cardId\` — stable per-instance UUID (per file)\n` +
  `- \`mica.filename\` — the card's instance file path\n` +
  `- \`mica.windowId\` — per-tab id (NOT per-card; use cardId for instance state)\n` +
  `- \`mica.onDestroy(cb)\` — cleanup on unmount; pair every \`addEventListener\`, \`setInterval\`, \`ResizeObserver\` etc. with this\n` +
  `- \`mica.refresh()\` — reload the card; cheaper alternatives are usually preferred (in-place DOM patches)\n` +
  `- \`mica.isSelfEcho(event)\` — true if event was caused by THIS card writing; use to break write-loops on \`file-changed\`\n\n` +
  `**Canvas-native persistence — use INSTEAD of localStorage / IndexedDB / sessionStorage**\n` +
  `- \`mica.getContent()\` → \`Promise<string>\` — read this card's instance file; called once at mount\n` +
  `- \`mica.files.read(path)\` → \`Promise<string>\` — read any project file\n` +
  `- \`mica.files.readBinary(path)\` → \`Promise<ArrayBuffer>\` — binary read\n` +
  `- \`mica.files.write(path, content)\` → \`Promise<void>\` — text or binary; auto-routes by content type; SSE-broadcasts \`file-changed\` to peer windows\n` +
  `- \`mica.files.list()\` → file metadata array\n` +
  `- \`mica.files.delete(path)\` / \`mica.files.url(path)\` (URL for \`<img src>\` etc.)\n\n` +
  `Why prefer these over browser storage: canvas files survive browser-data clear, sync cross-tab via the file watcher, are git-trackable, and are visible to the user as cards. IndexedDB/localStorage data is invisible to Mica and lost on browser reset.\n\n` +
  `**HTTP — use INSTEAD of \`fetch()\` for cross-origin / public APIs**\n` +
  `- \`mica.fetch(url, opts?)\` → \`Promise<{ status, headers, body, durationMs, errorCode? }>\` — server-proxied, bypasses CORS, blocks private/loopback IPs (SSRF protection), 120 req/60s rate limit per project, 10MB response cap, 60s max timeout. Always resolves; check \`errorCode\` then \`status\`.\n\n` +
  `Use direct \`fetch()\` ONLY for same-origin Mica-internal endpoints (e.g. \`/api/llm/status\`). For external APIs, RSS, etc.: \`mica.fetch\`.\n\n` +
  `**LLM / agent access — NEVER call llama-server, OpenRouter, or any LLM endpoint directly**\n\n` +
  `Cards do not own LLM endpoints, API keys, or streaming protocol. LLM access is mediated by a SERVER-SIDE channel handler that the card opens via \`mica.openChannel\`. Three patterns, in order of how custom you need to be:\n\n` +
  `1. **Drop a \`.llm-chat\` card on the canvas** — out-of-the-box streaming chat with a model switcher, no system prompt customization. The card class is already implemented (\`card-classes/llm-chat/\`) and registers \`channelManager.registerHandler("llm-chat", createLlmChatHandler())\` on the server. Use this when the user's need is "let me chat with an LLM" with no domain logic.\n` +
  `2. **Drop a \`.chat\` card** — full Qwen/Claude agent SDK with subagents, tools, file ops. Heavyweight; use when the conversation needs the agent loop (e.g., a chat that helps the user build). System prompt comes from canvas-back + skills.\n` +
  `3. **Build a custom card class with a paired server handler** — for domain-specific contracts (custom system prompt, structured response parsing, retrieval, multi-step pipelines). Requires both: (a) the card class files (card.html/js/css/metadata.json), AND (b) a server plugin at \`server/plugins/<name>.ts\` exporting a factory, AND (c) a registration line in \`server/index.ts\`: \`channelManager.registerHandler("<class-name>", create<Name>Handler())\`. Reference implementations: \`server/plugins/llmChat.ts\` (simple chat completion) and \`server/plugins/pty.ts\` (terminal). The card opens its channel with \`mica.openChannel(<any-string>, args?)\` — the routing key is the CARD's file extension, not the string argument (which is decorative, passed to the factory's \`_args\`).\n\n` +
  `**Existing channel-handler card classes** (already registered, ready to use):\n` +
  `- \`.chat\` → full Qwen agent SDK loop\n` +
  `- \`.claude\` → Claude Code agent SDK loop\n` +
  `- \`.terminal\` → PTY (node-pty)\n` +
  `- \`.llm-chat\` → direct LLM streaming chat (OpenAI-compatible, switchable models)\n` +
  `- \`.skills\` → collaborative SKILL.md authoring (propose/apply)\n` +
  `- \`.canvas-back\` → propose-then-apply canvas-back.md edits\n\n` +
  `**Anti-pattern (the spec-generation failure mode):** writing a spec that says "the card calls llama-server at \`/v1/chat/completions\` via \`fetch\`" or "use \`mica.fetch\` for the LLM call (with a note that \`mica.fetch\` blocks loopback)." Both are wrong — the card never calls LLM endpoints. If the spec implies it does, you've misframed the architecture; revise to "card opens \`mica.openChannel\`; server handler at \`server/plugins/<name>.ts\` owns the LLM call."\n\n` +
  `**Channel API shape** (when you do call \`mica.openChannel\`):\n` +
  `- \`const ch = mica.openChannel(label, args?)\` — open duplex stream\n` +
  `- \`ch.send(msg)\` — push a message; server receives via \`onData(clientId, data)\`\n` +
  `- \`ch.onData(cb)\` — receive server broadcasts (event types defined by handler)\n` +
  `- \`ch.onClose(cb)\` — server closed the channel\n` +
  `- \`ch.close()\` — client closes; pair with \`mica.onDestroy(() => ch.close())\`\n\n` +
  `**Events & cross-card communication**\n` +
  `- \`mica.on(event, cb)\` → unsubscribe fn. Events: \`file-changed\`, \`file-created\`, \`file-deleted\`, \`layout-changed\`, \`card-error\`. Always pair with \`mica.onDestroy(unsub)\`.\n` +
  `- \`mica.reportError(message)\` → surfaces a "Ask agent to fix" bubble in chat cards across the project. Use in catch blocks for errors the user should know about.\n\n` +
  `**Card-class introspection**\n` +
  `- \`mica.cardClasses.list()\` → registered classes; check before defining a new one (extension may already be handled).\n\n` +
  `For a fuller reference (parameter shapes, edge cases), read the \`create-card-class\` skill in \`.qwen/skills/create-card-class/SKILL.md\` (or \`.claude/skills/...\`). Don't paste its content into your specs verbatim — point at it.`;

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
  // here; full reference lives in the `create-card-class` skill body
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
        `## You are an Orchestrator`,
        ``,
        `For non-trivial multi-file work, you do not write code yourself — you read the canvas plan, dispatch each component to a specialized Subagent, and mark items complete. This is the ONLY way to build multi-file features inside the local model's 65K context slot. Inline implementation runs out of context around the 7th–10th \`write_file\` and the turn errors mid-stream.`,
        ``,
        `Each Subagent runs in its own context window. It reads what it needs from canvas on demand and returns a short summary. Your parent context (this turn) keeps the plan and the summaries, never the file contents.`,
        ``,
        `**To invoke a Subagent**, write a request in your turn response using natural language naming the agent. Example phrasings (these patterns trigger SDK routing):`,
        `- "Have the component-coder Subagent implement \`src/email_monitor.py\` per ${canvasRoot}/spec.md § Email Monitor."`,
        `- "Use the task-decomposer Subagent to plan: <user's request verbatim>"`,
        ``,
        `Available Subagents:`,
      ];
      for (const a of agents) {
        lines.push(`- **${a.name}**: ${a.description}`);
      }
      lines.push(``, `## Orchestrator workflow (MANDATORY for non-trivial requests)`, ``);
      if (hasDecomposer && hasComponentCoder) {
        lines.push(
          `**RULE 0: For non-trivial requests, your FIRST tool call MUST be \`task-decomposer\`. Not \`read_file\`. Not \`list_directory\`. Not \`glob\`. The decomposer.**`,
          ``,
          `If you read project files first to "get a comprehensive understanding," you have already lost the context game. The decomposer reads what it needs in its own slot; your slot stays free for dispatching subagents and tracking progress. Reading 10 files inline burns the budget the decomposer was supposed to spend for you.`,
          ``,
          `Trigger this workflow whenever the user's request is **multi-file work OR planning-shaped work**, regardless of phrasing. All of these are orchestrator-mode:`,
          ``,
          `- Building / implementing / creating: "build X", "implement Y", "create Z"`,
          `- Refactoring / restructuring: "refactor X into Y", "split this into modules"`,
          `- **Reviewing or planning** (these are NOT just-read-and-answer asks): "review the spec and figure out next steps", "design X", "audit Y", "what's the best implementation path", "plan how we'd add Z", "assess the codebase", "determine the best path forward"`,
          `- Extending / adding features: "add X to the app", "extend Y to support Z"`,
          `- ANY user message that contains "review", "design", "audit", "figure out", "best path", "next steps", "plan how" — even when paired with project-file references like "the spec" or "the design docs"`,
          ``,
          `**The temptation to read first is the failure mode.** Resist it. The user's words can sound like they want analysis ("review the spec") but the right next action is delegation, not reading. Trust that the decomposer will read carefully — that's its job.`,
          ``,
          `Steps:`,
          ``,
          `1. **Restate** the ask in one sentence. If genuinely ambiguous, ask the clarifying question and stop.`,
          `2. **Delegate the planning IMMEDIATELY** — invoke \`task-decomposer\` with the user's request verbatim. **This is your first tool call.** It writes \`${canvasRoot}/spec.md\`, \`${canvasRoot}/interfaces.md\`, and \`${canvasRoot}/plan.todo\` in its own context slot, returns a one-line status. You do not plan inline.`,
          `3. **Read \`${canvasRoot}/plan.todo\`** — each \`## Active\` line is one delegation-ready item naming a subagent (\`@component-coder\`) and a spec section.`,
          `4. **Show the user** the plan items so they can edit \`plan.todo\` before execution if they want.`,
          `5. **Per-item lifecycle: \`[ ]\` → \`[~]\` → \`[x]\` (or \`[!]\`).** For each plan item, in this order:`,
          `   - **Before dispatching:** \`edit\` plan.todo to flip the item's marker from \`[ ]\` to \`[~]\` (in-progress). The .todo card renders this as a pulsing dot — the user sees what you're working on.`,
          `   - **Dispatch:** invoke \`component-coder\` with the plan item's text verbatim.`,
          `   - **On successful return:** \`edit\` plan.todo to flip \`[~]\` to \`[x]\` (done).`,
          `   - **On failure return** (component-coder responds \`failed: ...\`): \`edit\` plan.todo to flip \`[~]\` to \`[!]\` (failed). User sees a red marker and can intervene; the .todo card lets them click \`!\` to reset to \`[ ]\` for retry.`,
          `   - Independent items can be dispatched in parallel — but EACH gets its own \`[~]\` flip BEFORE its dispatch and its own \`[x]\` / \`[!]\` flip AFTER its return.`,
          `   **Do NOT batch updates.** The .todo card watches its own file and re-renders per save. Per-item edits become live UI progress (pending → in-progress → done). Batching loses that visibility AND loses work if you hit overflow before the flush.`,
          `6. **Iterate** until \`## Active\` has no \`[ ]\` or \`[~]\` items left. Summarize what shipped — without including file contents.`,
          ``,
          `**SKIP this workflow** ONLY for these narrow cases:`,
          `- typo fixes (renaming a variable, fixing a misspelling)`,
          `- single-config tweaks (changing one setting in one config file)`,
          `- narrowly-scoped Q&A like "what does function foo() do in src/x.js" (one read, one answer — the answer is the deliverable)`,
          ``,
          `**Spec / architecture / canvas-back / interfaces revisions are NOT skip-eligible — even when only one file is touched.** A spec rewrite that touches multiple sections, or any edit informed by architectural guidance the user just shipped, is planning-shaped work. Delegate to \`task-decomposer\`. The "single-file" language is about scope of CONSEQUENCE (does this affect downstream code?), not literal file count. A spec rewrite affects every subagent that reads it — high consequence — delegate it.`,
          ``,
          `**Multi-section edits in one file are NOT "single-file edits."** If you'd touch 3+ sections of one file, or rewrite >50 lines of one file, or apply architectural guidance to one file, it's planning-shaped. Delegate.`,
          ``,
          `**SKIP this workflow** if the user explicitly says "just do it directly" / "don't bother with subagents" / "this is small". Respect their override.`,
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
  parts.push(`## You have vision

You CAN see images. This runtime loads Qwen3.6-35B-A3B with its vision encoder (mmproj). When a tool result includes an image attachment, you actually see that image — don't say "I can't view images" or fall back to describing source code when a picture is right there. Describe the attached image directly: colors, layout, visible text, whether anything is clipped or wrong.

The \`render_capture\` tool (MCP server \`mica-render\`) returns a screenshot of a rendered canvas card with the image attached. Use it to visually verify card work and report what you actually see in the pixels.`);

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
This project's skills are bundled by its template and live under \`.qwen/skills/<name>/SKILL.md\`. The Qwen SDK auto-discovers them and surfaces each skill's \`description:\` to you. When a user request matches a skill's trigger words, load that skill (read its SKILL.md) and follow it. If a \`participate-fully\` skill is present, read it at the start of every turn — it tells you how to handle the \`## Since your last turn\` section above.

**Skills are mandatory when they match, not optional.** If a skill's description matches the user's request, you MUST invoke it via the \`skill\` tool BEFORE taking any other action — before \`read_file\`, before \`list_directory\`, before anything. Do not "think the skill would apply" and then proceed without it. Do not summarize what the skill would do instead of running it. The skill body contains load-bearing procedural steps; noticing the skill is relevant and then free-forming the work anyway defeats the purpose. Match → invoke → follow.

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
    // Queue carries plain strings for text turns, or {text, attach} for
    // image-bearing turns. The drain handler below branches on shape.
    let queue: Array<string | { text: string; attach: string }> = [];
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
      markProjectActivity(sessionProject, +1);
      console.log(`[mica-agent] processMessage START: ${message.slice(0, 60)}`);

      // Per-turn read tracking. Used by checkCardClassPrecondition to refuse
      // card-class authoring writes until the agent has read the create-card-class
      // skill in this same turn. Reset each processMessage so the requirement
      // is per-turn rather than per-session (skills fall out of context as
      // history scrolls; safer to require a fresh read).
      const readFilesThisTurn = new Set<string>();

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
          // Default model resolution: per-card gear setting > OPENROUTER_DEFAULT_MODEL
          // env var (from .env) > built-in fallback.
          modelName = cardSettings.model || process.env.OPENROUTER_DEFAULT_MODEL || "anthropic/claude-3.5-sonnet";
        } else {
          baseUrl = LLAMA_URL.replace(/\/v1$/, "") + "/v1";
          apiKey = "dummy";
          // Model label for local llama-server. The name is informational from
          // llama-server's perspective (it uses whatever's loaded at startup),
          // but the Qwen SDK uses it to pick supported modalities via regex
          // match: /^qwen3-vl-/ → { image: true, video: true }. Our local
          // GGUF is Qwen3.6-35B-A3B with mmproj loaded (see llamaServer.ts),
          // so we tag it as "qwen3-vl-local" to unlock the SDK's image path
          // for mica.render.capture tool-result delivery. Without this
          // relabel the SDK strips image content to "[Unsupported modality]"
          // text before sending.
          modelName = cardSettings.model || "qwen3-vl-local";
        }
        console.log(`[mica-agent] provider=${provider} model=${modelName} baseUrl=${baseUrl}`);

        const since = getLastTurnAt(ctx.filename);
        const context = await buildContext(ctx.filename, sessionProject, since, modelName);

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
            canUseTool: canUseToolWithQuestionIntercept,
            abortController: activeAbort,
            systemPrompt: { type: "preset", preset: "qwen_code", append: context },
            // Project-defined subagents. Parent delegates heavy single-component
            // work (e.g. "implement src/email_monitor.py") via the SDK's `task`
            // tool, keeping the parent's context small. See plan:
            // /home/vscode/.claude/plans/joyful-honking-hinton.md
            ...(subagents.length > 0 ? { agents: subagents } : {}),
            // SDK-hosted MCP server exposing `render_capture` — see
            // buildRenderMcpServer above. Tool result returns the PNG inline
            // (via MCP ImageContent) so the next LLM call can see it via
            // Qwen3.6-35B-A3B's vision (mmproj-F16 loaded by llama-server).
            // Only attach when the server built OK (project set AND SDK
            // exports present); omitting is a safe no-op.
            // createSdkMcpServer() already returns { type: "sdk", name, instance }
            // — use the returned value directly as the mcpServers entry. Wrapping
            // it again produces `{instance: <the config>}`, which the SDK then
            // tries to .connect() and fails with "i.connect is not a function".
            ...(() => {
              const server = buildRenderMcpServer(sessionProject);
              return server ? { mcpServers: { "mica-render": server } } : {};
            })(),
            env: {
              OPENAI_API_KEY: apiKey,
              OPENAI_BASE_URL: baseUrl,
              // Forward web-search provider keys so qwen-code's built-in
              // web_search / web_fetch tools actually work. Without these
              // forwarded, the SDK reports "search is disabled - configure
              // a provider in settings.json" and the agent falls back to
              // its training prior for fact-finding (URL verification,
              // library versions, etc.) — plausible-but-stale.
              ...(process.env.TAVILY_API_KEY ? { TAVILY_API_KEY: process.env.TAVILY_API_KEY } : {}),
              ...(process.env.DASHSCOPE_API_KEY ? { DASHSCOPE_API_KEY: process.env.DASHSCOPE_API_KEY } : {}),
              ...(process.env.GOOGLE_AI_STUDIO ? { GOOGLE_AI_STUDIO: process.env.GOOGLE_AI_STUDIO } : {}),
            },
          },
        }) as AsyncIterable<Record<string, unknown>>;

        let resultText = "";
        let filesChanged = false;
        // Final turn usage from the SDK's `result` event. Shape: { input_tokens, output_tokens, ... }.
        // Forwarded verbatim to the client so the chat card can compute tokens/sec from elapsed time.
        let usage: Record<string, unknown> | null = null;
        let contextWindow: number = provider === "openrouter" ? 0 : LOCAL_CTX_WINDOW;
        // SDK error result detection: when llama-server / OpenRouter returns a
        // 400 (e.g. context overflow), the SDK emits a result event with
        // `is_error: true, subtype: "error_during_execution", error: { message }`
        // — not a thrown exception. Without inspecting these fields the result
        // text stays empty, the success path runs, and the chat card sees a
        // bland "Done." instead of the error → its overflow detector never
        // fires, no Clear/Spawn affordance appears. Capture the message here
        // and route through the error broadcast below.
        let sdkResultError: string | null = null;

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
            const msg = evt.message as { content?: Array<{ type: string; name?: string; text?: string; thinking?: string; input?: Record<string, unknown> }> };
            if (msg.content) {
              for (const block of msg.content) {
                if (block.type === "thinking") {
                  const t = block.thinking || "";
                  console.log(`[mica-agent] THINKING block (${t.length} chars): ${t.slice(0, 120).replace(/\n/g, " ")}...`);
                }
                if (block.type === "tool_use" && block.name) {
                  console.log(`[mica-agent] tool_use: ${block.name} input=${JSON.stringify(block.input || {}).slice(0, 200)}`);
                  toolCallCounts[block.name] = (toolCallCounts[block.name] || 0) + 1;
                  ctx.broadcast({
                    type: "progress",
                    tool: block.name,
                    description: describeToolUse(block.name, block.input || {}),
                  });
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
              sdkResultError = errInfo?.message?.trim() || "Provider returned an error";
              console.log(`[mica-agent] SDK result is_error subtype=${String(evt.subtype || "")} message=${sdkResultError.slice(0, 200)}`);
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

        // Detect the arc-complete marker emitted by the agent at natural
        // stopping points. Strip it from the user-visible text so chat
        // bubbles stay clean; keep the signal for cursor-advance below.
        const ARC_COMPLETE_RE = /<thread-state>\s*arc-complete\s*<\/thread-state>/i;
        const arcComplete = ARC_COMPLETE_RE.test(resultText);
        if (arcComplete) resultText = resultText.replace(ARC_COMPLETE_RE, "").trim();

        // Decide whether to advance the cursor. We advance only at genuine arc
        // breaks AND when capacity is tight enough (>80%) that the next turn
        // would benefit. Below 80% the cache-invalidation cost of advancing
        // isn't justified. Mid-arc advances never happen silently — those
        // surface as Clear/Spawn prompts in the UI at >95%.
        const capacity = contextWindow > 0 ? baselineTokens / contextWindow : 0;
        let cursorAdvanced = false;
        let newCursor = cursor;

        const updatedHistory = await loadHistory(chatId, sessionProject);
        updatedHistory.push({ role: "assistant", content: resultText, agent: "Qwen" });
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
            files_changed: filesChanged ? 1 : 0,
            cursor_advanced: false,
            arc_complete: false,
          });
          return;
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
          arcComplete,
          capacity,
          cursor: newCursor,
          cursorAdvanced,
          durationMs,
          ...(ttftMs !== null ? { ttftMs } : {}),
        });

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
          files_changed: filesChanged ? 1 : 0,
          cursor_advanced: cursorAdvanced,
          arc_complete: arcComplete,
        });

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
          files_changed: 0,
          cursor_advanced: false,
          arc_complete: false,
        });
      } finally {
        recordTurnEnd(ctx.filename);
        markProjectActivity(sessionProject, -1);
        console.log(`[mica-agent] processMessage DONE: ${message.slice(0, 60)} | queue depth: ${queue.length}`);
        // Hand off to next queued message WITHOUT releasing busy outside this
        // synchronous block. setImmediate's callback briefly clears busy then
        // re-enters processMessage atomically (JS event loop is cooperative,
        // so no other handler can squeeze in between the two statements).
        if (queue.length > 0) {
          const next = queue.shift()!;
          setImmediate(() => {
            busy = false; sessionState.busy = false;
            if (typeof next === "string") processMessage(next);
            else processImageMessage(next.text, next.attach);
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
    async function processImageMessage(text: string, attachmentFilename: string) {
      if (busy) {
        queue.push({ text, attach: attachmentFilename });
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
            model: "qwen3-vl-local",
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

        console.log(`[mica-agent] broadcasting assistant (image-path) for: ${text.slice(0, 60)}`);
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
          cursorAdvanced: false,
          durationMs: tsEnd - tsStart,
          ttftMs: firstTokenAt.t !== null ? firstTokenAt.t - requestStart : null,
        });

        const updatedHistory = await loadHistory(chatId, sessionProject);
        updatedHistory.push({ role: "assistant", content: reply, agent: "Qwen" });
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
          model: "qwen3-vl-local",
          input_tokens: typeof usageObj.prompt_tokens === "number" ? usageObj.prompt_tokens : 0,
          output_tokens: typeof usageObj.completion_tokens === "number" ? usageObj.completion_tokens : 0,
          baseline_tokens: 0,
          context_window: LOCAL_CTX_WINDOW,
          capacity: 0,
          subagent_count: 0,
          tool_calls: { attach_image: 1 },
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
        if (queue.length > 0) {
          const next = queue.shift()!;
          setImmediate(() => {
            busy = false; sessionState.busy = false;
            if (typeof next === "string") processMessage(next);
            else processImageMessage(next.text, next.attach);
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
        const msg = data as { type?: string; message?: string; attachmentFilename?: string };

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
          queue.push(msg.attachmentFilename ? { text: message, attach: msg.attachmentFilename } : message);
          return;
        }

        // Image-bearing turns bypass the Qwen SDK entirely. See
        // processImageMessage below for rationale — the SDK can't carry
        // images through its `prompt: string` parameter, and tool-result
        // delivery was unreliable across chat-template/modality boundaries.
        if (msg.attachmentFilename) {
          processImageMessage(message, msg.attachmentFilename);
        } else {
          processMessage(message);
        }
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
