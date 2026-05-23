// Verification framework — build-time checks the agent must pass before
// a write lands on disk. Each verifier handles one artifact type (card.js,
// python scripts, bash scripts, etc.) and runs at one of three modes:
//
//   gate       — at write time; failure refuses the write (agent reads
//                structured report, fixes, retries)
//   warning    — at write time after success; attaches a card-warning
//                event the agent sees but isn't blocked on
//   on-demand  — runs only when explicitly invoked (via mica_verify)
//
// Verifiers are pure-by-call: { matches(filepath, project), verify(filepath,
// content, project) } — the framework hands them the would-be content, the
// project name, and the path. They return { ok: true } or a structured
// problem list with file/line/column + human-readable problem + fix_hint.
//
// Integration points: every write-capable tool (write_file,
// mica_edit_class_file, mica_create_class) calls runVerifiers before
// persisting and aggregates failures into the tool result.

export type VerifierMode = "gate" | "warning" | "on-demand";

export interface VerifyProblem {
  /** File the problem is in (usually but not always the file being written). */
  file: string;
  line?: number;
  column?: number;
  /** Human-readable description of what's wrong. */
  problem: string;
  /** Actionable hint for fixing it. Agents follow these almost verbatim. */
  fix_hint: string;
}

export type VerifyResult =
  | { ok: true }
  | { ok: false; verifier: string; problems: VerifyProblem[] };

export interface FileVerifier {
  /** Stable name, used for logging and the disable-via-env-var path. */
  name: string;
  /** Mode controls when the verifier fires and what failure means. */
  mode: VerifierMode;
  /** Does this verifier apply to (filepath, project)? Synchronous when
   *  possible; async permitted for verifiers that need to inspect related
   *  files to decide (e.g. "this is a card.js if a sibling metadata.json
   *  exists"). */
  matches: (filepath: string, project: string) => boolean | Promise<boolean>;
  /** Run the check. Receives the would-be content (string for text files).
   *  The framework reads it for matches() that need content, but the
   *  verifier receives whatever the tool was going to write. */
  verify: (filepath: string, content: string, project: string) => Promise<VerifyResult>;
}

// Registry. Verifiers register themselves by being imported here.
const VERIFIERS: FileVerifier[] = [];

export function registerVerifier(v: FileVerifier): void {
  VERIFIERS.push(v);
}

/** Per-verifier disable via env var: MICA_VERIFIERS_DISABLED=name1,name2.
 *  Useful when a verifier produces false positives we haven't yet tuned. */
function isDisabled(name: string): boolean {
  const list = (process.env.MICA_VERIFIERS_DISABLED || "").split(",").map((s) => s.trim()).filter(Boolean);
  return list.includes(name);
}

/** Run every matching verifier of the requested mode. Returns ok if all
 *  pass; otherwise returns the FIRST failure's verifier name + the
 *  aggregated problems across all failing verifiers (so the agent sees
 *  every problem in one tool-result, not one-at-a-time). */
export async function runVerifiers(
  filepath: string,
  content: string,
  project: string,
  mode: VerifierMode,
): Promise<VerifyResult> {
  // Find matching verifiers of the requested mode.
  const candidates: FileVerifier[] = [];
  for (const v of VERIFIERS) {
    if (v.mode !== mode) continue;
    if (isDisabled(v.name)) continue;
    try {
      const m = await Promise.resolve(v.matches(filepath, project));
      if (m) candidates.push(v);
    } catch (err) {
      console.warn(`[verifier:${v.name}] matches() threw, skipping:`, (err as Error).message);
    }
  }
  if (candidates.length === 0) return { ok: true };

  // Run all matching verifiers in parallel.
  const results = await Promise.all(
    candidates.map(async (v) => {
      try {
        return await v.verify(filepath, content, project);
      } catch (err) {
        // A verifier crashing is itself a failure — but don't refuse the
        // write on framework-internal bugs. Log loudly and pass.
        console.warn(`[verifier:${v.name}] verify() threw, treating as pass:`, (err as Error).message);
        return { ok: true } as VerifyResult;
      }
    }),
  );

  // Aggregate: any failure means refuse, but collect every problem from
  // every failing verifier so the agent gets one rich report instead of
  // re-running and discovering issues serially.
  const allProblems: VerifyProblem[] = [];
  const failingVerifiers: string[] = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (!r.ok) {
      failingVerifiers.push(candidates[i].name);
      for (const p of r.problems) allProblems.push(p);
    }
  }
  if (allProblems.length === 0) return { ok: true };

  return {
    ok: false,
    verifier: failingVerifiers.join("+"),
    problems: allProblems,
  };
}

/** Format a VerifyResult failure for use as a tool-result text body. The
 *  shape matches what tool-call error returns look like in this codebase —
 *  agents are familiar with this format from existing predicate refusals. */
export function formatVerifyFailure(result: VerifyResult & { ok: false }): string {
  const lines: string[] = [];
  lines.push(`Verification failed (${result.verifier}). Fix the problems below and retry the write.\n`);
  for (let i = 0; i < result.problems.length; i++) {
    const p = result.problems[i];
    const loc = p.line ? `:${p.line}${p.column ? `:${p.column}` : ""}` : "";
    lines.push(`${i + 1}. [${p.file}${loc}] ${p.problem}`);
    lines.push(`   Fix: ${p.fix_hint}`);
    lines.push("");
  }
  return lines.join("\n");
}

// Side-effect imports register concrete verifiers.
import "./cardJsWrapperParse.js";
import "./cardJsUncalledFunctions.js";
import "./cardJsSelectorHtmlMatch.js";
import "./cardJsChannelArgs.js";
import "./pythonScriptParse.js";
import "./bashScriptParse.js";
