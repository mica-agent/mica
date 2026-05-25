// llmModelResolver — robust model-name resolution shared by `llm-chat`
// (server/plugins/llmChat.ts) and `llm-agent` (server/plugins/llmAgent.ts).
//
// The problem this solves: cards routinely specify a `model:` arg whose
// name doesn't match anything served by the configured endpoint — agent
// trained-data recall of model IDs from other ecosystems ("qwen-coder",
// "qwen2.5", "claude-3-opus"), or drift between the served-model-name
// list and what the agent thinks is there. Result: vLLM returns
// "model not found" and the card is dead in the water.
//
// Fix is to query /v1/models, see what's ACTUALLY served, and apply
// a fallback ladder: requested-if-served → first preferred-and-served →
// first served-thing-at-all. The card sees an `info` broadcast with the
// resolution so the agent learns what happened and can correct future
// metadata writes.

const CACHE_TTL_MS = 5 * 60_000;
const PROBE_TIMEOUT_MS = 3000;
const modelListCache = new Map<string, { ids: string[]; at: number }>();

/** Hit `<baseUrl>/v1/models` (5-min cache). Returns the served-id list,
 *  empty array on failure or stale cache exhaustion. Never throws. */
export async function listServedModels(baseUrl: string): Promise<string[]> {
  const key = baseUrl.replace(/\/+$/, "");
  const cached = modelListCache.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.ids;
  try {
    const resp = await fetch(`${key}/v1/models`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!resp.ok) {
      if (cached) return cached.ids;  // stale > nothing
      modelListCache.set(key, { ids: [], at: Date.now() });
      return [];
    }
    const data = (await resp.json()) as { data?: Array<{ id?: unknown }> };
    const ids = (data.data ?? [])
      .map((m) => (typeof m.id === "string" ? m.id : null))
      .filter((id): id is string => id !== null);
    modelListCache.set(key, { ids, at: Date.now() });
    return ids;
  } catch {
    return cached?.ids ?? [];
  }
}

/** Invalidate the cache — call this when the endpoint definitely changed
 *  (e.g. user reconfigured baseUrl from the gear panel). */
export function invalidateServedModelsCache(baseUrl?: string): void {
  if (baseUrl) modelListCache.delete(baseUrl.replace(/\/+$/, ""));
  else modelListCache.clear();
}

export interface ModelResolution {
  /** The model id to send to the endpoint. */
  modelName: string;
  /** Set only if the resolution differs from what the caller asked for —
   *  cards / agents can branch on this to broadcast a one-time `info`. */
  fallbackFromRequested?: string;
  /** Human-readable explanation when a fallback happened. Suitable for a
   *  warn log or info-broadcast to the card. Empty if `requested` was
   *  served-as-is. */
  reason?: string;
}

/** Pick the model to send to the endpoint, given:
 *   - `requested`: what the caller (card / agent) asked for, optional
 *   - `preferred`: ordered list of fallback names — first one served wins
 *
 *  Resolution ladder:
 *   1. `requested` is in the served list → use it (no fallback)
 *   2. else, first `preferred` name in the served list → use it
 *   3. else, the first served model at all → use it
 *   4. else (endpoint probe failed AND nothing cached) → return
 *      `requested || preferred[0] || ""` verbatim and let vLLM
 *      complain. We didn't have anything better to choose from.
 *
 *  Cases 2-4 set `reason` so the caller can surface the fallback. */
export async function resolveServedModel(
  baseUrl: string,
  requested: string | undefined,
  preferred: readonly string[],
): Promise<ModelResolution> {
  const served = await listServedModels(baseUrl);

  // Couldn't probe — best effort, return whatever the caller has.
  if (served.length === 0) {
    return { modelName: requested || preferred[0] || "" };
  }

  // Happy path: requested is served as-is.
  if (requested && served.includes(requested)) {
    return { modelName: requested };
  }

  // Look for the first preferred name that the endpoint actually serves.
  for (const p of preferred) {
    if (served.includes(p)) {
      const sample = served.slice(0, 4).join(", ") + (served.length > 4 ? ", …" : "");
      return {
        modelName: p,
        fallbackFromRequested: requested,
        reason: requested
          ? `model '${requested}' not served (available: ${sample}); using '${p}' instead`
          : `no model specified; defaulting to '${p}' (available: ${sample})`,
      };
    }
  }

  // No preferred name served — last resort, take whatever is first served.
  // This is the "endpoint reconfigured to something we don't know" path.
  const last = served[0];
  return {
    modelName: last,
    fallbackFromRequested: requested,
    reason: `none of [${preferred.join(", ")}] are served (available: ${served.slice(0, 4).join(", ")}${served.length > 4 ? ", …" : ""}); using '${last}'`,
  };
}
