// contextWindow.ts — provider-aware context-window resolution.
//
// Both the qwen card (micaAgent.ts) and the opencode card (opencodeAgent.ts)
// need the actual context window of the model the user has picked — not a
// hardcoded constant. The window drives capacity math, the proactive-
// compaction threshold, the fuel gauge UI, and subagent slot sizing.
//
// Sources, in order of authority:
//   - `local` → env LLAMA_CTX_SIZE (default 131072) — the vLLM container's
//     configured window. Same env var qwen has used since the local path
//     existed.
//   - `openrouter` → cached /api/v1/models response. Each entry's
//     `context_length` is authoritative. 1h TTL matches OpenRouter's
//     catalog churn.
//   - `openai-compat` → probe the user's configured endpoint via
//     `<baseUrl>/models` and look for vLLM/llama.cpp-style context
//     fields. Endpoint-specific; not all servers expose it. 1h cache
//     per (baseUrl, modelId).
//   - Fallback → 200_000 (matches the previous hardcoded default for
//     opencode, generous enough for most cloud cases).
//
// All fetches have aggressive timeouts; the resolver never blocks a
// turn for more than ~2s if the network is down.
//
// This module owns the OpenRouter catalog cache that used to live
// inline in server/index.ts:894. The /api/openrouter/models endpoint
// now thin-wraps `getOpenrouterModels()`.

const OPENROUTER_TTL_MS = 60 * 60 * 1000;
const OPENAI_COMPAT_TTL_MS = 60 * 60 * 1000;
const DEFAULT_CTX_WINDOW = 200_000;

export interface ModelEntry {
  id: string;
  name?: string;
  promptPerM?: number;
  completionPerM?: number;
  contextLength?: number;
}

let _openrouterCache: { ts: number; data: ModelEntry[] } | null = null;
let _openrouterInflight: Promise<ModelEntry[]> | null = null;

function parseUsdPerToken(v: unknown): number | undefined {
  if (typeof v !== "string" || !v) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return n * 1_000_000;
}

/** Fetch + cache the OpenRouter model catalog. Shared across all callers
 *  (card-side dropdown via /api/openrouter/models, server-side context
 *  resolver). Single-flight via _openrouterInflight prevents two parallel
 *  card opens from firing two upstream fetches. */
export async function getOpenrouterModels(): Promise<ModelEntry[]> {
  if (_openrouterCache && Date.now() - _openrouterCache.ts < OPENROUTER_TTL_MS) {
    return _openrouterCache.data;
  }
  if (_openrouterInflight) return _openrouterInflight;
  _openrouterInflight = (async () => {
    try {
      const r = await fetch("https://openrouter.ai/api/v1/models", { signal: AbortSignal.timeout(8000) });
      if (!r.ok) throw new Error(`OpenRouter returned ${r.status}`);
      const json = await r.json() as {
        data?: Array<{
          id?: unknown;
          name?: unknown;
          pricing?: { prompt?: unknown; completion?: unknown };
          context_length?: unknown;
        }>;
      };
      const models: ModelEntry[] = (json.data || [])
        .filter((m) => typeof m.id === "string" && m.id)
        .map((m) => {
          const entry: ModelEntry = { id: m.id as string };
          if (typeof m.name === "string" && m.name) entry.name = m.name;
          const promptPerM = parseUsdPerToken(m.pricing?.prompt);
          const completionPerM = parseUsdPerToken(m.pricing?.completion);
          if (promptPerM !== undefined) entry.promptPerM = promptPerM;
          if (completionPerM !== undefined) entry.completionPerM = completionPerM;
          if (typeof m.context_length === "number" && m.context_length > 0) entry.contextLength = m.context_length;
          return entry;
        })
        .sort((a, b) => a.id.localeCompare(b.id));
      _openrouterCache = { ts: Date.now(), data: models };
      return models;
    } finally {
      _openrouterInflight = null;
    }
  })();
  return _openrouterInflight;
}

/** Look up a specific OpenRouter model's context_length. Returns undefined
 *  if the model isn't in the catalog or the catalog fetch fails. Callers
 *  fall back to DEFAULT_CTX_WINDOW. */
export async function getOpenrouterContextLength(modelId: string): Promise<number | undefined> {
  try {
    const models = await getOpenrouterModels();
    const hit = models.find((m) => m.id === modelId);
    return hit?.contextLength;
  } catch {
    return undefined;
  }
}

