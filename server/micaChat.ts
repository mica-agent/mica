// micaChat — pluggable chat handler for mica.chat.* calls.
// NOTE: currently unused — the real chat routing goes through micaAgent.ts
// (Qwen SDK). This file remains as a reference implementation for a simpler
// request/response chat against llama-server. Project scoping is taken from
// the `project` field of each call's params (set by the caller). The
// exported setActiveProject is a backward-compat no-op shim for index.ts.

import { readFile, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { micaDir, listFiles, readProjectFile } from "./files.js";

// Phase-1 shim, retained so server/index.ts's import doesn't break. No-op.
export function setActiveProject(_project: string | null) { void _project; }

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

const LLAMA_URL = process.env.LLAMA_URL || "http://127.0.0.1:8012";

// ── Chat history persistence ─────────────────────────────────

async function loadHistory(chatId: string, project: string | undefined): Promise<ChatMessage[]> {
  try {
    const raw = await readFile(join(micaDir(project), "chats", `${chatId}.json`), "utf-8");
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

async function saveHistory(chatId: string, messages: ChatMessage[], project: string | undefined): Promise<void> {
  const dir = join(micaDir(project), "chats");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${chatId}.json`), JSON.stringify(messages, null, 2), "utf-8");
}

// ── System prompt builder ────────────────────────────────────

async function buildSystemPrompt(project: string | undefined): Promise<string> {
  let system = "You are a planning assistant for a software project. Help the user think through specs, decisions, tasks, and architecture.\n\n";

  // Include canvas-back (project AI context)
  try {
    const canvasBack = await readFile(join(micaDir(project), "canvas-back.md"), "utf-8");
    if (canvasBack.trim()) {
      system += `## Project Context\n${canvasBack}\n\n`;
    }
  } catch { /* no canvas-back yet */ }

  // Include project files for awareness (text files only, with content preview)
  try {
    const files = await listFiles(project);
    if (files.length > 0) {
      system += `## Project Files\n`;
      const TEXT_EXTS = new Set([".md", ".txt", ".json", ".todo", ".qwen", ".mmd", ".yaml", ".yml"]);
      for (const f of files) {
        const ext = f.name.substring(f.name.lastIndexOf(".")).toLowerCase();
        if (TEXT_EXTS.has(ext) && f.size < 50000) {
          try {
            const file = await readProjectFile(f.name, project);
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

async function send(params: { chatId: string; message: string; project?: string }): Promise<{ reply: string; history: ChatMessage[] }> {
  const { chatId, message, project } = params;
  if (!chatId || !message) throw new Error("chatId and message required");

  const history = await loadHistory(chatId, project);
  history.push({ role: "user", content: message });

  const systemPrompt = await buildSystemPrompt(project);
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
  await saveHistory(chatId, history, project);

  return { reply, history };
}

async function getHistory(params: { chatId: string; project?: string }): Promise<{ history: ChatMessage[] }> {
  const history = await loadHistory(params.chatId, params.project);
  return { history };
}

async function clearHistory(params: { chatId: string; project?: string }): Promise<{ success: boolean }> {
  await saveHistory(params.chatId, [], params.project);
  return { success: true };
}

// ── Namespace handler (dispatches mica.chat.* methods) ────────

export async function chatHandler(method: string, params: unknown, _project: string | null = null): Promise<unknown> {
  void _project;
  switch (method) {
    case "send":
      return send(params as { chatId: string; message: string; project?: string });
    case "history":
      return getHistory(params as { chatId: string; project?: string });
    case "clear":
      return clearHistory(params as { chatId: string; project?: string });
    default:
      throw new Error(`Unknown method: mica.chat.${method}`);
  }
}
