// Verifier #1 — flag top-level functions in card.js that are defined but
// never invoked from any call path. Catches the Galaxy / orbit42
// orchestration failure shape: agent writes `createScene()`,
// `loadTextures()`, `tryStart()` as plausible-looking helpers but never
// wires them into the load-completion callback. Card stays in its
// initial state forever; user sees nothing.
//
// Approach:
//   1. Parse card.js with @babel/parser.
//   2. Collect every top-level definition: `function foo() {...}`,
//      `const foo = (...) => {...}`, `const foo = function() {...}`.
//   3. Walk every CallExpression in the tree; collect callee identifiers.
//   4. ALSO collect identifiers passed as callback arguments to known
//      "consumer" patterns (addEventListener, mica.on*, library methods
//      like textureLoader.load(url, cb, undef, cb)). These count as
//      "called even if no direct call site appears."
//   5. Report any defined-name that's not in either set.
//
// Exemption: an opt-out comment `// mica-skip-verifier: uncalled-functions`
// anywhere in the file disables this check (escape hatch for legitimate
// false positives — e.g. functions held in a registry for later dispatch).

import { parse } from "@babel/parser";
import { registerVerifier, type FileVerifier, type VerifyResult, type VerifyProblem } from "./index.js";

const SKIP_COMMENT = /\/\/\s*mica-skip-verifier:\s*uncalled-functions/;

interface Definition {
  name: string;
  line: number;
  column: number;
}

const verifier: FileVerifier = {
  name: "card-js-uncalled-functions",
  mode: "gate",
  matches: (filepath) => /\.mica\/card-classes\/[^/]+\/card\.js$/.test(filepath),
  verify: async (filepath, content): Promise<VerifyResult> => {
    if (SKIP_COMMENT.test(content)) return { ok: true };

    let ast: ReturnType<typeof parse>;
    try {
      ast = parse(content, {
        sourceType: "script",   // card.js is a function body, not a module
        allowReturnOutsideFunction: true,
        allowAwaitOutsideFunction: true,
        errorRecovery: true,
        plugins: [],
      });
    } catch {
      // Parse failure is caught by the wrapper-parse verifier; don't
      // double-report. Skip this check when the AST can't be built.
      return { ok: true };
    }

    const definitions: Definition[] = [];
    const calledNames = new Set<string>();
    const callbackNames = new Set<string>();

    // Patterns where an identifier passed as an arg counts as "called."
    // The agent might write `function onLoad() {...}` then pass `onLoad`
    // to a loader's callback slot. The function never appears in
    // `onLoad()` form but it IS wired.
    const CALLBACK_SINKS = new Set([
      // DOM event listeners
      "addEventListener",
      // Mica lifecycle hooks
      "onCapture", "onDestroy", "onData", "on",
      // Async / iteration patterns
      "then", "catch", "finally",
      // requestAnimationFrame / timers
      "requestAnimationFrame", "setTimeout", "setInterval",
      // Array iteration
      "forEach", "map", "filter", "reduce", "find", "some", "every",
      // Three.js / WebGL loaders — any `.load(url, onSuccess, onProgress, onError)` shape
      "load",
      // Generic event hooks the shim adds
      "ResizeObserver", "MutationObserver", "IntersectionObserver",
    ]);

    function walk(node: unknown, depth = 0): void {
      if (!node || typeof node !== "object") return;
      const n = node as { type?: string; [k: string]: unknown };

      // Top-level definitions only — depth tracks Program → body[*] → ...
      // depth 0 = Program, depth 1 = its body items, deeper = nested.
      const isTopLevel = depth <= 2;

      if (isTopLevel && n.type === "FunctionDeclaration") {
        const id = n.id as { name?: string; loc?: { start?: { line: number; column: number } } } | undefined;
        if (id?.name) {
          const start = id.loc?.start;
          definitions.push({ name: id.name, line: start?.line ?? 0, column: start?.column ?? 0 });
        }
      }

      if (isTopLevel && n.type === "VariableDeclaration") {
        const decls = (n.declarations as Array<{
          id?: { name?: string; loc?: { start?: { line: number; column: number } } };
          init?: { type?: string };
        }> | undefined) ?? [];
        for (const d of decls) {
          if (d.id?.name && d.init && (d.init.type === "ArrowFunctionExpression" || d.init.type === "FunctionExpression")) {
            const start = d.id.loc?.start;
            definitions.push({ name: d.id.name, line: start?.line ?? 0, column: start?.column ?? 0 });
          }
        }
      }

      // Track every CallExpression's callee identifier — that's the "called" set.
      // Also detect callback-sink patterns: arg-position function identifiers.
      if (n.type === "CallExpression") {
        const callee = n.callee as { type?: string; name?: string; property?: { name?: string } } | undefined;
        if (callee?.type === "Identifier" && callee.name) {
          calledNames.add(callee.name);
        }
        // x.y(...) — if y is a callback sink, treat identifier args as called
        if (callee?.type === "MemberExpression") {
          const propName = (callee as unknown as { property?: { name?: string } }).property?.name;
          if (propName) {
            // Method calls: track the method name (in case it matches a defined fn we exported)
            calledNames.add(propName);
            if (CALLBACK_SINKS.has(propName)) {
              const args = (n.arguments as Array<{ type?: string; name?: string }> | undefined) ?? [];
              for (const arg of args) {
                if (arg?.type === "Identifier" && arg.name) callbackNames.add(arg.name);
              }
            }
          }
        }
        // foo(...) — if foo is a callback sink (rare; mostly things like
        // setTimeout used at top level), arg identifiers count as called
        if (callee?.type === "Identifier" && callee.name && CALLBACK_SINKS.has(callee.name)) {
          const args = (n.arguments as Array<{ type?: string; name?: string }> | undefined) ?? [];
          for (const arg of args) {
            if (arg?.type === "Identifier" && arg.name) callbackNames.add(arg.name);
          }
        }
      }

      // Recurse into all sub-nodes
      for (const key of Object.keys(n)) {
        if (key === "loc" || key === "start" || key === "end" || key === "leadingComments" || key === "trailingComments") continue;
        const child = n[key];
        if (Array.isArray(child)) {
          for (const c of child) walk(c, depth + 1);
        } else if (child && typeof child === "object") {
          walk(child, depth + 1);
        }
      }
    }

    walk(ast.program);

    // Find definitions that are neither called nor passed as callbacks
    const problems: VerifyProblem[] = [];
    for (const def of definitions) {
      if (calledNames.has(def.name)) continue;
      if (callbackNames.has(def.name)) continue;
      problems.push({
        file: filepath,
        line: def.line,
        column: def.column,
        problem: `Function \`${def.name}\` is defined at line ${def.line} but never called or passed as a callback anywhere in card.js`,
        fix_hint:
          `Wire \`${def.name}\` into a call path. Common cause: async-load completion that was never connected — e.g. ` +
          `define inside the loader callback or invoke from LoadingManager.onLoad / texture-load onSuccess. ` +
          `If \`${def.name}\` is genuinely intentional (e.g. an exported handler held in a registry), add the comment ` +
          `\`// mica-skip-verifier: uncalled-functions\` anywhere in card.js to disable this check.`,
      });
    }

    if (problems.length === 0) return { ok: true };
    return { ok: false, verifier: "card-js-uncalled-functions", problems };
  },
};

registerVerifier(verifier);
