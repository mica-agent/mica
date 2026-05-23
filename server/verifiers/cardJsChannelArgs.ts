// Verifier #5 — for every mica.openChannel(fn, {...}) call in card.js,
// validate the second arg against the handler's argsSchema. Catches
// "card mounts but never responds" failures where the agent passes
// args that don't match what the handler expects — e.g. typo'd field
// name, wrong type, missing required field. The argsSchema is the
// contract; the handler's downstream code will null-ref or 500 on
// bad shape.
//
// Handler is determined by the sibling metadata.json's `handler` field.
// If metadata.json is missing or has no handler, we skip the check
// (the card isn't using a registered handler — could be a UMD-only
// card, a static card, or mid-creation).

import { parse } from "@babel/parser";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { registerVerifier, type FileVerifier, type VerifyResult, type VerifyProblem } from "./registry.js";
import { getManifest, validateArgs } from "../handlerManifest.js";

interface ChannelCall {
  args: Record<string, unknown> | null; // null if not a literal object
  line: number;
  column: number;
}

/** Convert a Babel ObjectExpression to a plain JS object (with literal
 *  values). Returns null if any property is not a literal — we can't
 *  statically validate dynamic values. */
function objectExpressionToLiteral(node: unknown): Record<string, unknown> | null {
  if (!node || typeof node !== "object") return null;
  const n = node as { type?: string; properties?: Array<{ type?: string; key?: { name?: string; value?: string }; value?: { type?: string; value?: unknown } }> };
  if (n.type !== "ObjectExpression") return null;
  const out: Record<string, unknown> = {};
  for (const p of n.properties ?? []) {
    if (p.type !== "ObjectProperty") return null;
    const keyName = p.key?.name ?? p.key?.value;
    if (typeof keyName !== "string") return null;
    const v = p.value;
    if (!v) return null;
    if (v.type === "StringLiteral" || v.type === "NumericLiteral" || v.type === "BooleanLiteral") {
      out[keyName] = v.value;
    } else if (v.type === "NullLiteral") {
      out[keyName] = null;
    } else if (v.type === "ObjectExpression") {
      const nested = objectExpressionToLiteral(v);
      if (nested === null) return null;
      out[keyName] = nested;
    } else if (v.type === "ArrayExpression") {
      // Best-effort: empty arrays are common (e.g. dependencies). For now,
      // accept arrays as opaque; schema validation will only check the
      // existence of the field, not its element types.
      out[keyName] = [];
    } else {
      // Dynamic value (identifier, expression, template literal) — can't
      // validate. Mark the whole call as un-checkable.
      return null;
    }
  }
  return out;
}

/** Collect every mica.openChannel(_, {...}) call. */
function collectChannelCalls(content: string): ChannelCall[] {
  let ast: ReturnType<typeof parse>;
  try {
    ast = parse(content, { sourceType: "script", allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true, errorRecovery: true });
  } catch {
    return [];
  }
  const calls: ChannelCall[] = [];

  function walk(node: unknown): void {
    if (!node || typeof node !== "object") return;
    const n = node as { type?: string; [k: string]: unknown };

    if (n.type === "CallExpression") {
      const callee = n.callee as { type?: string; object?: { name?: string }; property?: { name?: string } } | undefined;
      // mica.openChannel(...)
      if (
        callee?.type === "MemberExpression" &&
        callee.object?.name === "mica" &&
        callee.property?.name === "openChannel"
      ) {
        const args = (n.arguments as Array<{ type?: string; loc?: { start?: { line: number; column: number } } }> | undefined) ?? [];
        // openChannel(fn, args) — we care about args[1]
        if (args.length >= 2) {
          const argsNode = args[1] as unknown;
          const literal = objectExpressionToLiteral(argsNode);
          const loc = (argsNode as { loc?: { start?: { line: number; column: number } } }).loc?.start;
          calls.push({ args: literal, line: loc?.line ?? 0, column: loc?.column ?? 0 });
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
  return calls;
}

const verifier: FileVerifier = {
  name: "card-js-channel-args",
  mode: "gate",
  matches: (filepath) => /\.mica\/card-classes\/[^/]+\/card\.js$/.test(filepath),
  verify: async (filepath, content): Promise<VerifyResult> => {
    // Look up the handler from sibling metadata.json
    const classDir = dirname(filepath);
    const metadataPath = join(classDir, "metadata.json");
    if (!existsSync(metadataPath)) return { ok: true }; // mid-creation; defer
    let handler: string | undefined;
    try {
      const meta = JSON.parse(await readFile(metadataPath, "utf-8"));
      handler = typeof meta?.handler === "string" ? meta.handler : undefined;
    } catch {
      return { ok: true };
    }
    if (!handler) return { ok: true }; // card doesn't use a handler — nothing to check

    const manifest = getManifest(handler);
    if (!manifest) return { ok: true }; // unregistered handler — separate validator catches that

    const calls = collectChannelCalls(content);
    const problems: VerifyProblem[] = [];

    for (const call of calls) {
      if (call.args === null) continue; // dynamic args — can't validate statically
      const result = validateArgs(manifest, call.args);
      if (!result.ok) {
        problems.push({
          file: filepath,
          line: call.line,
          column: call.column,
          problem: `mica.openChannel args don't match handler '${handler}' schema: ${result.error}`,
          fix_hint:
            `Look up the handler's argsSchema with \`mica_list_handlers\` (or curl /api/handlers/${handler}). ` +
            `Fix the field name / type / required-field to match. Common cause: misspelled \`systemPrompt\` as \`system_prompt\` or \`prompt\`; ` +
            `wrong \`model\` value; missing required field.`,
        });
      }
    }

    if (problems.length === 0) return { ok: true };
    return { ok: false, verifier: "card-js-channel-args", problems };
  },
};

registerVerifier(verifier);
