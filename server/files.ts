// files.ts — File operations for Mica.
// Multi-project model: WORKSPACE_DIR contains project subdirectories.
// Each project has its own .mica/ metadata directory.
// File operations are scoped to a specific project within the workspace.

import { readFile, writeFile, unlink, readdir, stat, mkdir, rename, rm, cp, symlink } from "fs/promises";
import { join, relative, dirname, basename, sep } from "path";
import { existsSync } from "fs";

/** The workspace root. Defaults to /project (Docker mount point). */
export const WORKSPACE_DIR = process.env.PROJECT_DIR || "/project";

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

  const root = canvasRoot || "docs";

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

/**
 * List canvas-visible files: direct children of canvasRoot + pinned files.
 * Excludes directories. Each file is decorated with its stable UUID (`id`).
 */
export async function listCanvasFiles(project?: string): Promise<FileMeta[]> {
  const allFiles = await listFiles(project);
  const { canvasRoot, pinned } = await readCanvasConfig(project);
  const root = canvasRoot === "." ? "" : canvasRoot.replace(/\/$/, "") + "/";
  const pinnedSet = new Set(pinned);

  const filtered = allFiles
    .filter((f) => {
      if (f.type === "directory") return false;
      if (root === "") {
        if (!f.name.includes("/")) return true;
      } else if (f.name.startsWith(root) && !f.name.slice(root.length).includes("/")) {
        return true;
      }
      if (pinnedSet.has(f.name)) return true;
      return false;
    })
    .map((f) => pinnedSet.has(f.name) ? { ...f, pinned: true } : f);

  return Promise.all(filtered.map(async (f) => ({ ...f, id: await getOrCreateCardId(project, f.name) })));
}

/**
 * List all files in a project directory (recursive, metadata only).
 * Files (not directories) are decorated with their stable UUID (`id`).
 */
export async function listFiles(project?: string): Promise<FileMeta[]> {
  const root = project ? join(WORKSPACE_DIR, project) : WORKSPACE_DIR;
  if (!existsSync(root)) return [];

  const files: FileMeta[] = [];
  await scanDir(root, root, files);
  return Promise.all(files.map(async (f) => {
    if (f.type === "directory") return f;
    return { ...f, id: await getOrCreateCardId(project, f.name) };
  }));
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
export async function createProjectFromTemplate(projectName: string, templateName: string): Promise<void> {
  validateProjectName(projectName);
  if (!templateName || templateName.includes("/") || templateName.includes("..") || templateName.startsWith(".")) {
    throw new Error(`Invalid template name: ${templateName}`);
  }
  const src = join(TEMPLATES_DIR, templateName);
  const dst = join(WORKSPACE_DIR, projectName);
  if (!existsSync(src)) throw new Error(`Template not found: ${templateName}`);
  if (existsSync(dst)) throw new Error(`Project already exists: ${projectName}`);
  await cp(src, dst, { recursive: true, force: false });
  // Patch config.json's name field if the template included one
  try {
    const configPath = join(dst, ".mica", "config.json");
    const raw = await readFile(configPath, "utf-8");
    const config = JSON.parse(raw);
    config.name = projectName;
    await writeFile(configPath, JSON.stringify(config, null, 2), "utf-8");
  } catch { /* template didn't include config; initProject will create it */ }
  // Fill any missing defaults (config.json, canvas-back.md, canvas root dir)
  await initProject(projectName);

  // Record the template lineage so "Reset canvas-back to template default"
  // knows which template to read from. Idempotent — only writes if not set.
  try {
    const configPath = join(dst, ".mica", "config.json");
    const cfg = JSON.parse(await readFile(configPath, "utf-8"));
    if (!cfg.template) {
      cfg.template = templateName;
      await writeFile(configPath, JSON.stringify(cfg, null, 2), "utf-8");
    }
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

  // Pre-warm UUIDs for every seeded file. Without this, the first /api/files
  // call would lazy-backfill — fine, but eager assignment guarantees that
  // when the user opens the project, the files already have stable IDs.
  try {
    const seeded = await listFiles(projectName);
    for (const f of seeded) {
      if (f.type === "file") await getOrCreateCardId(projectName, f.name);
    }
  } catch { /* best-effort */ }
}
