// files.ts — File operations for Mica.
// Multi-project model: WORKSPACE_DIR contains project subdirectories.
// Each project has its own .mica/ metadata directory.
// File operations are scoped to a specific project within the workspace.

import { readFile, writeFile, unlink, readdir, stat, mkdir, rename, rm, cp, symlink } from "fs/promises";
import { join, relative, dirname, basename, sep } from "path";
import { existsSync } from "fs";
import { exec as execCb } from "child_process";
import { promisify } from "util";

const execAsync = promisify(execCb);

/** The workspace root. Defaults to /project (Docker mount point). */
export const WORKSPACE_DIR = process.env.PROJECT_DIR || "/project";

/** Extensions that are known-binary; agent buildContext skips these. */
export const BINARY_EXTS = new Set<string>([
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".ico", ".svg",
  ".pdf", ".zip", ".tar", ".gz", ".bz2", ".xz", ".7z", ".rar",
  ".mp3", ".mp4", ".m4a", ".wav", ".ogg", ".webm", ".mov", ".avi",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".exe", ".dll", ".so", ".dylib", ".o", ".a",
]);

/** Cheap binary check: true if filename has a binary extension OR the first
 *  1KB of content contains a NUL byte. Used by both the agent prompt builder
 *  and the ctx tooltip to classify files consistently. */
export function isLikelyBinary(filename: string, contentHead: string): boolean {
  const ext = filename.substring(filename.lastIndexOf(".")).toLowerCase();
  if (BINARY_EXTS.has(ext)) return true;
  return contentHead.slice(0, 1024).includes("\0");
}

/** Soft cap on the agent prompt (chars). Not enforced by truncation — we
 *  warn in the ctx tooltip and server log when the rendered prompt exceeds
 *  this. The expectation is that the user splits large canvas cards (divide
 *  and conquer) rather than having the prompt silently clipped. */
export const CONTEXT_SOFT_CAP_CHARS = 100_000;

// ── Card class metadata lookup (shared across agents + ctx preview) ──────
//
// Reads each card class's metadata.json once and caches. `meta: true` marks
// "infrastructure" cards (canvas-back, skills) whose on-disk file is a shell
// — their content lives elsewhere and shouldn't be dumped into the agent's
// "Project Files" section.

interface ClassMeta { badge: string; meta: boolean }
const classMetaCache = new Map<string, ClassMeta>();

export async function getCardClassMeta(ext: string, project: string | null | undefined): Promise<ClassMeta> {
  const className = ext.startsWith(".") ? ext.slice(1) : ext;
  const cacheKey = `${project ?? ""}|${className}`;
  const cached = classMetaCache.get(cacheKey);
  if (cached) return cached;

  const candidates: string[] = [];
  if (project) candidates.push(join(WORKSPACE_DIR, project, ".mica", "card-classes", className));
  candidates.push(join(process.cwd(), "card-classes", className));

  for (const dir of candidates) {
    try {
      const raw = await readFile(join(dir, "metadata.json"), "utf-8");
      const m = JSON.parse(raw) as { badge?: unknown; meta?: unknown };
      const out: ClassMeta = {
        badge: typeof m.badge === "string" ? m.badge : "",
        meta: m.meta === true,
      };
      classMetaCache.set(cacheKey, out);
      return out;
    } catch { /* try next candidate */ }
  }
  const empty: ClassMeta = { badge: "", meta: false };
  classMetaCache.set(cacheKey, empty);
  return empty;
}

/** Clear the card-class metadata cache. Call after a card class file changes
 *  so fresh reads pick up edited metadata.json without a server restart. */
export function clearCardClassMetaCache(): void {
  classMetaCache.clear();
}

// Backwards-compatible alias used by other modules
export const PROJECT_DIR = WORKSPACE_DIR;

/** Project templates — copied to <workspace>/<projectName>/ on creation. */
export const TEMPLATES_DIR = join(process.cwd(), "templates");

/** Directories and patterns to skip when listing files recursively. */
const IGNORE_DIRS = new Set([
  ".mica", ".git", ".svn", ".hg",
  "node_modules", "__pycache__", ".venv", "venv",
  ".next", ".nuxt", "dist", "build", ".cache",
  ".qwen",
]);

/** File extensions to skip (binary/generated). */
const IGNORE_EXTENSIONS = new Set([
  ".pyc", ".pyo", ".class", ".o", ".so", ".dylib",
  ".exe", ".dll", ".wasm",
  ".zip", ".tar", ".gz", ".bz2", ".7z", ".rar",
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".webp",
  ".mp3", ".mp4", ".wav", ".avi", ".mov",
  ".doc", ".docx", ".xls", ".xlsx",
  ".sqlite", ".db",
  ".lock",
]);

// ── Workspace-level operations ──────────────────────────────

/** The .mica metadata directory for a given project. */
export function micaDir(projectName?: string): string {
  if (projectName) {
    return join(WORKSPACE_DIR, projectName, ".mica");
  }
  // Workspace-level .mica (for workspace config)
  return join(WORKSPACE_DIR, ".mica");
}

/** Get the project directory path. */
export function projectDir(projectName: string): string {
  validateProjectName(projectName);
  return join(WORKSPACE_DIR, projectName);
}

