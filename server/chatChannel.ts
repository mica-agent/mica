/**
 * ChatChannel — Node-side manager for chat sidebar sessions.
 *
 * Sessions are keyed by (project, canvas, filename), not by channel ID.
 * Multiple browser channels can attach/detach from the same session.
 *
 * The chat channel handles agent calls DIRECTLY in Node — no V8 isolate
 * involvement. This eliminates deadlock risks from long-running agent calls.
 *
 * Protocol (browser ↔ server):
 *   Browser → Server:  { message: string }
 *   Server → Browser:  { type: "history", messages: [...] }
 *                      { type: "user", content: string }
 *                      { type: "thinking" }
 *                      { type: "progress", tool: string, description: string }
 *                      { type: "assistant", content: string, agent: string, filesChanged: boolean }
 *                      { type: "error", error: string }
 */

import { readCanvasFile, writeCanvasFile } from "./canvasFiles.js";

export type ChatFn = (
  project: string,
  canvas: string,
  message: string,
  image?: string,
  onProgress?: (evt: { type: string; tool?: string; description?: string; elapsed?: number }) => void,
) => Promise<{ message: string; filesChanged?: boolean; agentName?: string }>;

export type BroadcastFn = (msg: Record<string, unknown>) => void;

interface ChannelHandle {
  onData: (data: unknown) => void;
  onClose: () => void;
}

interface ChatSession {
  channels: Map<string, ChannelHandle>;
  busy: boolean;  // is an agent call in progress?
}

interface ChatMessage {
  role: string;
  content: string;
  agent?: string;
  filesChanged?: boolean;
  reactive?: boolean;
  trigger?: string;
}

const MAX_HISTORY = 100;

export class ChatChannelManager {
  private sessions: Map<string, ChatSession> = new Map();
  private channelToSession: Map<string, string> = new Map();
  private chatFn: ChatFn | null = null;
  private broadcast: BroadcastFn | null = null;

  private sessionKey(project: string, canvas: string, filename: string): string {
    return `${project}/${canvas}/${filename}`;
  }

  setChatFn(fn: ChatFn): void {
    this.chatFn = fn;
  }

  setBroadcast(fn: BroadcastFn): void {
    this.broadcast = fn;
  }

  /**
   * Open or attach to a chat session.
   * Replays message history to the new channel.
   */
  async open(
    channelId: string,
    project: string,
    canvas: string,
    filename: string,
    _args: Record<string, unknown>,
    onData: (data: unknown) => void,
    onClose: () => void,
  ): Promise<void> {
    const key = this.sessionKey(project, canvas, filename);
    let session = this.sessions.get(key);

    if (!session) {
      session = { channels: new Map(), busy: false };
      this.sessions.set(key, session);
    }

    session.channels.set(channelId, { onData, onClose });
    this.channelToSession.set(channelId, key);

    // Replay message history to the new channel
    const messages = await this.loadHistory(project, canvas);
    onData({ type: "history", messages });

    console.log(`[chat] Attached channel ${channelId} to session ${key} (${session.channels.size} channels)`);
  }

  /**
   * Handle incoming data from the browser.
   */
  async sendData(channelId: string, data: unknown): Promise<void> {
    const key = this.channelToSession.get(channelId);
    if (!key) return;
    const session = this.sessions.get(key);
    if (!session) return;

    const msg = data as Record<string, unknown>;
    const message = msg.message as string;
    if (!message) return;

    // Parse session key back to (project, canvas, filename)
    const parts = key.split("/");
    const project = parts[0];
    const canvas = parts[1];

    if (!this.chatFn) {
      this.broadcastToSession(session, { type: "error", error: "No agent configured" });
      return;
    }

    // Broadcast user message to all attached channels
    this.broadcastToSession(session, { type: "user", content: message });

    // Append user message to history
    await this.appendHistory(project, canvas, [{ role: "user", content: message }]);

    // Mark busy and broadcast thinking state
    session.busy = true;
    this.broadcastToSession(session, { type: "thinking" });

    try {
      const response = await this.chatFn(project, canvas, message, undefined, (evt) => {
        // Stream progress events to all attached channels
        this.broadcastToSession(session!, {
          type: "progress",
          event: evt.type,
          tool: evt.tool,
          description: evt.description,
          elapsed: evt.elapsed,
        });

        // Also broadcast as agent-progress for the turn indicator
        this.broadcast?.({
          type: "agent-progress",
          project, canvas,
          event: evt.type,
          tool: evt.tool,
          description: evt.description,
          elapsed: evt.elapsed,
        });
      });

      const agentName = response.agentName || "AI Agent";
      const filesChanged = response.filesChanged || false;

      // Broadcast assistant response to all channels
      this.broadcastToSession(session, {
        type: "assistant",
        content: response.message,
        agent: agentName,
        filesChanged,
      });

      // Persist to history
      await this.appendHistory(project, canvas, [
        { role: "assistant", content: response.message, agent: agentName, filesChanged },
      ]);

    } catch (err) {
      this.broadcastToSession(session, {
        type: "error",
        error: (err as Error).message,
      });
    } finally {
      session.busy = false;
    }
  }

  /**
   * Detach a channel from its session.
   * Session stays alive (no process to kill, unlike terminal).
   */
  close(channelId: string): void {
    const key = this.channelToSession.get(channelId);
    if (!key) return;
    this.channelToSession.delete(channelId);

    const session = this.sessions.get(key);
    if (!session) return;

    session.channels.delete(channelId);
    console.log(`[chat] Detached channel ${channelId} from session ${key} (${session.channels.size} remaining)`);

    // Clean up session if no channels and not busy
    if (session.channels.size === 0 && !session.busy) {
      this.sessions.delete(key);
    }
  }

  has(channelId: string): boolean {
    return this.channelToSession.has(channelId);
  }

  closeAll(): void {
    for (const [key, session] of this.sessions) {
      for (const [chId] of session.channels) {
        this.channelToSession.delete(chId);
      }
      console.log(`[chat] Shutdown: closed session ${key}`);
    }
    this.sessions.clear();
  }

  // ── Internal helpers ──────────────────────────────────────

  private broadcastToSession(session: ChatSession, msg: unknown): void {
    for (const ch of session.channels.values()) {
      ch.onData(msg);
    }
  }

  private async loadHistory(project: string, canvas: string): Promise<ChatMessage[]> {
    try {
      const file = await readCanvasFile(project, canvas, ".chat-history.json");
      return JSON.parse(file.content);
    } catch {
      return [];
    }
  }

  private async appendHistory(project: string, canvas: string, newMessages: ChatMessage[]): Promise<void> {
    let messages = await this.loadHistory(project, canvas);
    messages.push(...newMessages);
    if (messages.length > MAX_HISTORY) {
      messages = messages.slice(-MAX_HISTORY);
    }
    await writeCanvasFile(project, canvas, ".chat-history.json", JSON.stringify(messages, null, 2));
  }
}
