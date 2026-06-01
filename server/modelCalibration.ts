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

import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";

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
    classify: "Gemini frontier (2.5+ / 3+ / Flash, Pro, Ultra)",
    matches: (_f, m) => /gemini-(2\.5|3|3\.5|4|pro|flash|ultra)/i.test(m),
    profile: {
      libraryNames: "high",
      libraryVersions: "medium",
      assetUrlPaths: "low",
      apiEndpoints: "medium",
      browserApis: "high",
      geographicCoordinates: "very-low",
    },
    notes: [
      "Library names and browser APIs: recall freely. Recent training cutoff (Jan 2026 for gemini-3.5-flash) covers modern library/API surface broadly.",
      "Library versions, API endpoint paths, asset URL specifics: recall + verify via mica_inspect_url. Gemini-flash variants lean slightly more on in-context docs than full-frontier Claude/GPT-4, but recall + verify still beats search-first wallclock.",
      "If verification fails: advance to Search craft + Asset URL Extract Pattern in discover-dependency Step 3b. Live web search is NOT wired through Mica's OpenRouter path for plain gemini routes (no google_search tool attached, no openrouter:web_search plugin) — fall back to mcp__tavily__tavily_search / tavily_extract or webfetch when verify misses.",
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
    classify: "Qwen cloud max/plus tier (3.6-plus / 3.7-max / coder-plus)",
    // Name-pattern rule for Alibaba's high-capability CLOUD Qwen line served
    // via OpenRouter (qwen/qwen3.7-max, qwen/qwen3-coder-plus, qwen3.6-plus,
    // qwen-max). These are closed/hosted — the HF config fetch 404s, so
    // f.architecture is never populated and the dense/MoE/Qwen3.6 rules below
    // can't fire. Matching on the model NAME is the only signal available.
    // Deliberately does NOT match local open checkpoints (qwen-vl,
    // Qwen/Qwen3.6-27B-FP8): no "max"/"plus" token, no "3.7" — those keep
    // their HF-fingerprinted classification via the rules below.
    matches: (_f, m) => /qwen[\d.]*-?(max|plus)\b/i.test(m) || /qwen3\.?7/i.test(m),
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
      "Library versions, asset URL specifics: recall + verify via mica_inspect_url against the package registry; advance to Search craft + Asset URL Extract Pattern in discover-dependency Step 3b if verify fails. Frontier-tier reliability — search-first would add unnecessary wallclock.",
      "API endpoint RESPONSE SHAPES: docs-first, not recall-first. Per discover-dependency § 3c, locate the official endpoint docs (tavily/exa search → mica_inspect_url to fetch the doc page), cite the doc URL in a code comment alongside the documented field layout, then verify the live response matches via one sample fetch. The frontier-tier lift on names/versions does NOT extend to response-shape recall — field-level schema (array index orders, key names, optional/nullable fields) fails silently and the debug loop never converges because every iteration re-reads the same wrong recall.",
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
      "Library versions: recall + verify via mica_inspect_url against the package registry.",
      "API endpoint RESPONSE SHAPES: docs-first, not recall-first. Per discover-dependency § 3c, locate the official endpoint docs (tavily/exa search → mica_inspect_url to fetch the doc page), cite the doc URL in a code comment alongside the documented field layout, then verify the live response matches via one sample fetch. Field-level schema recall (array index orders, key names, optional/nullable fields) fails silently at this model class and the debug loop never converges because every iteration re-reads the same wrong recall.",
      "Asset URL specifics: skip recall. Go directly to Search craft + Asset URL Extract Pattern in discover-dependency Step 3b (tavily_extract with include_images on the description page, or mcp__exa__web_search_advanced_exa with includeDomains for site-restricted search). Recall is unreliable for this category at this model class — direct search + extract is faster than the verification-retry loop that recall-first triggers.",
    ],
  },
  {
    classify: "Qwen3.6 dense family (27B+)",
    // Matches Qwen3.6 dense checkpoints by their HF id — populated from
    // vLLM's /v1/models `root` field, so served-name aliases like qwen-vl /
    // qwen3-vl-local resolve to the underlying repo (e.g. Qwen/Qwen3.6-27B-FP8).
    // Dense-only — excludes the 35B-A3B MoE variant which hits the MoE rule
    // above. Sub-27B dense variants (if any future release) match too; the
    // family is recent enough that the recall lift is justified across sizes.
    matches: (f) => /qwen3\.?6/i.test(f.hfModelId ?? "") && f.architecture === "dense",
    profile: {
      libraryNames: "high",
      libraryVersions: "medium",   // ↑ from the generic dense rule's "low"
      assetUrlPaths: "very-low",
      apiEndpoints: "medium",
      browserApis: "high",
      geographicCoordinates: "very-low",
    },
    notes: [
      "Library names and browser APIs: recall freely.",
      "Library versions: recall + verify via mica_inspect_url. Qwen3.6's training cutoff is recent enough that current popular-library versions (React, Three.js, Express, npm registry packages) are in-corpus — recall-first is usually faster than search-first for the version, then verify against the package registry to catch the cases that drifted.",
      "API endpoint RESPONSE SHAPES: docs-first, not recall-first. Per discover-dependency § 3c, locate the official endpoint docs (tavily/exa search → mica_inspect_url to fetch the doc page), cite the doc URL in a code comment alongside the documented field layout, then verify the live response matches via one sample fetch. The Qwen3.6 lift on library versions does NOT extend to response-shape recall — field-level schema (array index orders, key names, optional fields) fails silently and uniformly across non-frontier dense and small-active MoE. Concrete observed case: agent shifted OpenSky's v2 state-vector indices by 1 (omitted time_position), code parsed last_contact-as-longitude, markers placed at coordinates outside the visible map, debug loop never converged.",
      "Asset URL specifics: skip recall. Go directly to Search craft + Asset URL Extract Pattern in discover-dependency Step 3b. Empirically (Qwen3.6-27B-FP8 dense in orbit301) asset-URL recall fails the same way as smaller-active MoE — the version lift above doesn't extend to specific asset paths.",
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
      "Library versions: recall + verify via mica_inspect_url against the package registry.",
      "API endpoint RESPONSE SHAPES: docs-first, not recall-first. Per discover-dependency § 3c, locate the official endpoint docs (tavily/exa search → mica_inspect_url to fetch the doc page), cite the doc URL in a code comment alongside the documented field layout, then verify the live response matches via one sample fetch. Field-level schema (array index orders, key names, optional/nullable fields) fails silently at this model class and the debug loop never converges. Frontier-class dense models (Claude, GPT-4o, Gemini frontier) match their own rules above and get a less strict default.",
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

// ── Workspace override store ───────────────────────────────────────────
//
// A user can tune calibration for a given model id (workspace-wide) via the
// agent card gear panel. Overrides persist in a plain JSON file at
// ~/.mica/calibration-overrides.json, keyed by model id — same plain-file,
// homedir-scoped pattern as files.ts's include-projects.json (tenet 2). The
// override is merged over the rule-table default with explicit precedence
// (see buildCalibration). Owned here, not in files.ts, so all calibration
// logic — rules, introspection, overrides, merge — lives in one module.

/** A partial override for one model. Any field absent → keep the rule
 *  default. `knownFacts` is applied BEFORE classification, so forcing an
 *  architecture can change which rule fires. */
export interface CalibrationOverride {
  recallProfile?: Partial<RecallProfile>;
  notes?: string[];
  knownFacts?: Partial<ModelCalibration["knownFacts"]>;
}

export type CalibrationSource = "hf-fingerprint" | "user-override" | "name-pattern" | "unknown";

const OVERRIDES_FILE = join(homedir(), ".mica", "calibration-overrides.json");

/** Read all model overrides. Missing/malformed → {} (never throws). */
export function readCalibrationOverrides(): Record<string, CalibrationOverride> {
  if (!existsSync(OVERRIDES_FILE)) return {};
  try {
    const data = JSON.parse(readFileSync(OVERRIDES_FILE, "utf-8"));
    if (data && typeof data === "object" && data.overrides && typeof data.overrides === "object") {
      return data.overrides as Record<string, CalibrationOverride>;
    }
    return {};
  } catch (err) {
    console.warn(`[calibration] calibration-overrides.json malformed: ${(err as Error).message}`);
    return {};
  }
}

function writeOverridesFile(all: Record<string, CalibrationOverride>): void {
  mkdirSync(dirname(OVERRIDES_FILE), { recursive: true });
  writeFileSync(OVERRIDES_FILE, JSON.stringify({ overrides: all }, null, 2));
}

/** Upsert one model's override and bust its cached calibration so the next
 *  resolve (turn or gear-open) reflects it. */
export function writeCalibrationOverride(modelName: string, override: CalibrationOverride): void {
  const all = readCalibrationOverrides();
  all[modelName] = override;
  writeOverridesFile(all);
  invalidateCalibrationByModel(modelName);
}

/** Remove a model's override ("Reset to default"). Idempotent. */
export function deleteCalibrationOverride(modelName: string): void {
  const all = readCalibrationOverrides();
  if (!(modelName in all)) return;
  delete all[modelName];
  writeOverridesFile(all);
  invalidateCalibrationByModel(modelName);
}

/** Drop every cached calibration for this model id (across providers). The
 *  cache key is `provider:modelName` but overrides are keyed by model id
 *  alone, so we clear by suffix. */
function invalidateCalibrationByModel(modelName: string): void {
  for (const key of [..._cache.keys()]) {
    if (key.endsWith(`:${modelName}`)) _cache.delete(key);
  }
}

// ── Public API ────────────────────────────────────────────────────────

/** Introspect a model's facts from vLLM /v1/models root + HF config.json +
 *  README. Returns {} on any miss (closed cloud model, network down). */
async function introspectFacts(opts: GetCalibrationOpts): Promise<ModelCalibration["knownFacts"]> {
  const { provider, modelName, baseUrl } = opts;
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
      if (knownFacts.architecture === "moe" && expertsPerTok) {
        knownFacts.numExpertsPerTok = expertsPerTok;
      }
    }
  }
  if (trainingCutoff) knownFacts.trainingCutoff = trainingCutoff;
  if (hfId) knownFacts.hfModelId = hfId;
  return knownFacts;
}

