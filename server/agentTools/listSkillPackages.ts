// mica_list_skill_packages — return Mica's curated table of library-skills
// packages. Used by the research-candidates skill: for each library
// candidate it enumerates, it consults this list to decide whether to
// annotate the research artifact with `Skill pack: <name> (curated)`
// or `Skill pack: none authored`.
//
// Read-only — no project state touched, no fetching. The data source
// is `KNOWN_SKILL_PACKAGES` in installSkills.ts. Returns one row per
// canonical package (deduplicated across the shorthand-aliases that
// resolve to the same URL).

import { z } from "zod";
import { KNOWN_SKILL_PACKAGES } from "./installSkills.js";
import type { AgentToolDef, AgentToolResult } from "./registry.js";

const inputSchema = {
  query: z
    .string()
    .optional()
    .describe(
      "Optional case-insensitive substring filter against the library / " +
        "package shorthand. Omit to return the full curated list.",
    ),
} as const;

interface PackageRow {
  package: string;
  url: string;
  shorthands: string[];
}

function rollUp(entries: Record<string, string>): PackageRow[] {
  // URL → row, collecting every shorthand that resolves to it.
  const byUrl = new Map<string, PackageRow>();
  for (const [shorthand, url] of Object.entries(entries)) {
    let row = byUrl.get(url);
    if (!row) {
      // Pick the canonical "<x>-skills" shorthand as the package name
      // when present; otherwise the first shorthand seen.
      const skillsShorthand = Object.entries(entries)
        .filter(([, u]) => u === url)
        .map(([s]) => s)
        .find((s) => s.endsWith("-skills"));
      row = {
        package: skillsShorthand || shorthand,
        url,
        shorthands: [],
      };
      byUrl.set(url, row);
    }
    row.shorthands.push(shorthand);
  }
  // Sort shorthands per row + rows by package name for stable output.
  for (const row of byUrl.values()) row.shorthands.sort();
  return Array.from(byUrl.values()).sort((a, b) =>
    a.package.localeCompare(b.package),
  );
}

export const listSkillPackagesTool: AgentToolDef<typeof inputSchema> = {
  name: "mica_list_skill_packages",
  description:
    "List Mica's curated library-skills packages — the packs that " +
    "`mica_install_skills` accepts as a shorthand. Each entry carries " +
    "library-specific Mica patterns (container sizing, init order, " +
    "common plugin gotchas, disposer rules) that the base model misses. " +
    "Call this once during research-candidates: for each library you " +
    "enumerate as a candidate, check whether a pack exists. If yes, " +
    "annotate the candidate's Notes column with " +
    "`Skill pack: <package> (curated)` so downstream phases install it; " +
    "if no, annotate `Skill pack: none authored` so the gap is visible " +
    "on canvas. The list is short and stable — one call per build is " +
    "enough; do NOT call again on every subproblem. Returns JSON: " +
    "`{ packages: [{ package, url, shorthands: [...] }, ...] }`. " +
    "Optional `query` filters by substring against the shorthand.",
  inputSchema,
  restPath: "/api/tools/list-skill-packages",
  handler: async (input): Promise<AgentToolResult> => {
    const all = rollUp(KNOWN_SKILL_PACKAGES);
    const q = input.query?.trim().toLowerCase();
    const filtered = q
      ? all.filter((row) =>
          row.shorthands.some((s) => s.toLowerCase().includes(q)) ||
          row.package.toLowerCase().includes(q),
        )
      : all;
    return {
      text: JSON.stringify({ packages: filtered }, null, 2),
    };
  },
};