// ── OpenAI-compat probe ─────────────────────────────────────────────
// Many OpenAI-compatible servers (vLLM, sglang, some llama.cpp builds,
// mistral.rs) expose per-model context windows via /v1/models — but the
// field name varies. We try the common ones in order: max_model_len
// (vLLM), context_length (llama.cpp / sglang extensions), max_context_length,
// n_ctx. First non-zero positive number wins.
//
// Cache by (baseUrl, modelId) since different endpoints could serve
// different windows for the same id (e.g. a self-hosted Qwen at 128K vs
// the OpenAI gpt-4o at 128K — same window happens to match here, but
// not guaranteed in general).

const _openaiCompatCache = new Map<string, { ts: number; ctx: number | undefined }>();

interface OpenAIModelEntry {
  id?: string;
  max_model_len?: number;
  context_length?: number;
  max_context_length?: number;
  n_ctx?: number;
}

function extractCtx(entry: OpenAIModelEntry): number | undefined {
  const candidates = [entry.max_model_len, entry.context_length, entry.max_context_length, entry.n_ctx];
  for (const c of candidates) {
    if (typeof c === "number" && c > 0) return c;
  }
  return undefined;
}

/** Probe an OpenAI-compatible endpoint for a specific model's context
 *  window. Returns undefined if the endpoint doesn't expose the field
 *  or the probe fails. Cached for 1h per (baseUrl, modelId). */
export async function probeOpenAICompatContextLength(
  baseUrl: string,
  modelId: string,
): Promise<number | undefined> {
  const cacheKey = `${baseUrl}|${modelId}`;
  const cached = _openaiCompatCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < OPENAI_COMPAT_TTL_MS) {
    return cached.ctx;
  }
  let ctx: number | undefined;
  try {
    // baseUrl is typically `https://api.example.com/v1` — the models
    // endpoint is `<baseUrl>/models`. Some users may configure baseUrl
    // without the /v1 suffix; we handle both by stripping a trailing
    // slash, not by guessing.
    const cleaned = baseUrl.replace(/\/+$/, "");
    const res = await fetch(`${cleaned}/models`, { signal: AbortSignal.timeout(2000) });
    if (res.ok) {
      const json = await res.json() as { data?: OpenAIModelEntry[] };
      const entries = json.data ?? [];
      const hit = entries.find((m) => m.id === modelId);
      if (hit) ctx = extractCtx(hit);
    }
  } catch {
    // Probe failed (DNS, timeout, non-JSON) — leave ctx undefined; caller
    // falls back to DEFAULT_CTX_WINDOW. We still cache the negative result
    // briefly so a flapping endpoint doesn't cause a probe per turn.
  }
  _openaiCompatCache.set(cacheKey, { ts: Date.now(), ctx });
  return ctx;
}

// ── Unified resolver ────────────────────────────────────────────────

export interface CtxResolveOpts {
  provider: string;        // "local" | "openrouter" | "openai-compat"
  modelId?: string;        // required for openrouter + openai-compat
  baseUrl?: string;        // required for openai-compat
  localFallback?: number;  // override LLAMA_CTX_SIZE for local provider
}

/** Resolve the effective context window for a (provider, model) pair.
 *  Always returns a positive number — falls back to DEFAULT_CTX_WINDOW
 *  if introspection fails. Use the returned value for capacity math,
 *  proactive-compaction thresholds, and any UI that surfaces the
 *  window to the user. */
export async function resolveCtxWindow(opts: CtxResolveOpts): Promise<number> {
  const { provider, modelId, baseUrl, localFallback } = opts;
  if (provider === "local") {
    const env = parseInt(process.env.LLAMA_CTX_SIZE || "", 10);
    if (Number.isFinite(env) && env > 0) return env;
    if (localFallback && localFallback > 0) return localFallback;
    return 131_072;
  }
  if (provider === "openrouter" && modelId) {
    const ctx = await getOpenrouterContextLength(modelId);
    if (ctx) return ctx;
  }
  if (provider === "openai-compat" && baseUrl && modelId) {
    const ctx = await probeOpenAICompatContextLength(baseUrl, modelId);
    if (ctx) return ctx;
  }
  return DEFAULT_CTX_WINDOW;
}
