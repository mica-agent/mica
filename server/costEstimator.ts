// costEstimator — derive a per-turn dollar cost.
//
// Used by opencodeAgent, qwenAgent, and llmChat to attach a `cost` field to
// the per-turn assistant broadcast. Cards display it next to the existing
// token/fuel chips (always-visible topbar strip + per-bubble chevron footer).
//
// Resolution order:
//   1. `reportedCost` — when the upstream API returned the exact figure in its
//      response (OpenRouter sets `usage.cost` in the terminal SSE chunk when
//      stream_options.include_usage is on). Authoritative; matches the bill;
//      picks up cache discounts and provider-specific rates automatically.
//   2. Catalog-pricing estimate from contextWindow.ts (`promptPerM` /
//      `completionPerM` × token counts). Used when the upstream didn't include
//      cost, or for providers that don't report it (some openai-compat). This
//      slightly OVERestimates when cache_read is heavy because the catalog
//      rates are full-price.
//   3. $0 for local inference — explicit zero, distinguished from null.
//   4. null when no rate data is available (openai-compat with no known
//      catalog and no upstream-reported cost) — caller surfaces tokens only.

import { getOpenrouterModels } from "./contextWindow.js";
import type { CardSettings } from "./files.js";

export interface CostBreakdown {
  /** USD spent on input tokens this turn. May be 0 when only `total_usd` is
   *  reported by the upstream (some providers don't break it out). */
  input_usd: number;
  /** USD spent on output tokens this turn. Reasoning tokens are billed
   *  as output by every provider we route to. */
  output_usd: number;
  /** Sum of input_usd + output_usd, or the upstream's authoritative figure
   *  when it provided one directly. */
  total_usd: number;
  /** How the figure was obtained. UI can append "(estimate)" or "(reported)"
   *  to set user expectations.
   *  - `openrouter-reported`: read straight from `usage.cost` on the final
   *    SSE chunk. Authoritative, cache-aware, billing-accurate.
   *  - `openrouter-catalog`: multiplied tokens × cached per-million rates.
   *    Estimate; may drift if catalog cache is stale.
   *  - `local-free`: zero (local inference has no usage-based cost).
   *  - `unknown`: never set; null is returned instead. */
  source: "openrouter-reported" | "openrouter-catalog" | "local-free";
}

export interface TurnCostInputs {
  provider: NonNullable<CardSettings["provider"]>;
  modelId: string | undefined;
  /** Billed input tokens — what the user pays for. For OpenRouter this is
   *  the sum across model steps in the turn. */
  billedInput: number;
  /** Completion tokens this turn. Includes reasoning tokens (billed as
   *  output by every provider we route to). */
  output: number;
  /** Optional upstream-reported total cost in USD. When set, wins over the
   *  catalog-pricing estimate. OpenRouter reports this in `usage.cost` on the
   *  terminal SSE chunk (only when stream_options.include_usage is on). */
  reportedCost?: number;
  /** Optional upstream-reported prompt/completion split (USD). Lets the UI
   *  show the breakdown when available — falls back to a 50/50 split of
   *  `reportedCost` otherwise. OpenRouter exposes these as
   *  `usage.cost_details.upstream_inference_prompt_cost` and
   *  `usage.cost_details.upstream_inference_completions_cost`. */
  reportedInputCost?: number;
  reportedOutputCost?: number;
}

/** Compute (or read) a per-turn cost. Returns null when no pricing data is
 *  available — the caller surfaces tokens only in that case. */
export async function estimateTurnCost(inputs: TurnCostInputs): Promise<CostBreakdown | null> {
  // (1) Upstream-reported cost wins, regardless of provider. This is the
  // path that matches the user's actual bill — no token math, no catalog
  // drift, picks up cache discounts and BYOK pricing automatically.
  if (typeof inputs.reportedCost === "number" && isFinite(inputs.reportedCost) && inputs.reportedCost >= 0) {
    const total = inputs.reportedCost;
    const reportedSplit =
      typeof inputs.reportedInputCost === "number" && typeof inputs.reportedOutputCost === "number";
    const input_usd = reportedSplit ? inputs.reportedInputCost! : total / 2;
    const output_usd = reportedSplit ? inputs.reportedOutputCost! : total / 2;
    return { input_usd, output_usd, total_usd: total, source: "openrouter-reported" };
  }

  // (3) Local inference: no usage-based cost. Explicit zero so the topbar
  // can render "$0.00" instead of an empty-data null.
  if (inputs.provider === "local") {
    return { input_usd: 0, output_usd: 0, total_usd: 0, source: "local-free" };
  }

  // (2) Catalog-pricing estimate. Available for openrouter when we can find
  // the model in the cached catalog with both rates. openai-compat falls
  // through to null because there's no universal rate card.
  if (inputs.provider === "openrouter" && inputs.modelId) {
    try {
      const models = await getOpenrouterModels();
      const hit = models.find((m) => m.id === inputs.modelId);
      const promptPerM = hit?.promptPerM;
      const completionPerM = hit?.completionPerM;
      if (typeof promptPerM === "number" && typeof completionPerM === "number") {
        const input_usd = (inputs.billedInput / 1_000_000) * promptPerM;
        const output_usd = (inputs.output / 1_000_000) * completionPerM;
        return {
          input_usd,
          output_usd,
          total_usd: input_usd + output_usd,
          source: "openrouter-catalog",
        };
      }
    } catch {
      // Catalog fetch failed — fall through to null so the UI hides the
      // figure rather than showing a stale or zero value.
    }
  }

  // (4) Unknown — openai-compat without a catalog hit, or openrouter with a
  // model id missing from the cached list. UI shows tokens only.
  return null;
}
