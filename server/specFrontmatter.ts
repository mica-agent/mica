// specFrontmatter.ts — parse the YAML frontmatter block at the top of
// canvas/<class>-spec.md.
//
// Consolidates the structured data that previously lived in two markdown
// tables (Architecture Decomposition + Verified Dependencies) plus the
// metadata.json fields the agent had to re-derive when calling
// mica_create_class. With this consolidation, the agent writes the
// structured data ONCE in the spec's frontmatter; the tool reads it
// directly; the freeform prose below the frontmatter is for human review.
//
// The eliminated translation step ("spec says Three.js 0.160 UMD → tool
// call says scripts: [...]") is where spec/build drift used to sneak in
// (wrong version, wrong URL, missed UMD-vs-ESM). With frontmatter as the
// single source of truth, the tool's input IS the spec's structured part.
//
// Backward compatible: specs without frontmatter parse to null and the
// agent's explicit args remain authoritative. New specs benefit; old
// specs keep working.

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";

export interface SpecDependencyEntry {
  /** Full HTTPS URL of the CDN asset. */
  url: string;
  /** Format detected at verification time. UMD/ESM dispatch the loading
   *  pattern; agent should set this from `mica_inspect_url` output. */
  format?: "UMD" | "ESM" | "CommonJS" | "data" | "unknown";
  /** Pinned version. Cosmetic — but lets humans skim "what was locked." */
  version?: string;
}

export interface SpecSubtask {
  /** Short label, e.g. "render the 3D scene". */
  name: string;
  /** Cheapest viable tier per card-class-handbook hierarchy. */
  tier: 1 | 2 | 3 | 4;
  /** Library / handler / CLI tool / sidecar entry. Free-form short text. */
  mechanism: string;
  /** Optional. How this subtask will be verified end-to-end. */
  verify?: string;
}

export interface SpecSidecarConfig {
  entry: string;
  ready_path?: string;
  ready_timeout_ms?: number;
  python?: string;
  interpreter?: string;
}

export interface CardClassFrontmatter {
  /** Directory name under .mica/card-classes/. Lowercase + dashes only,
   *  no dots. Must equal the spec's filename stem (e.g. spec is
   *  canvas/moon-orbit-spec.md → name is "moon-orbit"). */
  name: string;
  /** 1-4 character abbreviation shown on the canvas card tile. */
  badge?: string;
  /** Pretty display title. */
  default_title?: string;
  /** Optional. Routes the card's channel to a reusable handler
   *  (`llm-direct`, `llm-agent`, `process`). */
  handler?: string;
  /** Optional. Card-class-private sidecar declaration. */
  sidecar?: SpecSidecarConfig;
  /** Optional. For container-style card classes whose instances are
   *  directories containing a specific file. */
  primary_file?: string;
  dependencies?: {
    /** CDN URLs loaded via `<script>` tag in card.html — **UMD only**.
     *  ESM URLs do NOT go here; they're loaded inside card.js via
     *  `await import(url)`. The deps-reachable validator refuses ESM
     *  URLs in this slot at metadata-write time with a prescriptive
     *  error naming both fixes. Format detection runs against the
     *  body content (Three.js r150+ UMD bundles that ship a
     *  console.warn deprecation prefix are still recognized as UMD). */
    umd_scripts?: Array<string | SpecDependencyEntry>;
    /** CDN URLs loaded via `<link rel="stylesheet">`. */
    styles?: Array<string | SpecDependencyEntry>;
  };
  /** Required for canvas card classes. Each row maps a subtask to its
   *  cheapest viable tier. The schema forces the agent to walk the
   *  decomposition hierarchy explicitly — analogous to the previous
   *  markdown table that asked for the same thinking. */
  subtasks?: SpecSubtask[];
  /** Optional. Captured items the agent decided NOT to build, so the
   *  user can redirect at the approval gate before they're lost to
   *  history. */
  out_of_scope?: string[];
}

export interface ParsedSpec {
  /** Resolved card-class config block, or null if no frontmatter was
   *  found in the spec. */
  cardClass: CardClassFrontmatter | null;
  /** Raw YAML object (the part inside `---...---`), or null if absent.
   *  Exposed so future fields don't require parser changes — caller can
   *  read its own keys directly. */
  raw: unknown;
  /** When frontmatter was present but YAML parse failed, the error
   *  message. Use to surface a structured error from the tool layer. */
  parseError?: string;
}

const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n/;

/** Parse YAML frontmatter from a spec.md content string. Returns
 *  `cardClass: null` (with no error) when no frontmatter block exists —
 *  this is the backward-compat path. Returns a parseError when a
 *  frontmatter block exists but contains invalid YAML. */
export function parseSpecFrontmatter(content: string): ParsedSpec {
  const m = content.match(FRONTMATTER_RE);
  if (!m) {
    return { cardClass: null, raw: null };
  }
  const yamlText = m[1];
  let raw: unknown;
  try {
    raw = yaml.load(yamlText);
  } catch (err) {
    return {
      cardClass: null,
      raw: null,
      parseError: `YAML parse failed in spec frontmatter: ${(err as Error).message}`,
    };
  }
  if (!raw || typeof raw !== "object") {
    return { cardClass: null, raw };
  }
  const cardClassRaw = (raw as Record<string, unknown>)["card-class"];
  if (!cardClassRaw || typeof cardClassRaw !== "object") {
    return { cardClass: null, raw };
  }
  // The `card-class:` block is the contract `mica_create_class` reads.
  // Cast directly — runtime validation of nested shapes is the caller's
  // job (the tool's input schema already validates after merging).
  return { cardClass: cardClassRaw as CardClassFrontmatter, raw };
}

/** Read and parse the spec file for a given card class. Returns null if
 *  the spec doesn't exist; otherwise the ParsedSpec (which itself may
 *  have a null cardClass for old specs without frontmatter). */
export async function readSpecForClass(
  projectDir: string,
  className: string,
): Promise<ParsedSpec | null> {
  const specPath = join(projectDir, "canvas", `${className}-spec.md`);
  if (!existsSync(specPath)) return null;
  try {
    const content = await readFile(specPath, "utf-8");
    return parseSpecFrontmatter(content);
  } catch {
    return null;
  }
}

/** Extract the agent-facing version of one dependency URL, regardless of
 *  whether the spec wrote it as a bare string or a structured object. */
export function urlFromDep(dep: string | SpecDependencyEntry): string {
  return typeof dep === "string" ? dep : dep.url;
}
