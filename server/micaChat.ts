// micaChat — pluggable chat handler for mica.chat.* calls.
// Proxies to llama-server (OpenAI-compatible API).
// Registered as a mica.* namespace handler.

import { readFile, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { micaDir, listFiles, readProjectFile, WORKSPACE_DIR } from "./files.js";

// Active project is tracked in index.ts and passed via module-level setter
let _activeProject: string | null = null;
export function setActiveProject(project: string | null) { _activeProject = project; }
function getMicaDir() { return micaDir(_activeProject || undefined); }

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

const LLAMA_URL = process.env.LLAMA_URL || "http://127.0.0.1:8012";

// ── Chat history persistence ─────────────────────────────────

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
  await writeFile(join(dir, `${chatId}.json`), JSON.stringify(messages, null, 2), "utf-8");
}

// ── System prompt builder ────────────────────────────────────

async function buildSystemPrompt(): Promise<string> {
  let system = "You are a planning assistant for a software project. Help the user think through specs, decisions, tasks, and architecture.\n\n";

  // Include canvas-back (project AI context)
  try {
    const canvasBack = await readFile(join(getMicaDir(), "canvas-back.md"), "utf-8");
    if (canvasBack.trim()) {
      system += `## Project Context\n${canvasBack}\n\n`;
    }
  } catch { /* no canvas-back yet */ }

  // Include project files for awareness (text files only, with content preview)
  try {
    const files = await listFiles(_activeProject || undefined);
    if (files.length > 0) {
      system += `## Project Files\n`;
      const TEXT_EXTS = new Set([".md", ".txt", ".json", ".todo", ".chat", ".mmd", ".yaml", ".yml"]);
      for (const f of files) {
        const ext = f.name.substring(f.name.lastIndexOf(".")).toLowerCase();
        if (TEXT_EXTS.has(ext) && f.size < 50000) {
          try {
            const file = await readProjectFile(f.name, _activeProject || undefined);
            system += `### ${f.name}\n${file.content.slice(0, 2000)}\n\n`;
          } catch { system += `### ${f.name} (${f.size} bytes)\n\n`; }
        } else {
          system += `### ${f.name} (${f.size} bytes)\n\n`;
        }
      }
    }
  } catch { /* ignore */ }

  return system;
}

// ── Handler methods ──────────────────────────────────────────

async function send(params: { chatId: string; message: string }): Promise<{ reply: string; history: ChatMessage[] }> {
  const { chatId, message } = params;
  if (!chatId || !message) throw new Error("chatId and message required");

  const history = await loadHistory(chatId);
  history.push({ role: "user", content: message });

  const systemPrompt = await buildSystemPrompt();
  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    ...history,
  ];

  const res = await fetch(`${LLAMA_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "mica",
      messages,
      max_tokens: 4096,
      stream: false,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`LLM error: ${errText}`);
  }

  const data = await res.json() as {
    choices: Array<{ message: { content: string; reasoning_content?: string } }>;
  };
  const reply = data.choices[0]?.message?.content
    || data.choices[0]?.message?.reasoning_content
    || "(no response)";

  history.push({ role: "assistant", content: reply });
  await saveHistory(chatId, history);

  return { reply, history };
}

async function getHistory(params: { chatId: string }): Promise<{ history: ChatMessage[] }> {
  const history = await loadHistory(params.chatId);
  return { history };
}

async function clearHistory(params: { chatId: string }): Promise<{ success: boolean }> {
  await saveHistory(params.chatId, []);
  return { success: true };
}

// ── Namespace handler (dispatches mica.chat.* methods) ────────

export async function chatHandler(method: string, params: unknown): Promise<unknown> {
  switch (method) {
    case "send":
      return send(params as { chatId: string; message: string });
    case "history":
      return getHistory(params as { chatId: string });
    case "clear":
      return clearHistory(params as { chatId: string });
    default:
      throw new Error(`Unknown method: mica.chat.${method}`);
  }
}