/** Get the workspace name from the directory basename. */
export function getWorkspaceName(): string {
  return basename(WORKSPACE_DIR);
}

/** Get a project's display name from its .mica config or directory name. */
export async function getProjectName(project?: string): Promise<string> {
  if (!project) return getWorkspaceName();
  try {
    const configPath = join(micaDir(project), "config.json");
    const raw = await readFile(configPath, "utf-8");
    const config = JSON.parse(raw);
    return config.name || project;
  } catch {
    return project;
  }
}

export interface ProjectInfo {
  name: string;
  path: string;
  hasGit: boolean;
  hasMica: boolean;
  docsDir?: string;
}

/** List all projects (subdirectories) in the workspace. */
export async function listProjects(): Promise<ProjectInfo[]> {
  if (!existsSync(WORKSPACE_DIR)) return [];

  const entries = await readdir(WORKSPACE_DIR, { withFileTypes: true });
  const projects: ProjectInfo[] = [];

  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (!entry.isDirectory()) continue;
    if (IGNORE_DIRS.has(entry.name)) continue;

    const projPath = join(WORKSPACE_DIR, entry.name);
    const hasGit = existsSync(join(projPath, ".git"));
    const hasMica = existsSync(join(projPath, ".mica"));

    let docsDir: string | undefined;
    if (hasMica) {
      try {
        const cfg = JSON.parse(await readFile(join(projPath, ".mica", "config.json"), "utf-8"));
        docsDir = cfg.docsDir;
      } catch { /* no config */ }
    }

    projects.push({
      name: entry.name,
      path: projPath,
      hasGit,
      hasMica,
      docsDir,
    });
  }

  return projects;
}

/** Initialize a project's .mica directory with default config. */
export async function initProject(projectName: string, canvasRoot?: string): Promise<void> {
  const dir = micaDir(projectName);
  await mkdir(dir, { recursive: true });
  await mkdir(join(dir, "cards"), { recursive: true });
  await mkdir(join(dir, "chats"), { recursive: true });

  const root = canvasRoot || "canvas";

  // Create config.json if it doesn't exist
  const configPath = join(dir, "config.json");
  if (!existsSync(configPath)) {
    const config: Record<string, unknown> = {
      name: projectName,
      canvasClass: "canvas",
      canvasRoot: root,
      pinned: [],
    };
    await writeFile(configPath, JSON.stringify(config, null, 2), "utf-8");
  }

  // Create canvas-back.md if it doesn't exist
  const canvasBackPath = join(dir, "canvas-back.md");
  if (!existsSync(canvasBackPath)) {
    await writeFile(canvasBackPath, "", "utf-8");
  }

  // Create canvas root directory (everything on canvas lives here)
  if (root !== ".") {
    await mkdir(join(WORKSPACE_DIR, projectName, root), { recursive: true });
  }
}

/** Create a new empty project directory and initialize it. */
export async function createProject(projectName: string, docsDir?: string): Promise<void> {
  validateProjectName(projectName);
  const dir = join(WORKSPACE_DIR, projectName);
  if (existsSync(dir)) {
    throw new Error(`Project already exists: ${projectName}`);
  }
  await mkdir(dir, { recursive: true });
  await initProject(projectName, docsDir);
}

/** Rename a project directory. */
export async function renameProject(oldName: string, newName: string): Promise<void> {
  validateProjectName(oldName);
  validateProjectName(newName);
  const oldDir = join(WORKSPACE_DIR, oldName);
  const newDir = join(WORKSPACE_DIR, newName);
  if (!existsSync(oldDir)) throw new Error(`Project not found: ${oldName}`);
  if (existsSync(newDir)) throw new Error(`Project already exists: ${newName}`);
  await rename(oldDir, newDir);

  // Update config.json name if it exists
  try {
    const configPath = join(newDir, ".mica", "config.json");
    const raw = await readFile(configPath, "utf-8");
    const config = JSON.parse(raw);
    config.name = newName;
    await writeFile(configPath, JSON.stringify(config, null, 2), "utf-8");
  } catch { /* no config to update */ }
}

/** Delete a project directory entirely. */
export async function deleteProject(projectName: string): Promise<void> {
  validateProjectName(projectName);
  const dir = join(WORKSPACE_DIR, projectName);
  if (!existsSync(dir)) throw new Error(`Project not found: ${projectName}`);
  await rm(dir, { recursive: true, force: true });
}

// ── File operations (project-scoped) ────────────────────────

export interface FileMeta {
  name: string;       // Relative path from project root (e.g., "docs/spec.md")
  type: "file" | "directory";
  size: number;
  modifiedAt: string;
  pinned?: boolean;   // true if file is pinned to canvas (not a canvasRoot child)
  badge?: string;     // Card class badge (resolved from metadata.json), populated by /api/files
  meta?: boolean;     // True if the file's card class has `meta: true` in its metadata.json.
                      // Used by the canvas card class to render meta cards in a docked
                      // sidebar (configures HOW the canvas works) instead of the freeform
                      // area (the WHAT you're building).
  id?: string;        // Stable per-file UUID (sidecar in .mica/cards/<sanitized>.id.json).
                      // Used as the channel-session key — sessions are file-identity-bound,
                      // not filename-bound, so two projects with the same template-seeded
                      // filename get distinct sessions.
}

