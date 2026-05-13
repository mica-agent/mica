// toolPrerequisites.ts — predicate framework for tool-call gates.
//
// Background: a few Mica primitives need preconditions before they run.
// The card-class build flow ("write the spec, then invoke
// card-class-handbook, then create the class") has invariants the
// model empirically compresses across turns. This module externalizes
// the contract: each tool registers an ordered list of predicates, a
// wrapper runs them before the tool's impl, and the first failing
// predicate produces a structured error that the agent's tool-result
// loop reads. The error's `nextMove` text guides the agent's next
// tool call.
//
// Predicate scope. Three predicates today, all narrow:
//
//   - `canvasHasSpecForClass`: mica_create_class needs a non-empty
//     canvas/<name>-spec.md to exist. The spec is the contract the
//     create_class call serializes from. Without it the agent is
//     building from working memory alone, with no canvas-visible
//     trace of the design.
//
//   - `requiredLibrarySkillsInstalled`: if the spec mentions a curated
//     library that has a `<lib>-skills` package (Three.js → threejs-
//     skills), that package must be installed. Skill packs carry
//     library-specific patterns (container sizing, init order,
//     disposer rules) the base model misses. Pattern-based detection
//     keeps this narrow — adds an entry per curated library.
//
//   - `sessionHasCardClassHandbook`: the card-class-handbook skill
//     must have been invoked in the chat session before
//     mica_create_class / mica_edit_class_file runs. The handbook is
//     the contract those tools enforce (CARD_SHIM globals, metadata
//     schema, render verification). Without it in working memory,
//     common violations surface only as post-write lint errors.
//
// Predicates are composable functions so future (tool, predicate)
// pairs can be added without architectural change. The check function
// can grow from file existence today to frontmatter parsing tomorrow
// to LLM-based relevance later — the framework is indifferent.

import { existsSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { WORKSPACE_DIR } from "./files.js";
import { hasSkillBeenInvoked } from "./skillInvocationTracker.js";

export interface PredicateContext {
  /** Project name (e.g. "map2"). Never null at predicate time —
   *  the routing layer rejects tool calls without a project. */
  project: string;
  /** Absolute path to <WORKSPACE_DIR>/<project>. */
  projectDir: string;
  /** Chat-card filename (the session key) — may be null when the
   *  call doesn't originate from an agent session (e.g. opencode's
   *  shared bridge). Session-scoped predicates short-circuit to
   *  pass when this is null; they have no way to check otherwise. */
  chatFilename: string | null;
  /** Parsed input the tool was called with. Predicates may read tool
   *  args (e.g. the class name being created) to decide what canvas
   *  state to inspect. */
  toolArgs: Record<string, unknown>;
}

export type PredicateResult =
  | { ok: true }
  | { ok: false; reason: string; nextMove: string };

export interface Predicate {
  /** Stable name for logging (e.g. "canvas-has-spec-for-class"). */
  name: string;
  /** Synchronous or async check. Returns ok or a structured failure. */
  check: (ctx: PredicateContext) => PredicateResult | Promise<PredicateResult>;
}

// -- Predicate definitions --
//
// canvas-has-spec-for-class: the spec file must exist with non-trivial
// content. Filename-convention based (canvas/<name>-spec.md); a future
// escalation could parse spec frontmatter for `class: <name>` when
// user-written specs under non-conventional names show up.
const canvasHasSpecForClass: Predicate = {
  name: "canvas-has-spec-for-class",
  check: ({ projectDir, toolArgs }) => {
    const rawName = toolArgs.name;
    if (typeof rawName !== "string" || !rawName.trim()) {
      // Tool input validation should have caught this already; if we
      // somehow got here without a name, fail closed.
      return {
        ok: false,
        reason: "Tool was called without a class name.",
        nextMove: "Supply a `name` argument matching the spec filename (canvas/<name>-spec.md).",
      };
    }
    const className = rawName.trim();
    const specPath = join(projectDir, "canvas", `${className}-spec.md`);
    if (!existsSync(specPath)) {
      return {
        ok: false,
        reason: `No spec found at canvas/${className}-spec.md.`,
        nextMove:
          `Per the develop skill (step 2), write canvas/${className}-spec.md first. ` +
          `The spec must include subproblems-to-solutions, dependencies (run ` +
          `skill('discover-dependency') for non-trivial subproblems first), and an ` +
          `out-of-scope section. After writing the spec, your turn ENDS; wait for ` +
          `user approval before retrying this tool.`,
      };
    }
    try {
      const size = statSync(specPath).size;
      if (size < 100) {
        return {
          ok: false,
          reason: `canvas/${className}-spec.md exists but has only ${size} bytes — too short to be a usable spec.`,
          nextMove:
            `Flesh out canvas/${className}-spec.md per the develop skill (step 2) ` +
            `before retrying this tool.`,
        };
      }
    } catch {
      // statSync threw — treat as a missing-spec failure since we can't
      // confirm the file is readable.
      return {
        ok: false,
        reason: `canvas/${className}-spec.md could not be read.`,
        nextMove: `Verify canvas/${className}-spec.md exists and is readable, then retry.`,
      };
    }
    return { ok: true };
  },
};

// required-library-skills-installed: for each curated library mentioned
// in the spec, the matching `<lib>-skills` package must be installed
// in this project. Library-specific skill packs carry Mica-specific
// patterns (container sizing for WebGL, init-order quirks, disposer
// rules) that the base model misses; skipping the install leaves the
// agent to improvise from training-prior knowledge, which produced
// the canonical "blank Three.js canvas because the container had no
// height" failure mode in the moon-orbit build.
//
// Detection is intentionally loose-pattern: a library is "in use" if
// a clear marker (canonical name, CDN URL, API namespace) appears in
// spec.md. Vague mentions don't trigger. The mapping table is small —
// extend as more curated `<lib>-skills` packages land.
interface LibrarySkillsMapping {
  /** Detection regex; case-insensitive; matches when the library is
   *  clearly in use in the spec (canonical name, CDN URL, or API
   *  namespace). Avoid loose matches that would fire on incidental
   *  mentions ("considered Three.js but went with Canvas"). */
  pattern: RegExp;
  /** Display name for the error message. */
  libraryName: string;
  /** Source string to pass to mica_install_skills. */
  source: string;
  /** Directory name under .qwen/skills/ after install — used to detect
   *  whether the package is already there. Must match the resolution
   *  in installSkills.ts:resolveSource (defaultName). */
  installedDirName: string;
}

const LIBRARY_SKILLS_MAP: LibrarySkillsMapping[] = [
  {
    pattern: /\bthree\.?js\b|\bThreeJS\b|\bTHREE\.[A-Z]\w*|cdn\.jsdelivr\.net\/npm\/three[@/]/i,
    libraryName: "Three.js",
    source: "threejs-skills",
    installedDirName: "threejs",
  },
];

const requiredLibrarySkillsInstalled: Predicate = {
  name: "required-library-skills-installed",
  check: ({ projectDir, toolArgs }) => {
    const rawName = toolArgs.name;
    if (typeof rawName !== "string" || !rawName.trim()) return { ok: true };
    const className = rawName.trim();
    const specPath = join(projectDir, "canvas", `${className}-spec.md`);
    if (!existsSync(specPath)) return { ok: true }; // canvasHasSpecForClass handles
    let spec: string;
    try {
      spec = readFileSync(specPath, "utf-8");
    } catch {
      return { ok: true };
    }
    for (const m of LIBRARY_SKILLS_MAP) {
      if (!m.pattern.test(spec)) continue;
      const skillDir = join(projectDir, ".qwen", "skills", m.installedDirName);
      if (existsSync(skillDir)) continue;
      return {
        ok: false,
        reason:
          `Spec ${join("canvas", `${className}-spec.md`)} uses ${m.libraryName}, ` +
          `but the ${m.source} package is not installed in this project.`,
        nextMove:
          `Invoke \`mica_install_skills source="${m.source}"\` as your next tool call. ` +
          `The package carries ${m.libraryName}-specific patterns (container sizing, ` +
          `init order, disposer rules, asset paths) that the base model misses — ` +
          `installing it BEFORE the class is created prevents the common "blank canvas" ` +
          `and "library global undefined" failure modes. After installing, retry this tool.`,
      };
    }
    return { ok: true };
  },
};

// session-has-card-class-handbook: skill('card-class-handbook') must
// have been invoked in this chat session. Tracked in
// skillInvocationTracker.ts; recorded by micaAgent.ts when the agent's
// event stream emits a `tool_use: skill` for that skill name.
//
// When chatFilename is null (the caller can't supply session scope —
// e.g. opencode bridge), the predicate passes. Opencode mirroring is
// out of scope for the MVP.
const sessionHasCardClassHandbook: Predicate = {
  name: "session-has-card-class-handbook",
  check: ({ project, chatFilename }) => {
    if (!chatFilename) return { ok: true };
    if (hasSkillBeenInvoked(project, chatFilename, "card-class-handbook")) {
      return { ok: true };
    }
    return {
      ok: false,
      reason: `skill('card-class-handbook') has not been invoked in this chat session.`,
      nextMove:
        `Invoke skill('card-class-handbook') as your next tool call. The handbook ` +
        `is the contract this tool enforces (CARD_SHIM globals, metadata schema, ` +
        `render verification, partial-edit rules). After invoking the handbook, ` +
        `retry this tool.`,
    };
  },
};

// -- Registry --
//
// Each tool name maps to its ordered predicate list. Order matters:
// `runPredicates` short-circuits on the first failure, so list the
// cheapest predicate first when ordering is otherwise neutral.
//
// Tools NOT in this map have no prerequisites — they run as before.
export const TOOL_PREREQUISITES: Record<string, Predicate[]> = {
  mica_create_class: [
    canvasHasSpecForClass,
    requiredLibrarySkillsInstalled,
    sessionHasCardClassHandbook,
  ],
  mica_edit_class_file: [sessionHasCardClassHandbook],
};

/** Run all predicates for a tool. Returns ok if every predicate
 *  passes; returns the FIRST failing predicate's result otherwise.
 *  If the tool isn't in the registry, returns ok unconditionally. */
export async function runPredicates(
  toolName: string,
  ctx: PredicateContext,
): Promise<PredicateResult> {
  const predicates = TOOL_PREREQUISITES[toolName];
  if (!predicates || predicates.length === 0) return { ok: true };
  for (const p of predicates) {
    const result = await p.check(ctx);
    if (!result.ok) {
      console.log(
        `[tool-prereq] ${toolName} blocked by ${p.name}: ${result.reason}`,
      );
      return result;
    }
  }
  return { ok: true };
}

/** Helper to format a predicate failure as a single error string for
 *  the tool result. The agent reads this; the nextMove text guides
 *  the retry. */
export function formatPredicateFailure(failure: { reason: string; nextMove: string }): string {
  return `Prerequisite not met: ${failure.reason}\n\nNext: ${failure.nextMove}`;
}

// -- Helpers (exported for testing and for use in future predicates) --

/** True if a canvas/<className>-spec.md exists in the project with
 *  non-trivial content. Exposed so other code (e.g. future predicates
 *  on related tools) can check the same condition without duplicating
 *  the path-build logic. */
export function canvasHasSpec(projectDir: string, className: string): boolean {
  const specPath = join(projectDir, "canvas", `${className}-spec.md`);
  if (!existsSync(specPath)) return false;
  try {
    return statSync(specPath).size >= 100;
  } catch {
    return false;
  }
}

/** Build the PredicateContext for a tool call from the routing layer's
 *  inputs. Centralized so the routing code stays a one-liner. */
export function buildPredicateContext(
  project: string,
  chatFilename: string | null,
  toolArgs: Record<string, unknown>,
): PredicateContext {
  return {
    project,
    projectDir: join(WORKSPACE_DIR, project),
    chatFilename,
    toolArgs,
  };
}