/** Merge an override over the rule-table default, four layers in order:
 *   1. facts:   introspected ⊕ override.knownFacts (override wins) — a forced
 *               architecture therefore feeds classification.
 *   2. classify: run the rules on the MERGED facts → class + profile + notes.
 *   3. dials:   rule profile ⊕ override.recallProfile (per-key).
 *   4. notes:   override.notes replaces rule notes when present.
 *  Returns the calibration plus `source` (basis of the classification) and
 *  `overridden` (which fields differ from the rule default — for the gear UI). */
function buildCalibration(
  introspected: ModelCalibration["knownFacts"],
  modelName: string,
  override: CalibrationOverride | undefined,
): { calibration: ModelCalibration; source: CalibrationSource; overridden: string[] } {
  const overridden: string[] = [];

  const mergedFacts: ModelCalibration["knownFacts"] = { ...introspected };
  if (override?.knownFacts) {
    for (const [k, v] of Object.entries(override.knownFacts)) {
      if (v !== undefined && v !== null) {
        (mergedFacts as Record<string, unknown>)[k] = v;
        overridden.push(`knownFacts.${k}`);
      }
    }
  }

  const { classify, profile, notes } = classifyAndProfile(mergedFacts, modelName);

  const mergedProfile: RecallProfile = { ...profile };
  if (override?.recallProfile) {
    for (const [k, v] of Object.entries(override.recallProfile)) {
      if (v) {
        (mergedProfile as Record<string, Confidence>)[k] = v as Confidence;
        overridden.push(`recallProfile.${k}`);
      }
    }
  }

  let mergedNotes = notes;
  if (override?.notes && override.notes.length > 0) {
    mergedNotes = override.notes;
    overridden.push("notes");
  }

  const calibration: ModelCalibration = {
    identity: { name: modelName, class: classify },
    knownFacts: mergedFacts,
    recallProfile: mergedProfile,
    notes: mergedNotes,
  };

  let source: CalibrationSource;
  if (introspected.architecture) source = "hf-fingerprint";
  else if (override?.knownFacts?.architecture) source = "user-override";
  else if (classify !== "unknown — conservative defaults") source = "name-pattern";
  else source = "unknown";

  return { calibration, source, overridden };
}

