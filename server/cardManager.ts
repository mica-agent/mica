/**
 * CardManager — Orchestrates card rendering with caching.
 *
 * Resolves card classes from file metadata, manages render cache,
 * and delegates rendering/export calls to the WorkerPool.
 */

import path from "path";
import fs from "fs";
import { WorkerPool, type RenderResult } from "./workerPool.js";
import { IsolatePool, type RenderResult as IsolateRenderResult, type CardDependencies } from "./isolatePool.js";
import type { SandboxManager } from "./projectSandbox.js";
import {
  readCanvasFile,
  writeCanvasFile,
  listFiles,
} from "./canvasFiles.js";
import { getProjectPath } from "./projectConnection.js";

// ── Types ──────────────────────────────────────────────────

export interface CardMeta {
  cardClass: string;
  title: string;
  badge: string;
  isSystem: boolean;
  network: boolean;
  config: Record<string, unknown>;
}

interface CacheEntry {
  html: string;
  exports: string[];
  dependencies?: CardDependencies;
  meta: CardMeta;
  mtime: number;
}

interface ClassManifestEntry {
  extension?: string;
  badge: string;
  system?: boolean;
  defaultTitle?: string;
  network?: boolean;
}

// ── Constants ──────────────────────────────────────────────

const CARD_CLASSES_DIR = path.resolve("card-classes");

// ── Frontmatter parsing ────────────────────────────────────

interface ParsedFile {
  metadata: Record<string, unknown>;
  content: string;
}

function parseFrontmatter(raw: string): ParsedFile {
  if (!raw.startsWith("---\n") && !raw.startsWith("---\r\n")) {
    return { metadata: {}, content: raw };
  }

  const endMarker = raw.indexOf("\n---", 4);
  if (endMarker === -1) {
    return { metadata: {}, content: raw };
  }

  const yamlBlock = raw.slice(4, endMarker).trim();
  const content = raw.slice(endMarker + 4).replace(/^\r?\n/, "");

  // Simple YAML parser (handles key: value pairs)
  const metadata: Record<string, unknown> = {};
  for (const line of yamlBlock.split("\n")) {
    const match = line.match(/^(\w[\w-]*)\s*:\s*(.+)$/);
    if (match) {
      const [, key, value] = match;
      // Try to parse as JSON for nested values, otherwise keep as string
      try {
        metadata[key] = JSON.parse(value);
      } catch {
        metadata[key] = value.trim();
      }
    }
  }

  return { metadata, content };
}

// ── CardManager ────────────────────────────────────────────

export class CardManager {
  private cache: Map<string, CacheEntry> = new Map();
  private pool: WorkerPool;
  private isolatePool: IsolatePool;
  private sandboxManager: SandboxManager | null = null;
  private manifest: Record<string, ClassManifestEntry> = {};
  private extensionMap: Map<string, string> = new Map(); // ".todo" → "todo"

  constructor(pool: WorkerPool, sandboxManager?: SandboxManager) {
    this.pool = pool;
    this.isolatePool = new IsolatePool();
    this.sandboxManager = sandboxManager ?? null;
    this.loadManifest();
  }

  /** Set the RPC handler for the V8 isolate pool. */
  setIsolateRpcHandler(handler: import("./isolatePool.js").RpcHandler) {
    this.isolatePool.setRpcHandler(handler);
  }

  /** Get all valid card extensions (for file validation and watching). */
  getValidExtensions(): string[] {
    return [...this.extensionMap.keys(), ".json"];
  }

  /** Check if a card class has network permission (manifest `network: true`). */
  hasNetworkPermission(cardClass: string): boolean {
    return this.manifest[cardClass]?.network === true;
  }

  /** Get the worker pool for a project. Uses sandbox if available, else global pool. */
  private async getPool(project: string): Promise<WorkerPool> {
    if (this.sandboxManager) {
      try {
        return await this.sandboxManager.getPool(project);
      } catch (err) {
        console.warn(`[card-manager] Sandbox unavailable for "${project}", falling back to global pool:`, (err as Error).message);
      }
    }
    return this.pool;
  }

  private loadManifest(projectPath?: string) {
    // Load built-in manifest
    const manifestPath = path.join(CARD_CLASSES_DIR, "_manifest.json");
    try {
      const raw = fs.readFileSync(manifestPath, "utf-8");
      this.manifest = JSON.parse(raw);
    } catch {
      console.warn("[card-manager] No _manifest.json found, using defaults");
      this.manifest = {};
    }

    // Merge project-level manifest on top (if it exists)
    // Deep-merge per entry so project overrides don't drop built-in fields like `extension`
    if (projectPath) {
      const projectManifestPath = path.join(projectPath, ".mica", ".card-classes", "_manifest.json");
      try {
        const raw = fs.readFileSync(projectManifestPath, "utf-8");
        const projectManifest = JSON.parse(raw) as Record<string, ClassManifestEntry>;
        for (const [className, projectEntry] of Object.entries(projectManifest)) {
          const builtIn = this.manifest[className];
          if (builtIn) {
            // Merge: project fields override, but keep built-in fields the project didn't specify
            this.manifest[className] = { ...builtIn, ...projectEntry };
          } else {
            this.manifest[className] = projectEntry;
          }
        }
      } catch {
        // No project manifest — that's fine
      }
    }

    // Build extension → class lookup from manifest
    this.extensionMap.clear();
    for (const [className, entry] of Object.entries(this.manifest)) {
      if (entry.extension) {
        this.extensionMap.set(entry.extension, className);
      }
    }
  }

