// Direct LLM chat — streaming chat completions against an OpenAI-compatible
// endpoint. The factory reads its configuration from `args` passed at
// `mica.openChannel(fn, args)`, which lets a card class drive system prompt,
// model, endpoint, and sampling without writing server-side code. Same code
// path serves the legacy `.llm-chat` registration AND the new `llm-direct`
// built-in (registered with a manifest in server/index.ts).

import sharp from "sharp";
import type { ChannelHandler, SessionContext } from "../channelManager.js";
import type { HandlerManifest } from "../handlerManifest.js";
import { resolveServedModel } from "./llmModelResolver.js";
import {
  readCardSettings,
  resolveDefaultProvider,
  resolveDefaultModel,
  readOpenRouterKey,
  readOpenAICompatConfig,
  type CardSettings,
} from "../files.js";
import { estimateTurnCost } from "../costEstimator.js";

// Default OpenAI-compatible endpoint when neither `baseUrl` nor LLAMA_URL
// is set. Post-vLLM-consolidation the chat container is on 8012 (served
// from the docker-host gateway in the devcontainer; 127.0.0.1 works from
// the host).
const DEFAULT_LLM_BASE_URL = "http://127.0.0.1:8012";

function resolveLocalBaseUrl(cfg: { baseUrl?: string }): string {
  if (cfg.baseUrl) return cfg.baseUrl.replace(/\/$/, "");
  if (process.env.LLAMA_URL) return process.env.LLAMA_URL.replace(/\/$/, "");
  return DEFAULT_LLM_BASE_URL;
}

interface ResolvedRoute {
  /** The provider the cost estimator + per-turn telemetry use. */
  provider: NonNullable<CardSettings["provider"]>;
  baseUrl: string;           // includes /v1 segment; chat completions = `${baseUrl}/chat/completions`
  authHeader: Record<string, string>;  // bearer token, or empty for local
  modelHint?: string;        // when the user pinned a model in the card sidecar
  /** Empty string when no fallback list is appropriate (cloud providers — the
   *  cloud catalog is too large to use as a "did you mean" list). For local,
   *  we keep the legacy [qwen-vl, qwen3-vl-local] fallback so the served-model
   *  resolver can still pick a working name. */
  servedFallbacks: string[];
  /** Human-readable label for log/info messages. */
  label: string;
  /** vLLM-specific knob (chat_template_kwargs.enable_thinking=false). Only
   *  safe to send for the local engine; cloud providers reject unknown kwargs. */
  isLocal: boolean;
}

/** Resolve the chat-completions endpoint for THIS card. Per-card sidecar
 *  setting (provider, model) wins; falls back to MICA_DEFAULT_PROVIDER + the
 *  per-provider {OPENROUTER,OPENAI,LOCAL}_DEFAULT_MODEL envs. Mirrors the same
 *  resolution order used by the qwen / opencode agent cards so an .llm-chat
 *  card configured via the gear behaves identically to those classes. */
