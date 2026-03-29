/**
 * IsolatePool — Manages V8 isolates for running JavaScript card classes.
 *
 * Each card class (render.js) runs inside an isolated-vm V8 isolate with
 * zero OS access. The only bridge to the outside world is the __mica_rpc
 * function injected by the host, which the Mica JS SDK uses internally.
 *
 * This replaces the Python worker pool for card class execution.
 */

import ivm from "isolated-vm";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── Types ──────────────────────────────────────────────────

export interface CardDependencies {
  scripts?: string[];
  styles?: string[];
}

export interface RenderResult {
  html: string;
  exports: string[];
  dependencies?: CardDependencies;
}

export interface RpcHandler {
  (
    method: string,
    args: Record<string, unknown>,
    requestContext: { project: string; canvas: string; filename: string }
  ): Promise<unknown>;
}

interface LoadedClass {
  isolate: ivm.Isolate;
  context: ivm.Context;
  exportNames: string[];
  dependencies?: CardDependencies;
}

// ── SDK & library source cache ─────────────────────────────

const SDK_PATH = path.join(__dirname, "mica_sdk", "mica.js");
const libCache = new Map<string, string>();

function getCachedSource(key: string, filePath: string, transform?: (src: string) => string): string {
  let src = libCache.get(key);
  if (!src) {
    src = fs.readFileSync(filePath, "utf-8");
    if (transform) src = transform(src);
    libCache.set(key, src);
  }
  return src;
}

