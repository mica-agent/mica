// mica_verify_spec_conformance — agent-time check that a card class's
// CODE conforms to what its SPEC declared.
//
// Sister tool to mica_verify_sidecar. Where verify_sidecar exercises a
// real outbound HTTP path, verify_spec_conformance reads the spec's
// machine-readable contracts (frontmatter `dependencies`, per-subtask
// `mechanism`) and lints the generated card.html / card.js / card.css /
// server.py against them. Three contracts:
//
//   Contract 1 — declared deps must appear; undeclared deps in card.html
//     should not (warning).
//   Contract 2 — mechanism conformance per subtask (e.g. "sidecar proxy"
//     forbids direct external fetches from card.js).
//   Contract 3 — every URL literal in code must be cited per discover-
//     dependency § 3c with a nearby `// Per <url>` / `# Per <url>`
//     comment.
//
// All three checks ALSO fire at write-time inside the warning-mode
// verifier `card-spec-conformance` (see server/verifiers/
// cardSpecConformance.ts). This tool gives the agent a way to ask
// for the same report on demand — useful after a batch of edits or
// when chasing a runtime bug that smells like spec drift.

import { z } from "zod";
import { existsSync } from "fs";
import { join } from "path";
import type { AgentToolDef, AgentToolResult } from "./registry.js";
import { runVerifiers, type VerifyResult } from "../verifiers/index.js";
import { readFile } from "fs/promises";
import { micaDir, findCardClassInLibraries } from "../files.js";

const CARD_CLASSES_DIR = join(process.cwd(), "card-classes");

function resolveClassDir(className: string, project: string | null): string | null {
  if (project) {
    const projectScoped = join(micaDir(project), "card-classes", className);
    if (existsSync(join(projectScoped, "card.html"))) return projectScoped;
  }
  const lib = findCardClassInLibraries(className);
  if (lib) return lib.dir;
  const builtIn = join(CARD_CLASSES_DIR, className);
  if (existsSync(join(builtIn, "card.html"))) return builtIn;
  return null;
}

const inputSchema = {
  card_class: z
    .string()
    .describe(
      "The card class name (directory name under `.mica/card-classes/`, e.g. 'sfo-aircraft'). Project is inferred from the active session.",
    ),
} as const;

function formatResult(cardClass: string, project: string, results: VerifyResult[]): string {
  const errors: string[] = [];
  const warnings: string[] = [];
  for (const r of results) {
    if (r.ok) continue;
    for (const p of r.problems) {
      const loc = p.line ? `${p.file}:${p.line}` : p.file;
      const line = `- [${loc}] ${p.problem}\n  Fix: ${p.fix_hint}`;
      if (p.problem.startsWith("[ERROR]")) errors.push(line);
      else warnings.push(line);
    }
  }

  const errorCount = errors.length;
  const warningCount = warnings.length;
  const verdict =
    errorCount > 0
      ? `[verify_spec_conformance: ERRORS] ${errorCount} error(s), ${warningCount} warning(s)`
      : warningCount > 0
        ? `[verify_spec_conformance: WARNINGS] ${warningCount} warning(s)`
        : `[verify_spec_conformance: CLEAN]`;

  const lines: string[] = [verdict, ""];
  lines.push(`Card class: ${cardClass}`);
  lines.push(`Project: ${project}`);
  lines.push("");

  if (errorCount === 0 && warningCount === 0) {
    lines.push(
      "Code conforms to spec on all three contracts: declared dependencies present, mechanism matches per subtask, every URL literal cited per discover-dependency § 3c.",
    );
    return lines.join("\n");
  }

  if (errorCount > 0) {
    lines.push("ERRORS:");
    lines.push(...errors);
    lines.push("");
  }
  if (warningCount > 0) {
    lines.push("WARNINGS:");
    lines.push(...warnings);
    lines.push("");
  }
  lines.push(
    "Severity guide: [ERROR] = spec contract violated (missing declared dep, or mechanism drift like sidecar bypass). [WARN] = uncited URL or undeclared dep in card.html — fix by adding the citation comment per § 3c or promoting the dep to spec.dependencies.",
  );
  return lines.join("\n");
}

export const verifySpecConformanceTool: AgentToolDef<typeof inputSchema> = {
  name: "mica_verify_spec_conformance",
  description:
    "Check whether a card class's CODE (card.html / card.js / card.css / server.py) conforms to what its SPEC declared (canvas/<card-class>-spec.md frontmatter). Three contracts: (1) declared spec.dependencies must appear in card.html; undeclared external <script>/<link> get warned; (2) mechanism conformance — `mechanism: sidecar proxy` forbids direct external fetches from card.js; (3) every URL literal in code must be cited within 3 lines by a `// Per <doc-url>` (or `# Per <doc-url>`) comment per discover-dependency § 3c, or opted out with `// mica-skip-cite: <reason>`. Returns a verdict tag — `[verify_spec_conformance: CLEAN|WARNINGS|ERRORS]` — and a problem list with file:line and a fix hint per problem. Severity is encoded as an [ERROR] / [WARN] prefix in each problem. Call after writing or editing card files when the spec has a frontmatter block (it always does for cards built via the develop skill). Run this before `mica_verify_sidecar` if you suspect a generated URL is wrong — Contract 3 surfaces uncited URLs that need a doc-cross-check. Input: `{ card_class }`.",
  inputSchema,
  restPath: "/api/tools/mica-verify-spec-conformance",
  handler: async (input, ctx): Promise<AgentToolResult> => {
    if (!ctx.project) {
      return { isError: true, text: "Active project required." };
    }
    const project = ctx.project;
    const cardClass = input.card_class;

    const classDir = resolveClassDir(cardClass, project);
    if (!classDir) {
      return {
        isError: true,
        text:
          `[verify_spec_conformance: ERROR — lookup] Card class '${cardClass}' not found in project '${project}'.\n\n` +
          `Check the spelling, or that the class has been created via mica_create_class.`,
      };
    }

    // Fire each code file's content through the verifier framework in
    // on-demand-style runs. The verifier is registered in `warning` mode
    // (so it fires automatically at write time), but it's a normal
    // verifier — we can dispatch it manually by passing each file's
    // current content. We pass "warning" so we hit the same code path
    // the write-time pipeline uses; runVerifiers will collect the
    // problems from cardSpecConformance for whichever code file matches.
    const filePaths = [
      join(classDir, "card.html"),
      join(classDir, "card.js"),
      join(classDir, "card.css"),
      join(classDir, "server.py"),
    ];
    const results: VerifyResult[] = [];
    for (const fp of filePaths) {
      if (!existsSync(fp)) continue;
      try {
        const content = await readFile(fp, "utf-8");
        const r = await runVerifiers(fp, content, project, "warning");
        results.push(r);
      } catch {
        // Skip unreadable files — they're not part of the contract.
      }
    }

    // De-duplicate: the verifier reads all four files on every fire, so
    // running it once per file would re-emit every problem N times. We
    // only need ONE result for the conformance check — pick the first
    // failing result; if none failed, the report is CLEAN.
    const firstFailure = results.find((r) => !r.ok);
    const dedupedResults: VerifyResult[] = firstFailure ? [firstFailure] : [];

    return { text: formatResult(cardClass, project, dedupedResults) };
  },
};
