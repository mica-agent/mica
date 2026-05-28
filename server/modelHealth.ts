// Fast, provider-appropriate health probe for an agent card's model endpoint.
//
// The qwen and opencode agents auto-fire a hidden "initialize" turn on
// project open, and llm-agent fires on the first user message — all three
// assume a reachable, correctly-configured model endpoint. When that
// assumption is wrong (no local vLLM, bad OpenRouter key, stale
// OpenAI-compatible base URL), the SDK query throws deep inside the turn and
// the user gets a raw error with no guidance.
//
// `probeModelEndpoint` runs *before* the turn so the handler can surface a
// clean, actionable message instead. It resolves the same provider config the
// agents use (readCardSettings / readOpenRouterKey / readOpenAICompatConfig)
// and reuses the same checks already wired into the HTTP routes:
//   - local       → GET ${LLAMA_URL}/health         (cf. /api/llm/status)
//   - openrouter  → GET /auth/key (+ model lookup)  (cf. /api/openrouter/validate)
//   - openai-compat → GET ${baseUrl}/models         (cf. contextWindow probe)
// Timeouts are deliberately short — this is a "quick test", not a full turn.

import { readCardSettings, resolveDefaultProvider, readOpenRouterKey, readOpenAICompatConfig } from "./files.js";

const LLAMA_URL = process.env.LLAMA_URL || "http://127.0.0.1:8012";

export interface ProbeResult {
  ok: boolean;
  /** Human-readable failure reason, suitable for surfacing inline to the user. */
  reason?: string;
}

/**
 * Probe the model endpoint configured for a given card. Resolves provider +
 * credentials from the same stores the agents read, then runs the matching
 * fast reachability/auth check. Never throws — network/DNS/timeout failures
 * are returned as `{ ok: false, reason }`.
 */
export async function probeModelEndpoint(
  project: string | undefined,
  filename: string,
): Promise<ProbeResult> {
  const settings = await readCardSettings(project, filename);
  // Unset → MICA_DEFAULT_PROVIDER; explicit provider honored.
  const provider = settings.provider ?? resolveDefaultProvider();

  if (provider === "openrouter") {
    return probeOpenRouter(project, settings.model);
  }
  if (provider === "openai-compat") {
    return probeOpenAICompat(project);
  }
  return probeLocal();
}

async function probeLocal(): Promise<ProbeResult> {
  const base = LLAMA_URL.replace(/\/v1$/, "");
  try {
    const r = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2000) });
    if (r.ok) return { ok: true };
    return { ok: false, reason: `Local model server at ${base} returned HTTP ${r.status} (still starting?). Start it with scripts/start.sh, or pick a different provider in the ⚙️ gear.` };
  } catch {
    return { ok: false, reason: `Local model server not reachable at ${base}. Start it with scripts/start.sh, or switch provider in the ⚙️ gear.` };
  }
}

async function probeOpenRouter(
  project: string | undefined,
  model: string | undefined,
): Promise<ProbeResult> {
  const key = await readOpenRouterKey(project);
  if (!key) {
    return { ok: false, reason: "OpenRouter selected but no API key is set. Add your key in the ⚙️ gear (or set OPENROUTER_API_KEY)." };
  }
  try {
    const errors: string[] = [];
    const calls: Promise<unknown>[] = [];
    calls.push(fetch("https://openrouter.ai/api/v1/auth/key", {
      method: "GET",
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(8000),
    }).then((r) => {
      if (r.status === 401 || r.status === 403) errors.push("OpenRouter API key rejected");
      else if (!r.ok) errors.push(`OpenRouter returned HTTP ${r.status} validating the key`);
    }));
    if (model) {
      calls.push(fetch("https://openrouter.ai/api/v1/models", {
        method: "GET",
        signal: AbortSignal.timeout(8000),
      }).then(async (r) => {
        if (!r.ok) return; // model lookup is best-effort; key check is the gate
        const data = await r.json() as { data?: Array<{ id?: string }> };
        const ids = new Set((data.data || []).map((m) => m.id).filter((x): x is string => typeof x === "string"));
        const baseModel = model.split(":")[0];
        if (!ids.has(baseModel)) errors.push(`Model "${baseModel}" not found on OpenRouter`);
      }));
    }
    await Promise.all(calls);
    if (errors.length > 0) {
      return { ok: false, reason: `${errors.join("; ")}. Check the ⚙️ gear settings.` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `Could not reach OpenRouter: ${(err as Error).message || String(err)}. Check your network or the ⚙️ gear settings.` };
  }
}

async function probeOpenAICompat(project: string | undefined): Promise<ProbeResult> {
  const { baseUrl, key } = await readOpenAICompatConfig(project);
  if (!baseUrl) {
    return { ok: false, reason: "OpenAI-compatible selected but no base URL is set. Add it in the ⚙️ gear (e.g. https://api.openai.com/v1)." };
  }
  const normalized = baseUrl.replace(/\/+$/, "");
  const v1 = normalized.endsWith("/v1") ? normalized : `${normalized}/v1`;
  try {
    const r = await fetch(`${v1}/models`, {
      method: "GET",
      headers: key ? { Authorization: `Bearer ${key}` } : {},
      signal: AbortSignal.timeout(3000),
    });
    if (r.ok) return { ok: true };
    if (r.status === 401 || r.status === 403) {
      return { ok: false, reason: `OpenAI-compatible endpoint ${v1} rejected the API key. Check the key in the ⚙️ gear.` };
    }
    return { ok: false, reason: `OpenAI-compatible endpoint ${v1} returned HTTP ${r.status}. Check the base URL in the ⚙️ gear.` };
  } catch {
    return { ok: false, reason: `OpenAI-compatible endpoint ${v1} unreachable. Check the base URL in the ⚙️ gear.` };
  }
}
