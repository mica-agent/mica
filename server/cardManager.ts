/**
 * CardManager — Orchestrates card rendering with caching.
 *
 * Resolves card classes from file metadata, manages render cache,
 * and delegates rendering/export calls to the WorkerPool.
 */

import path from "path";
import fs from "fs";
import { WorkerPool, type RenderResult } from "./workerPool.js";
import {
  readLayerFile,
  writeLayerFile,
  listFiles,
} from "./layerFiles.js";
import { getProjectPath } from "./projectConnection.js";

// ── Types ──────────────────────────────────────────────────

export interface CardMeta {
  cardClass: string;
  title: string;
  badge: string;
  isSystem: boolean;
  config: Record<string, unknown>;
}

interface CacheEntry {
  html: string;
  exports: string[];
  meta: CardMeta;
  mtime: number;
}

interface ClassManifestEntry {
  badge: string;
  system?: boolean;
  defaultTitle?: string;
}

// ── Constants ──────────────────────────────────────────────

const CARD_CLASSES_DIR = path.resolve("card-classes");

// Filename → card class mapping (convention-based)
const FILENAME_CLASS_MAP: Record<string, string> = {
  "_goal.md": "goal",
  "_todo.md": "todo",
  "_brief.md": "brief",
  "_log.md": "log",
  "_chat.md": "chat",
};

