// micaAgent.ts -- Qwen Code agent channel handler.
// Uses @qwen-code/sdk to provide an agentic coding assistant.
// Registered as a ChannelManager handler for .chat files.

import { readFile, writeFile, mkdir, readdir } from "fs/promises";
import { join } from "path";
import { WORKSPACE_DIR, micaDir, listFiles, readProjectFile } from "./files.js";
import type { ChannelHandler, SessionContext } from "./channelManager.js";
import type { FileWatcher } from "./fileWatcher.js";

// Active project tracking
let _activeProject: string | null = null;
export function setActiveProject(project: string | null) { _activeProject = project; }
function getProjectDir() {
  return _activeProject ? join(WORKSPACE_DIR, _activeProject) : WORKSPACE_DIR;
}
function getMicaDir() { return micaDir(_activeProject || undefined); }

const LLAMA_URL = process.env.LLAMA_URL || "http://127.0.0.1:8012";
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

async function loadHistory(chatId: string): Promise<ChatMessage[]> {
  try {
    const raw = await readFile(join(getMicaDir(), "chats", `${chatId}.json`), "utf-8");
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

async function saveHistory(chatId: string, messages: ChatMessage[]): Promise<void> {
  const dir = join(getMicaDir(), "chats");
  await mkdir(dir, { recursive: true });
  const trimmed = messages.length > MAX_HISTORY ? messages.slice(-MAX_HISTORY) : messages;
  await writeFile(join(dir, `${chatId}.json`), JSON.stringify(trimmed, null, 2), "utf-8");
}

// -- Context builder --

async function buildContext(agentFilename: string): Promise<string> {
  const parts: string[] = [];

  // 1. Instance-level AI context (per-card behavior instructions)
  try {
    // Sanitize filename: replace / with _ so files in subdirectories work
    const contextKey = agentFilename.replace(/\//g, "_");
    const instanceContext = await readFile(join(getMicaDir(), "cards", contextKey + ".context.md"), "utf-8");
    if (instanceContext.trim()) parts.push(`## Your Behavior Instructions\n${instanceContext.trim()}`);
  } catch { /* no instance context */ }

  // 2. Class-level AI context (shared across all cards of this type)
  try {
    const ext = agentFilename.split(".").pop() || "";
    const CARD_CLASSES_DIR = join(process.cwd(), "card-classes");
    // Check project-scoped first, then built-in
    let classContext = "";
    try {
      classContext = await readFile(join(getMicaDir(), "card-classes", ext, "context.md"), "utf-8");
    } catch {
      try {
        classContext = await readFile(join(CARD_CLASSES_DIR, ext, "context.md"), "utf-8");
      } catch { /* no class context */ }
    }
    if (classContext.trim()) parts.push(`## Card Class Context\n${classContext.trim()}`);
  } catch { /* ignore */ }

  // 3. Project-level AI context (canvas back)
  try {
    const canvasBack = await readFile(join(getMicaDir(), "canvas-back.md"), "utf-8");
    if (canvasBack.trim()) parts.push(`## Project Context\n${canvasBack.trim()}`);
  } catch { /* no canvas-back */ }

  // Project files — list all, read text content for context
  try {
    const files = await listFiles(_activeProject || undefined);
    if (files.length > 0) {
      parts.push(`## Project Files`);
      const TEXT_EXTS = new Set([".md", ".txt", ".json", ".todo", ".chat", ".mmd", ".yaml", ".yml", ".toml", ".csv", ".html", ".css", ".js", ".ts", ".py", ".sh", ".rb", ".go", ".rs", ".java"]);
      const MAX_PREVIEW = 1500;
      const MAX_FILES_WITH_CONTENT = 20;
      let filesWithContent = 0;
      for (const f of files) {
        const ext = f.name.substring(f.name.lastIndexOf(".")).toLowerCase();
        if (TEXT_EXTS.has(ext) && f.size < 50000 && filesWithContent < MAX_FILES_WITH_CONTENT) {
          try {
            const file = await readProjectFile(f.name, _activeProject || undefined);
            const preview = file.content.slice(0, MAX_PREVIEW);
            parts.push(`### ${f.name}\n${preview}`);
            filesWithContent++;
          } catch { parts.push(`### ${f.name} (${f.size} bytes)`); }
        } else {
          parts.push(`### ${f.name} (${f.size} bytes)`);
        }
      }
    }
  } catch { /* ignore */ }

  // Project structure guidance
  let canvasRoot = "docs";
  try {
    const cfg = JSON.parse(await readFile(join(getMicaDir(), "config.json"), "utf-8"));
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

## Available Skills
- When asked to build, create, or make ANY interactive UI (card, widget, visualization, browser, dashboard, chart, game, calculator, tool, viewer, editor, etc.), ALWAYS use the \`create-card-class\` skill.
- This includes requests like "make a kanban board", "build a dashboard", "create a viewer" — even if the user doesn't say "card", treat it as a card class request.
- Card classes go in .mica/card-classes/{name}/ (this is the ONE exception to the .mica rule)
- Before building, confirm with the user what features they want.`);

  return parts.join("\n\n");
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

const COALESCE_QUIET_MS = 15000; // Wait 15s of quiet before delivering file events

export function createAgentHandler(fileWatcher: FileWatcher) {
  // Single file-watcher listener shared across all agent sessions.
  // Maps filename -> session state. Prevents listener leaks from StrictMode.
  const activeSessions = new Map<string, {
    busy: boolean;
    agentWrittenFiles: Set<string>;
    coalesceBuffer: Map<string, number>;
    coalesceTimer: ReturnType<typeof setTimeout> | null;
    deliverFn: (() => void) | null;
  }>();

  fileWatcher.on("file-change", (event: { type: string; filename: string }) => {
    if (event.filename.startsWith(".")) return;

    for (const [sessionFile, state] of activeSessions) {
      if (event.filename === sessionFile) continue; // ignore own chat file
      if (state.busy) continue; // agent is working, skip
      if (state.agentWrittenFiles.has(event.filename)) {
        state.agentWrittenFiles.delete(event.filename);
        continue; // agent wrote this file
      }

      state.coalesceBuffer.set(event.filename, (state.coalesceBuffer.get(event.filename) || 0) + 1);

      if (state.coalesceTimer) clearTimeout(state.coalesceTimer);
      state.coalesceTimer = setTimeout(() => {
        state.coalesceTimer = null;
        if (state.deliverFn) state.deliverFn();
      }, COALESCE_QUIET_MS);
    }
  });

  return async function agentHandlerFactory(
    _content: string,
    _args: Record<string, unknown>,
    ctx: SessionContext
  ): Promise<ChannelHandler> {
    // Sanitize: replace / with _ so files in subdirectories (e.g. docs/agent.chat)
    // don't break the chats/ directory layout
    const chatId = ctx.filename.replace(".chat", "").replace(/\//g, "_");
    let busy = false;
    let queue: string[] = [];
    let activeAbort: AbortController | null = null;

    // Register this session in the shared state (replaces any previous from StrictMode)
    const sessionState = {
      busy: false,
      agentWrittenFiles: new Set<string>(),
      coalesceBuffer: new Map<string, number>(),
      coalesceTimer: null as ReturnType<typeof setTimeout> | null,
      deliverFn: null as (() => void) | null,
    };
    activeSessions.set(ctx.filename, sessionState);

    function deliverCoalescedEvents() {
      if (sessionState.coalesceBuffer.size === 0) return;

      const changes: string[] = [];
      for (const [filename, count] of sessionState.coalesceBuffer) {
        changes.push(count > 1 ? `${filename} (${count}x)` : filename);
      }
      sessionState.coalesceBuffer.clear();

      const message = `[File changes detected] The following files were modified:\n${changes.map(c => "- " + c).join("\n")}\n\nReview the canvas back context and these files. If any changes require your attention (e.g., @agent tasks in a todo, spec changes to review), respond. Otherwise, acknowledge briefly.`;

      if (busy) {
        queue.push(message);
      } else {
        processMessage(message);
      }
    }

    sessionState.deliverFn = deliverCoalescedEvents;

    async function processMessage(message: string) {
      busy = true; sessionState.busy = true;

      // Send user message to browser
      ctx.broadcast({ type: "user", content: message });

      // Persist
      const history = await loadHistory(chatId);
      history.push({ role: "user", content: message });
      await saveHistory(chatId, history);

      // Show thinking state
      ctx.broadcast({ type: "thinking" });

      try {
        const context = await buildContext(ctx.filename);
        const baseUrl = LLAMA_URL.replace(/\/v1$/, "") + "/v1";

        console.log(`[mica-agent] Query: ${message.slice(0, 100)}... (context: ${context.length} chars)`);

        const queryFn = await getQuery();
        activeAbort = new AbortController();

        const q = queryFn({
          prompt: message,
          options: {
            cwd: getProjectDir(),
            model: "openai:local",
            authType: "openai" as const,
            // "default" + canUseTool gives us auto-approve with guards
            permissionMode: "default" as const,
            canUseTool: guardTool,
            abortController: activeAbort,
            systemPrompt: { type: "preset", preset: "qwen_code", append: context },
            env: {
              OPENAI_API_KEY: "dummy",
              OPENAI_BASE_URL: baseUrl,
            },
          },
        }) as AsyncIterable<Record<string, unknown>>;

        let resultText = "";
        let filesChanged = false;

        for await (const evt of q) {
          const evtType = evt.type as string;

          if (evtType === "assistant" && evt.message) {
            const msg = evt.message as { content?: Array<{ type: string; name?: string; text?: string; input?: Record<string, unknown> }> };
            if (msg.content) {
              for (const block of msg.content) {
                if (block.type === "tool_use" && block.name) {
                  ctx.broadcast({
                    type: "progress",
                    tool: block.name,
                    description: describeToolUse(block.name, block.input || {}),
                  });
                  if (["write_file", "write_to_file", "edit_file", "create_file"].includes(block.name)) {
                    filesChanged = true;
                    // Track the file so we ignore the resulting file-changed event
                    const writtenPath = String((block.input as Record<string, unknown>)?.file_path || (block.input as Record<string, unknown>)?.filePath || "");
                    const writtenFile = writtenPath.split("/").pop();
                    if (writtenFile) sessionState.agentWrittenFiles.add(writtenFile);
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

          if (evtType === "result") {
            const result = evt.result as { text?: string } | undefined;
            if (result?.text) resultText = result.text;
          }
        }

        activeAbort = null;

        if (!resultText.trim()) {
          resultText = filesChanged ? "Done -- I made changes." : "Done.";
        }

        ctx.broadcast({ type: "assistant", content: resultText, agent: "Qwen", filesChanged });

        const updatedHistory = await loadHistory(chatId);
        updatedHistory.push({ role: "assistant", content: resultText, agent: "Qwen" });
        await saveHistory(chatId, updatedHistory);

      } catch (err) {
        activeAbort = null;
        const errMsg = (err as Error).message || String(err);
        // Empty response = model had nothing to say (common for reactive events)
        if (errMsg.includes("empty response")) {
          console.log("[mica-agent] Empty response (no action needed)");
          ctx.broadcast({ type: "assistant", content: "No action needed.", agent: "Qwen", filesChanged: false });
        } else {
          console.error("[mica-agent] Error:", errMsg);
          ctx.broadcast({ type: "error", error: errMsg });
        }
      } finally {
        busy = false; sessionState.busy = false;
        // Priority: user messages first, then coalesced file events
        if (queue.length > 0) {
          const next = queue.shift()!;
          setImmediate(() => processMessage(next));
        } else if (sessionState.coalesceBuffer.size > 0) {
          // Deliver accumulated file events now that agent is free
          setImmediate(() => deliverCoalescedEvents());
        }
      }
    }

    // Track if initial scan has been triggered
    let initialScanDone = false;

    return {
      onAttach(clientId, _args) {
        // Send history to newly attached client
        loadHistory(chatId).then((messages) => {
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
          buildContext(ctx.filename).then((context) => {
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
