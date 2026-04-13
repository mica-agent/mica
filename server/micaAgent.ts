// micaAgent.ts -- Qwen Code agent channel handler.
// Uses @qwen-code/sdk to provide an agentic coding assistant.
// Registered as a ChannelManager handler for .chat files.

import { readFile, writeFile, mkdir, readdir } from "fs/promises";
import { join } from "path";
import { PROJECT_DIR, micaDir, listFiles } from "./files.js";
import type { ChannelHandler, SessionContext } from "./channelManager.js";
import type { FileWatcher } from "./fileWatcher.js";

const LLAMA_URL = process.env.LLAMA_URL || "http://127.0.0.1:8012";
const MAX_HISTORY = 50;

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
    const raw = await readFile(join(micaDir(), "chats", `${chatId}.json`), "utf-8");
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

async function saveHistory(chatId: string, messages: ChatMessage[]): Promise<void> {
  const dir = join(micaDir(), "chats");
  await mkdir(dir, { recursive: true });
  const trimmed = messages.length > MAX_HISTORY ? messages.slice(-MAX_HISTORY) : messages;
  await writeFile(join(dir, `${chatId}.json`), JSON.stringify(trimmed, null, 2), "utf-8");
}

// -- Context builder --

async function buildContext(agentFilename: string): Promise<string> {
  const parts: string[] = [];

  // Agent card back (per-agent behavior instructions)
  try {
    const backFilename = agentFilename.replace(/\//g, "--");
    const agentBack = await readFile(join(micaDir(), "cards", backFilename), "utf-8");
    if (agentBack.trim()) parts.push(`## Your Behavior Instructions\n${agentBack.trim()}`);
  } catch { /* no agent card back */ }

  // Canvas-back (project AI context)
  try {
    const canvasBack = await readFile(join(micaDir(), "canvas-back.md"), "utf-8");
    if (canvasBack.trim()) parts.push(`## Project Context\n${canvasBack.trim()}`);
  } catch { /* no canvas-back */ }

  // Project files
  try {
    const files = await listFiles();
    if (files.length > 0) {
      parts.push(`## Project Files`);
      for (const f of files) {
        const preview = f.content.slice(0, 1500);
        parts.push(`### ${f.name}\n${preview}`);
      }
    }
  } catch { /* ignore */ }

  // Default behavior (if no agent card back provides instructions)
  parts.push(`## Default Behavior
When reacting to file changes:
- Evaluate what actions should be taken
- Check for @agent tasks in todo files
- Update dependent docs if needed
- Log decisions and actions taken to decisions.md
- If you have questions, add them to your chat response AND create a todo item assigned to @human

## Available Skills
- When asked to build a card, widget, visualization, or interactive component, use the \`create-card-class\` skill.
- Card classes go in .mica/card-classes/{name}/render.js`);

  return parts.join("\n\n");
}

// -- Tool use description --

function describeToolUse(name: string, input: Record<string, unknown>): string {
  if (!input) return name;
  switch (name) {
    case "bash": case "execute_command": {
      const cmd = String(input.command || input.cmd || "").split("\n")[0].slice(0, 80);
      return cmd ? `$ ${cmd}` : "Running command";
    }
    case "read_file": case "read": return `Read ${String(input.file_path || input.filePath || "").split("/").pop() || "file"}`;
    case "write_file": case "write": case "write_to_file": return `Write ${String(input.file_path || input.filePath || "").split("/").pop() || "file"}`;
    case "edit_file": case "edit": return `Edit ${String(input.file_path || input.filePath || "").split("/").pop() || "file"}`;
    default: return name;
  }
}

// -- Channel handler factory --

const COALESCE_QUIET_MS = 15000; // Wait 15s of quiet before delivering file events

export function createAgentHandler(fileWatcher: FileWatcher) {
  return async function agentHandlerFactory(
    _content: string,
    _args: Record<string, unknown>,
    ctx: SessionContext
  ): Promise<ChannelHandler> {
    const chatId = ctx.filename.replace(".chat", "");
    let busy = false;
    let queue: string[] = [];
    let activeAbort: AbortController | null = null;

    // -- Coalesced file events --
    const coalesceBuffer = new Map<string, number>(); // filename -> change count
    let coalesceTimer: ReturnType<typeof setTimeout> | null = null;

    function onFileChanged(event: { type: string; filename: string }) {
      // Ignore our own chat file and dotfiles
      if (event.filename === ctx.filename) return;
      if (event.filename.startsWith(".")) return;

      coalesceBuffer.set(event.filename, (coalesceBuffer.get(event.filename) || 0) + 1);

      // Reset quiet timer
      if (coalesceTimer) clearTimeout(coalesceTimer);
      coalesceTimer = setTimeout(() => {
        coalesceTimer = null;
        deliverCoalescedEvents();
      }, COALESCE_QUIET_MS);
    }

    function deliverCoalescedEvents() {
      if (coalesceBuffer.size === 0) return;

      // Build summary
      const changes: string[] = [];
      for (const [filename, count] of coalesceBuffer) {
        changes.push(count > 1 ? `${filename} (${count}x)` : filename);
      }
      coalesceBuffer.clear();

      const message = `[File changes detected] The following files were modified:\n${changes.map(c => "- " + c).join("\n")}\n\nReview the canvas back context and these files. If any changes require your attention (e.g., @agent tasks in a todo, spec changes to review), respond. Otherwise, acknowledge briefly.`;

      if (busy) {
        // Agent is busy — queue it behind user messages
        queue.push(message);
      } else {
        processMessage(message);
      }
    }

    // Subscribe to file watcher for reactive behavior
    fileWatcher.on("file-change", onFileChanged);

    async function processMessage(message: string) {
      busy = true;

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
            cwd: PROJECT_DIR,
            model: "openai:local",
            authType: "openai" as const,
            permissionMode: "yolo" as const,
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
        console.error("[mica-agent] Error:", errMsg);
        ctx.broadcast({ type: "error", error: errMsg });
      } finally {
        busy = false;
        // Priority: user messages first, then coalesced file events
        if (queue.length > 0) {
          const next = queue.shift()!;
          setImmediate(() => processMessage(next));
        } else if (coalesceBuffer.size > 0) {
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
        fileWatcher.removeListener("file-change", onFileChanged);
        if (coalesceTimer) clearTimeout(coalesceTimer);
      },
    };
  };
}
