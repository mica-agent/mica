// Direct LLM chat — streaming chat completions against an OpenAI-compatible
// endpoint. The factory reads its configuration from `args` passed at
// `mica.openChannel(fn, args)`, which lets a card class drive system prompt,
// model, endpoint, and sampling without writing server-side code. Same code
// path serves the legacy `.llm-chat` registration AND the new `llm-direct`
// built-in (registered with a manifest in server/index.ts).

import type { ChannelHandler, SessionContext } from "../channelManager.js";
import type { HandlerManifest } from "../handlerManifest.js";

const LLM_PORTS: Record<string, number> = {
  coder: 8012,
  vlm: 8013,
};

// Content can be a plain string or OpenAI-style multimodal content blocks
type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }
  | { type: "video_url"; video_url: { url: string } };
interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string | ContentBlock[];
}

interface DirectArgs {
  systemPrompt?: string;
  model?: string;
  baseUrl?: string;
  temperature?: number;
  maxTokens?: number;
}

export function createLlmChatHandler() {
  return async function llmChatFactory(
    _content: string,
    args: Record<string, unknown>,
    ctx: SessionContext,
  ): Promise<ChannelHandler> {
    const cfg: DirectArgs = {
      systemPrompt: typeof args.systemPrompt === "string" ? args.systemPrompt : undefined,
      model: typeof args.model === "string" ? args.model : undefined,
      baseUrl: typeof args.baseUrl === "string" ? args.baseUrl : undefined,
      temperature: typeof args.temperature === "number" ? args.temperature : 0.7,
      maxTokens: typeof args.maxTokens === "number" ? args.maxTokens : 2048,
    };

    const history: ChatMessage[] = [];
    if (cfg.systemPrompt) {
      history.push({ role: "system", content: cfg.systemPrompt });
    }
    let activeAbort: AbortController | null = null;

    return {
      onAttach(clientId) {
        // Send conversation history to reconnecting client. Strip the system
        // message from the surface — cards display turns, not the prompt.
        const visible = history.filter(m => m.role !== "system");
        ctx.sendTo(clientId, { type: "history", messages: visible });
      },

      async onData(_clientId, data) {
        const msg = data as { type?: string; message?: string; model?: string; content?: ContentBlock[] };

        if (msg.type === "interrupt") {
          if (activeAbort) activeAbort.abort();
          // Broadcast `done` so a chat-card UI listening on it unsticks
          // its busy state. Empty content marks the turn as cancelled.
          ctx.broadcast({ type: "done", content: "", model: cfg.model || "coder" });
          return;
        }

        if (msg.type === "clear") {
          history.length = 0;
          if (cfg.systemPrompt) history.push({ role: "system", content: cfg.systemPrompt });
          ctx.broadcast({ type: "history", messages: [] });
          return;
        }

        const userMessage = msg.message;
        const userContent = msg.content;
        if (!userMessage && !userContent) return;

        // Synthetic clientId from channelMgr.dispatchToFilename — voice
        // dispatched this turn. The eventual `done` broadcast carries
        // viaVoice:true so voice's ambient gate plays the reply aloud.
        const turnSource: "user" | "voice" = _clientId === "voice-dispatch" ? "voice" : "user";

        // Per-message model override wins over the args default. Either way,
        // an explicit baseUrl bypasses the LLM_PORTS table entirely.
        const modelKey = msg.model || cfg.model || "coder";
        // LLAMA_URL is a full URL (e.g. `http://172.17.0.1:8012`) since the
        // vLLM consolidation; it covers the `coder` channel which used to be
        // llama-server on the same port. Other model keys still use the
        // local port table.
        const endpoint = cfg.baseUrl
          ? `${cfg.baseUrl.replace(/\/$/, "")}/v1/chat/completions`
          : modelKey === "coder" && process.env.LLAMA_URL
            ? `${process.env.LLAMA_URL.replace(/\/$/, "")}/v1/chat/completions`
            : `http://127.0.0.1:${LLM_PORTS[modelKey] || LLM_PORTS.coder}/v1/chat/completions`;

        const messageForLlm: string | ContentBlock[] = userContent || userMessage || "";
        history.push({ role: "user", content: messageForLlm });
        ctx.broadcast({ type: "user", content: userMessage || "[image]" });
        ctx.broadcast({ type: "thinking", model: modelKey });

        activeAbort = new AbortController();

        try {
          const resp = await fetch(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              model: modelKey,
              messages: history,
              max_tokens: cfg.maxTokens,
              temperature: cfg.temperature,
              stream: true,
              // Qwen3.6+ has thinking mode on by default — turn it off for direct chat
              // so the model writes reply tokens immediately. Templates that don't
              // recognize the field ignore it.
              chat_template_kwargs: { enable_thinking: false },
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
          ctx.broadcast({
            type: "done",
            content: assistantText,
            model: modelKey,
            // Source attribution for any listener that wants to gate
            // on voice-dispatched turns (voice's ambient TTS gate).
            // Today voice's listener only fires on `type: "assistant"`
            // — these fields are no-ops until that broadens, but
            // ship the data shape now to avoid future plumbing churn.
            source: turnSource,
            viaVoice: turnSource === "voice",
          });

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

export const manifest: HandlerManifest = {
  name: "llm-direct",
  version: "1.0.0",
  description: "Streaming chat against an OpenAI-compatible endpoint with a fixed persona.",
  whenToUse:
    "Pick this when your card class needs streaming chat against a single model with a fixed system prompt — a persona, a focused assistant, an interactive helper. NOT for tool-using behavior (use llm-agent). NOT if you need the project-wide chat role with skills and canvas baseline (use the existing chat card).",
  argsSchema: {
    type: "object",
    properties: {
      systemPrompt: { type: "string", description: "System message prepended to every request. Defines the persona/role." },
      model: { type: "string", description: "Model id. Default: 'coder'. Must be a key in LLM_PORTS or used with a custom baseUrl." },
      baseUrl: { type: "string", description: "OpenAI-compatible base URL (without /v1). When set, bypasses the LLM_PORTS table and the model id is forwarded as-is." },
      temperature: { type: "number", description: "Sampling temperature. Default: 0.7." },
      maxTokens: { type: "number", description: "Max output tokens per turn. Default: 2048." },
    },
  },
  sendShapes: {
    type: "object",
    description:
      "What the card may send via channel.send(). Three message types: " +
      "{ message: string, model?: string, content?: ContentBlock[] } for a user turn (model override is per-message); " +
      "{ type: 'interrupt' } to abort the in-flight stream; " +
      "{ type: 'clear' } to reset history (system prompt is preserved).",
  },
  recvShapes: {
    type: "object",
    description:
      "What the card receives via channel.onData(). Event types: " +
      "{ type: 'history', messages: [...] } on attach; " +
      "{ type: 'user', content: string } user-turn echo; " +
      "{ type: 'thinking', model: string } before tokens start; " +
      "{ type: 'delta', content: string } per-token streaming; " +
      "{ type: 'done', content: string, model: string } turn end; " +
      "{ type: 'error', error: string } on failure.",
  },
  examples:
    "// card.js skeleton\n" +
    "const channel = mica.openChannel('turn', {\n" +
    "  systemPrompt: 'You are a children\\'s storyteller. Reply in 2 short paragraphs.',\n" +
    "  model: 'coder',\n" +
    "});\n" +
    "channel.onData((evt) => {\n" +
    "  if (evt.type === 'delta') appendToBubble(evt.content);\n" +
    "  if (evt.type === 'done') finishBubble(evt.content);\n" +
    "  if (evt.type === 'error') showError(evt.error);\n" +
    "});\n" +
    "// to send: channel.send({ message: 'Tell me about a frog.' });\n" +
    "// to abort:  channel.send({ type: 'interrupt' });\n",
};
