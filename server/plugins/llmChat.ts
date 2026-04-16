// LLM Chat plugin — direct streaming chat with switchable models.
// No agent tools — just conversation with the LLM via OpenAI-compatible API.

import type { ChannelHandler, SessionContext } from "../channelManager.js";

const LLM_PORTS: Record<string, number> = {
  coder: 8012,
  vlm: 8013,
};

interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export function createLlmChatHandler() {
  return async function llmChatFactory(
    _content: string,
    _args: Record<string, unknown>,
    ctx: SessionContext,
  ): Promise<ChannelHandler> {
    const history: ChatMessage[] = [];
    let activeAbort: AbortController | null = null;

    return {
      onAttach(clientId) {
        // Send conversation history to reconnecting client
        ctx.sendTo(clientId, { type: "history", messages: history });
      },

      async onData(_clientId, data) {
        const msg = data as { type?: string; message?: string; model?: string };

        if (msg.type === "interrupt") {
          if (activeAbort) activeAbort.abort();
          return;
        }

        const userMessage = msg.message;
        if (!userMessage) return;

        const modelKey = msg.model || "coder";
        const port = LLM_PORTS[modelKey] || LLM_PORTS.coder;

        history.push({ role: "user", content: userMessage });
        ctx.broadcast({ type: "user", content: userMessage });
        ctx.broadcast({ type: "thinking", model: modelKey });

        activeAbort = new AbortController();

        try {
          const resp = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              model: modelKey,
              messages: history,
              max_tokens: 2048,
              temperature: 0.7,
              stream: true,
            }),
            signal: activeAbort.signal,
          });

          if (!resp.ok) {
            const err = await resp.text();
            ctx.broadcast({ type: "error", error: `LLM error (${resp.status}): ${err.slice(0, 200)}` });
            return;
          }

          let assistantText = "";
          const reader = resp.body as unknown as AsyncIterable<Uint8Array>;
          const decoder = new TextDecoder();
          let buffer = "";

          for await (const chunk of reader) {
            buffer += decoder.decode(chunk, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";

            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed.startsWith("data: ")) continue;
              const payload = trimmed.slice(6);
              if (payload === "[DONE]") continue;

              try {
                const parsed = JSON.parse(payload);
                const delta = parsed.choices?.[0]?.delta;
                if (delta?.content) {
                  assistantText += delta.content;
                  ctx.broadcast({ type: "delta", content: delta.content });
                }
              } catch {
                // skip unparseable
              }
            }
          }

          if (assistantText) {
            history.push({ role: "assistant", content: assistantText });
          }
          ctx.broadcast({ type: "done", content: assistantText, model: modelKey });

        } catch (err) {
          if ((err as Error).name !== "AbortError") {
            ctx.broadcast({ type: "error", error: (err as Error).message });
          }
        } finally {
          activeAbort = null;
        }
      },

      onDestroy() {
        if (activeAbort) activeAbort.abort();
      },
    };
  };
}
