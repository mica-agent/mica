// LLM REST API for sidecars — POST /api/llm/chat
//
// Single source of truth for sidecar-initiated LLM calls. The Python
// `mica_sidecar.llm.chat(...)` and TS `mica-sidecar` `llm.chat(...)` clients
// both POST to this endpoint. The endpoint owns:
//   - URL resolution (LLAMA_URL env / DEFAULT_LLM_BASE_URL fallback)
//   - Default model selection (queries /v1/models once, caches the first id)
//   - vLLM `enable_thinking=false` default (the trap that consumed
//     rag-chatbot's answer budget — handled here so sidecars don't need to
//     know)
//   - Auth (MICA_SIDECAR_TOKEN check; localhost-only)
//
// Non-streaming: takes messages, returns the full reply once. Cards that
// need token streaming use the `llm-direct` channel handler via
// `mica.openChannel('turn', ...)` from card.js — that surface is unchanged.
//
// Adding new sample params (top_p, presence_penalty, etc.): extend the body
// schema below + forward to the vLLM POST. The set is intentionally small
// to start; agents can ask for more as use cases arise.
import type { Express, Request, Response } from "express";

const DEFAULT_LLM_BASE_URL = "http://127.0.0.1:8012";

function resolveBaseUrl(): string {
  if (process.env.LLAMA_URL) return process.env.LLAMA_URL.replace(/\/$/, "");
  return DEFAULT_LLM_BASE_URL;
}

// Default-model cache. The first served model from /v1/models is the
// canonical default when a caller doesn't specify. Caching is fine — vLLM
// can serve multiple models in theory, but in practice the deployment loads
// one and serves it under a few aliases. If the served set changes mid-
// run, restart the backend.
let _defaultModelCache: string | null = null;
let _defaultModelFetchedAt = 0;
const DEFAULT_MODEL_CACHE_MS = 60 * 1000;

async function resolveDefaultModel(baseUrl: string): Promise<string | null> {
  const now = Date.now();
  if (_defaultModelCache && now - _defaultModelFetchedAt < DEFAULT_MODEL_CACHE_MS) {
    return _defaultModelCache;
  }
  try {
    const resp = await fetch(`${baseUrl}/v1/models`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!resp.ok) return _defaultModelCache; // keep stale cache on probe failure
    const data = (await resp.json()) as { data?: Array<{ id: string }> };
    const ids = (data.data ?? []).map(m => m.id).filter((id): id is string => typeof id === "string");
    if (ids.length === 0) return _defaultModelCache;
    _defaultModelCache = ids[0];
    _defaultModelFetchedAt = now;
    return _defaultModelCache;
  } catch {
    return _defaultModelCache;
  }
}

interface ChatRequestBody {
  messages?: Array<{ role: string; content: string }>;
  model?: string;
  max_tokens?: number;
  temperature?: number;
  thinking?: boolean;
}

interface ChatResponseBody {
  text: string;
  model: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

export function registerLlmRestApi(app: Express, sidecarToken: string): void {
  app.post("/api/llm/chat", async (req: Request, res: Response) => {
    // Auth — sidecars include this token in the x-mica-sidecar-auth header.
    // The token is generated per backend startup; sidecars read it from
    // their MICA_SIDECAR_TOKEN env var.
    const supplied = req.header("x-mica-sidecar-auth");
    if (supplied !== sidecarToken) {
      res.status(401).json({ error: "sidecar auth required" });
      return;
    }

    const body = req.body as ChatRequestBody;
    if (!body || !Array.isArray(body.messages) || body.messages.length === 0) {
      res.status(400).json({ error: "messages required (non-empty array)" });
      return;
    }

    const baseUrl = resolveBaseUrl();
    const model = body.model || (await resolveDefaultModel(baseUrl));
    if (!model) {
      res.status(503).json({
        error: `No model available — local LLM not reachable at ${baseUrl}/v1/models`,
      });
      return;
    }

    const maxTokens = typeof body.max_tokens === "number" ? body.max_tokens : 2048;
    const temperature = typeof body.temperature === "number" ? body.temperature : 0.3;
    // Default `enable_thinking: false` — the trap that consumed rag-chatbot's
    // answer budget. Sidecars that DO want thinking pass `thinking: true`.
    const enableThinking = body.thinking === true;

    const endpoint = `${baseUrl}/v1/chat/completions`;
    const t0 = Date.now();

    try {
      const upstream = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          messages: body.messages,
          max_tokens: maxTokens,
          temperature,
          stream: false,
          chat_template_kwargs: { enable_thinking: enableThinking },
        }),
        // Generous timeout — first call to a cold sidecar that needs a long
        // response can exceed default node fetch defaults under load.
        signal: AbortSignal.timeout(120_000),
      });

      if (!upstream.ok) {
        const errText = (await upstream.text().catch(() => "")) || `HTTP ${upstream.status}`;
        res.status(upstream.status).json({
          error: `LLM upstream error (${upstream.status}): ${errText.slice(0, 500)}`,
          model,
        });
        return;
      }

      const data = (await upstream.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
      };
      const text = data.choices?.[0]?.message?.content ?? "";
      const result: ChatResponseBody = { text, model, usage: data.usage };
      console.log(`[llm-rest] /api/llm/chat → ${text.length} chars, model=${model}, ${Date.now() - t0}ms`);
      res.json(result);
    } catch (err) {
      const msg = (err as Error).message || String(err);
      console.error(`[llm-rest] /api/llm/chat error: ${msg}`);
      res.status(502).json({ error: `LLM request failed: ${msg}`, model });
    }
  });

  console.log("[llm-rest] registered POST /api/llm/chat");
}
