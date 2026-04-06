/**
 * CardManager — Orchestrates card rendering with caching.
 *
 * Resolves card classes from file metadata, manages render cache,
 * and delegates rendering/export calls to the ModuleLoader.
 */

import path from "path";
import fs from "fs";
import { ModuleLoader, type RenderResult as ModuleRenderResult, type CardDependencies, type MicaBridge } from "./moduleLoader.js";
import type { ContainerRuntime } from "./containerRuntime.js";
import {
  readCanvasFile,
  writeCanvasFile,
  listFiles,
} from "./cardFiles.js";
import { getProjectPath } from "./projectConnection.js";

// ── Types ──────────────────────────────────────────────────

export interface CardMeta {
  cardClass: string;
  title: string;
  badge: string;
  network: boolean;
  config: Record<string, unknown>;
}

interface CacheEntry {
  html: string;
  exports: string[];
  dependencies?: CardDependencies;
  hasStream: boolean;
  meta: CardMeta;
  mtime: number;
}

interface ClassManifestEntry {
  extension?: string;
  badge: string;
  system?: boolean;
  defaultTitle?: string;
  network?: boolean;
  primaryFile?: string;
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

  const metadata: Record<string, unknown> = {};
  for (const line of yamlBlock.split("\n")) {
    const match = line.match(/^(\w[\w-]*)\s*:\s*(.+)$/);
    if (match) {
      const [, key, value] = match;
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
  private moduleLoader: ModuleLoader;
  private containerRuntimes: Map<string, ContainerRuntime> = new Map();
  private manifest: Record<string, ClassManifestEntry> = {};
  private extensionMap: Map<string, string> = new Map();

  constructor() {
    this.moduleLoader = new ModuleLoader();
    this.loadManifest();
  }

  /** Register a container runtime for a project. Card execution goes through the container. */
  setContainerRuntime(projectId: string, runtime: ContainerRuntime): void {
    this.containerRuntimes.set(projectId, runtime);
  }

  /** Get the container runtime for a project (if any). */
  getContainerRuntime(projectId: string): ContainerRuntime | undefined {
    return this.containerRuntimes.get(projectId);
  }

  /** Get the full manifest (for API endpoint). */
  getManifest(): Record<string, ClassManifestEntry> {
    return { ...this.manifest };
  }

  /** Get all valid card extensions (for file validation and watching). */
  getValidExtensions(): string[] {
    return [...this.extensionMap.keys(), ".json"];
  }

  /** Check if a card class has network permission (manifest `network: true`). */
  hasNetworkPermission(cardClass: string): boolean {
    return this.manifest[cardClass]?.network === true;
  }

  private loadManifest(projectPath?: string) {
    this.manifest = {};

    // Scan built-in card classes
    this.scanCardClassDir(CARD_CLASSES_DIR);

    // Scan project-level card classes (override built-in)
    if (projectPath) {
      this.scanCardClassDir(path.join(projectPath, ".mica", ".card-classes"));
    }

    this.extensionMap.clear();
    for (const [className, entry] of Object.entries(this.manifest)) {
      if (entry.extension) {
        this.extensionMap.set(entry.extension, className);
      }
    }
  }

  /** Scan a card class directory for render.js files with metadata exports. */
  private scanCardClassDir(dir: string) {
    try {
      const entries = fs.readdirSync(dir);
      for (const entry of entries) {
        const renderJs = path.join(dir, entry, "render.js");
        if (fs.existsSync(renderJs)) {
          try {
            const source = fs.readFileSync(renderJs, "utf-8");
            const match = source.match(/export\s+const\s+metadata\s*=\s*(\{[^}]+\})/);
            if (match) {
              const meta = new Function(`return ${match[1]}`)() as ClassManifestEntry;
              this.manifest[entry] = { ...this.manifest[entry], ...meta };
            }
          } catch { /* parse error */ }
        }
      }
    } catch { /* directory may not exist */ }
  }

  // ── Card class resolution ──────────────────────────────

  resolveCardClass(filename: string, content?: string): { cardClass: string; strippedContent: string; metadata: Record<string, unknown> } {
    const rawContent = content || "";
    const { metadata, content: strippedContent } = parseFrontmatter(rawContent);
    if (metadata.card && typeof metadata.card === "string") {
      return { cardClass: metadata.card, strippedContent, metadata };
    }

    const ext = path.extname(filename);
    const cardClass = this.extensionMap.get(ext) || "text";
    return { cardClass, strippedContent: rawContent, metadata };
  }

  resolveCardMeta(filename: string, content: string): CardMeta {
    const { cardClass, metadata } = this.resolveCardClass(filename, content);
    const manifestEntry = this.manifest[cardClass];

    let title = (metadata.title as string) || manifestEntry?.defaultTitle || "";
    if (!title) {
      const ext = path.extname(filename);
      title = (ext ? filename.slice(0, -ext.length) : filename)
        .replace(/[-_]/g, " ")
        .replace(/\b\w/g, (c) => c.toUpperCase());
    }

    return {
      cardClass,
      title,
      badge: manifestEntry?.badge || cardClass.toUpperCase(),
      network: manifestEntry?.network === true,
      config: metadata as Record<string, unknown>,
    };
  }

  // ── Rendering ──────────────────────────────────────────

  getClassPath(className: string, projectPath?: string): string {
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
  ): Promise<{ html: string; exports: string[]; dependencies?: CardDependencies; hasStream?: boolean; meta: CardMeta }> {
    const key = this.cacheKey(project, canvas, filename);
    let projectPath: string | undefined;
    try { projectPath = await getProjectPath(project); } catch { /* fallback */ }
    this.loadManifest(projectPath);
    const { cardClass, strippedContent, metadata } = this.resolveCardClass(filename, content);
    const meta = this.resolveCardMeta(filename, content);

    const classPath = this.getClassPath(cardClass, projectPath);
    if (!fs.existsSync(classPath)) {
      const html = `<pre style="color: #f87171;">Card class "${cardClass}" not found.\nFile: ${filename}</pre>`;
      return { html, exports: [], meta };
    }

    const maxRetries = 3;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const renderConfig = { ...metadata, ...(config || {}), project, canvas, filename };
        console.log(`[card-manager] Rendering ${filename} (class=${cardClass})...`);
        const containerRuntime = this.containerRuntimes.get(project);
        const result = containerRuntime
          ? await containerRuntime.render(cardClass, classPath, strippedContent, renderConfig)
          : await this.moduleLoader.render(cardClass, classPath, strippedContent, renderConfig);
        console.log(`[card-manager] Rendered ${filename} (${result.html.length} chars)`);

        this.cache.set(key, {
          html: result.html,
          exports: result.exports,
          dependencies: result.dependencies,
          hasStream: result.hasStream,
          meta,
          mtime: Date.now(),
        });

        return { html: result.html, exports: result.exports, dependencies: result.dependencies, hasStream: result.hasStream, meta };
      } catch (err) {
        const msg = (err as Error).message;
        if (attempt < maxRetries - 1) {
          console.warn(`[card-manager] Render retry ${attempt + 1}/${maxRetries} for ${project}/${canvas}/${filename}: ${msg}`);
          await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
          continue;
        }
        const errorHtml = `<pre style="color: #f87171; white-space: pre-wrap;">Render error (${cardClass}):\n${msg}</pre>`;
        return { html: errorHtml, exports: [], meta };
      }
    }
    return { html: "", exports: [], meta };
  }

  async callExport(
    project: string,
    canvas: string,
    filename: string,
    fn: string,
    args: Record<string, unknown>,
    mica: MicaBridge
  ): Promise<unknown> {
    const file = await readCanvasFile(project, canvas, filename);
    const { cardClass } = this.resolveCardClass(filename, file.content);
    let projectPath: string | undefined;
    try { projectPath = await getProjectPath(project); } catch { /* fallback */ }
    const classPath = this.getClassPath(cardClass, projectPath);

    if (!fs.existsSync(classPath)) {
      throw new Error(`Card class "${cardClass}" not found`);
    }

    const containerRuntime = this.containerRuntimes.get(project);
    if (containerRuntime) {
      return containerRuntime.callExport(cardClass, classPath, fn, file.content, args, filename);
    }
    return this.moduleLoader.callExport(
      cardClass, classPath, fn, file.content, args, mica
    );
  }

  /** Get the module loader (fallback for non-containerized projects) */
  getModuleLoader(): ModuleLoader {
    return this.moduleLoader;
  }

  /** Render all cards for a project canvas. */
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
    this.moduleLoader.invalidateClass(className);
    for (const rt of this.containerRuntimes.values()) {
      rt.invalidateClass(className).catch(() => {});
    }
    for (const [key, entry] of this.cache) {
      if (entry.meta.cardClass === className) {
        this.cache.delete(key);
      }
    }
    this.loadManifest();
  }

  invalidateAll() {
    this.cache.clear();
    this.moduleLoader.invalidateAll();
  }
}

export { parseFrontmatter };
export type { CardDependencies };
