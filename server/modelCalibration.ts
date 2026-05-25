// modelCalibration.ts — model self-awareness for the chat agent's system prompt.
//
// The chat agent runs on a model whose training cutoff, architecture, and
// per-category recall reliability vary by provider and model id. We surface
// this calibration to the agent in the runtime banner so it can pick the
// right discovery strategy per category (recall for stable identifiers,
// registry/search for unstable ones like asset URL paths).
//
// Sources:
//   - vLLM /v1/models — for the served model's `root` (often an HF id).
//   - HuggingFace config.json + README.md — architecture + training cutoff.
//   - Mica-internal rules table — empirical recall reliability per model class
//     (the only hand-curated part; everything else is fetched).
//
// Mirrors the cache + fetch pattern from contextWindow.ts (1h TTL, in-memory,
// single-flight to avoid duplicate fetches from parallel chat opens).
//
// Fallback: when introspection fails (network down, no HF page, unknown
// model), the caller still gets a ModelCalibration — just with the
// conservative "unknown" profile. The agent always sees a self-awareness
// block, never an empty one.

export type Confidence = "high" | "medium" | "low" | "very-low" | "unknown";

export interface RecallProfile {
  libraryNames: Confidence;
  libraryVersions: Confidence;
  assetUrlPaths: Confidence;
  apiEndpoints: Confidence;
  browserApis: Confidence;
  /** Precise lat/lng of named places — POIs, trailheads, restaurants,
   *  beaches, harbors. Universally `very-low` across current LLMs: no
   *  frontier model reliably recalls non-centroid coordinates to better
   *  than ~0.5 km. Web search returns prose snippets, not coordinates,
   *  so the agent must reach for a geocoder (Nominatim, Mapbox, Google
   *  Maps) rather than recall or generic text search. See
   *  `_conventions.md` "Precision over recall for external facts." */
  geographicCoordinates: Confidence;
}

export interface ModelCalibration {
  identity: {
    name: string;
    class: string;
  };
  knownFacts: {
    architecture?: "moe" | "dense";
    numExperts?: number;
    numExpertsPerTok?: number;
    trainingCutoff?: string;
    hfModelId?: string;
  };
  recallProfile: RecallProfile;
  notes: string[];
}

export interface GetCalibrationOpts {
  provider: "local" | "openrouter" | "openai-compat" | string;
  modelName: string;
  baseUrl?: string;
}

const TTL_MS = 60 * 60 * 1000; // 1h, matches OpenRouter catalog cache
const _cache = new Map<string, { ts: number; data: ModelCalibration }>();
const _inflight = new Map<string, Promise<ModelCalibration>>();

// ── Rules table ────────────────────────────────────────────────────────
//
// Each rule's matches() runs against (knownFacts, modelName). First match
// wins. The fallback rule matches everything, so this list is exhaustive.

interface CalibrationRule {
  classify: string;
  matches: (facts: ModelCalibration["knownFacts"], modelName: string) => boolean;
  profile: RecallProfile;
  notes: string[];
}

