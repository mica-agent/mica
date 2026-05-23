// Verifier #4 — every container.querySelector('#X') / .querySelectorAll
// in card.js must reference an id or class that actually exists in
// card.html. Catches the silent-break class where the agent renames an
// id in HTML but forgets in JS (or vice versa) — the queries return
// null, downstream code throws ".textContent on null", card is broken.
//
// Whether triggered on card.js or card.html, we read BOTH files and
// cross-check. The verifier matches on either filepath, so editing
// either side re-runs the check.

import { parse } from "@babel/parser";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { load as cheerioLoad } from "cheerio";
import { registerVerifier, type FileVerifier, type VerifyResult, type VerifyProblem } from "./registry.js";

interface SelectorUsage {
  selector: string;       // exactly what was passed to querySelector
  line: number;
  column: number;
}

/** Parse card.js and collect every container.querySelector(literal) /
 *  querySelectorAll(literal) call. Returns an empty array on parse
 *  failure (wrapper-parse verifier handles syntax errors). */
function collectSelectorsFromJs(content: string): SelectorUsage[] {
  let ast: ReturnType<typeof parse>;
  try {
    ast = parse(content, { sourceType: "script", allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true, errorRecovery: true });
  } catch {
    return [];
  }
  const usages: SelectorUsage[] = [];

  function walk(node: unknown): void {
    if (!node || typeof node !== "object") return;
    const n = node as { type?: string; [k: string]: unknown };

    if (n.type === "CallExpression") {
      const callee = n.callee as { type?: string; property?: { name?: string } } | undefined;
      if (callee?.type === "MemberExpression") {
        const propName = callee.property?.name;
        if (propName === "querySelector" || propName === "querySelectorAll") {
          const args = (n.arguments as Array<{ type?: string; value?: string; loc?: { start: { line: number; column: number } } }> | undefined) ?? [];
          const first = args[0];
          if (first?.type === "StringLiteral" && typeof first.value === "string") {
            const loc = first.loc?.start;
            usages.push({ selector: first.value, line: loc?.line ?? 0, column: loc?.column ?? 0 });
          }
        }
      }
    }

    for (const key of Object.keys(n)) {
      if (key === "loc" || key === "start" || key === "end") continue;
      const child = n[key];
      if (Array.isArray(child)) for (const c of child) walk(c);
      else if (child && typeof child === "object") walk(child);
    }
  }
  walk(ast.program);
  return usages;
}

/** Parse card.html with cheerio. Returns sets of available ids and classes. */
function collectFromHtml(content: string): { ids: Set<string>; classes: Set<string> } {
  const ids = new Set<string>();
  const classes = new Set<string>();
  try {
    const $ = cheerioLoad(content);
    $("[id]").each((_, el) => {
      const id = $(el).attr("id");
      if (id) ids.add(id);
    });
    $("[class]").each((_, el) => {
      const cls = $(el).attr("class");
      if (cls) for (const c of cls.split(/\s+/)) if (c) classes.add(c);
    });
  } catch {
    // cheerio shouldn't throw on real HTML; if it does, skip the check
  }
  return { ids, classes };
}

/** Check one selector against available ids/classes. Returns null on OK,
 *  or a problem message on miss. Supports simple `#id`, `.class`, and
 *  compound `#id .class` selectors — splits on whitespace and checks
 *  each token. Skips selectors with brackets / attribute predicates /
 *  pseudo-classes (too complex to validate statically). */
function checkSelector(selector: string, ids: Set<string>, classes: Set<string>): string | null {
  // Bail on complex selectors — heuristic to avoid false positives.
  if (/[\[\]:,>+~()*]/.test(selector)) return null;
  const tokens = selector.trim().split(/\s+/);
  for (const tok of tokens) {
    if (tok.startsWith("#")) {
      const id = tok.slice(1);
      if (!ids.has(id)) return `selector '${selector}' references #${id}, but no element in card.html has id="${id}"`;
    } else if (tok.startsWith(".")) {
      const cls = tok.slice(1);
      if (!classes.has(cls)) return `selector '${selector}' references .${cls}, but no element in card.html has class "${cls}"`;
    }
    // Tag-name tokens (e.g. `button`) — can't statically check; skip
  }
  return null;
}

const verifier: FileVerifier = {
  name: "card-js-selector-html-match",
  mode: "gate",
  matches: (filepath) =>
    /\.mica\/card-classes\/[^/]+\/card\.js$/.test(filepath) ||
    /\.mica\/card-classes\/[^/]+\/card\.html$/.test(filepath),
  verify: async (filepath, content): Promise<VerifyResult> => {
    const classDir = dirname(filepath);
    const cardJsPath = join(classDir, "card.js");
    const cardHtmlPath = join(classDir, "card.html");

    // Figure out which file is being written; read the OTHER from disk.
    const isJs = filepath.endsWith("card.js");
    let cardJs: string;
    let cardHtml: string;
    try {
      cardJs = isJs ? content : (existsSync(cardJsPath) ? await readFile(cardJsPath, "utf-8") : "");
      cardHtml = isJs ? (existsSync(cardHtmlPath) ? await readFile(cardHtmlPath, "utf-8") : "") : content;
    } catch {
      return { ok: true }; // missing sibling file — class is mid-creation, defer
    }
    if (!cardJs || !cardHtml) return { ok: true };

    const usages = collectSelectorsFromJs(cardJs);
    const { ids, classes } = collectFromHtml(cardHtml);

    const problems: VerifyProblem[] = [];
    for (const u of usages) {
      const err = checkSelector(u.selector, ids, classes);
      if (err) {
        problems.push({
          file: cardJsPath,
          line: u.line,
          column: u.column,
          problem: err,
          fix_hint:
            `Either add the missing id/class to card.html, OR fix the selector in card.js to match what card.html actually has. ` +
            `Available ids: [${[...ids].join(", ")}]. Available classes: [${[...classes].slice(0, 20).join(", ")}${classes.size > 20 ? ", ..." : ""}].`,
        });
      }
    }

    if (problems.length === 0) return { ok: true };
    return { ok: false, verifier: "card-js-selector-html-match", problems };
  },
};

registerVerifier(verifier);
