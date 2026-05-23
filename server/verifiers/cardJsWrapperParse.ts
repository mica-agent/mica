// Verifier #3 — assemble the wrapped form (CARD_SHIM + card.js + closing)
// and parse it. Catches cases where card.js parses cleanly alone but
// fails inside the runtime's IIFE wrapping. Observed failure: trailing
// `//` line comment with no newline eats the closing `})` (hotdog-
// opencode3 today). Defense-in-depth on top of the `\n` fix shipped in
// CardRuntime.tsx.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { registerVerifier, type FileVerifier, type VerifyResult } from "./registry.js";

// CARD_SHIM is extracted from CardRuntime.tsx at first use and cached.
// If CardRuntime is edited, server restart re-extracts.
let CARD_SHIM: string | null = null;

async function getCardShim(): Promise<string> {
  if (CARD_SHIM !== null) return CARD_SHIM;
  try {
    const src = await readFile(
      join(process.cwd(), "src", "whiteboard", "CardRuntime.tsx"),
      "utf-8",
    );
    const m = src.match(/const CARD_SHIM = `([\s\S]*?)\n`;/);
    CARD_SHIM = m ? m[1] : "";
  } catch {
    // CardRuntime.tsx unreadable (test env, etc.) — empty shim degrades
    // the check to "does the raw card.js parse as a function body."
    // Still catches gross errors, just not wrap-interaction ones.
    CARD_SHIM = "";
  }
  return CARD_SHIM;
}

const verifier: FileVerifier = {
  name: "card-js-wrapper-parse",
  mode: "gate",
  matches: (filepath) => /\.mica\/card-classes\/[^/]+\/card\.js$/.test(filepath),
  verify: async (filepath, content): Promise<VerifyResult> => {
    const shim = await getCardShim();
    // Assemble the wrap exactly as CardRuntime.tsx does. Trailing \n is
    // important — matches today's commit fixing the line-comment trap.
    const wrapped = `(async function(mica,_c){${shim}${content}\n})(undefined, undefined)`;
    try {
      // new Function parses but doesn't execute. We pass the assembled
      // string as the body of an outer no-op fn so the IIFE inside is
      // an expression statement.
      new Function(wrapped);
      return { ok: true };
    } catch (err) {
      const msg = (err as Error).message || String(err);
      return {
        ok: false,
        verifier: "card-js-wrapper-parse",
        problems: [{
          file: filepath,
          problem: `card.js does not parse inside the runtime's async IIFE wrapper: ${msg}`,
          fix_hint:
            "Common causes: top-level `import` / `export` (cards run as classic-script function body, not ES modules); " +
            "trailing `//` line comment without a newline before the wrapper close; unbalanced braces / parens / strings; " +
            "redeclared CARD_SHIM globals (`mica`, `container`, `setInterval`, etc.). Re-read card.js, fix the syntax, retry.",
        }],
      };
    }
  },
};

registerVerifier(verifier);
