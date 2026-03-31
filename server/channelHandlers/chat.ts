/**
 * Chat channel handler — manages conversation history and agent calls.
 *
 * Replaces ChatChannelManager with the unified ChannelHandler interface.
 *
 * Protocol (browser <-> server):
 *   Browser -> Server:  { message: string }
 *   Server -> Browser:  { type: "history", messages: [...] }
 *                       { type: "user", content: string }
 *                       { type: "thinking" }
 *                       { type: "progress", tool: string, description: string }
 *                       { type: "assistant", content: string, agent: string, filesChanged: boolean }
 *                       { type: "error", error: string }
 */

import { getProvider } from "../agentCore/registry.js";
import { resolveAgentProvider } from "../agentCore/config.js";
import { describeToolUse } from "../agentCore/logging.js";
import type { ChannelHandler, SessionContext } from "../channelManager.js";

interface ChatMessage {
  role: string;
  content: string;
  agent?: string;
  filesChanged?: boolean;
  reactive?: boolean;
  trigger?: string;
}

const MAX_HISTORY = 100;
const HISTORY_FILE = ".chat-history.json";

export function createChatHandler(
  _content: string,
  args: Record<string, unknown>,
  ctx: SessionContext,
): ChannelHandler {
  const providerName = args.provider as string | undefined;

  let busy = false;
  const messageQueue: string[] = [];
  let agentSessionId: string | undefined;

  // ── History helpers ──────────────────────────────────────

  async function loadHistory(): Promise<ChatMessage[]> {
    try {
      const raw = await ctx.readFile(HISTORY_FILE);
      return JSON.parse(raw) as ChatMessage[];
    } catch {
      return [];
    }
  }

  async function appendHistory(newMessages: ChatMessage[]): Promise<void> {
    let messages = await loadHistory();
    messages.push(...newMessages);
    if (messages.length > MAX_HISTORY) {
      messages = messages.slice(-MAX_HISTORY);
    }
    await ctx.writeFile(HISTORY_FILE, JSON.stringify(messages, null, 2));
  }

  // ── Agent call ───────────────────────────────────────────

  async function processMessage(clientId: string, message: string): Promise<void> {
    busy = true;

    // Resolve provider
    const resolvedName = providerName || await resolveAgentProvider(ctx.project);
    const provider = getProvider(resolvedName);
    if (!provider) {
      busy = false;
      ctx.broadcast({ type: "error", error: `No agent provider found: ${resolvedName}` });
      return;
    }

    // Broadcast user message to all clients
    ctx.broadcast({ type: "user", content: message });

    // Persist user message
    await appendHistory([{ role: "user", content: message }]);

    // Signal thinking
    ctx.broadcast({ type: "thinking" });

    try {
      const response = await provider.chat(
        ctx.project,
        ctx.canvas,
        message,
        undefined,
        (evt) => {
          const description = evt.description
            || (evt.tool ? describeToolUse(evt.tool) : undefined);
          ctx.broadcast({
            type: "progress",
            event: evt.type,
            tool: evt.tool,
            description,
            elapsed: evt.elapsed,
          });
        },
        agentSessionId,
      );

      // Store SDK session ID for conversation continuity
      if (response.sessionId) {
        agentSessionId = response.sessionId;
      }

      const agentName = provider.name;
      const filesChanged = response.filesChanged ?? false;

      // Broadcast assistant response
      console.log(`[chat-handler] Agent responded (${response.message?.length || 0} chars, filesChanged=${filesChanged})`);
      ctx.broadcast({
        type: "assistant",
        content: response.message,
        agent: agentName,
        filesChanged,
      });

      // Persist assistant message
      await appendHistory([
        { role: "assistant", content: response.message, agent: agentName, filesChanged },
      ]);
    } catch (err) {
      console.error(`[chat-handler] Agent error:`, (err as Error).message);
      ctx.broadcast({ type: "error", error: (err as Error).message });
    } finally {
      busy = false;

      // Drain queue: take only the last message (intermediate ones are stale)
      if (messageQueue.length > 0) {
        const lastMessage = messageQueue[messageQueue.length - 1];
        const skipped = messageQueue.length - 1;
        messageQueue.length = 0;
        if (skipped > 0) {
          console.log(`[chat-handler] Skipping ${skipped} stale queued messages`);
        }
        // Use setImmediate to avoid deep recursion
        setImmediate(() => processMessage(clientId, lastMessage));
      }
    }
  }

  // ── Handler interface ────────────────────────────────────

  return {
    onAttach(clientId: string, _args: Record<string, unknown>): void {
      // Replay history to the newly attached client
      loadHistory().then((messages) => {
        ctx.sendTo(clientId, { type: "history", messages });
      }).catch((err) => {
        console.warn(`[chat-handler] Failed to load history for ${clientId}:`, (err as Error).message);
        ctx.sendTo(clientId, { type: "history", messages: [] });
      });
    },

    onData(clientId: string, data: unknown): void {
      const msg = data as Record<string, unknown>;

      // Handle history request (persistent channel reattach)
      if (msg.type === "request_history") {
        loadHistory().then((messages) => {
          ctx.sendTo(clientId, { type: "history", messages });
        }).catch(() => {
          ctx.sendTo(clientId, { type: "history", messages: [] });
        });
        return;
      }

      const message = msg.message as string;
      if (!message) return;
      console.log(`[chat-handler] Received message from ${clientId}: "${message.slice(0, 50)}"`);

      if (busy) {
        messageQueue.push(message);
        console.log(`[chat-handler] Busy, queued message (${messageQueue.length} pending)`);
        return;
      }

      processMessage(clientId, message);
    },

    onDetach(_clientId: string): void {
      // Nothing to do — session stays alive
    },

    onDestroy(): void {
      // Nothing to clean up
      messageQueue.length = 0;
    },
  };
}