const RULES: CalibrationRule[] = [
  {
    classify: "Claude frontier (Sonnet / Opus / Haiku, 3.x or later)",
    matches: (_f, m) => /claude-(3|4|5|sonnet|opus|haiku)/i.test(m),
    profile: {
      libraryNames: "high",
      libraryVersions: "medium",
      assetUrlPaths: "low",
      apiEndpoints: "medium",
      browserApis: "high",
      geographicCoordinates: "very-low",
    },
    notes: [
      "Library names and browser APIs: recall freely.",
      "Library versions, API endpoint paths, asset URL specifics: recall + verify via mica_inspect_url. Verification is the safety net for occasional training-cutoff drift.",
      "If verification fails: advance to Search craft + Asset URL Extract Pattern in discover-dependency Step 3b. Recall reliability is high enough at this model class that search-first would add unnecessary wallclock overhead.",
    ],
  },
  {
    classify: "GPT-4 frontier (GPT-4o / GPT-4 Turbo class)",
    matches: (_f, m) => /gpt-4o|gpt-4-turbo|gpt-4-omni/i.test(m),
    profile: {
      libraryNames: "high",
      libraryVersions: "medium",
      assetUrlPaths: "low",
      apiEndpoints: "medium",
      browserApis: "high",
      geographicCoordinates: "very-low",
    },
    notes: [
      "Library names and browser APIs: recall freely.",
      "Library versions, API endpoint paths, asset URL specifics: recall + verify via mica_inspect_url. Verification is the safety net for occasional training-cutoff drift.",
      "If verification fails: advance to Search craft + Asset URL Extract Pattern in discover-dependency Step 3b. Recall reliability is high enough at this model class that search-first would add unnecessary wallclock overhead.",
    ],
  },
  {
    classify: "MoE with sparse activation (~8 experts active per token)",
    matches: (f) => f.architecture === "moe" && (f.numExpertsPerTok ?? 0) > 0 && (f.numExpertsPerTok ?? 0) <= 10,
    profile: {
      libraryNames: "high",
      libraryVersions: "low",
      assetUrlPaths: "very-low",
      apiEndpoints: "medium",
      browserApis: "high",
      geographicCoordinates: "very-low",
    },
    notes: [
      "Library names and browser APIs: recall freely.",
      "Library versions, API endpoint paths: recall + verify via mica_inspect_url.",
      "Asset URL specifics: skip recall. Go directly to Search craft + Asset URL Extract Pattern in discover-dependency Step 3b (tavily_extract with include_images on the description page, or mcp__exa__web_search_advanced_exa with includeDomains for site-restricted search). Recall is unreliable for this category at this model class — direct search + extract is faster than the verification-retry loop that recall-first triggers.",
    ],
  },
  {
    classify: "Dense 30B+ parameter model (non-frontier)",
    matches: (f) => f.architecture === "dense",
    profile: {
      libraryNames: "high",
      libraryVersions: "low",
      assetUrlPaths: "very-low",
      apiEndpoints: "medium",
      browserApis: "high",
      geographicCoordinates: "very-low",
    },
    notes: [
      "Library names and browser APIs: recall freely.",
      "Library versions, API endpoint paths: recall + verify via mica_inspect_url.",
      "Asset URL specifics: skip recall. Go directly to Search craft + Asset URL Extract Pattern in discover-dependency Step 3b. Empirically (Qwen3.6-27B-FP8 dense in orbit301), non-frontier dense models at 30B+ produce the same asset-URL recall failures as MoE-small-active — search + extract + verify is the faster path. Frontier-class dense models (Claude, GPT-4o, etc.) match those specific rules by name pattern and get the recall + verify default.",
    ],
  },
  {
    classify: "unknown — conservative defaults",
    matches: () => true,
    profile: {
      libraryNames: "medium",
      libraryVersions: "low",
      assetUrlPaths: "very-low",
      apiEndpoints: "low",
      browserApis: "medium",
      geographicCoordinates: "very-low",
    },
    notes: [
      "This model class is not in Mica's calibration table. Treat any recalled URL specific as a hypothesis; verify via mica_inspect_url before committing.",
      "Asset URL specifics: skip recall. Go directly to Search craft + Asset URL Extract Pattern in discover-dependency Step 3b.",
      "For all other categories: recall + verify is the safer default until empirical builds refine the rule for this model class.",
    ],
  },
];

function classifyAndProfile(
  facts: ModelCalibration["knownFacts"],
  modelName: string,
): { classify: string; profile: RecallProfile; notes: string[] } {
  for (const rule of RULES) {
    if (rule.matches(facts, modelName)) {
      return { classify: rule.classify, profile: rule.profile, notes: rule.notes };
    }
  }
  // Unreachable — fallback rule matches everything — but TypeScript wants it.
  return {
    classify: "unknown",
    profile: RULES[RULES.length - 1].profile,
    notes: RULES[RULES.length - 1].notes,
  };
}

// ── HF metadata fetchers ───────────────────────────────────────────────

interface HFConfigCore {
  architectures?: string[];
  num_experts?: number;
  num_experts_per_tok?: number;
  num_local_experts?: number;
  num_hidden_layers?: number;
  hidden_size?: number;
  max_position_embeddings?: number;
  model_type?: string;
}

// Multimodal configs (Qwen3-VL, Llama-VL, etc.) nest the language-model
// fields under text_config and put modality-specific fields at the top.
// We read both — top-level first, falling through to text_config when
// the top-level field is absent.
interface HFConfig extends HFConfigCore {
  text_config?: HFConfigCore;
}