/** Fetch (or cache-return) the calibration for a (provider, model) pair,
 *  with any workspace override applied. Always resolves — falls back to the
 *  conservative "unknown" profile if introspection fails. Safe to call
 *  per-turn; the 1h cache eliminates duplicate fetches (busted when an
 *  override for the model is written/deleted). */
export async function getModelCalibration(opts: GetCalibrationOpts): Promise<ModelCalibration> {
  const { provider, modelName } = opts;
  const cacheKey = `${provider}:${modelName}`;
  const cached = _cache.get(cacheKey);
  if (cached && Date.now() - cached.ts < TTL_MS) return cached.data;
  const existing = _inflight.get(cacheKey);
  if (existing) return existing;

  const p = (async (): Promise<ModelCalibration> => {
    try {
      const introspected = await introspectFacts(opts).catch(() => ({} as ModelCalibration["knownFacts"]));
      const override = readCalibrationOverrides()[modelName];
      const { calibration } = buildCalibration(introspected, modelName, override);
      _cache.set(cacheKey, { ts: Date.now(), data: calibration });
      return calibration;
    } finally {
      _inflight.delete(cacheKey);
    }
  })();
  _inflight.set(cacheKey, p);
  return p;
}

/** Resolve calibration + transparency metadata (source, which fields are
 *  overridden) for the gear-panel dialog. Bypasses the turn cache so the UI
 *  always reflects the current override file; one HF fetch per gear-open is
 *  cheap. */
export async function getCalibrationDetail(
  opts: GetCalibrationOpts,
): Promise<{
  calibration: ModelCalibration;
  source: CalibrationSource;
  overridden: string[];
  base: ModelCalibration;
}> {
  const introspected = await introspectFacts(opts).catch(() => ({} as ModelCalibration["knownFacts"]));
  const override = readCalibrationOverrides()[opts.modelName];
  const merged = buildCalibration(introspected, opts.modelName, override);
  // `base` = same model, no override applied — lets the gear UI mark which
  // fields the user has changed and send only real diffs on save.
  const base = buildCalibration(introspected, opts.modelName, undefined).calibration;
  return { ...merged, base };
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
