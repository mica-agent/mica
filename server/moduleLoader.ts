/**
 * ModuleLoader — Loads card classes as Node.js ES modules.
 *
 * Replaces IsolatePool. Card classes are standard JavaScript modules that
 * export render() and optionally onConnect/onMessage/onDestroy handlers.
 *
 * Card classes get full Node.js access — require/import any package.
 * Blast radius is the Docker container (per-project isolation).
 */

import fs from "fs";
import path from "path";
import { pathToFileURL } from "url";
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
  hasStream: boolean;  // true if module exports onMessage (has server-side stream handler)
}

/** The mica bridge object passed to server-side card functions */
export interface MicaBridge {
  /** Send message to all connected browsers for this card */
  send(data: unknown): void;
  /** Reply to the client that sent the current message (only valid inside onMessage) */
  reply(data: unknown): void;
  /** Read a file from this card's directory */
  read(filename: string): Promise<string>;
  /** Write a file to this card's directory */
  write(filename: string, content: string): Promise<void>;
  /** Run a shell command in the project container */
  exec(command: string, opts?: { cwd?: string; timeout?: number }): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  /** Append to the activity log */
  log(message: string): Promise<void>;
  /** Create a new card instance on the canvas. Extension determines class. Seeds copied automatically. */
  createCard(name: string): Promise<void>;
  /** Subscribe to events (e.g. 'file-changed'). Returns unsubscribe function. */
  on(event: string, cb: (data: unknown) => void): () => void;
  /** Project and canvas identifiers */
  project: string;
  canvas: string;
  filename: string;
}

/** A loaded card module */
interface LoadedModule {
  render?: (content: string, config: Record<string, unknown>) => string | Promise<string>;
  onConnect?: (mica: MicaBridge, args: Record<string, unknown>) => void | Promise<void>;
  onMessage?: (msg: unknown, mica: MicaBridge) => void | Promise<void>;
  onDestroy?: (mica: MicaBridge) => void | Promise<void>;
  dependencies?: CardDependencies;
  exportNames: string[];
  /** Named exports (non-lifecycle) that can be called via mica.call() */
  [key: string]: unknown;
}

// ── Module cache ────────────────────────────────────────────

// Cache loaded modules by class name. Invalidate on file change.
const moduleCache = new Map<string, LoadedModule>();

// ── Card class path resolution ──────────────────────────────

const CARD_CLASSES_DIR = path.resolve("card-classes");

function getClassPath(className: string, projectPath?: string): string | null {
  // Project-level override
  if (projectPath) {
    const projectJs = path.join(projectPath, ".mica", ".card-classes", className, "render.js");
    if (fs.existsSync(projectJs)) return projectJs;
  }
  // Built-in
  const builtinJs = path.join(CARD_CLASSES_DIR, className, "render.js");
  if (fs.existsSync(builtinJs)) return builtinJs;
  return null;
}

// ── Module loading ──────────────────────────────────────────

async function loadModule(className: string, classPath: string): Promise<LoadedModule> {
  // Check cache
  const cached = moduleCache.get(className);
  if (cached) return cached;

  // Dynamic import — use file URL for ES modules
  const fileUrl = pathToFileURL(classPath).href;
  // Cache-bust by appending timestamp so re-imports after invalidation get fresh code
  const mod = await import(`${fileUrl}?t=${Date.now()}`);

  const loaded: LoadedModule = {
    exportNames: [],
  };

  // Extract known exports
  if (typeof mod.default === "function") {
    loaded.render = mod.default;
  } else if (typeof mod.render === "function") {
    loaded.render = mod.render;
  }

  if (typeof mod.onConnect === "function") loaded.onConnect = mod.onConnect;
  if (typeof mod.onMessage === "function") loaded.onMessage = mod.onMessage;
  if (typeof mod.onDestroy === "function") loaded.onDestroy = mod.onDestroy;
  if (mod.dependencies) loaded.dependencies = mod.dependencies;

  // Collect named exports (for backward compat with mica.call())
  for (const [name, value] of Object.entries(mod)) {
    if (name === "default" || name === "dependencies") continue;
    if (name === "onConnect" || name === "onMessage" || name === "onDestroy") continue;
    if (typeof value === "function") {
      loaded.exportNames.push(name);
      loaded[name] = value;
    }
  }

  moduleCache.set(className, loaded);
  return loaded;
}

// ── Public API ──────────────────────────────────────────────

export class ModuleLoader {

  /** Render a card class — returns HTML + metadata */
  async render(
    className: string,
    classPath: string,
    content: string,
    config: Record<string, unknown>,
  ): Promise<RenderResult> {
    const mod = await loadModule(className, classPath);

    if (!mod.render) {
      return {
        html: `<div style="color:#f87171;padding:12px;">Card class "${className}" has no render function.</div>`,
        exports: mod.exportNames,
        dependencies: mod.dependencies,
        hasStream: !!mod.onMessage,
      };
    }

    const html = await mod.render(content, config);

    return {
      html: typeof html === "string" ? html : String(html),
      exports: mod.exportNames,
      dependencies: mod.dependencies,
      hasStream: !!mod.onMessage,
    };
  }

  /** Call a named export on a card class (backward compat) */
  async callExport(
    className: string,
    classPath: string,
    fn: string,
    content: string,
    args: Record<string, unknown>,
    mica: MicaBridge,
  ): Promise<unknown> {
    const mod = await loadModule(className, classPath);
    const handler = mod[fn];
    if (typeof handler !== "function") {
      throw new Error(`Card class "${className}" has no export "${fn}"`);
    }
    return handler(content, args, mica);
  }

  /** Get the stream handlers for a card class (if any) */
  async getStreamHandlers(
    className: string,
    classPath: string,
  ): Promise<{
    onConnect?: (mica: MicaBridge, args: Record<string, unknown>) => void | Promise<void>;
    onMessage?: (msg: unknown, mica: MicaBridge) => void | Promise<void>;
    onDestroy?: (mica: MicaBridge) => void | Promise<void>;
  } | null> {
    const mod = await loadModule(className, classPath);
    if (!mod.onMessage && !mod.onConnect) return null;
    return {
      onConnect: mod.onConnect,
      onMessage: mod.onMessage,
      onDestroy: mod.onDestroy,
    };
  }

  /** Invalidate a cached module (on file change) */
  invalidateClass(className: string): void {
    moduleCache.delete(className);
    console.log(`[module-loader] Invalidated class "${className}"`);
  }

  /** Invalidate all cached modules */
  invalidateAll(): void {
    moduleCache.clear();
  }
}