  // ── Card class resolution ──────────────────────────────

  resolveCardClass(filename: string, content: string): { cardClass: string; strippedContent: string; metadata: Record<string, unknown> } {
    // 1. Check frontmatter
    const { metadata, content: strippedContent } = parseFrontmatter(content);
    if (metadata.card && typeof metadata.card === "string") {
      return { cardClass: metadata.card, strippedContent, metadata };
    }

    // 2. Extension → class via manifest
    const ext = path.extname(filename);
    const cardClass = this.extensionMap.get(ext) || "text";
    return { cardClass, strippedContent: content, metadata };
  }

  resolveCardMeta(filename: string, content: string): CardMeta {
    const { cardClass, metadata } = this.resolveCardClass(filename, content);
    const manifestEntry = this.manifest[cardClass];

    // Determine title
    let title = (metadata.title as string) || manifestEntry?.defaultTitle || "";
    if (!title) {
      // Strip any registered extension for title humanization
      const ext = path.extname(filename);
      title = (ext ? filename.slice(0, -ext.length) : filename)
        .replace(/[-_]/g, " ")
        .replace(/\b\w/g, (c) => c.toUpperCase());
    }

    // System file check
    const isSystem =
      manifestEntry?.system ||
      filename.startsWith("_") ||
      false;

    return {
      cardClass,
      title,
      badge: manifestEntry?.badge || cardClass.toUpperCase(),
      isSystem,
      network: manifestEntry?.network === true,
      config: metadata as Record<string, unknown>,
    };
  }

  // ── Rendering ──────────────────────────────────────────

  /**
   * Resolve the class file path for a card class.
   * Project-level classes take priority over built-in classes.
   */
  private getClassPath(className: string, projectPath?: string): string {
    if (projectPath) {
      const projectJs = path.join(projectPath, ".mica", ".card-classes", className, "render.js");
      if (fs.existsSync(projectJs)) return projectJs;
    }
    return path.join(CARD_CLASSES_DIR, className, "render.js");
  }

  private cacheKey(project: string, canvas: string, filename: string): string {
    return `${project}/${canvas}/${filename}`;
  }