async function resolveRoute(
  cfg: { baseUrl?: string },
  ctx: SessionContext,
): Promise<ResolvedRoute> {
  let settings: CardSettings = {};
  if (ctx.project) {
    try { settings = await readCardSettings(ctx.project, ctx.filename); } catch { /* empty */ }
  }
  const provider = settings.provider ?? resolveDefaultProvider();

  if (provider === "openrouter") {
    const key = ctx.project ? await readOpenRouterKey(ctx.project) : null;
    if (!key) {
      console.warn(`[llm-chat] OpenRouter selected for ${ctx.filename} but no key — falling back to local engine. Set the key via the card's gear panel.`);
      // Fall through to local
    } else {
      const model = (settings.model || "").trim() || resolveDefaultModel("openrouter");
      return {
        provider: "openrouter",
        baseUrl: "https://openrouter.ai/api/v1",
        authHeader: { Authorization: `Bearer ${key}` },
        modelHint: model,
        servedFallbacks: [],
        label: `OpenRouter (${model})`,
        isLocal: false,
      };
    }
  }

  if (provider === "openai-compat") {
    const oc = ctx.project ? await readOpenAICompatConfig(ctx.project) : { baseUrl: null, key: null };
    if (!oc.baseUrl || !oc.key) {
      console.warn(`[llm-chat] openai-compat selected for ${ctx.filename} but baseUrl/key missing — falling back to local engine.`);
      // Fall through to local
    } else {
      const baseClean = oc.baseUrl.replace(/\/+$/, "");
      const v1 = /\/v\d+$/.test(baseClean) ? baseClean : `${baseClean}/v1`;
      const model = (settings.model || "").trim() || resolveDefaultModel("openai-compat");
      return {
        provider: "openai-compat",
        baseUrl: v1,
        authHeader: { Authorization: `Bearer ${oc.key}` },
        modelHint: model,
        servedFallbacks: [],
        label: `openai-compat ${v1} (${model})`,
        isLocal: false,
      };
    }
  }

  // Local (default, or any of the above's fallback path).
  const localBase = resolveLocalBaseUrl(cfg);
  // Include /v1 so it's symmetric with the cloud branches — the chat-completions
  // call below just appends /chat/completions.
  const v1 = /\/v\d+$/.test(localBase) ? localBase : `${localBase}/v1`;
  const model = (settings.model || "").trim() || resolveDefaultModel("local");
  return {
    provider: "local",
    baseUrl: v1,
    authHeader: {},
    modelHint: model,
    servedFallbacks: ["qwen-vl", "qwen3-vl-local"],
    label: `local ${localBase}`,
    isLocal: true,
  };
}

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
  /** Conversation memory policy. 'persist' (default) retains turn-by-turn
   *  history across send() calls — the canonical chat pattern. 'stateless'
   *  treats each send() as a one-shot query: only the system prompt + the
   *  current user turn reach the model; no history accumulation. Stateless
   *  is the right pick for classification/generation cards where every
   *  query is independent — prevents the "history accumulates images and
   *  hits the model's per-turn cap" failure mode that bit stt7. */
  history?: "persist" | "stateless";
}

// Parse a `data:image/<fmt>;base64,<payload>` URL into its parts. Returns
// null if the URL isn't a data: URL we can decode (blob:, https:, etc.) —
// the caller passes those through untouched.
function parseDataUrl(url: string): { mime: string; format: string; buffer: Buffer } | null {
  const m = url.match(/^data:image\/([a-z]+);base64,(.+)$/i);
  if (!m) return null;
  const format = m[1].toLowerCase();
  const buffer = Buffer.from(m[2], "base64");
  return { mime: `image/${format}`, format, buffer };
}

// Encode a Buffer back into a data: URL with the given mime.
function encodeDataUrl(buffer: Buffer, mime: string): string {
  return `data:${mime};base64,${buffer.toString("base64")}`;
}

/** Walk every user message's content blocks; for any image_url block whose
 *  URL is a base64 data: URL exceeding `maxDim` on its longest edge, resize
 *  it with sharp (preserve aspect ratio, preserve source format) and
 *  replace the URL in-place. Non-data: URLs and non-image blocks pass
 *  through untouched. Errors during decode/resize are logged and the
 *  original block is passed through so vLLM surfaces its own error.
 *
 *  This is the server-side equivalent of "client-side resize before send"
 *  — the agent doesn't have to remember to do it in card.js because the
 *  framework owns the precondition. */