// ── Card identity (UUID per file) ──────────────────────────
//
// Each file in a project gets a stable UUID stored in a sidecar at
// `.mica/cards/<sanitized>.id.json`. The UUID is the session key used by
// channelManager — using it instead of filename means two projects with
// the same filename (e.g. template-seeded `docs/qwen.chat`) don't share
// state.
//
// In-memory cache is the runtime source of truth; sidecar is durability.
// Single-flight via cardIdPending eliminates the race where two concurrent
// /api/files calls both generate a UUID for the same missing sidecar.

const cardIdCache = new Map<string, string>();             // `${project}|${filename}` → uuid
const cardIdPending = new Map<string, Promise<string>>();  // single-flight

function cardIdKey(project: string | null | undefined, filename: string): string {
  return `${project ?? "<workspace>"}|${filename}`;
}

function cardIdSidecarPath(project: string | null | undefined, filename: string): string {
  const sanitized = filename.replace(/\//g, "_");
  return join(micaDir(project ?? undefined), "cards", `${sanitized}.id.json`);
}

/** Atomically write JSON: tmp file + rename (POSIX rename is atomic). */
async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  await writeFile(tmp, JSON.stringify(value), "utf-8");
  await rename(tmp, path);
}

/** Get the file's stable UUID. Creates the sidecar (and caches) on first access.
 *  Concurrent calls for the same file collapse onto the same Promise (single-flight),
 *  so two /api/files responses for the same file always return the same UUID. */
