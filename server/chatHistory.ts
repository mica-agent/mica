// Chat history helpers — append messages to _chat-history.json for a canvas.
// Used by the reactive agent to inject messages into the chat sidebar.

import { readCanvasFile, writeCanvasFile } from "./canvasFiles.js";

export interface ChatHistoryMessage {
  role: "user" | "assistant";
  content: string;
  agent?: string;
  filesChanged?: boolean;
  reactive?: boolean;
  trigger?: string;
}

/** Append messages to a canvas's _chat-history.json (creates if missing). */
export async function appendChatHistory(
  project: string,
  canvas: string,
  messages: ChatHistoryMessage[],
): Promise<void> {
  let history: ChatHistoryMessage[] = [];

  try {
    const file = await readCanvasFile(project, canvas, "_chat-history.json");
    history = JSON.parse(file.content);
  } catch {
    // No history yet or parse error — start fresh
  }

  history.push(...messages);

  // Keep last 100 messages
  if (history.length > 100) {
    history = history.slice(-100);
  }

  await writeCanvasFile(project, canvas, "_chat-history.json", JSON.stringify(history, null, 2));
}