function pickConfigField<K extends keyof HFConfigCore>(
  config: HFConfig,
  field: K,
): HFConfigCore[K] | undefined {
  return config[field] ?? config.text_config?.[field];
}

async function fetchHFConfig(modelId: string): Promise<HFConfig | null> {
  try {
    const url = `https://huggingface.co/${modelId}/raw/main/config.json`;
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    return (await r.json()) as HFConfig;
  } catch {
    return null;
  }
}

// Best-effort training-cutoff extraction from a model card README. Many
// cards mention it in prose ("training data through April 2025"); some
// don't mention it at all. Failure returns undefined and the caller
// renders "training cutoff unknown" gracefully.
async function fetchHFTrainingCutoff(modelId: string): Promise<string | undefined> {
  try {
    const url = `https://huggingface.co/${modelId}/raw/main/README.md`;
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return undefined;
    const text = await r.text();
    const patterns: RegExp[] = [
      /training\s+(?:data\s+)?(?:up\s+to|through|until|cutoff|cut-off)\s*(?:approximately\s+)?:?\s*([A-Z][a-z]+\s+\d{4})/i,
      /knowledge\s+cutoff[^:]*:\s*([A-Z][a-z]+\s+\d{4})/i,
      /cutoff\s+date[^:]*:\s*([A-Z][a-z]+\s+\d{4})/i,
      /trained\s+(?:up\s+to|through)\s+([A-Z][a-z]+\s+\d{4})/i,
    ];
    for (const re of patterns) {
      const m = text.match(re);
      if (m && m[1]) return m[1];
    }
    return undefined;
  } catch {
    return undefined;
  }
}

// Probe vLLM's /v1/models endpoint for the served model's `root` field —
// typically the actual HF id (e.g., served "qwen3-vl-local" with
// root "RedHatAI/Qwen3.6-35B-A3B-NVFP4"). Falls back to undefined if the
// endpoint isn't reachable or doesn't include the field.
async function probeVLLMRoot(baseUrl: string, modelName: string): Promise<string | undefined> {
  try {
    const cleaned = baseUrl.replace(/\/+$/, "");
    const r = await fetch(`${cleaned}/models`, { signal: AbortSignal.timeout(2000) });
    if (!r.ok) return undefined;
    const json = (await r.json()) as { data?: Array<{ id?: string; root?: string }> };
    const entries = json.data ?? [];
    const hit = entries.find((m) => m.id === modelName);
    if (hit?.root && hit.root !== modelName) return hit.root;
    return undefined;
  } catch {
    return undefined;
  }
}

function deriveHFIdFromModel(provider: string, modelName: string): string | undefined {
  // OpenRouter ids follow "<vendor>/<model>" which often matches an HF id
  // for open models (Meta, Mistral, Qwen). Closed models (Anthropic,
  // OpenAI) have OpenRouter ids that won't resolve on HF — the HF fetch
  // will return null and the rules table's name-pattern match (e.g.,
  // claude-frontier by modelName) carries the classification.
  if (provider === "openrouter" && /\//.test(modelName)) {
    return modelName;
  }
  return undefined;
}

// ── Public API ────────────────────────────────────────────────────────

/** Fetch (or cache-return) the calibration for a (provider, model) pair.
 *  Always resolves — falls back to the conservative "unknown" profile if
 *  introspection fails. Safe to call per-turn; the cache eliminates
 *  duplicate fetches. */