function getSDKSource(): string {
  return getCachedSource("mica-sdk", SDK_PATH, (raw) =>
    raw.replace(/\/\*\s*global __mica_rpc\s*\*\//, "")
  );
}

/** Get the UMD source for the `marked` markdown library. */
function getMarkedSource(): string {
  const markedPath = path.resolve("node_modules/marked/lib/marked.umd.js");
  return getCachedSource("marked", markedPath);
}

// ── ESM → Script transform ─────────────────────────────────

/**
 * Transform ESM card class source into a script that populates
 * globalThis.__card with { render, exportName1, exportName2, ... }.
 *
 * Handles:
 *   export default function render(content, config) { ... }
 *   export default async function render(content, config) { ... }
 *   export function toggle(content, args, mica) { ... }
 *   export async function toggle(content, args, mica) { ... }
 *   export default expr
 *   import ... from '...'  (stripped — libraries injected by host)
 */
function transformCardSource(source: string): { script: string; exportNames: string[] } {
  const exportNames: string[] = [];
  let defaultName: string | null = null;

  // Strip import statements (libraries are injected by the host)
  let transformed = source.replace(/^import\s+.*?from\s+['"].*?['"];?\s*$/gm, "");
  transformed = transformed.replace(/^import\s+['"].*?['"];?\s*$/gm, "");

  // Order matters: handle `export default` before `export` to avoid partial matches.

  // 1. export default async function name(...)
  transformed = transformed.replace(
    /export\s+default\s+async\s+function\s+(\w+)/g,
    (_match, name) => { defaultName = name; return `async function ${name}`; }
  );

  // 2. export default function name(...)
  transformed = transformed.replace(
    /export\s+default\s+function\s+(\w+)/g,
    (_match, name) => { defaultName = name; return `function ${name}`; }
  );

  // 3. export default function(...)  (anonymous)
  if (!defaultName) {
    transformed = transformed.replace(
      /export\s+default\s+function\s*\(/g,
      () => { defaultName = "__defaultExport"; return `function __defaultExport(`; }
    );
  }

  // 4. export default expr
  if (!defaultName) {
    transformed = transformed.replace(
      /export\s+default\s+/g,
      () => { defaultName = "__defaultExport"; return `const __defaultExport = `; }
    );
  }

  // 5. export async function name(...)
  transformed = transformed.replace(
    /export\s+async\s+function\s+(\w+)/g,
    (_match, name) => { exportNames.push(name); return `async function ${name}`; }
  );

  // 6. export function name(...)
  transformed = transformed.replace(
    /export\s+function\s+(\w+)/g,
    (_match, name) => { exportNames.push(name); return `function ${name}`; }
  );

  // 7. export const dependencies = { ... }
  let hasDependencies = false;
  transformed = transformed.replace(
    /export\s+const\s+dependencies\s*=/g,
    () => { hasDependencies = true; return `const dependencies =`; }
  );

  // Build the IIFE that collects exports into globalThis.__card
  const assignments = [];
  if (defaultName) {
    assignments.push(`  __card.render = ${defaultName};`);
  }
  for (const name of exportNames) {
    assignments.push(`  __card['${name}'] = ${name};`);
  }
  if (hasDependencies) {
    assignments.push(`  __card.dependencies = dependencies;`);
  }

  const script = `(function() {
${transformed}
  const __card = {};
${assignments.join("\n")}
  globalThis.__card = __card;
})();`;

  return { script, exportNames };
}

// ── IsolatePool ────────────────────────────────────────────

export class IsolatePool {
  private classes: Map<string, LoadedClass> = new Map();
  private rpcHandler: RpcHandler | null = null;
  private label: string;

  constructor(options: { label?: string } = {}) {
    this.label = options.label || "global";
  }

  setRpcHandler(handler: RpcHandler) {
    this.rpcHandler = handler;
  }

  /**
   * Load a card class from its render.js file into a V8 isolate.
   * Cached by class name; call invalidateClass() to reload.
   */
  private async loadClass(className: string, classPath: string): Promise<LoadedClass> {
    const cached = this.classes.get(className);
    if (cached) return cached;

    const isolate = new ivm.Isolate({ memoryLimit: 32 });
    const context = await isolate.createContext();
    const jail = context.global;

    // Set up globalThis reference so card code can use it
    await jail.set("global", jail.derefInto());

    // Inject __mica_rpc placeholder (replaced per-request)
    await jail.set("__mica_rpc", new ivm.Reference(() => null));

    // Load SDK — creates the `mica` object in the isolate's global scope
    await context.eval(getSDKSource(), { filename: "mica.js" });

    // Load and transform the card class
    const classSource = fs.readFileSync(classPath, "utf-8");

    // Inject libraries that the card class references.
    if (/\bmarked\b/.test(classSource)) {
      await context.eval(getMarkedSource(), { filename: "marked.umd.js" });
    }

    // Inject sibling data files (e.g., agent/providers.json)
    const classDir = path.dirname(classPath);
    const providersPath = path.join(classDir, "providers.json");
    if (fs.existsSync(providersPath)) {
      const data = fs.readFileSync(providersPath, "utf-8");
      await context.eval(`globalThis.__providers = ${data};`, { filename: "providers.json" });
    }
    const { script, exportNames } = transformCardSource(classSource);

    try {
      await context.eval(script, { filename: path.basename(classPath) });
    } catch (err) {
      isolate.dispose();
      throw new Error(`Failed to load card class "${className}": ${(err as Error).message}`);
    }

    // Verify render function exists
    const hasRender = await context.eval(
      `typeof globalThis.__card !== 'undefined' && typeof globalThis.__card.render === 'function'`,
      { copy: true }
    );
    if (!hasRender) {
      isolate.dispose();
      throw new Error(`Card class "${className}" has no render function (export default function render(content, config) {...})`);
    }

    // Extract dependencies (optional)
    let dependencies: CardDependencies | undefined;
    const depsJson = await context.eval(
      `globalThis.__card.dependencies ? JSON.stringify(globalThis.__card.dependencies) : null`,
      { copy: true }
    ) as string | null;
    if (depsJson) {
      dependencies = JSON.parse(depsJson);
    }

    const loaded: LoadedClass = { isolate, context, exportNames, dependencies };
    this.classes.set(className, loaded);

    const depsInfo = dependencies ? ` deps: ${(dependencies.scripts?.length || 0)}js+${(dependencies.styles?.length || 0)}css` : "";
    console.log(`[isolate-pool:${this.label}] Loaded class "${className}" with exports: [${exportNames.join(", ")}]${depsInfo}`);
    return loaded;
  }

  /**
   * Inject the __mica_rpc callback for a given request context.
   * This is an async Callback — the isolate can `await` calls to it.
   * For render calls (no RPC needed), injects a no-op.
   * For export calls (RPC needed), injects the real handler.
   */
  private async injectRpc(
    loaded: LoadedClass,
    requestContext: { project: string; canvas: string; filename: string },
    active: boolean
  ): Promise<void> {
    if (!active || !this.rpcHandler) {
      await loaded.context.global.set(
        "__mica_rpc",
        new ivm.Callback(() => null),
      );
      return;
    }

    const handler = this.rpcHandler;
    const ctx = requestContext;

    // Async RPC bridge using deferred pattern.
    // Each RPC call gets a unique ID. The isolate creates a native Promise
    // and stores its resolve/reject in a map. The host calls __mica_rpc_resolve
    // or __mica_rpc_reject when the async operation completes.
    // This avoids applySyncPromise (deadlocks) and Promise cloning issues.

    let rpcIdCounter = 0;

    // Host-side: receives (method, argsJson, rpcId), calls handler, then resolves
    const dispatchRef = new ivm.Reference(function (method: string, argsJson: string, rpcId: number) {
      const args = JSON.parse(argsJson);
      handler(method, args, ctx).then(
        (result) => {
          const val = result === undefined ? null : result;
          loaded.context.evalSync(
            `globalThis.__mica_rpc_settle(${rpcId}, ${JSON.stringify(val)}, null)`,
          );
        },
        (err) => {
          loaded.context.evalSync(
            `globalThis.__mica_rpc_settle(${rpcId}, null, ${JSON.stringify(String((err as Error).message || err))})`,
          );
        }
      );
    });
    await loaded.context.global.set("__mica_rpc_dispatch", dispatchRef);

    // Isolate-side: __mica_rpc returns a native Promise, __mica_rpc_settle resolves it
    await loaded.context.eval(`
      globalThis.__mica_rpc_pending = new Map();
      globalThis.__mica_rpc_id = 0;

      globalThis.__mica_rpc = function(method, args) {
        return new Promise((resolve, reject) => {
          const id = ++globalThis.__mica_rpc_id;
          globalThis.__mica_rpc_pending.set(id, { resolve, reject });
          __mica_rpc_dispatch.applyIgnored(undefined, [method, JSON.stringify(args), id]);
        });
      };

      globalThis.__mica_rpc_settle = function(id, result, error) {
        const pending = globalThis.__mica_rpc_pending.get(id);
        if (!pending) return;
        globalThis.__mica_rpc_pending.delete(id);
        if (error) pending.reject(new Error(error));
        else pending.resolve(result);
      };
    `);
  }

  /**
   * Render a card. Returns HTML string and list of export names.
   */
  async render(
    className: string,
    classPath: string,
    content: string,
    config: Record<string, unknown>,
    requestContext: { project: string; canvas: string; filename: string }
  ): Promise<RenderResult> {
    const loaded = await this.loadClass(className, classPath);
    // RPC is disabled during renders — applySyncPromise deadlocks the event loop.
    // Cards that need data during render should receive it via config.
    await this.injectRpc(loaded, requestContext, false);

    const configJson = JSON.stringify(config);
    const contentEscaped = JSON.stringify(content);

    const html = await loaded.context.eval(
      `globalThis.__card.render(${contentEscaped}, ${configJson})`,
      { copy: true, timeout: 30000 }
    ) as string;

    return { html: html || "", exports: loaded.exportNames, dependencies: loaded.dependencies };
  }

  /**
   * Call an exported function on a card class.
   * Export functions can be async and use `await mica.write()` etc.
   */
  async callExport(
    className: string,
    classPath: string,
    fn: string,
    content: string,
    args: Record<string, unknown>,
    requestContext: { project: string; canvas: string; filename: string }
  ): Promise<unknown> {
    const loaded = await this.loadClass(className, classPath);

    if (!loaded.exportNames.includes(fn)) {
      throw new Error(`Function "${fn}" is not exported by class "${className}"`);
    }

    // Inject active RPC handler for this request
    await this.injectRpc(loaded, requestContext, true);

    const contentEscaped = JSON.stringify(content);
    const argsJson = JSON.stringify(args);

    // Wrap in async IIFE to support both sync and async export functions.
    // The `{ promise: true }` option tells isolated-vm to await the result.
    const result = await loaded.context.eval(
      `Promise.resolve(globalThis.__card['${fn}'](${contentEscaped}, ${argsJson}, mica))`,
      { copy: true, timeout: 300000, promise: true }
    );

    return result;
  }

  /**
   * Invalidate a cached card class (e.g., when render.js changes).
   */
  invalidateClass(className: string) {
    const loaded = this.classes.get(className);
    if (loaded) {
      try { loaded.isolate.dispose(); } catch { /* already disposed */ }
      this.classes.delete(className);
      console.log(`[isolate-pool:${this.label}] Invalidated class "${className}"`);
    }
  }

  /**
   * Dispose all isolates (server shutdown).
   */
  dispose() {
    for (const [, loaded] of this.classes) {
      try { loaded.isolate.dispose(); } catch { /* ok */ }
    }
    this.classes.clear();
    console.log(`[isolate-pool:${this.label}] Disposed all isolates`);
  }
}
