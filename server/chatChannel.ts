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
  resumeSessionId?: string,
) => Promise<{ message: string; filesChanged?: boolean; agentName?: string; sessionId?: string }>;

export type BroadcastFn = (msg: Record<string, unknown>) => void;

interface ChannelHandle {
  onData: (data: unknown) => void;
  onClose: () => void;
}

interface ChatSession {
  channels: Map<string, ChannelHandle>;
  busy: boolean;  // is an agent call in progress?
  provider?: string;  // provider override from channel open args (for card-based agents)
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
  private providerChatFns: Map<string, ChatFn> = new Map(); // provider name → chat function
  private broadcast: BroadcastFn | null = null;
  private messageQueues: Map<string, string[]> = new Map(); // session key → queued messages
  private agentSessionIds: Map<string, string> = new Map(); // session key → SDK session ID (persists across channel reconnects)

  private sessionKey(project: string, canvas: string, filename: string): string {
    return `${project}/${canvas}/${filename}`;
  }

  setChatFn(fn: ChatFn): void {
    this.chatFn = fn;
  }

  /** Register a chat function for a specific provider (used by card-based agents). */
  setProviderChatFn(provider: string, fn: ChatFn): void {
    this.providerChatFns.set(provider, fn);
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
      session = { channels: new Map(), busy: false, provider: _args.provider as string | undefined };
      this.sessions.set(key, session);
    }

    session.channels.set(channelId, { onData, onClose });
    this.channelToSession.set(channelId, key);

    console.log(`[chat] Attached channel ${channelId} to session ${key} (${session.channels.size} channels)`);

    // Replay message history to the new channel.
    // NOTE: This is async — a channel_close may arrive during the await.
    // The channel is already registered above so sendData() works even if
    // loadHistory is slow. If the channel is closed during the await,
    // the onData call below will harmlessly send to a detached channel.
    const messages = await this.loadHistory(project, canvas);
    onData({ type: "history", messages });
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
    console.log(`[chat] Received data on channel ${channelId}:`, JSON.stringify(msg).slice(0, 100));
    if (!message) return;

    // If an agent call is already in progress, queue the message.
    if (session.busy) {
      let queue = this.messageQueues.get(key);
      if (!queue) {
        queue = [];
        this.messageQueues.set(key, queue);
      }
      queue.push(message);
      console.log(`[chat] Session ${key} is busy, queued message (${queue.length} pending)`);
      return;
    }

    // Mark busy IMMEDIATELY (synchronous) before any async work,
    // so concurrent sendData calls are blocked.
    session.busy = true;

    // Parse session key back to (project, canvas, filename)
    const parts = key.split("/");
    const project = parts[0];
    const canvas = parts[1];

    // Resolve chat function: provider-specific (from card args) or default (from project config)
    const chatFn = session.provider
      ? this.providerChatFns.get(session.provider) || this.chatFn
      : this.chatFn;

    if (!chatFn) {
      session.busy = false;
      this.broadcastToSession(session, { type: "error", error: "No agent configured" });
      return;
    }

    // Broadcast user message to all attached channels
    this.broadcastToSession(session, { type: "user", content: message });

    // Append user message to history
    await this.appendHistory(project, canvas, [{ role: "user", content: message }]);
    this.broadcastToSession(session, { type: "thinking" });

    const resumeId = this.agentSessionIds.get(key);
    console.log(`[chat] Calling agent for session ${key}: "${message.slice(0, 50)}"${resumeId ? ` (resuming ${resumeId.slice(0, 8)}...)` : ""}`);
    try {
      const response = await chatFn(project, canvas, message, undefined, (evt) => {
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
      }, resumeId);

      // Store the SDK session ID for conversation continuity (persists across reconnects)
      if (response.sessionId) {
        this.agentSessionIds.set(key, response.sessionId);
      }

      const agentName = response.agentName || "AI Agent";
      const filesChanged = response.filesChanged || false;

      if (!response.message) {
        console.warn(`[chat] Agent returned empty response for session ${key}`);
      }

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
      console.error(`[chat] Agent error for session ${key}:`, (err as Error).message);
      this.broadcastToSession(session, {
        type: "error",
        error: (err as Error).message,
      });
    } finally {
      session.busy = false;

      // Process next queued message if any
      const queue = this.messageQueues.get(key);
      if (queue && queue.length > 0) {
        // Take only the LAST queued message — intermediate ones are stale
        const lastMessage = queue[queue.length - 1];
        const skipped = queue.length - 1;
        queue.length = 0;
        if (skipped > 0) {
          console.log(`[chat] Skipping ${skipped} stale queued messages for session ${key}`);
        }
        // Find a channel ID that maps to this session and re-dispatch
        let dispatchChannel: string | null = null;
        this.channelToSession.forEach((sKey, chId) => {
          if (!dispatchChannel && sKey === key) dispatchChannel = chId;
        });
        if (dispatchChannel) {
          console.log(`[chat] Processing queued message for session ${key}: "${lastMessage.slice(0, 50)}"`);
          const chId = dispatchChannel;
          // Use setImmediate to avoid deep recursion
          setImmediate(() => this.sendData(chId, { message: lastMessage }));
        }
      }
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

    // When the last channel detaches, keep the session alive (don't delete it).
    // Chat cards can detach/reattach during re-render cycles, and deleting the
    // session would lose the provider and busy state. Sessions are lightweight
    // (just a Map + flags) so keeping them around is fine.
    if (session.channels.size === 0) {
      if (session.busy) {
        console.warn(`[chat] Last channel detached while session ${key} was busy — keeping session alive`);
      }
      this.messageQueues.delete(key);
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
    this.messageQueues.clear();
  }

  // ── Internal helpers ──────────────────────────────────────

  private broadcastToSession(session: ChatSession, msg: unknown): void {
    const staleChannels: string[] = [];
    for (const [channelId, ch] of session.channels) {
      try {
        ch.onData(msg);
      } catch (err) {
        console.warn(`[chat] Stale channel ${channelId}, removing:`, (err as Error).message);
        staleChannels.push(channelId);
      }
    }
    // Remove stale channels outside the iteration
    for (const channelId of staleChannels) {
      session.channels.delete(channelId);
      this.channelToSession.delete(channelId);
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