export async function getModelCalibration(opts: GetCalibrationOpts): Promise<ModelCalibration> {
  const { provider, modelName, baseUrl } = opts;
  const cacheKey = `${provider}:${modelName}`;
  const cached = _cache.get(cacheKey);
  if (cached && Date.now() - cached.ts < TTL_MS) return cached.data;
  const existing = _inflight.get(cacheKey);
  if (existing) return existing;

  const p = (async (): Promise<ModelCalibration> => {
    try {
      let hfId: string | undefined;
      if (provider === "local" && baseUrl) {
        hfId = await probeVLLMRoot(baseUrl, modelName);
      } else {
        hfId = deriveHFIdFromModel(provider, modelName);
      }

      let config: HFConfig | null = null;
      let trainingCutoff: string | undefined;
      if (hfId) {
        config = await fetchHFConfig(hfId);
        trainingCutoff = await fetchHFTrainingCutoff(hfId);
      }

      const knownFacts: ModelCalibration["knownFacts"] = {};
      if (config) {
        const expertCount = pickConfigField(config, "num_experts") ?? pickConfigField(config, "num_local_experts");
        const expertsPerTok = pickConfigField(config, "num_experts_per_tok");
        const architectures = config.architectures ?? config.text_config?.architectures;
        if (expertCount && expertCount > 1) {
          knownFacts.architecture = "moe";
          knownFacts.numExperts = expertCount;
          if (expertsPerTok) knownFacts.numExpertsPerTok = expertsPerTok;
        } else if (architectures && architectures.length > 0) {
          const arch = architectures[0];
          knownFacts.architecture = /Moe/i.test(arch) ? "moe" : "dense";
          // Architecture string says MoE but expert count isn't in the top-level
          // config — accept the architecture signal and read expertsPerTok if present.
          if (knownFacts.architecture === "moe" && expertsPerTok) {
            knownFacts.numExpertsPerTok = expertsPerTok;
          }
        }
      }
      if (trainingCutoff) knownFacts.trainingCutoff = trainingCutoff;
      if (hfId) knownFacts.hfModelId = hfId;

      const { classify, profile, notes } = classifyAndProfile(knownFacts, modelName);

      const calibration: ModelCalibration = {
        identity: { name: modelName, class: classify },
        knownFacts,
        recallProfile: profile,
        notes,
      };

      _cache.set(cacheKey, { ts: Date.now(), data: calibration });
      return calibration;
    } finally {
      _inflight.delete(cacheKey);
    }
  })();
  _inflight.set(cacheKey, p);
  return p;
}

/** Render the self-awareness block as a string suitable for inclusion in
 *  the runtime banner. Positive imperative tone; uses the rules table's
 *  notes for category-specific guidance. */
export function renderCalibrationBlock(cal: ModelCalibration): string {
  const lines: string[] = [];
  lines.push(`**Model self-awareness.**`);

  const idLine: string[] = [`You are \`${cal.identity.name}\``];
  if (cal.identity.class && cal.identity.class !== "unknown") {
    idLine.push(`(${cal.identity.class})`);
  }
  lines.push(idLine.join(" ") + ".");

  if (cal.knownFacts.architecture) {
    const archParts: string[] = [`Architecture: ${cal.knownFacts.architecture}`];
    if (cal.knownFacts.numExperts) {
      const expertsPerTok = cal.knownFacts.numExpertsPerTok ?? "?";
      archParts.push(`${cal.knownFacts.numExperts} experts (${expertsPerTok} active per token)`);
    }
    lines.push(archParts.join(", ") + ".");
  }

  if (cal.knownFacts.trainingCutoff) {
    lines.push(`Training data through approximately ${cal.knownFacts.trainingCutoff}.`);
  }

  lines.push(``);
  lines.push(`**Recall reliability for this model class:**`);
  lines.push(`- Library names (npm package names) — ${cal.recallProfile.libraryNames}`);
  lines.push(`- Library version numbers — ${cal.recallProfile.libraryVersions}`);
  lines.push(`- Asset URL specifics (file paths inside repos, image hosts) — ${cal.recallProfile.assetUrlPaths}`);
  lines.push(`- API endpoint paths — ${cal.recallProfile.apiEndpoints}`);
  lines.push(`- Browser API specifics — ${cal.recallProfile.browserApis}`);
  lines.push(`- Geographic coordinates (precise lat/lng of places, trailheads, addresses) — ${cal.recallProfile.geographicCoordinates}`);

  lines.push(``);
  lines.push(`**Confidence → procedural default (apply per category):**`);
  lines.push(`- **high** — recall freely; no verification step required for type-safe outputs.`);
  lines.push(`- **medium** — recall + verify via mica_inspect_url. Verification is the safety net for occasional drift.`);
  lines.push(`- **low** — recall + verify. If verification fails, advance to Search craft + Asset URL Extract Pattern (discover-dependency Step 3b).`);
  lines.push(`- **very-low** — skip recall. Go directly to Search craft + Asset URL Extract Pattern. Verify before commit (universal rule).`);
  lines.push(`- **unknown** — treat as very-low until empirical data refines.`);

  if (cal.notes.length > 0) {
    lines.push(``);
    for (const note of cal.notes) lines.push(note);
  }

  return lines.join("\n");
}