async function resizeImagesInMessages(messages: ChatMessage[], maxDim: number): Promise<ChatMessage[]> {
  return Promise.all(messages.map(async (msg) => {
    if (typeof msg.content === "string") return msg;
    if (!Array.isArray(msg.content)) return msg;
    const newContent = await Promise.all(msg.content.map(async (block) => {
      if (block.type !== "image_url") return block;
      const url = block.image_url?.url;
      if (typeof url !== "string") return block;
      const parsed = parseDataUrl(url);
      if (!parsed) return block; // blob:/http(s): URL — pass through; vLLM will error if unsupported
      try {
        const image = sharp(parsed.buffer);
        const metadata = await image.metadata();
        const w = metadata.width ?? 0;
        const h = metadata.height ?? 0;
        if (!w || !h) return block; // can't read dimensions — pass through
        const longEdge = Math.max(w, h);
        if (longEdge <= maxDim) return block; // already within limit
        // Resize: fit:'inside' clamps the bounding box, preserving aspect ratio.
        // toFormat with the source format preserves jpeg/png/webp encoding.
        const resized = await image
          .resize({ width: maxDim, height: maxDim, fit: "inside", withoutEnlargement: true })
          .toFormat(parsed.format as keyof sharp.FormatEnum)
          .toBuffer();
        const newMetadata = await sharp(resized).metadata();
        const newW = newMetadata.width ?? w;
        const newH = newMetadata.height ?? h;
        console.log(`[llmChat] resized image ${w}x${h} → ${newW}x${newH} (long edge ${maxDim}px)`);
        return {
          type: "image_url" as const,
          image_url: { url: encodeDataUrl(resized, parsed.mime) },
        };
      } catch (err) {
        console.warn(`[llmChat] resize failed, passing through original:`, (err as Error).message);
        return block;
      }
    }));
    return { ...msg, content: newContent };
  }));
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
      history: args.history === "stateless" ? "stateless" : "persist",
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
          ctx.broadcast({ type: "done", content: "", model: cfg.model || "" });
          return;
        }

        if (msg.type === "clear") {
          history.length = 0;
          if (cfg.systemPrompt) history.push({ role: "system", content: cfg.systemPrompt });
          ctx.broadcast({ type: "history", messages: [] });
          return;
        }

        if (msg.type === "list_models") {
          // Legacy ping retained for any card-class that still asks for it (the
          // current llm-chat card.html uses the gear panel instead and does
          // not send this). Probe the LOCAL endpoint only — cloud catalogs
          // are surfaced via /api/openrouter/models from the card's own gear.
          const localBase = resolveLocalBaseUrl(cfg);
          try {
            const modelsResp = await fetch(`${localBase}/v1/models`, {
              signal: AbortSignal.timeout(5000),
            });
            if (!modelsResp.ok) {
              ctx.broadcast({ type: "models", models: [], error: `HTTP ${modelsResp.status}` });
              return;
            }
            const data = (await modelsResp.json()) as { data?: Array<{ id: string }> };
            const ids = (data.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === "string");
            ctx.broadcast({ type: "models", models: ids });
          } catch (err) {
            ctx.broadcast({ type: "models", models: [], error: (err as Error).message });
          }
          return;
        }

        const userMessage = msg.message;
        const userContent = msg.content;
        if (!userMessage && !userContent) return;

        // Synthetic clientId from channelMgr.dispatchToFilename — voice
        // dispatched this turn. The eventual `done` broadcast carries
        // viaVoice:true so voice's ambient gate plays the reply aloud.
        const turnSource: "user" | "voice" = _clientId === "voice-dispatch" ? "voice" : "user";

        // Resolve the route for THIS card and turn. Per-card gear setting
        // (sidecar) wins, MICA_DEFAULT_PROVIDER + {OPENROUTER,OPENAI,LOCAL}_
        // DEFAULT_MODEL fills in. Per-message model override (msg.model from
        // the card.js payload, if any) still trumps the resolver — covers
        // call sites that pass a model id explicitly without touching the
        // gear (used by the legacy voice-tool routing).
        const route = await resolveRoute(cfg, ctx);

        // Local engine still needs the served-model-name resolver — the card
        // setting names "qwen-vl", but the engine may have started with
        // "qwen3-vl-local". For cloud providers the model id is forwarded
        // verbatim (OpenRouter / openai-compat validate and 404 cleanly).
        let modelKey: string;
        if (route.isLocal) {
          const resolution = await resolveServedModel(
            route.baseUrl.replace(/\/v\d+$/, ""),
            msg.model || route.modelHint,
            route.servedFallbacks,
          );
          if (resolution.reason) {
            console.warn(`[llm-chat] ${resolution.reason}`);
            ctx.broadcast({ type: "info", message: resolution.reason });
          }
          if (!resolution.modelName) {
            ctx.broadcast({
              type: "error",
              error: `No model could be resolved — local endpoint ${route.baseUrl} returned no served models, and no fallback was specified.`,
            });
            return;
          }
          modelKey = resolution.modelName;
        } else {
          modelKey = (msg.model || route.modelHint || "").trim();
          if (!modelKey) {
            ctx.broadcast({
              type: "error",
              error: `No model configured for ${route.label}. Open the gear icon and pick a model.`,
            });
            return;
          }
        }
        const endpoint = `${route.baseUrl}/chat/completions`;

        const messageForLlm: string | ContentBlock[] = userContent || userMessage || "";
        // History policy: in 'persist' mode we accumulate the turn into the
        // shared history; in 'stateless' mode we build a fresh messages list
        // per turn (system + just this user turn) and skip the push so the
        // next call doesn't see anything carried over. Net effect: stateless
        // cards (classification, generation) never hit per-turn caps from
        // accumulated context (e.g. vLLM's "At most 4 images" rejection).
        const stateless = cfg.history === "stateless";
        const messagesForLlm: ChatMessage[] = stateless
          ? [
              ...(cfg.systemPrompt ? [{ role: "system" as const, content: cfg.systemPrompt }] : []),
              { role: "user" as const, content: messageForLlm },
            ]
          : history;
        if (!stateless) {
          history.push({ role: "user", content: messageForLlm });
        }
        ctx.broadcast({ type: "user", content: userMessage || "[image]" });
        ctx.broadcast({ type: "thinking", model: modelKey });

        activeAbort = new AbortController();

        // Server-side image resize: enforce the model's maxImageDimensionPx
        // before forwarding. Eliminates the failure class where a card.js
        // forgets to resize and vLLM rejects with 400. History storage stays
        // unchanged — resize is a forwarding-time transformation.
        const maxDim = manifest.modelConstraints?.[modelKey]?.maxImageDimensionPx;
        const messagesToSend = maxDim
          ? await resizeImagesInMessages(messagesForLlm, maxDim)
          : messagesForLlm;

        const requestBody: Record<string, unknown> = {
          model: modelKey,
          messages: messagesToSend,
          max_tokens: cfg.maxTokens,
          temperature: cfg.temperature,
          stream: true,
          // Ask OpenAI-compatible servers to include a final `usage` object in
          // the SSE stream. vLLM, OpenRouter, and Together all honor this.
          // Required for the per-turn cost estimate; without it we don't know
          // billed input/output tokens for streamed completions.
          stream_options: { include_usage: true },
        };
        // Qwen3.6+ has thinking mode on by default — turn it off for direct
        // chat so the model writes reply tokens immediately. This is a
        // vLLM-specific knob; OpenRouter / generic openai-compat endpoints
        // may reject unknown kwargs, so only send it for the local engine.
        if (route.isLocal) {
          requestBody.chat_template_kwargs = { enable_thinking: false };
        }
        try {
          const resp = await fetch(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...route.authHeader },
            body: JSON.stringify(requestBody),
            signal: activeAbort.signal,
          });

          if (!resp.ok) {
            const err = await resp.text();
            ctx.broadcast({ type: "error", error: `LLM error (${resp.status}): ${err.slice(0, 200)}` });
            return;
          }

          let assistantText = "";
          // Captured from the final SSE chunk when stream_options.include_usage
          // is honored (vLLM, OpenRouter, Together). Used for per-turn cost
          // and per-bubble token stats. OpenRouter additionally returns
          // `cost` (USD) and `cost_details` directly on the usage chunk; we
          // read those when present and pass them through the cost estimator
          // instead of computing the dollar figure from tokens × pricing.
          let streamUsage: {
            prompt_tokens?: number;
            completion_tokens?: number;
            cost?: number;
            cost_details?: {
              upstream_inference_prompt_cost?: number;
              upstream_inference_completions_cost?: number;
            };
          } | null = null;
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
                // The terminal usage chunk has no choices array — just a
                // usage object. Capture it for the cost broadcast below.
                if (parsed.usage && typeof parsed.usage === "object") {
                  streamUsage = parsed.usage as typeof streamUsage;
                }
              } catch {
                // skip unparseable
              }
            }
          }

          if (assistantText && !stateless) {
            history.push({ role: "assistant", content: assistantText });
          }
          // Per-turn cost estimate. Cards display this in the per-bubble
          // stat line (under each assistant message). Falls to null if the
          // provider rate card isn't known (openai-compat) or if streamed
          // usage wasn't returned by the upstream server.
          const promptTokens = streamUsage?.prompt_tokens ?? 0;
          const completionTokens = streamUsage?.completion_tokens ?? 0;
          const reportedCost = typeof streamUsage?.cost === "number" && streamUsage.cost > 0
            ? streamUsage.cost
            : undefined;
          const reportedInputCost = streamUsage?.cost_details?.upstream_inference_prompt_cost;
          const reportedOutputCost = streamUsage?.cost_details?.upstream_inference_completions_cost;
          const cost = await estimateTurnCost({
            provider: route.provider,
            modelId: modelKey,
            billedInput: promptTokens,
            output: completionTokens,
            reportedCost,
            reportedInputCost,
            reportedOutputCost,
          });
          ctx.broadcast({
            type: "done",
            content: assistantText,
            model: modelKey,
            provider: route.provider,
            promptTokens,
            completionTokens,
            cost,                // per-turn USD estimate (null when no rate card / no usage)
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
      history: {
        type: "string",
        enum: ["persist", "stateless"],
        default: "persist",
        description:
          "Conversation memory policy. 'persist' (default) retains turn-by-turn history across send() calls — the canonical chat pattern. 'stateless' treats each send() as a one-shot query: only the system prompt + the current user turn reach the model; no history accumulation. PICK 'stateless' for classification, generation, transformation cards where every query is independent — it prevents the 'accumulated images hit per-turn cap' failure (vLLM rejects more than maxImagesPerTurn — see modelConstraints).",
      },
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
    "// ── card.js skeleton — TEXT-ONLY persistent chat ─────────────\n" +
    "// Default history: 'persist' — turn-by-turn history accumulates.\n" +
    "// Right for chat-style cards where the user has a back-and-forth.\n" +
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
    "// to abort:  channel.send({ type: 'interrupt' });\n" +
    "// to reset:  channel.send({ type: 'clear' });   // drops history, keeps system prompt\n" +
    "\n" +
    "// ── STATELESS classification — vision model (qwen3-vl-local) ─\n" +
    "// history: 'stateless' makes each send() a one-shot query — no\n" +
    "// turn history retained. Required for classification/generation\n" +
    "// cards that send multiple images: otherwise history accumulates\n" +
    "// images and hits modelConstraints.maxImagesPerTurn (see below).\n" +
    "//\n" +
    "// Two REQUIRED differences from text-only:\n" +
    "//   1. model: vision-capable id like 'qwen3-vl-local' (NOT 'coder').\n" +
    "//   2. image_url.url MUST be a base64 data: URL.\n" +
    "//      URL.createObjectURL(file) returns blob:http://localhost:5173/...\n" +
    "//      The LLM server runs in a DIFFERENT process and cannot fetch\n" +
    "//      blob: URLs. Use FileReader.readAsDataURL to inline the bytes.\n" +
    "//   `message` stays REQUIRED — the text turn. `content` is ADDITIONAL.\n" +
    "//   Mica resizes images >maxImageDimensionPx server-side automatically;\n" +
    "//   no client-side resize needed.\n" +
    "const classifyChannel = mica.openChannel('turn', {\n" +
    "  systemPrompt: 'You classify images. Reply concisely.',\n" +
    "  model: 'qwen3-vl-local',\n" +
    "  history: 'stateless',   // ← key for classification cards\n" +
    "});\n" +
    "classifyChannel.onData((evt) => {\n" +
    "  if (evt.type === 'delta') appendToBubble(evt.content);\n" +
    "  if (evt.type === 'done') finishBubble(evt.content);\n" +
    "  if (evt.type === 'error') showError(evt.error);\n" +
    "});\n" +
    "const reader = new FileReader();\n" +
    "reader.onload = () => {\n" +
    "  classifyChannel.send({\n" +
    "    message: 'What is in this image?',         // REQUIRED — the text turn\n" +
    "    content: [                                  // ADDITIONAL inputs\n" +
    "      { type: 'image_url', image_url: { url: reader.result } }\n" +
    "    ],\n" +
    "  });\n" +
    "};\n" +
    "reader.readAsDataURL(file);  // produces 'data:image/jpeg;base64,...'\n",
  modelConstraints: {
    "qwen3-vl-local": {
      maxImagesPerTurn: 4,
      maxImageDimensionPx: 1568,
      supportedImageFormats: ["jpeg", "png", "webp"],
      maxOutputTokens: 8192,
      notes: "Vision input must be a data: URL (NOT blob:) — the LLM server cannot fetch browser-process blob URLs. Mica resizes images >1568px (long edge) server-side automatically before forwarding to the inference backend (vLLM in the 2-container topology, llama-server with mmproj-F16 in the 1-container topology — both serve Qwen3.6 with vision). For classification/generation cards that send multiple images across calls, use `history: 'stateless'` at openChannel — otherwise accumulated images hit the maxImagesPerTurn cap on the 5th call.",
    },
    "qwen-vl": {
      maxImagesPerTurn: 4,
      maxImageDimensionPx: 1568,
      supportedImageFormats: ["jpeg", "png", "webp"],
      maxOutputTokens: 8192,
      notes: "Alias for qwen3-vl-local. Same constraints.",
    },
    "coder": {
      maxOutputTokens: 8192,
      notes: "Text-only. Sending image_url content blocks will be ignored or error depending on the model variant.",
    },
  },
};