// Extension → card class fallback
const EXTENSION_CLASS_MAP: Record<string, string> = {
  ".md": "markdown",
  ".mmd": "mermaid",
  ".txt": "text",
  ".py": "text", // .py files render as text by default
  ".html": "html",
};

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
  private manifest: Record<string, ClassManifestEntry> = {};

  constructor(pool: WorkerPool) {
    this.pool = pool;
    this.loadManifest();
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
    if (projectPath) {
      const projectManifestPath = path.join(projectPath, ".mica", "_card-classes", "_manifest.json");
      try {
        const raw = fs.readFileSync(projectManifestPath, "utf-8");
        const projectManifest = JSON.parse(raw);
        this.manifest = { ...this.manifest, ...projectManifest };
      } catch {
        // No project manifest — that's fine
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

    // 2. Check filename convention
    if (FILENAME_CLASS_MAP[filename]) {
      return { cardClass: FILENAME_CLASS_MAP[filename], strippedContent: content, metadata };
    }

    // 3. Extension fallback
    const ext = path.extname(filename);
    const cardClass = EXTENSION_CLASS_MAP[ext] || "text";
    return { cardClass, strippedContent: content, metadata };
  }

  resolveCardMeta(filename: string, content: string): CardMeta {
    const { cardClass, metadata } = this.resolveCardClass(filename, content);
    const manifestEntry = this.manifest[cardClass];

    // Determine title
    let title = (metadata.title as string) || manifestEntry?.defaultTitle || "";
    if (!title) {
      title = filename
        .replace(/\.(txt|md|mmd|py|html)$/, "")
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
      config: metadata as Record<string, unknown>,
    };
  }

  // ── Rendering ──────────────────────────────────────────

  private getClassPath(className: string, projectPath?: string): string {
    // Check project-level card classes first
    if (projectPath) {
      const projectClassPath = path.join(projectPath, ".mica", "_card-classes", className, "render.py");
      if (fs.existsSync(projectClassPath)) {
        return projectClassPath;
      }
    }
    // Fall back to built-in card classes
    return path.join(CARD_CLASSES_DIR, className, "render.py");
  }

  private cacheKey(project: string, layer: string, filename: string): string {
    return `${project}/${layer}/${filename}`;
  }

  async renderCard(
    project: string,
    layer: string,
    filename: string,
    content: string,
    config?: Record<string, unknown>
  ): Promise<{ html: string; exports: string[]; meta: CardMeta }> {
    const key = this.cacheKey(project, layer, filename);
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

    // Retry renders up to 3 times (workers may be temporarily busy with exports)
    const maxRetries = 3;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const result = await this.pool.render(
          cardClass,
          classPath,
          strippedContent,
          { ...metadata, ...(config || {}), project, layer, filename },
          { project, layer, filename }
        );

        // Cache the result
        this.cache.set(key, {
          html: result.html,
          exports: result.exports,
          meta,
          mtime: Date.now(),
        });

        return { html: result.html, exports: result.exports, meta };
      } catch (err) {
        const msg = (err as Error).message;
        const isTimeout = msg.includes("timed out") || msg.includes("pool exhausted");
        if (isTimeout && attempt < maxRetries - 1) {
          console.warn(`[card-manager] Render retry ${attempt + 1}/${maxRetries} for ${project}/${layer}/${filename}: ${msg}`);
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
    layer: string,
    filename: string,
    fn: string,
    args: Record<string, unknown>
  ): Promise<any> {
    // Read the current file content
    const file = await readLayerFile(project, layer, filename);
    const { cardClass, strippedContent, metadata } = this.resolveCardClass(filename, file.content);
    let projectPath: string | undefined;
    try { projectPath = await getProjectPath(project); } catch { /* fallback */ }
    const classPath = this.getClassPath(cardClass, projectPath);

    if (!fs.existsSync(classPath)) {
      throw new Error(`Card class "${cardClass}" not found`);
    }

    return this.pool.callExport(
      cardClass,
      classPath,
      fn,
      strippedContent,
      args,
      { project, layer, filename }
    );
  }

  /** Fire-and-forget: call an export but don't return the result to the caller. */
  async callSend(
    project: string,
    layer: string,
    filename: string,
    fn: string,
    args: Record<string, unknown>
  ): Promise<void> {
    const file = await readLayerFile(project, layer, filename);
    const { cardClass, strippedContent } = this.resolveCardClass(filename, file.content);
    let projectPath: string | undefined;
    try { projectPath = await getProjectPath(project); } catch { /* fallback */ }
    const classPath = this.getClassPath(cardClass, projectPath);

    if (!fs.existsSync(classPath)) {
      console.error(`[card-manager] callSend: card class "${cardClass}" not found`);
      return;
    }

    this.pool.callExport(cardClass, classPath, fn, strippedContent, args, { project, layer, filename })
      .catch((err) => console.error(`[card-manager] callSend error:`, (err as Error).message));
  }

  /**
   * Open a bidirectional channel to a @mica.channel handler.
   * Returns the channel ID (same as the caller-provided channelId).
   */
  async openChannel(
    channelId: string,
    project: string,
    layer: string,
    filename: string,
    fn: string,
    args: Record<string, unknown>,
    onData: (data: unknown) => void,
    onClose: () => void
  ): Promise<string> {
    const file = await readLayerFile(project, layer, filename);
    const { cardClass, strippedContent } = this.resolveCardClass(filename, file.content);
    let projectPath: string | undefined;
    try { projectPath = await getProjectPath(project); } catch { /* fallback */ }
    const classPath = this.getClassPath(cardClass, projectPath);

    if (!fs.existsSync(classPath)) {
      throw new Error(`Card class "${cardClass}" not found`);
    }

    return this.pool.openChannel(
      channelId,
      cardClass,
      classPath,
      fn,
      strippedContent,
      args,
      { project, layer, filename },
      onData,
      onClose
    );
  }

  /**
   * Render all cards for a project layer. Returns an array of rendered cards.
   */
  async renderAllCards(project: string, layer: string): Promise<
    Array<{
      filename: string;
      html: string;
      exports: string[];
      meta: CardMeta;
    }>
  > {
    const files = await listFiles(project, layer);
    const results = [];

    for (const file of files) {
      // Skip chat history files
      if (file.name === "_chat-history.json") continue;

      const rendered = await this.renderCard(project, layer, file.name, file.content);
      results.push({
        filename: file.name,
        ...rendered,
      });
    }

    return results;
  }

  // ── Cache management ───────────────────────────────────

  invalidateCard(project: string, layer: string, filename: string) {
    this.cache.delete(this.cacheKey(project, layer, filename));
  }

  invalidateLayer(project: string, layer: string) {
    const prefix = `${project}/${layer}/`;
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) {
        this.cache.delete(key);
      }
    }
  }

  invalidateClass(className: string) {
    this.pool.invalidateClass(className);
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