export async function getOrCreateCardId(project: string | null | undefined, filename: string): Promise<string> {
  const key = cardIdKey(project, filename);
  const cached = cardIdCache.get(key);
  if (cached) return cached;

  const inflight = cardIdPending.get(key);
  if (inflight) return inflight;

  const promise = (async (): Promise<string> => {
    const path = cardIdSidecarPath(project, filename);
    // Try to read existing sidecar
    try {
      const raw = await readFile(path, "utf-8");
      const parsed = JSON.parse(raw) as { id?: unknown };
      if (typeof parsed.id === "string" && parsed.id) {
        cardIdCache.set(key, parsed.id);
        return parsed.id;
      }
      console.warn(`[card-id] Sidecar at ${path} is malformed; regenerating.`);
    } catch {
      // sidecar missing or unreadable; generate fresh
    }
    const id = (globalThis.crypto?.randomUUID?.() ?? `card-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
    await atomicWriteJson(path, { id });
    cardIdCache.set(key, id);
    return id;
  })();

  cardIdPending.set(key, promise);
  promise.finally(() => cardIdPending.delete(key));
  return promise;
}

/** Look up a cached UUID without disk access. Returns undefined if not yet generated. */
export function lookupCardId(project: string | null | undefined, filename: string): string | undefined {
  return cardIdCache.get(cardIdKey(project, filename));
}

/** Tear down the UUID for a deleted file: evict cache, delete sidecar (best-effort). */
export async function deleteCardId(project: string | null | undefined, filename: string): Promise<void> {
  cardIdCache.delete(cardIdKey(project, filename));
  cardIdPending.delete(cardIdKey(project, filename));
  const path = cardIdSidecarPath(project, filename);
  try { await unlink(path); } catch { /* sidecar may already be gone */ }
}

/** Evict every cardId cache entry for a project. Used when a project is renamed
 *  or deleted so stale `${oldName}|filename → uuid` entries don't shadow the
 *  new project's lookups. */
export function evictCardIdsForProject(project: string): void {
  const prefix = `${project}|`;
  for (const k of cardIdCache.keys()) if (k.startsWith(prefix)) cardIdCache.delete(k);
  for (const k of cardIdPending.keys()) if (k.startsWith(prefix)) cardIdPending.delete(k);
}

// ── Per-card settings (alongside the UUID in the same sidecar) ──
//
// The card sidecar at `.mica/cards/<sanitized>.id.json` carries an optional
// `settings` blob. Today the only consumer is the chat card (provider/model
// override), but the field is generic — any card class can stash structured
// state here without needing its own sidecar file.

export interface CardSettings {
  provider?: "local" | "openrouter";
  model?: string;
}

export async function readCardSettings(project: string | undefined, filename: string): Promise<CardSettings> {
  const path = cardIdSidecarPath(project, filename);
  try {
    const raw = await readFile(path, "utf-8");
    const parsed = JSON.parse(raw) as { settings?: CardSettings };
    return parsed.settings ?? {};
  } catch {
    return {};
  }
}

export async function writeCardSettings(
  project: string | undefined,
  filename: string,
  settings: CardSettings,
): Promise<void> {
  // Ensure the UUID exists; we want one source of truth, no orphan settings without an id.
  await getOrCreateCardId(project, filename);
  const path = cardIdSidecarPath(project, filename);
  let cur: Record<string, unknown> = {};
  try {
    cur = JSON.parse(await readFile(path, "utf-8"));
  } catch { /* freshly created above; re-read race ok */ }
  cur.settings = settings;
  await atomicWriteJson(path, cur);
}

/** Backwards-compatible interface for server-side consumers that need content. */
export interface FileInfo {
  name: string;
  content: string;
  modifiedAt?: string;
}

/** Read canvas config (canvasRoot, pinned) from .mica/config.json. */
export async function readCanvasConfig(project?: string): Promise<{ canvasRoot: string; pinned: string[] }> {
  const defaults = { canvasRoot: "docs", pinned: [] as string[] };
  try {
    const configPath = project
      ? join(WORKSPACE_DIR, project, ".mica", "config.json")
      : join(WORKSPACE_DIR, ".mica", "config.json");
    const raw = await readFile(configPath, "utf-8");
    const cfg = JSON.parse(raw);
    return {
      canvasRoot: cfg.canvasRoot || cfg.docsDir || defaults.canvasRoot,
      pinned: Array.isArray(cfg.pinned) ? cfg.pinned : defaults.pinned,
    };
  } catch {
    return defaults;
  }
}

/** Update canvas config fields in .mica/config.json (merges with existing). */
export async function updateCanvasConfig(
  project: string | undefined,
  updates: { canvasRoot?: string; pinned?: string[] },
): Promise<void> {
  const configPath = project
    ? join(WORKSPACE_DIR, project, ".mica", "config.json")
    : join(WORKSPACE_DIR, ".mica", "config.json");
  let cfg: Record<string, unknown> = {};
  try {
    cfg = JSON.parse(await readFile(configPath, "utf-8"));
  } catch { /* start fresh */ }
  if (updates.canvasRoot !== undefined) cfg.canvasRoot = updates.canvasRoot;
  if (updates.pinned !== undefined) cfg.pinned = updates.pinned;
  await writeFile(configPath, JSON.stringify(cfg, null, 2), "utf-8");
}

/** Read project-wide OpenRouter API key from .mica/config.json. Returns null when unset. */
export async function readOpenRouterKey(project: string | undefined): Promise<string | null> {
  const configPath = project
    ? join(WORKSPACE_DIR, project, ".mica", "config.json")
    : join(WORKSPACE_DIR, ".mica", "config.json");
  try {
    const cfg = JSON.parse(await readFile(configPath, "utf-8"));
    const k = cfg.openrouterApiKey;
    return typeof k === "string" && k.length > 0 ? k : null;
  } catch {
    return null;
  }
}

/** Write or clear the project-wide OpenRouter API key in .mica/config.json. Empty string clears. */
export async function writeOpenRouterKey(project: string | undefined, key: string): Promise<void> {
  const configPath = project
    ? join(WORKSPACE_DIR, project, ".mica", "config.json")
    : join(WORKSPACE_DIR, ".mica", "config.json");
  await mkdir(dirname(configPath), { recursive: true });
  let cfg: Record<string, unknown> = {};
  try {
    cfg = JSON.parse(await readFile(configPath, "utf-8"));
  } catch { /* start fresh */ }
  if (key.length === 0) delete cfg.openrouterApiKey;
  else cfg.openrouterApiKey = key;
  await writeFile(configPath, JSON.stringify(cfg, null, 2), "utf-8");
}

/**
 * List canvas-visible files: direct children of canvasRoot + pinned files.
 * Excludes directories. Each file is decorated with its stable UUID (`id`).
 *
 * Implementation note: we read canvasRoot's immediate children directly
 * instead of walking the entire project and filtering. Previously this
 * called listFiles() (recursive over the whole project) and filtered to
 * the canvas set — that was O(all-project-files) just to list the 8 files
 * users actually care about. On a project containing a large unrelated
 * tree (e.g. extracted google-cloud-sdk with ~27K files), /api/files took
 * 2+ seconds. Now it's O(canvas-files + pinned-count).
 */
export async function listCanvasFiles(project?: string): Promise<FileMeta[]> {
  const { canvasRoot, pinned } = await readCanvasConfig(project);
  const projectRoot = project ? join(WORKSPACE_DIR, project) : WORKSPACE_DIR;
  const normalizedRoot = canvasRoot === "." || canvasRoot === "" ? "" : canvasRoot.replace(/\/$/, "");
  const canvasAbs = normalizedRoot === "" ? projectRoot : join(projectRoot, normalizedRoot);

  const out: FileMeta[] = [];
  const seen = new Set<string>();

  // 1. Direct children of canvasRoot (files only, one level deep).
  try {
    const entries = await readdir(canvasAbs, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      if (!entry.isFile()) continue;
      const relName = normalizedRoot === "" ? entry.name : `${normalizedRoot}/${entry.name}`;
      try {
        const s = await stat(join(canvasAbs, entry.name));
        out.push({ name: relName, type: "file", size: s.size, modifiedAt: s.mtime.toISOString() });
        seen.add(relName);
      } catch { /* file disappeared between readdir and stat */ }
    }
  } catch { /* canvasRoot doesn't exist yet — fine, empty canvas */ }

  // 2. Pinned files (anywhere in the project). Skip pins that already fall
  // inside canvasRoot (they were picked up in step 1).
  const pinnedSet = new Set(pinned);
  for (const pin of pinned) {
    if (seen.has(pin)) {
      // Already in the list; just flag as pinned.
      const existing = out.find((f) => f.name === pin);
      if (existing) existing.pinned = true;
      continue;
    }
    const abs = join(projectRoot, pin);
    try {
      const s = await stat(abs);
      if (s.isFile()) {
        out.push({ name: pin, type: "file", size: s.size, modifiedAt: s.mtime.toISOString(), pinned: true });
        seen.add(pin);
      }
    } catch { /* pinned file doesn't exist — silently skip */ }
  }
  void pinnedSet;

  // UUIDs are created ONLY for canvas-visible files, post-filter. This bounds
  // the sidecar population to the canvas — previously we created IDs for every
  // file in the project (including tens of thousands of SDK extract files), which
  // filled .mica/cards/ and blew inotify limits.
  return Promise.all(out.map(async (f) => ({ ...f, id: await getOrCreateCardId(project, f.name) })));
}

/**
 * List all files in a project directory (recursive, metadata only).
 *
 * Files are NOT decorated with UUIDs here — listFiles is used for prompt
 * context and bulk operations where we don't want the side effect of
 * minting sidecars for every file. Callers that need IDs (listCanvasFiles,
 * specific file lookups) should call getOrCreateCardId explicitly on the
 * filtered set.
 */
export async function listFiles(project?: string): Promise<FileMeta[]> {
  const root = project ? join(WORKSPACE_DIR, project) : WORKSPACE_DIR;
  if (!existsSync(root)) return [];

  const files: FileMeta[] = [];
  await scanDir(root, root, files);
  return files;
}

async function scanDir(dir: string, root: string, files: FileMeta[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;

    const fullPath = join(dir, entry.name);
    const relPath = relative(root, fullPath);

    if (entry.isDirectory()) {
      if (IGNORE_DIRS.has(entry.name)) continue;
      try {
        const dirStat = await stat(fullPath);
        files.push({
          name: relPath,
          type: "directory",
          size: 0,
          modifiedAt: dirStat.mtime.toISOString(),
        });
      } catch { /* skip unreadable */ }
      await scanDir(fullPath, root, files);
    } else if (entry.isFile()) {
      const ext = entry.name.substring(entry.name.lastIndexOf(".")).toLowerCase();
      if (IGNORE_EXTENSIONS.has(ext)) continue;

      try {
        const fileStat = await stat(fullPath);
        files.push({
          name: relPath,
          type: "file",
          size: fileStat.size,
          modifiedAt: fileStat.mtime.toISOString(),
        });
      } catch {
        // Skip unreadable files (permissions, etc.)
      }
    }
  }
}

/**
 * Resolve a filename to its absolute path within a project.
 * Used by the raw file serving endpoint.
 */
export function resolveFilePath(filename: string, project?: string): string {
  validateFilename(filename);
  const root = project ? join(WORKSPACE_DIR, project) : WORKSPACE_DIR;
  return join(root, filename);
}

/**
 * Read a single file as text from a project directory.
 * Used server-side for AI context building, chat, etc.
 */
export async function readProjectFile(filename: string, project?: string): Promise<FileInfo> {
  validateFilename(filename);
  const root = project ? join(WORKSPACE_DIR, project) : WORKSPACE_DIR;
  const filePath = join(root, filename);
  const content = await readFile(filePath, "utf-8");
  const fileStat = await stat(filePath);
  return {
    name: filename,
    content,
    modifiedAt: fileStat.mtime.toISOString(),
  };
}

/**
 * Write a file to a project directory.
 * Creates parent directories if needed.
 */
export async function writeProjectFile(filename: string, content: string, project?: string): Promise<void> {
  validateFilename(filename);
  const root = project ? join(WORKSPACE_DIR, project) : WORKSPACE_DIR;
  const filePath = join(root, filename);
  // Create parent directories if needed
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf-8");
}

/**
 * Delete a file from a project directory.
 */
export async function deleteProjectFile(filename: string, project?: string): Promise<void> {
  validateFilename(filename);
  const root = project ? join(WORKSPACE_DIR, project) : WORKSPACE_DIR;
  await unlink(join(root, filename));
}

// ── Validation ──────────────────────────────────────────────

function validateProjectName(name: string): void {
  if (!name || name.includes("/") || name.includes("\\") || name.includes("..") || name.startsWith(".")) {
    throw new Error(`Invalid project name: ${name}`);
  }
}

function validateFilename(filename: string): void {
  // Allow path separators (for nested files like "docs/spec.md")
  // but block directory traversal
  if (!filename || filename.includes("..") || filename.startsWith("/") || filename.startsWith("\\")) {
    throw new Error(`Invalid filename: ${filename}`);
  }
  // Normalize separators
  const normalized = filename.split(sep).join("/");
  if (normalized.startsWith("/")) {
    throw new Error(`Invalid filename (absolute path): ${filename}`);
  }
}


// ── Skills (project-scoped, lives in <project>/.qwen/skills/) ─────────────

export interface SkillMeta {
  name: string;
  description: string;  // first non-empty, non-frontmatter, non-heading line of SKILL.md
  hasContent: boolean;
}

/** Read summary info from SKILL.md at given path */
async function readSkillSummary(skillPath: string): Promise<{ description: string; hasContent: boolean }> {
  let description = "";
  let hasContent = false;
  try {
    const content = await readFile(skillPath, "utf-8");
    hasContent = content.trim().length > 0;
    // Try YAML frontmatter description: first
    const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
    if (fmMatch) {
      const descLine = fmMatch[1].split("\n").find(l => /^description:/i.test(l));
      if (descLine) description = descLine.replace(/^description:\s*/i, "").trim().slice(0, 200);
    }
    if (!description) {
      // Fall back to first body line that isn't heading or frontmatter fence
      const body = fmMatch ? content.slice(fmMatch[0].length) : content;
      for (const line of body.split("\n")) {
        const t = line.trim();
        if (!t || t.startsWith("#") || t.startsWith("---")) continue;
        description = t.slice(0, 200);
        break;
      }
    }
  } catch { /* no SKILL.md */ }
  return { description, hasContent };
}

/** List skills for a project — flat list from <project>/.qwen/skills/<name>/SKILL.md */
export async function listSkills(project?: string): Promise<SkillMeta[]> {
  if (!project) return [];
  const projSkillsDir = join(WORKSPACE_DIR, project, ".qwen", "skills");
  if (!existsSync(projSkillsDir)) return [];
  const out: SkillMeta[] = [];
  try {
    const entries = await readdir(projSkillsDir, { withFileTypes: true });
    for (const s of entries) {
      if (!s.isDirectory() || s.name.startsWith(".")) continue;
      const summary = await readSkillSummary(join(projSkillsDir, s.name, "SKILL.md"));
      out.push({ name: s.name, ...summary });
    }
  } catch { /* ignore */ }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function validateSkillName(name: string): void {
  if (!name || name.includes("/") || name.includes("..") || name.startsWith(".")) {
    throw new Error(`Invalid skill name: ${name}`);
  }
}

/** Resolve the SKILL.md path for a project-scoped skill */
function skillPath(name: string, project: string): string {
  validateSkillName(name);
  return join(WORKSPACE_DIR, project, ".qwen", "skills", name, "SKILL.md");
}

/** Read SKILL.md content for a skill */
export async function readSkill(name: string, project: string): Promise<string> {
  return await readFile(skillPath(name, project), "utf-8");
}

/** Write SKILL.md content for a skill (creates skill dir if needed) */
export async function writeSkill(name: string, content: string, project: string): Promise<void> {
  const path = skillPath(name, project);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf-8");
}

/** Delete a skill */
export async function deleteSkill(name: string, project: string): Promise<void> {
  const path = skillPath(name, project);
  const dir = dirname(path);
  if (!existsSync(dir)) throw new Error(`Skill not found: ${name}`);
  await rm(dir, { recursive: true, force: true });
}

// ── Templates (project starter directories at mica/templates/<name>/) ─────

export interface TemplateMeta {
  name: string;
  description: string;  // first non-empty line of canvas-back.md (or empty)
}

/** List available templates — directories under mica/templates/ */
export async function listTemplates(): Promise<TemplateMeta[]> {
  if (!existsSync(TEMPLATES_DIR)) return [];
  const out: TemplateMeta[] = [];
  const entries = await readdir(TEMPLATES_DIR, { withFileTypes: true });
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith(".")) continue;
    let description = "";
    try {
      const back = await readFile(join(TEMPLATES_DIR, e.name, ".mica", "canvas-back.md"), "utf-8");
      for (const line of back.split("\n")) {
        const t = line.trim();
        if (!t || t.startsWith("#")) continue;
        description = t.slice(0, 200);
        break;
      }
    } catch { /* no canvas-back */ }
    out.push({ name: e.name, description });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Create a new project by recursively copying a template directory.
 *  Then runs initProject() to fill any missing .mica defaults. */
/** Overlay template content onto an existing project directory. Used by both
 *  `createProjectFromTemplate` (project dir is fresh) and `cloneProjectFromRepo`
 *  (project dir contains a git clone and should NOT be clobbered).
 *
 *  `cp` runs with `force: false` throughout so files already present in the
 *  target (from a clone, or seeded earlier) are never overwritten. Patches
 *  config.json with the project name, canvas root, and template lineage.
 *  Handles the case where the template's canvas root (e.g. `docs/`) differs
 *  from the caller's chosen canvas root (e.g. `canvas/`) by copying template
 *  canvas-root contents into whichever directory the project actually uses.
 */
export async function overlayTemplate(
  projectName: string,
  templateName: string,
  options: { canvasRoot?: string } = {},
): Promise<void> {
  if (!templateName || templateName.includes("/") || templateName.includes("..") || templateName.startsWith(".")) {
    throw new Error(`Invalid template name: ${templateName}`);
  }
  const src = join(TEMPLATES_DIR, templateName);
  const dst = join(WORKSPACE_DIR, projectName);
  if (!existsSync(src)) throw new Error(`Template not found: ${templateName}`);
  if (!existsSync(dst)) throw new Error(`Project directory does not exist: ${projectName}`);

  // Templates store their seed canvas files in `canvas/` by convention (matches
  // the new-project default). Read from there; remap to the project's canvas
  // root if the caller chose a different name.
  const templateCanvasRoot = "canvas";
  const targetCanvasRoot = options.canvasRoot || templateCanvasRoot;

  // Copy every top-level entry from the template except the template's canvas
  // root, which we may need to remap.
  const entries = await readdir(src, { withFileTypes: true });
  for (const e of entries) {
    if (e.name === templateCanvasRoot) continue;
    const srcPath = join(src, e.name);
    const dstPath = join(dst, e.name);
    await cp(srcPath, dstPath, { recursive: true, force: false, errorOnExist: false });
  }

  // Copy template's canvas-root seed files into the project's canvas root
  // (which may or may not be the same name).
  const srcRoot = join(src, templateCanvasRoot);
  if (existsSync(srcRoot)) {
    const dstRoot = join(dst, targetCanvasRoot);
    await mkdir(dstRoot, { recursive: true });
    await cp(srcRoot, dstRoot, { recursive: true, force: false, errorOnExist: false });
  }

  // Patch config.json: set name, canvasRoot override, template lineage. Keeps
  // any other fields the template or initProject already wrote.
  try {
    const configPath = join(dst, ".mica", "config.json");
    let config: Record<string, unknown> = {};
    if (existsSync(configPath)) {
      try { config = JSON.parse(await readFile(configPath, "utf-8")); } catch { /* ignore parse errors */ }
    }
    config.name = projectName;
    if (options.canvasRoot) config.canvasRoot = options.canvasRoot;
    if (!config.canvasClass) config.canvasClass = "canvas";
    if (!config.template) config.template = templateName;
    if (!Array.isArray(config.pinned)) config.pinned = [];
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(configPath, JSON.stringify(config, null, 2), "utf-8");
  } catch { /* best-effort */ }

  // Make skills visible to the Claude Code SDK too — it reads from .claude/skills/
  // while Qwen reads from .qwen/skills/. Symlink `.claude/skills → ../.qwen/skills`
  // so both SDKs see the same SKILL.md files. Skip silently if the template has no
  // .qwen/skills/ dir.
  try {
    const qwenSkillsDir = join(dst, ".qwen", "skills");
    const claudeDir = join(dst, ".claude");
    const claudeSkillsLink = join(claudeDir, "skills");
    if (existsSync(qwenSkillsDir) && !existsSync(claudeSkillsLink)) {
      await mkdir(claudeDir, { recursive: true });
      await symlink("../.qwen/skills", claudeSkillsLink);
    }
  } catch { /* best-effort */ }

  // Pre-warm UUIDs for canvas-visible files only. Seeding IDs for every file
  // in the project would create sidecars for user data unrelated to the canvas
  // (e.g. extracted SDKs, vendored tarballs, generated build output). The
  // canvas is the unit of identity; non-canvas files get IDs lazily if/when
  // they're promoted to pins.
  try {
    const seeded = await listCanvasFiles(projectName);
    for (const f of seeded) {
      if (f.type === "file") await getOrCreateCardId(projectName, f.name);
    }
  } catch { /* best-effort */ }
}

export async function createProjectFromTemplate(projectName: string, templateName: string): Promise<void> {
  validateProjectName(projectName);
  const dst = join(WORKSPACE_DIR, projectName);
  if (existsSync(dst)) throw new Error(`Project already exists: ${projectName}`);
  await mkdir(dst, { recursive: true });
  // Overlay the template FIRST so its canvas-back.md / config.json / skills /
  // seed cards land on a blank slate. `overlayTemplate` uses `cp` with
  // `force: false` so running it before initProject means nothing yet exists
  // to block the copy. Then `initProject` fills whatever the template didn't
  // ship (its own existsSync guards keep it from stomping on template files).
  await overlayTemplate(projectName, templateName);
  await initProject(projectName);
}

// ── Chat history lifecycle (live thread + per-card archives + cursor) ─────
//
// Each chat card persists its live conversation at
// `.mica/chats/<cardId>.json` (a plain array of {role, content, agent}).
// When a user "Clears" the card, the file is moved to
// `.mica/chats/archived/<cardId>/<iso>.json` and a fresh empty array replaces it.
// The card stays on canvas; only its transcript resets.
//
// The "context cursor" is an index into the live messages array. Messages
// before the cursor are history the USER can still scroll through but the
// agent does NOT see on its next turn. It advances forward only — at a
// natural arc break (detected by an `<thread-state>arc-complete</thread-state>`
// marker from the agent AND capacity > 80%) or on Clear. Persisted at
// `.mica/chats/<cardId>.cursor.json`.

function chatHistoryPath(chatId: string, project: string | null | undefined): string {
  return join(micaDir(project ?? undefined), "chats", `${chatId}.json`);
}

function chatCursorPath(chatId: string, project: string | null | undefined): string {
  return join(micaDir(project ?? undefined), "chats", `${chatId}.cursor.json`);
}

function chatArchiveDir(chatId: string, project: string | null | undefined): string {
  return join(micaDir(project ?? undefined), "chats", "archived", chatId);
}

/** Read the cursor (count of messages the agent should skip). Returns 0 if
 *  no cursor file exists. */
export async function readChatCursor(chatId: string, project: string | null | undefined): Promise<number> {
  try {
    const raw = await readFile(chatCursorPath(chatId, project), "utf-8");
    const parsed = JSON.parse(raw) as { cursor?: unknown };
    return typeof parsed.cursor === "number" && parsed.cursor >= 0 ? Math.floor(parsed.cursor) : 0;
  } catch { return 0; }
}

/** Write the cursor. Caps at `historyLen` so a stale cursor can't point
 *  past the end of the messages array. */
export async function writeChatCursor(
  chatId: string,
  project: string | null | undefined,
  cursor: number,
  historyLen?: number,
): Promise<void> {
  const safe = Math.max(0, Math.floor(cursor));
  const clamped = typeof historyLen === "number" ? Math.min(safe, historyLen) : safe;
  const path = chatCursorPath(chatId, project);
  await mkdir(dirname(path), { recursive: true });
  await atomicWriteJson(path, { cursor: clamped });
}

export interface ArchivedChatEntry {
  timestamp: string;       // ISO-ish stem of the archive filename (what was written)
  filename: string;        // raw filename (<timestamp>.json)
  size: number;            // bytes on disk
  messageCount: number;    // approx count — read+parse the file
  archivedAt: string;      // ISO mtime from the FS
}

/** Move the current live chat history to an archive file and leave the live
 *  file replaced with an empty array. Also resets the cursor to 0. Returns
 *  the archive filename (or null if there was nothing to archive). */
export async function archiveChat(
  chatId: string,
  project: string | null | undefined,
): Promise<string | null> {
  const livePath = chatHistoryPath(chatId, project);
  const cursorPath = chatCursorPath(chatId, project);
  const archiveDir = chatArchiveDir(chatId, project);

  // If there's nothing on disk, we still succeed — the card is already empty.
  let raw: string | null = null;
  try { raw = await readFile(livePath, "utf-8"); } catch { /* no live history */ }
  if (!raw || raw.trim() === "" || raw.trim() === "[]") {
    // Clear cursor even when no archive is written, so resets are idempotent.
    try { await unlink(cursorPath); } catch { /* ignore */ }
    return null;
  }

  await mkdir(archiveDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const archiveName = `${stamp}.json`;
  await writeFile(join(archiveDir, archiveName), raw, "utf-8");
  await writeFile(livePath, "[]", "utf-8");
  try { await unlink(cursorPath); } catch { /* ignore */ }
  return archiveName;
}

/** List archived conversations for one chat card, most recent first. */
export async function listArchivedChats(
  chatId: string,
  project: string | null | undefined,
): Promise<ArchivedChatEntry[]> {
  const dir = chatArchiveDir(chatId, project);
  if (!existsSync(dir)) return [];
  const names = await readdir(dir);
  const out: ArchivedChatEntry[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const p = join(dir, name);
    try {
      const s = await stat(p);
      let messageCount = 0;
      try {
        const raw = await readFile(p, "utf-8");
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) messageCount = parsed.length;
      } catch { /* best-effort */ }
      out.push({
        timestamp: name.replace(/\.json$/, ""),
        filename: name,
        size: s.size,
        messageCount,
        archivedAt: s.mtime.toISOString(),
      });
    } catch { /* skip unreadable */ }
  }
  out.sort((a, b) => b.archivedAt.localeCompare(a.archivedAt));
  return out;
}

/** Read one archived chat's messages array. Returns [] if missing/unparseable. */
export async function readArchivedChat(
  chatId: string,
  project: string | null | undefined,
  archiveName: string,
): Promise<unknown[]> {
  // Defense against traversal; archive names are generated, but validate anyway.
  if (!archiveName || archiveName.includes("/") || archiveName.includes("..")) {
    throw new Error(`Invalid archive name: ${archiveName}`);
  }
  const p = join(chatArchiveDir(chatId, project), archiveName);
  try {
    const raw = await readFile(p, "utf-8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

/** Clone a git repo into a new project directory and optionally overlay a
 *  template on top (for skills, agents, canvas-back, and seed cards). The
 *  cloned repo's files are never overwritten — the template fills gaps
 *  around them. */
export async function cloneProjectFromRepo(
  projectName: string,
  url: string,
  options: { templateName?: string; canvasRoot?: string } = {},
): Promise<void> {
  validateProjectName(projectName);
  const dst = join(WORKSPACE_DIR, projectName);
  if (existsSync(dst)) throw new Error(`Project already exists: ${projectName}`);

  console.log(`[mica] Cloning ${url} -> ${dst}`);
  await execAsync(`git clone ${JSON.stringify(url)} ${JSON.stringify(dst)}`, {
    timeout: 120000,
    maxBuffer: 10 * 1024 * 1024,
  });

  // Overlay the template BEFORE initProject. `overlayTemplate` uses
  // `cp` with `force: false`, so running it before initProject lets the
  // template's canvas-back.md / config fields land cleanly. `initProject`
  // afterwards fills any gaps (its own existsSync guards keep it from
  // replacing template content). See createProjectFromTemplate for the
  // same ordering rationale.
  if (options.templateName) {
    await overlayTemplate(projectName, options.templateName, { canvasRoot: options.canvasRoot });
  }
  await initProject(projectName, options.canvasRoot);
}