  async renderCard(
    project: string,
    canvas: string,
    filename: string,
    content: string,
    config?: Record<string, unknown>
  ): Promise<{ html: string; exports: string[]; dependencies?: CardDependencies; meta: CardMeta }> {
    const key = this.cacheKey(project, canvas, filename);
    let projectPath: string | undefined;
    try { projectPath = await getProjectPath(project); } catch { /* fallback */ }
    this.loadManifest(projectPath);
    const { cardClass, strippedContent, metadata } = this.resolveCardClass(filename, content);
    const meta = this.resolveCardMeta(filename, content);

    // Check class file exists (project-level first, then built-in)
    const classPath = this.getClassPath(cardClass, projectPath);
    if (!fs.existsSync(classPath)) {
      // Fallback: render as escaped HTML
      const html = `<pre style="color: #f87171;">Card class "${cardClass}" not found.\nFile: ${filename}</pre>`;
      return { html, exports: [], meta };
    }

    // Pre-load data into config for cards that need it during render.
    // RPC is not available during render (applySyncPromise would deadlock),
    // so cards receive data via config instead of calling mica.readFile().
    const extraConfig: Record<string, unknown> = {};
    if (cardClass === "chat") {
      try {
        const historyFile = await readCanvasFile(project, canvas, ".chat-history.json");
        extraConfig.__chatHistory = historyFile.content;
      } catch { /* no history yet */ }
    }

    const maxRetries = 3;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const renderConfig = { ...metadata, ...(config || {}), ...extraConfig, project, canvas, filename };
        const requestContext = { project, canvas, filename };
        const result = await this.isolatePool.render(
          cardClass, classPath, strippedContent, renderConfig, requestContext
        );

        // Cache the result
        this.cache.set(key, {
          html: result.html,
          exports: result.exports,
          dependencies: result.dependencies,
          meta,
          mtime: Date.now(),
        });

        return { html: result.html, exports: result.exports, dependencies: result.dependencies, meta };
      } catch (err) {
        const msg = (err as Error).message;
        const isTimeout = msg.includes("timed out") || msg.includes("pool exhausted");
        if (isTimeout && attempt < maxRetries - 1) {
          console.warn(`[card-manager] Render retry ${attempt + 1}/${maxRetries} for ${project}/${canvas}/${filename}: ${msg}`);
          await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
          continue;
        }
        const errorHtml = `<pre style="color: #f87171; white-space: pre-wrap;">Render error (${cardClass}):\n${msg}</pre>`;
        return { html: errorHtml, exports: [], meta };
      }
    }
    // Should not reach here
    return { html: "", exports: [], meta };
  }

  async callExport(
    project: string,
    canvas: string,
    filename: string,
    fn: string,
    args: Record<string, unknown>
  ): Promise<any> {
    // Read the current file content
    const file = await readCanvasFile(project, canvas, filename);
    const { cardClass, strippedContent, metadata } = this.resolveCardClass(filename, file.content);
    let projectPath: string | undefined;
    try { projectPath = await getProjectPath(project); } catch { /* fallback */ }
    const classPath = this.getClassPath(cardClass, projectPath);

    if (!fs.existsSync(classPath)) {
      throw new Error(`Card class "${cardClass}" not found`);
    }

    return this.isolatePool.callExport(
      cardClass, classPath, fn, strippedContent, args,
      { project, canvas, filename }
    );
  }

  /** Fire-and-forget: call an export but don't return the result to the caller. */
  async callSend(
    project: string,
    canvas: string,
    filename: string,
    fn: string,
    args: Record<string, unknown>
  ): Promise<void> {
    const file = await readCanvasFile(project, canvas, filename);
    const { cardClass, strippedContent } = this.resolveCardClass(filename, file.content);
    let projectPath: string | undefined;
    try { projectPath = await getProjectPath(project); } catch { /* fallback */ }
    const classPath = this.getClassPath(cardClass, projectPath);

    if (!fs.existsSync(classPath)) {
      console.error(`[card-manager] callSend: card class "${cardClass}" not found`);
      return;
    }

    const pool = await this.getPool(project);
    pool.callExport(cardClass, classPath, fn, strippedContent, args, { project, canvas, filename })
      .catch((err) => console.error(`[card-manager] callSend error:`, (err as Error).message));
  }

  /**
   * Open a bidirectional channel to a @mica.channel handler.
   * Returns the channel ID (same as the caller-provided channelId).
   */
  async openChannel(
    channelId: string,
    project: string,
    canvas: string,
    filename: string,
    fn: string,
    args: Record<string, unknown>,
    onData: (data: unknown) => void,
    onClose: () => void
  ): Promise<string> {
    const file = await readCanvasFile(project, canvas, filename);
    const { cardClass, strippedContent } = this.resolveCardClass(filename, file.content);
    let projectPath: string | undefined;
    try { projectPath = await getProjectPath(project); } catch { /* fallback */ }
    const classPath = this.getClassPath(cardClass, projectPath);

    if (!fs.existsSync(classPath)) {
      throw new Error(`Card class "${cardClass}" not found`);
    }

    const pool = await this.getPool(project);
    return pool.openChannel(
      channelId,
      cardClass,
      classPath,
      fn,
      strippedContent,
      args,
      { project, canvas, filename },
      onData,
      onClose
    );
  }

  /**
   * Render all cards for a project canvas. Returns an array of rendered cards.
   */
  async renderAllCards(project: string, canvas: string): Promise<
    Array<{
      filename: string;
      html: string;
      exports: string[];
      meta: CardMeta;
    }>
  > {
    const files = await listFiles(project, canvas);
    const results = [];

    for (const file of files) {
      // Skip chat history files
      if (file.name === ".chat-history.json") continue;

      const rendered = await this.renderCard(project, canvas, file.name, file.content);
      results.push({
        filename: file.name,
        ...rendered,
      });
    }

    return results;
  }

  // ── Cache management ───────────────────────────────────

  invalidateCard(project: string, canvas: string, filename: string) {
    this.cache.delete(this.cacheKey(project, canvas, filename));
  }

  invalidateCanvas(project: string, canvas: string) {
    const prefix = `${project}/${canvas}/`;
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) {
        this.cache.delete(key);
      }
    }
  }

  invalidateClass(className: string) {
    this.pool.invalidateClass(className);
    this.isolatePool.invalidateClass(className);
    // Clear all cached cards of this class
    for (const [key, entry] of this.cache) {
      if (entry.meta.cardClass === className) {
        this.cache.delete(key);
      }
    }
    // Reload manifest in case it changed
    this.loadManifest();
  }

  invalidateAll() {
    this.cache.clear();
    // Invalidate all classes in workers
    for (const className of Object.keys(this.manifest)) {
      this.pool.invalidateClass(className);
    }
  }
}

export { parseFrontmatter };
