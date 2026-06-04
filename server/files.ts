// files.ts — File operations for Mica.
// Multi-project model: WORKSPACE_DIR contains project subdirectories.
// Each project has its own .mica/ metadata directory.
// File operations are scoped to a specific project within the workspace.

import { readFile, writeFile, unlink, readdir, stat, mkdir, rename, rm, cp, symlink } from "fs/promises";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join, relative, dirname, basename, sep } from "path";
import { existsSync } from "fs";
import { exec as execCb } from "child_process";
import { promisify } from "util";
import { archiveSnapshots } from "./turnSnapshots.js";
import { archiveTurnEvents } from "./turnEvents.js";
import { getCurrentTenant } from "./tenantContext.js";
import { resolveInjectedKey } from "./auth/hooks.js";
import { decryptSecret } from "./auth/secrets.js";

const execAsync = promisify(execCb);

/** The workspace ROOT. Defaults to /project (Docker mount point). In
 *  single-tenant Mica this is where project subdirectories live directly. */
export const WORKSPACE_DIR = process.env.PROJECT_DIR || "/project";

/** The EFFECTIVE workspace dir for the current request/turn. Single-tenant
 *  (no tenant bound): returns WORKSPACE_DIR unchanged — byte-identical to the
 *  old `WORKSPACE_DIR` references this replaced. Multi-tenant fork (a tenant is
 *  bound via tenantContext): returns `WORKSPACE_DIR/<tenantId>`, so every
 *  project/.mica path lands one level deeper, per tenant. This is the single
 *  seam that makes the whole codebase tenant-aware without threading a param.
 *  DORMANT until a fork's middleware calls runWithTenant(). */
export function getEffectiveWorkspaceDir(): string {
  const tenantId = getCurrentTenant();
  const base = WORKSPACE_DIR;
  return tenantId ? join(base, tenantId) : base;
}

/** Workspace-shared docs directory. Files here are pinnable into any project
 *  via the `shared/` virtual prefix — see `isSharedFilename` /
 *  `resolveSharedPath`. Distinct from per-project pins (which stay
 *  project-relative) so the boundary is grep-able everywhere. */
export const SHARED_DIR = process.env.MICA_SHARED_DIR || "/workspaces/shared";

/** Virtual prefix used in `pinned` listings and layout.json keys to refer
 *  to a file under SHARED_DIR. e.g. `shared/cdn-library-catalog.md`. */
export const SHARED_PREFIX = "shared/";

/** True iff `filename` references a workspace-shared file via the
 *  `shared/` prefix. */
export function isSharedFilename(filename: string): boolean {
  return filename.startsWith(SHARED_PREFIX);
}

/** Resolve a `shared/<name>` virtual path to its absolute on-disk path
 *  under SHARED_DIR. Rejects traversal. */
export function resolveSharedPath(filename: string): string {
  if (!isSharedFilename(filename)) {
    throw new Error(`Not a shared path: ${filename}`);
  }
  const rest = filename.slice(SHARED_PREFIX.length);
  if (!rest || rest.includes("..") || rest.startsWith("/")) {
    throw new Error(`Invalid shared filename: ${filename}`);
  }
  return join(SHARED_DIR, rest);
}

export interface SharedDocSummary {
  /** Bare filename inside SHARED_DIR (e.g. "cdn-library-catalog.md"). */
  name: string;
  /** Virtual canvas-visible name including prefix. */
  virtualName: string;
  /** Absolute on-disk path. Exposed so the agent's filesystem-level
   *  `read_file` tool (which doesn't route the `shared/` virtual prefix
   *  through Mica's REST API) can read the doc directly without
   *  fumbling three different path guesses. */
  path: string;
  /** Title from frontmatter, or first H1, or the filename stem. */
  title: string;
  /** Description from frontmatter, or empty string. */
  description: string;
  /** Tags from frontmatter, or []. */
  tags: string[];
  size: number;
  modifiedAt: string;
}

/** Strip a leading YAML frontmatter block and return its parsed
 *  `shared-doc:` section plus the body. Tolerant: missing frontmatter,
 *  missing `shared-doc`, or YAML parse failures all collapse to nulls. */
async function readSharedDocFrontmatter(absPath: string, fallbackName: string): Promise<{
  title: string;
  description: string;
  tags: string[];
}> {
  let text = "";
  try {
    text = await readFile(absPath, "utf-8");
  } catch {
    return { title: stemOf(fallbackName), description: "", tags: [] };
  }
  const m = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n/);
  let title = "";
  let description = "";
  let tags: string[] = [];
  if (m) {
    try {
      const yaml = await import("js-yaml");
      const parsed = yaml.load(m[1]) as Record<string, unknown> | null;
      const sd = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>)["shared-doc"] : null;
      if (sd && typeof sd === "object") {
        const s = sd as Record<string, unknown>;
        if (typeof s.title === "string") title = s.title;
        if (typeof s.description === "string") description = s.description;
        if (Array.isArray(s.tags)) tags = s.tags.filter((t): t is string => typeof t === "string");
      }
    } catch { /* malformed YAML — fall through to heading-derived title */ }
  }
  if (!title) {
    // First H1 in the body wins; otherwise filename stem.
    const body = m ? text.slice(m[0].length) : text;
    const h1 = body.match(/^\s*#\s+(.+)$/m);
    title = h1 ? h1[1].trim() : stemOf(fallbackName);
  }
  return { title, description, tags };
}

function stemOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

/** Enumerate workspace-shared docs under SHARED_DIR. Currently scoped to
 *  the directory's direct children — no nested layout yet. Returns an
 *  empty array if SHARED_DIR doesn't exist or is unreadable. */
export async function listSharedDocs(): Promise<SharedDocSummary[]> {
  let entries: import("fs").Dirent[];
  try {
    entries = await readdir(SHARED_DIR, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: SharedDocSummary[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (!entry.isFile()) continue;
    const abs = join(SHARED_DIR, entry.name);
    let s;
    try { s = await stat(abs); } catch { continue; }
    const fm = await readSharedDocFrontmatter(abs, entry.name);
    out.push({
      name: entry.name,
      virtualName: `${SHARED_PREFIX}${entry.name}`,
      path: abs,
      title: fm.title,
      description: fm.description,
      tags: fm.tags,
      size: s.size,
      modifiedAt: s.mtime.toISOString(),
    });
  }
  return out.sort((a, b) => a.title.localeCompare(b.title));
}

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

interface ClassMeta { badge: string; meta: boolean; handler: string | null; displayName: string }
const classMetaCache = new Map<string, ClassMeta>();

export async function getCardClassMeta(ext: string, project: string | null | undefined): Promise<ClassMeta> {
  const className = ext.startsWith(".") ? ext.slice(1) : ext;
  const cacheKey = `${project ?? ""}|${className}`;
  const cached = classMetaCache.get(cacheKey);
  if (cached) return cached;

  const candidates: string[] = [];
  if (project) candidates.push(join(getEffectiveWorkspaceDir(), project, ".mica", "card-classes", className));
  // Library-project search path — same precedence as resolveCardClassDir
  // (project > library > built-in). Without this, library-resolved cards
  // appear in the list endpoint and render their HTML, but the channel
  // manager's metadata.handler lookup misses the file and falls back to
  // extension-name-as-handler — so a card declaring handler="process"
  // tries to open a channel for "gpu-monitor" and fails.
  for (const libPath of getIncludeProjects()) {
    candidates.push(join(libPath, ".mica", "card-classes", className));
  }
  candidates.push(join(process.cwd(), "card-classes", className));

  for (const dir of candidates) {
    try {
      const raw = await readFile(join(dir, "metadata.json"), "utf-8");
      const m = JSON.parse(raw) as { badge?: unknown; meta?: unknown; handler?: unknown; displayName?: unknown };
      const out: ClassMeta = {
        badge: typeof m.badge === "string" ? m.badge : "",
        meta: m.meta === true,
        handler: typeof m.handler === "string" && m.handler.length > 0 ? m.handler : null,
        displayName: typeof m.displayName === "string" ? m.displayName : "",
      };
      classMetaCache.set(cacheKey, out);
      return out;
    } catch { /* try next candidate */ }
  }
  const empty: ClassMeta = { badge: "", meta: false, handler: null, displayName: "" };
  classMetaCache.set(cacheKey, empty);
  return empty;
}

/** Clear the card-class metadata cache. Call after a card class file changes
 *  so fresh reads pick up edited metadata.json without a server restart. */
export function clearCardClassMetaCache(): void {
  classMetaCache.clear();
}

// ── Library-project card-class resolution ────────────────────
//
// A Mica project can be marked as a "library project," which makes its
// `.mica/card-classes/<name>/` available to every other project on this
// machine via the card-class resolver. The include list lives in
// `~/.mica/include-projects.json`. Card classes are edited in their home
// project (under that project's git); other projects resolve them
// transparently. No copy-on-share, no sync, no special user directory.

const INCLUDE_PROJECTS_FILE = join(homedir(), ".mica", "include-projects.json");

/** Read the user's library-project include list. Missing or malformed
 *  files return an empty list — never throw. Absolute paths only. */
export function getIncludeProjects(): string[] {
  if (!existsSync(INCLUDE_PROJECTS_FILE)) return [];
  try {
    const data = JSON.parse(readFileSync(INCLUDE_PROJECTS_FILE, "utf-8"));
    if (!data || !Array.isArray(data.include)) return [];
    return data.include.filter((p: unknown) => typeof p === "string" && p.length > 0);
  } catch (err) {
    console.warn(`[files] include-projects.json malformed: ${(err as Error).message}`);
    return [];
  }
}

/** Append a project path to the include list (idempotent). Creates the
 *  parent directory + file on first write. Clears the card-class meta
 *  cache so subsequent reads pick up the newly-visible library cards. */
export function addIncludeProject(absPath: string): void {
  const current = getIncludeProjects();
  if (current.includes(absPath)) return;
  current.push(absPath);
  mkdirSync(dirname(INCLUDE_PROJECTS_FILE), { recursive: true });
  writeFileSync(INCLUDE_PROJECTS_FILE, JSON.stringify({ include: current }, null, 2));
  clearCardClassMetaCache();
}

/** Remove a project path from the include list (idempotent). Clears the
 *  card-class meta cache so subsequent reads stop seeing the removed
 *  library's cards. */
export function removeIncludeProject(absPath: string): void {
  const current = getIncludeProjects();
  const next = current.filter((p) => p !== absPath);
  if (next.length === current.length) return;
  mkdirSync(dirname(INCLUDE_PROJECTS_FILE), { recursive: true });
  writeFileSync(INCLUDE_PROJECTS_FILE, JSON.stringify({ include: next }, null, 2));
  clearCardClassMetaCache();
}

/** Find a card class in the library-project search path. Returns the
 *  absolute path to the class directory, or null if not found. Skips
 *  libraries whose directories no longer exist. */
export function findCardClassInLibraries(className: string): { dir: string; libraryProject: string } | null {
  for (const libPath of getIncludeProjects()) {
    const classDir = join(libPath, ".mica", "card-classes", className);
    if (existsSync(join(classDir, "card.html"))) {
      return { dir: classDir, libraryProject: libPath };
    }
  }
  return null;
}

// Backwards-compatible alias used by other modules
export const PROJECT_DIR = WORKSPACE_DIR;

/** Project templates — copied to <workspace>/<projectName>/ on creation. */
export const TEMPLATES_DIR = join(process.cwd(), "templates");

/** The default canvas-root directory name. Lives in config.json as
 *  `canvasRoot`, selects where canvas-visible cards live in the project
 *  tree. Used as the fallback anywhere the value is missing from config,
 *  and as the convention templates are expected to follow for their seed
 *  files (every template under `templates/` keeps its seeds in
 *  `<template>/canvas/`). Change this and every default new project
 *  picks up the new name; existing projects with an explicit canvasRoot
 *  keep theirs. */
export const DEFAULT_CANVAS_ROOT = "canvas";

/** The default card class that renders the canvas. Stored in config.json
 *  as `canvasClass`. The card class itself lives at
 *  `card-classes/canvas/` — same name by convention. Projects can
 *  override this in config to use an alternative canvas class if one
 *  gets authored. */
export const DEFAULT_CANVAS_CLASS = "canvas";

/** Always-skip directories — build artifacts, VCS internals, package caches.
 *  Filtered regardless of `showHidden`. Listing inside these is hostile to
 *  the user (huge binary trees, generated files) and to the agent's context.
 *  If a user genuinely wants to see `.git/objects` they can use a real
 *  filesystem browser, not a Mica card.
 *
 *  Note: `.mica`, `.qwen`, `.claude` are deliberately NOT in this set —
 *  they're hidden by the dot-prefix default-filter, but a `showHidden=true`
 *  caller (the filebrowser card's "show hidden" toggle) reveals them. The
 *  user inspects Mica's own state without it being a debug port into deep
 *  internals like git objects. */
const IGNORE_DIRS = new Set([
  ".git", ".svn", ".hg",
  "node_modules", "__pycache__", ".venv", "venv",
  ".next", ".nuxt", "dist", "build", ".cache",
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
    return join(getEffectiveWorkspaceDir(), projectName, ".mica");
  }
  // Workspace-level .mica (for workspace config)
  return join(getEffectiveWorkspaceDir(), ".mica");
}

/** Get the project directory path. */
export function projectDir(projectName: string): string {
  validateProjectName(projectName);
  return join(getEffectiveWorkspaceDir(), projectName);
}

/** Get the workspace name from the directory basename. */
export function getWorkspaceName(): string {
  return basename(WORKSPACE_DIR);
}

/** Get a project's display name from its .mica config or directory name. */
export async function getProjectName(project?: string): Promise<string> {
  // Project identity = directory name. We used to read `name` from
  // .mica/config.json, but storing it in a tracked file caused drift on
  // every clone (publisher's name vs receiver's directory) — receivers
  // saw a permanent uncommitted modification they shouldn't push. The
  // directory IS the identity; the field was redundant.
  if (!project) return getWorkspaceName();
  return project;
}

export interface ProjectInfo {
  name: string;
  path: string;
  hasGit: boolean;
  hasMica: boolean;
  docsDir?: string;
  /** Wall-clock ms of the last `/api/projects/:project/open` call. Read from
   *  the mtime of `<project>/.mica/last-opened`. Undefined for projects that
   *  have never been opened (or were created before this field shipped).
   *  Drives the "Recent" sort in the project list. */
  lastOpenedAt?: number;
}

/** Path to the per-project last-opened marker. The file's mtime is the
 *  timestamp; the file content is unused. */
function lastOpenedMarkerPath(projectName: string): string {
  return join(getEffectiveWorkspaceDir(), projectName, ".mica", "last-opened");
}

/** Mark a project as just opened. Writes an empty file (or refreshes its
 *  mtime if it already exists). Best-effort — an I/O failure here shouldn't
 *  break project open. */
export async function markProjectOpened(projectName: string): Promise<void> {
  validateProjectName(projectName);
  const path = lastOpenedMarkerPath(projectName);
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "", "utf-8");
  } catch (err) {
    console.warn(`[mark-opened:${projectName}] failed: ${(err as Error).message}`);
  }
}

/** List all projects (subdirectories) in the workspace. */
export async function listProjects(): Promise<ProjectInfo[]> {
  const workspaceDir = getEffectiveWorkspaceDir();
  if (!existsSync(workspaceDir)) return [];

  const entries = await readdir(workspaceDir, { withFileTypes: true });
  const projects: ProjectInfo[] = [];

  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (!entry.isDirectory()) continue;
    if (IGNORE_DIRS.has(entry.name)) continue;

    const projPath = join(getEffectiveWorkspaceDir(), entry.name);
    const hasGit = existsSync(join(projPath, ".git"));
    const hasMica = existsSync(join(projPath, ".mica"));

    let docsDir: string | undefined;
    if (hasMica) {
      try {
        const cfg = JSON.parse(await readFile(join(projPath, ".mica", "config.json"), "utf-8"));
        docsDir = cfg.docsDir;
      } catch { /* no config */ }
    }

    let lastOpenedAt: number | undefined;
    try {
      const s = await stat(lastOpenedMarkerPath(entry.name));
      lastOpenedAt = s.mtime.getTime();
    } catch { /* never opened */ }

    projects.push({
      name: entry.name,
      path: projPath,
      hasGit,
      hasMica,
      docsDir,
      lastOpenedAt,
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

  const root = canvasRoot || DEFAULT_CANVAS_ROOT;

  // Create config.json if it doesn't exist. No `name` field — identity
  // comes from the directory name (see getProjectName).
  const configPath = join(dir, "config.json");
  if (!existsSync(configPath)) {
    const config: Record<string, unknown> = {
      canvasClass: DEFAULT_CANVAS_CLASS,
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
    await mkdir(join(getEffectiveWorkspaceDir(), projectName, root), { recursive: true });
  }
}

/** Create a new empty project directory and initialize it. */
export async function createProject(projectName: string, docsDir?: string): Promise<void> {
  validateProjectName(projectName);
  const dir = join(getEffectiveWorkspaceDir(), projectName);
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
  const oldDir = join(getEffectiveWorkspaceDir(), oldName);
  const newDir = join(getEffectiveWorkspaceDir(), newName);
  if (!existsSync(oldDir)) throw new Error(`Project not found: ${oldName}`);
  if (existsSync(newDir)) throw new Error(`Project already exists: ${newName}`);
  await rename(oldDir, newDir);
  // No config.json `name` field to sync — identity follows the directory.
}

/** Delete a project directory entirely. */
export async function deleteProject(projectName: string): Promise<void> {
  validateProjectName(projectName);
  const dir = join(getEffectiveWorkspaceDir(), projectName);
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
// the same filename (e.g. template-seeded `docs/qwen.qwen`) don't share
// state.
//
// In-memory cache is the runtime source of truth; sidecar is durability.
// Single-flight via cardIdPending eliminates the race where two concurrent
// /api/files calls both generate a UUID for the same missing sidecar.

const cardIdCache = new Map<string, string>();             // `${project}|${filename}` → uuid
const cardIdPending = new Map<string, Promise<string>>();  // single-flight

function cardIdKey(project: string | null | undefined, filename: string): string {
  // The on-disk sidecar (.mica/cards/<file>.id.json) is already tenant-scoped via
  // micaDir → getEffectiveWorkspaceDir. This in-memory cache key must ALSO carry the
  // tenant, or two tenants with a same-named project+file (e.g. everyone's seeded
  // showcase) would collide on one cache entry and share a session UUID — the
  // cross-tenant channel-session leak. Inert single-tenant: no tenant bound ⇒
  // getCurrentTenant() is undefined ⇒ key is exactly the old `${project}|${filename}`.
  const tenant = getCurrentTenant();
  const base = `${project ?? "<workspace>"}|${filename}`;
  return tenant ? `${tenant}::${base}` : base;
}

/** Server-side mirror of src/api/canvasPaths.ts canonicalizeCardPath. Translates
 *  a card-supplied (canvas-relative) path to the project-relative path the
 *  server stores on the wire / in sidecars. Used at endpoints that take a
 *  card-provided path and need to look up server-side state — sidecar reads,
 *  card-error reports, settings save/load.
 *
 *  Convention (Unix-CWD model with canvas as cwd):
 *    bare name "foo.bar"      → "<canvasRoot>/foo.bar"
 *    sub path  "sub/foo"      → "<canvasRoot>/sub/foo"
 *    escape    "../foo"       → one level above canvas
 *    absolute  "/foo"         → project-root absolute (slash stripped)
 *
 *  Idempotent on already-project-relative paths: if the input starts with
 *  `<canvasRoot>/`, it's returned as-is. Lets callers be defensive: pass
 *  whatever the client sent, get a canonical form back.
 */
export function canonicalizeCardPath(rawPath: string, canvasRoot: string): string {
  if (typeof rawPath !== "string" || !rawPath) {
    throw new Error("canonicalizeCardPath: path must be a non-empty string");
  }
  const path = rawPath.replace(/\\/g, "/");
  if (path.startsWith("/")) {
    const stripped = path.slice(1);
    if (stripped.includes("..")) {
      throw new Error(`canonicalizeCardPath: leading-slash path "${rawPath}" cannot also contain ..`);
    }
    return stripped;
  }
  // Already project-relative if it starts with <canvasRoot>/. Idempotent.
  if (canvasRoot && (path === canvasRoot || path.startsWith(canvasRoot + "/"))) {
    return path;
  }
  const baseParts = canvasRoot ? canvasRoot.split("/").filter(Boolean) : [];
  const parts = path.split("/");
  const result = [...baseParts];
  for (const p of parts) {
    if (p === "..") {
      if (result.length === 0) {
        throw new Error(`canonicalizeCardPath: path "${rawPath}" escapes the project root`);
      }
      result.pop();
    } else if (p === "." || p === "") {
      // skip
    } else {
      result.push(p);
    }
  }
  if (result.length === 0) {
    throw new Error(`canonicalizeCardPath: path "${rawPath}" resolves to project root with no filename`);
  }
  return result.join("/");
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
  provider?: "local" | "openrouter" | "openai-compat";
  model?: string;
}

/** The provider an agent card uses when its settings sidecar doesn't pin one.
 *  Single source of truth for the instantiation default — read by the agent
 *  handlers, the health probe, and the GET /api/cards/settings endpoint so the
 *  card UI's gear reflects the same default. Configured globally via
 *  MICA_DEFAULT_PROVIDER (.env); unset or unrecognized → "local". Applied as a
 *  resolution-time fallback only: an *explicit* provider in the sidecar
 *  (including "local") is always honored over this. */
export function resolveDefaultProvider(): NonNullable<CardSettings["provider"]> {
  const v = process.env.MICA_DEFAULT_PROVIDER;
  if (v === "openrouter" || v === "openai-compat" || v === "local") return v;
  return "local";
}

/** The default model for a given provider when a card's settings sidecar
 *  doesn't pin one. Single source of truth for the per-provider env-or-fallback
 *  defaults — read by the agent handlers (so turns use it) AND by
 *  GET /api/inference/defaults (so the gear UI placeholder reflects the same
 *  value). Configured via {LOCAL,OPENROUTER,OPENAI}_DEFAULT_MODEL in .env.
 *  Note: the local fallback keeps the `qwen3-vl-` prefix the qwen-code SDK
 *  requires for image modality on its SDK-facing path. */
export function resolveDefaultModel(provider: NonNullable<CardSettings["provider"]>): string {
  switch (provider) {
    // anthropic/claude-sonnet-4.5 is the workspace fallback for OpenRouter
    // because it reliably emits structured tool_calls under opencode's loop.
    // Earlier defaults (qwen/qwen3.6-35b-a3b, gpt-oss-120b, etc.) hit the
    // "reasoning channel swallows the tool call" failure mode documented in
    // opencode-ai/opencode #7185, #24316, #27210 — turn ends with output=0,
    // Mica masks it as "Done.", agent stalls without doing anything.
    case "openrouter": return process.env.OPENROUTER_DEFAULT_MODEL || "anthropic/claude-sonnet-4.5";
    case "openai-compat": return process.env.OPENAI_DEFAULT_MODEL || "deepseek/deepseek-v4-flash";
    default: return process.env.LOCAL_DEFAULT_MODEL || "qwen3-vl-local";
  }
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

export interface CanvasConfig {
  canvasRoot: string;
  pinned: string[];
  /** Bare filenames (no path) under SHARED_DIR that this project has pinned.
   *  Surfaced in `listCanvasFiles` with the `shared/` virtual prefix; the
   *  prefix is the boundary at file-read time. Separate from `pinned` so
   *  the existing project-relative semantics stay untouched and the
   *  workspace-vs-project distinction is grep-able everywhere. */
  sharedPinned: string[];
}

/** Read canvas config (canvasRoot, pinned, sharedPinned) from .mica/config.json. */
export async function readCanvasConfig(project?: string): Promise<CanvasConfig> {
  // Default matches initProject's default (DEFAULT_CANVAS_ROOT). Older
  // projects whose config explicitly carries `canvasRoot: "docs"` still
  // work — this fallback only kicks in for configs that omit the field
  // entirely.
  const defaults: CanvasConfig = {
    canvasRoot: DEFAULT_CANVAS_ROOT,
    pinned: [],
    sharedPinned: [],
  };
  try {
    const configPath = project
      ? join(getEffectiveWorkspaceDir(), project, ".mica", "config.json")
      : join(getEffectiveWorkspaceDir(), ".mica", "config.json");
    const raw = await readFile(configPath, "utf-8");
    const cfg = JSON.parse(raw);
    return {
      canvasRoot: cfg.canvasRoot || cfg.docsDir || defaults.canvasRoot,
      pinned: Array.isArray(cfg.pinned) ? cfg.pinned : defaults.pinned,
      sharedPinned: Array.isArray(cfg.sharedPinned) ? cfg.sharedPinned : defaults.sharedPinned,
    };
  } catch {
    return defaults;
  }
}

/** Update canvas config fields in .mica/config.json (merges with existing). */
export async function updateCanvasConfig(
  project: string | undefined,
  updates: { canvasRoot?: string; pinned?: string[]; sharedPinned?: string[] },
): Promise<void> {
  const configPath = project
    ? join(getEffectiveWorkspaceDir(), project, ".mica", "config.json")
    : join(getEffectiveWorkspaceDir(), ".mica", "config.json");
  let cfg: Record<string, unknown> = {};
  try {
    cfg = JSON.parse(await readFile(configPath, "utf-8"));
  } catch { /* start fresh */ }
  if (updates.canvasRoot !== undefined) cfg.canvasRoot = updates.canvasRoot;
  if (updates.pinned !== undefined) cfg.pinned = updates.pinned;
  if (updates.sharedPinned !== undefined) cfg.sharedPinned = updates.sharedPinned;
  await writeFile(configPath, JSON.stringify(cfg, null, 2), "utf-8");
}

/** Read the OpenRouter API key. Resolution order:
 *    1. Per-project `<project>/.mica/config.json:openrouterApiKey`
 *       (set via the chat card gear UI — the per-project override).
 *    2. Workspace `<workspace>/.mica/credentials.json:openrouter.api_key`
 *       (set via the Connections panel — the canonical workspace home).
 *    3. Legacy workspace `<workspace>/.mica/config.json:openrouterApiKey`
 *       (pre-Connections setups; kept for backwards-compatibility).
 *    4. `OPENROUTER_API_KEY` environment variable (populated from `.env`
 *       by the dotenv load in server/index.ts, or from ambient env).
 *  Returns null when none of the four are set. Reads credentials.json
 *  directly rather than importing connections.ts to avoid a module
 *  cycle (connections.ts already imports WORKSPACE_DIR/micaDir from here). */
export async function readOpenRouterKey(project: string | undefined): Promise<string | null> {
  // 0. Injected resolver (multi-tenant fork: sponsor / per-tenant token). Returns
  //    undefined in main (no resolver registered) ⇒ fall through to the normal
  //    config → credentials → env chain unchanged.
  const injected = await resolveInjectedKey({ provider: "openrouter", project, tenant: getCurrentTenant() });
  if (injected) return injected;
  // 1. Per-project override.
  if (project) {
    try {
      const cfg = JSON.parse(await readFile(join(getEffectiveWorkspaceDir(), project, ".mica", "config.json"), "utf-8"));
      if (typeof cfg.openrouterApiKey === "string" && cfg.openrouterApiKey.length > 0) {
        return cfg.openrouterApiKey;
      }
    } catch { /* no project override — fall through */ }
  }
  // 2. Workspace credentials.json (Connections panel home).
  try {
    const credRaw = await readFile(join(getEffectiveWorkspaceDir(), ".mica", "credentials.json"), "utf-8");
    const creds = JSON.parse(decryptSecret(credRaw));
    const entry = creds && typeof creds === "object" ? creds.openrouter : undefined;
    if (entry && typeof entry.api_key === "string" && entry.api_key.length > 0) {
      return entry.api_key;
    }
  } catch { /* no credentials.json or no openrouter entry */ }
  // 3. Legacy workspace config.json (pre-Connections setups).
  try {
    const cfg = JSON.parse(await readFile(join(getEffectiveWorkspaceDir(), ".mica", "config.json"), "utf-8"));
    if (typeof cfg.openrouterApiKey === "string" && cfg.openrouterApiKey.length > 0) {
      return cfg.openrouterApiKey;
    }
  } catch { /* no legacy workspace config */ }
  // 4. Env var.
  const envKey = process.env.OPENROUTER_API_KEY;
  return typeof envKey === "string" && envKey.length > 0 ? envKey : null;
}

/** Read the Google Gemini API key (Google AI Studio). Same four-step
 *  resolution as readOpenRouterKey: per-project config.json:geminiApiKey →
 *  workspace credentials.json:gemini.api_key → legacy workspace
 *  config.json:geminiApiKey → GEMINI_API_KEY env. Returns null if unset.
 *  One key powers both the gemini-media tools and (when wired) the
 *  openai-compat chat route. */
export async function readGeminiKey(project: string | undefined): Promise<string | null> {
  if (project) {
    try {
      const cfg = JSON.parse(await readFile(join(WORKSPACE_DIR, project, ".mica", "config.json"), "utf-8"));
      if (typeof cfg.geminiApiKey === "string" && cfg.geminiApiKey.length > 0) return cfg.geminiApiKey;
    } catch { /* no project override */ }
  }
  try {
    const creds = JSON.parse(await readFile(join(WORKSPACE_DIR, ".mica", "credentials.json"), "utf-8"));
    const entry = creds && typeof creds === "object" ? creds.gemini : undefined;
    if (entry && typeof entry.api_key === "string" && entry.api_key.length > 0) return entry.api_key;
  } catch { /* no credentials.json or no gemini entry */ }
  try {
    const cfg = JSON.parse(await readFile(join(WORKSPACE_DIR, ".mica", "config.json"), "utf-8"));
    if (typeof cfg.geminiApiKey === "string" && cfg.geminiApiKey.length > 0) return cfg.geminiApiKey;
  } catch { /* no legacy workspace config */ }
  const envKey = process.env.GEMINI_API_KEY;
  return typeof envKey === "string" && envKey.length > 0 ? envKey : null;
}

/** Write or clear the project-wide OpenRouter API key in .mica/config.json. Empty string clears. */
export async function writeOpenRouterKey(project: string | undefined, key: string): Promise<void> {
  const configPath = project
    ? join(getEffectiveWorkspaceDir(), project, ".mica", "config.json")
    : join(getEffectiveWorkspaceDir(), ".mica", "config.json");
  await mkdir(dirname(configPath), { recursive: true });
  let cfg: Record<string, unknown> = {};
  try {
    cfg = JSON.parse(await readFile(configPath, "utf-8"));
  } catch { /* start fresh */ }
  if (key.length === 0) delete cfg.openrouterApiKey;
  else cfg.openrouterApiKey = key;
  await writeFile(configPath, JSON.stringify(cfg, null, 2), "utf-8");
}

/** Read the project-wide OpenAI-compatible endpoint configuration:
 *  base URL + API key. Stored alongside the OpenRouter key in
 *  `.mica/config.json` for the project. Returns `{baseUrl: null,
 *  key: null}` when nothing's set. Both fields are persisted together
 *  because they describe one connection (e.g. api.openai.com vs
 *  api.together.xyz vs a self-hosted endpoint). Resolution order
 *  matches OpenRouter: per-project config.json → workspace config →
 *  env vars (OPENAI_BASE_URL / OPENAI_API_KEY). */
export async function readOpenAICompatConfig(
  project: string | undefined,
): Promise<{ baseUrl: string | null; key: string | null }> {
  let baseUrl: string | null = null;
  let key: string | null = null;
  // Injected resolver (fork: sponsor / per-tenant key). Undefined in main ⇒
  // fall through. Only the key is injected; baseUrl still resolves from config/env.
  const injectedKey = await resolveInjectedKey({ provider: "openai-compat", project, tenant: getCurrentTenant() });
  if (injectedKey) key = injectedKey;
  // Per-project override.
  if (project) {
    try {
      const cfg = JSON.parse(await readFile(join(getEffectiveWorkspaceDir(), project, ".mica", "config.json"), "utf-8"));
      if (typeof cfg.openaiCompatBaseUrl === "string" && cfg.openaiCompatBaseUrl.length > 0) baseUrl = cfg.openaiCompatBaseUrl;
      if (!key && typeof cfg.openaiCompatApiKey === "string" && cfg.openaiCompatApiKey.length > 0) key = cfg.openaiCompatApiKey;
    } catch { /* no project override */ }
  }
  // Workspace fallback.
  if (!baseUrl || !key) {
    try {
      const cfg = JSON.parse(await readFile(join(getEffectiveWorkspaceDir(), ".mica", "config.json"), "utf-8"));
      if (!baseUrl && typeof cfg.openaiCompatBaseUrl === "string" && cfg.openaiCompatBaseUrl.length > 0) baseUrl = cfg.openaiCompatBaseUrl;
      if (!key && typeof cfg.openaiCompatApiKey === "string" && cfg.openaiCompatApiKey.length > 0) key = cfg.openaiCompatApiKey;
    } catch { /* no workspace config */ }
  }
  // Env var fallbacks. Matches the convention OpenAI client libraries
  // already follow so a user with these in `.env` doesn't need to repeat
  // them in the gear panel.
  if (!baseUrl && typeof process.env.OPENAI_BASE_URL === "string" && process.env.OPENAI_BASE_URL.length > 0) {
    baseUrl = process.env.OPENAI_BASE_URL;
  }
  if (!key && typeof process.env.OPENAI_API_KEY === "string" && process.env.OPENAI_API_KEY.length > 0) {
    key = process.env.OPENAI_API_KEY;
  }
  // One-key Gemini fallback: when openai-compat is entirely unconfigured but a
  // GEMINI_API_KEY is present, route openai-compat to Google's OpenAI-compatible
  // endpoint with that key. Lets the gemini-showcase template run chat on
  // gemini-3.5-flash with ONE key (which also powers the media tools).
  // Centralized here so every consumer — the model-health probe, the opencode
  // env injection, and render_capture's captioner routing — resolves it
  // consistently. Explicit openai-compat config (above) always wins.
  if (!baseUrl && !key) {
    const gk = await readGeminiKey(project);
    if (gk) {
      baseUrl = "https://generativelanguage.googleapis.com/v1beta/openai/";
      key = gk;
    }
  }
  return { baseUrl, key };
}

/** Persist OpenAI-compatible config to `.mica/config.json`. Empty
 *  string clears that field. Both fields are independent — caller
 *  may pass `null` to leave a field untouched. */
export async function writeOpenAICompatConfig(
  project: string | undefined,
  cfg: { baseUrl?: string | null; key?: string | null },
): Promise<void> {
  const configPath = project
    ? join(getEffectiveWorkspaceDir(), project, ".mica", "config.json")
    : join(getEffectiveWorkspaceDir(), ".mica", "config.json");
  await mkdir(dirname(configPath), { recursive: true });
  let stored: Record<string, unknown> = {};
  try {
    stored = JSON.parse(await readFile(configPath, "utf-8"));
  } catch { /* start fresh */ }
  if (cfg.baseUrl !== undefined && cfg.baseUrl !== null) {
    if (cfg.baseUrl.length === 0) delete stored.openaiCompatBaseUrl;
    else stored.openaiCompatBaseUrl = cfg.baseUrl;
  }
  if (cfg.key !== undefined && cfg.key !== null) {
    if (cfg.key.length === 0) delete stored.openaiCompatApiKey;
    else stored.openaiCompatApiKey = cfg.key;
  }
  await writeFile(configPath, JSON.stringify(stored, null, 2), "utf-8");
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
  const { canvasRoot, pinned, sharedPinned } = await readCanvasConfig(project);
  const projectRoot = project ? join(getEffectiveWorkspaceDir(), project) : getEffectiveWorkspaceDir();
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

  // 3. Workspace-shared pins. Surfaced under the `shared/` virtual prefix.
  // Resolution and read/write routing happen in resolveFilePath; the canvas
  // listing here just exposes them as files the agent and UI can discover.
  // Missing files (catalog removed, pin stale) are silently skipped — pin
  // hygiene is the user's job via the discovery card.
  for (const name of sharedPinned) {
    if (!name || name.includes("/") || name.includes("..")) continue;
    const virtualName = `${SHARED_PREFIX}${name}`;
    if (seen.has(virtualName)) continue;
    try {
      const s = await stat(join(SHARED_DIR, name));
      if (s.isFile()) {
        out.push({
          name: virtualName,
          type: "file",
          size: s.size,
          modifiedAt: s.mtime.toISOString(),
          pinned: true,
        });
        seen.add(virtualName);
      }
    } catch { /* shared file missing — skip */ }
  }

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
export async function listFiles(project?: string, opts: { showHidden?: boolean } = {}): Promise<FileMeta[]> {
  const root = project ? join(getEffectiveWorkspaceDir(), project) : getEffectiveWorkspaceDir();
  if (!existsSync(root)) return [];

  const files: FileMeta[] = [];
  await scanDir(root, root, files, !!opts.showHidden);
  return files;
}

async function scanDir(dir: string, root: string, files: FileMeta[], showHidden: boolean): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    // Default: hide dot-prefixed entries (Unix convention).
    // showHidden=true reveals dot-prefixed entries including Mica/agent state
    // dirs (.mica, .qwen, .claude — see REVEALABLE_DOT_DIRS) but does NOT
    // affect the always-skip list (.git, .next, node_modules, etc.) which
    // are build-noise the user never wants in a project file browser.
    if (!showHidden && entry.name.startsWith(".")) continue;
    if (IGNORE_DIRS.has(entry.name)) continue;

    const fullPath = join(dir, entry.name);
    const relPath = relative(root, fullPath);

    if (entry.isDirectory()) {
      try {
        const dirStat = await stat(fullPath);
        files.push({
          name: relPath,
          type: "directory",
          size: 0,
          modifiedAt: dirStat.mtime.toISOString(),
        });
      } catch { /* skip unreadable */ }
      await scanDir(fullPath, root, files, showHidden);
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
  if (isSharedFilename(filename)) return resolveSharedPath(filename);
  validateFilename(filename);
  const root = project ? join(getEffectiveWorkspaceDir(), project) : getEffectiveWorkspaceDir();
  return join(root, filename);
}

/**
 * Read a single file as text from a project directory.
 * Used server-side for AI context building, chat, etc.
 */
export async function readProjectFile(filename: string, project?: string): Promise<FileInfo> {
  const filePath = isSharedFilename(filename)
    ? resolveSharedPath(filename)
    : (validateFilename(filename), join(project ? join(getEffectiveWorkspaceDir(), project) : getEffectiveWorkspaceDir(), filename));
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
  const filePath = isSharedFilename(filename)
    ? resolveSharedPath(filename)
    : (validateFilename(filename), join(project ? join(getEffectiveWorkspaceDir(), project) : getEffectiveWorkspaceDir(), filename));
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf-8");
}

/**
 * Delete a file from a project directory.
 */
export async function deleteProjectFile(filename: string, project?: string): Promise<void> {
  if (isSharedFilename(filename)) {
    // Workspace-shared files are not deletable through a project's file API.
    // Use the discovery card or the workspace filesystem directly.
    throw new Error(`Shared files cannot be deleted through a project context: ${filename}`);
  }
  validateFilename(filename);
  const root = project ? join(getEffectiveWorkspaceDir(), project) : getEffectiveWorkspaceDir();
  await unlink(join(root, filename));
}

// ── Validation ──────────────────────────────────────────────

export function validateProjectName(name: string): void {
  if (!name || name.includes("/") || name.includes("\\") || name.includes("..") || name.startsWith(".")) {
    throw new Error(`Invalid project name: ${name}`);
  }
}

/** True for credential-bearing files that must never be served through the
 *  generic file API or read by an agent file tool. `.mica/credentials.json`
 *  (Connections panel store) and `.mica/config.json` (holds per-project /
 *  legacy provider keys) both carry secrets; nothing legitimate reads them via
 *  the file path (dedicated endpoints + internal direct-join reads handle them),
 *  so blocking here is a pure hardening. ALWAYS ON — protects single-tenant BYO
 *  keys from a prompt-injected card, and is the linchpin of the sponsored-token
 *  "use but not copy" guarantee (the sponsor token itself lives outside the
 *  workspace tree entirely). */
export function isProtectedCredentialPath(filename: string): boolean {
  const normalized = filename.split(sep).join("/").toLowerCase();
  return /(^|\/)\.mica\/(credentials|config)\.json$/.test(normalized);
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
  // Credential read/write guard (always-on). The file API + agent file tools
  // funnel through here; internal key resolution (readOpenRouterKey) and the
  // Connections panel use direct fs joins that bypass this, so they're
  // unaffected. See isProtectedCredentialPath.
  if (isProtectedCredentialPath(normalized)) {
    throw new Error(`Access to credential files is not permitted: ${filename}`);
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
  const projSkillsDir = join(getEffectiveWorkspaceDir(), project, ".qwen", "skills");
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
  return join(getEffectiveWorkspaceDir(), project, ".qwen", "skills", name, "SKILL.md");
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
    if (!e.isDirectory() || e.name.startsWith(".") || e.name.startsWith("_")) continue;
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
  const dst = join(getEffectiveWorkspaceDir(), projectName);
  if (!existsSync(src)) throw new Error(`Template not found: ${templateName}`);
  if (!existsSync(dst)) throw new Error(`Project directory does not exist: ${projectName}`);

  // Templates store their seed canvas files in `<DEFAULT_CANVAS_ROOT>/`
  // by convention. Read from there; remap to the project's canvas root
  // if the caller chose a different name.
  const templateCanvasRoot = DEFAULT_CANVAS_ROOT;
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

  // Patch config.json: canvasRoot override, template lineage. Keeps any
  // other fields the template or initProject already wrote. No `name` —
  // identity follows the directory.
  try {
    const configPath = join(dst, ".mica", "config.json");
    let config: Record<string, unknown> = {};
    if (existsSync(configPath)) {
      try { config = JSON.parse(await readFile(configPath, "utf-8")); } catch { /* ignore parse errors */ }
    }
    delete config.name;
    // Always write canvasRoot so downstream readers (readCanvasConfig, the
    // canvas card's card.js) don't fall back to their legacy "docs" default
    // when the template's seeds actually live in "canvas/" (or wherever the
    // caller specified). `targetCanvasRoot` is already the right value
    // whether or not options.canvasRoot was passed.
    config.canvasRoot = targetCanvasRoot;
    if (!config.canvasClass) config.canvasClass = DEFAULT_CANVAS_CLASS;
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

  // Apply template-declared default card settings. A template may ship
  // `.mica/card-defaults.json` mapping a canvas-relative filename to
  // { provider, model } — e.g. to pin its agent card to a specific model.
  // Applied AFTER the id-prewarm so each project keeps a UNIQUE id:
  // writeCardSettings preserves the freshly-minted id and only sets
  // `.settings` (getOrCreateCardId never persists settings, and a fixed
  // shipped id would collide across projects — hence this indirection).
  // No-op for templates that don't ship the file, so existing templates
  // are byte-for-byte unaffected.
  try {
    const defaultsPath = join(src, ".mica", "card-defaults.json");
    if (existsSync(defaultsPath)) {
      const raw = JSON.parse(await readFile(defaultsPath, "utf-8")) as Record<string, unknown>;
      for (const [rawFilename, rawSettings] of Object.entries(raw)) {
        // Remap the template's canvas-root prefix to the project's if they differ.
        const filename =
          targetCanvasRoot !== templateCanvasRoot && rawFilename.startsWith(templateCanvasRoot + "/")
            ? targetCanvasRoot + rawFilename.slice(templateCanvasRoot.length)
            : rawFilename;
        const s = (rawSettings && typeof rawSettings === "object") ? (rawSettings as Record<string, unknown>) : {};
        const settings: CardSettings = {};
        if (s.provider === "local" || s.provider === "openrouter" || s.provider === "openai-compat") settings.provider = s.provider;
        if (typeof s.model === "string" && s.model.trim()) settings.model = s.model.trim();
        if (settings.provider || settings.model) {
          await writeCardSettings(projectName, filename, settings);
        }
      }
    }
  } catch (err) {
    console.warn(`[overlayTemplate] card-defaults.json apply failed for ${templateName}: ${(err as Error).message}`);
  }
}

export async function createProjectFromTemplate(projectName: string, templateName: string): Promise<void> {
  validateProjectName(projectName);
  const dst = join(getEffectiveWorkspaceDir(), projectName);
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

/** Persisted-queue helpers for the chat agent's per-card pending-message
 *  queue. The queue file lives at `.mica/chats/<chatId>.queue.json` and
 *  carries an array of structured items (see `QueuedItem` in
 *  server/micaAgent.ts). Used to survive server restarts: anything queued
 *  but not-yet-processed is restored on next session-create. The in-flight
 *  turn at restart time is gone (its message was already shifted out of
 *  the queue when processing started), but everything queued behind it
 *  comes back. */

function chatQueuePath(chatId: string, project: string | null | undefined): string {
  return join(micaDir(project ?? undefined), "chats", `${chatId}.queue.json`);
}

export async function loadChatQueue<T>(
  chatId: string,
  project: string | null | undefined,
): Promise<T[]> {
  try {
    const raw = await readFile(chatQueuePath(chatId, project), "utf-8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

export async function saveChatQueue<T>(
  chatId: string,
  items: T[],
  project: string | null | undefined,
): Promise<void> {
  const dir = join(micaDir(project ?? undefined), "chats");
  await mkdir(dir, { recursive: true });
  await atomicWriteJson(chatQueuePath(chatId, project), items);
}

/** Read the live chat history's message count. Returns 0 if no history
 *  file exists or the file is empty/corrupt. Used by the manual advance-
 *  cursor endpoint to set cursor = current length. */
export async function readChatHistoryLength(
  chatId: string,
  project: string | null | undefined,
): Promise<number> {
  try {
    const raw = await readFile(chatHistoryPath(chatId, project), "utf-8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch { return 0; }
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
  const archiveStampBase = join(archiveDir, stamp);
  await writeFile(join(archiveDir, archiveName), raw, "utf-8");
  await writeFile(livePath, "[]", "utf-8");
  try { await unlink(cursorPath); } catch { /* ignore */ }

  // Archive per-turn snapshots + filtered metrics alongside the chat JSON.
  // Snapshots move to <archiveDir>/<stamp>-snapshots/. Turn/subagent records
  // for the archived turn_ids get filtered out of the live JSONLs and
  // copied into <archiveDir>/<stamp>-turns.jsonl + <stamp>-subagents.jsonl.
  // All best-effort — failures don't break the chat clear.
  try {
    const archivedTurnIds = await archiveSnapshots(project ?? null, chatId, archiveStampBase);
    if (archivedTurnIds.length > 0 && project) {
      await archiveMetricsForTurns(project, archivedTurnIds, archiveStampBase);
    }
    // Move turn-*.events.jsonl files into <archiveDir>-events/. Mirrors the
    // snapshots archive shape so a chat's full record (transcript +
    // snapshots + events) stays together post-clear.
    await archiveTurnEvents(project ?? null, chatId, archiveStampBase);
  } catch (err) {
    console.warn(`[archive-chat] aux archive (snapshots/metrics/events) failed for ${chatId}:`, (err as Error).message);
  }

  return archiveName;
}

/** Filter per-turn metric records into per-archive sidecars. Reads
 *  `.mica/metrics/turns.jsonl` and `subagents.jsonl`, partitions each line
 *  by whether its turn_id is in `turnIds`, writes the matching subset to
 *  `<archiveStampBase>-turns.jsonl` / `-subagents.jsonl`, and rewrites the
 *  live JSONLs without those lines. Idempotent on missing files. */
async function archiveMetricsForTurns(
  project: string,
  turnIds: string[],
  archiveStampBase: string,
): Promise<void> {
  const turnIdSet = new Set(turnIds);
  const metricsDir = join(micaDir(project), "metrics");
  for (const [filename, suffix] of [["turns.jsonl", "-turns.jsonl"], ["subagents.jsonl", "-subagents.jsonl"]] as const) {
    const livePath = join(metricsDir, filename);
    if (!existsSync(livePath)) continue;
    let raw: string;
    try { raw = await readFile(livePath, "utf-8"); } catch { continue; }
    const lines = raw.split("\n");
    const matched: string[] = [];
    const kept: string[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line) as { turn_id?: string };
        if (rec.turn_id && turnIdSet.has(rec.turn_id)) matched.push(line);
        else kept.push(line);
      } catch {
        kept.push(line); // unparseable; keep as-is
      }
    }
    if (matched.length === 0) continue;
    await writeFile(`${archiveStampBase}${suffix}`, matched.join("\n") + "\n", "utf-8");
    await writeFile(livePath, kept.length > 0 ? kept.join("\n") + "\n" : "", "utf-8");
  }
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
  const dst = join(getEffectiveWorkspaceDir(), projectName);
  if (existsSync(dst)) throw new Error(`Project already exists: ${projectName}`);

  console.log(`[mica] Cloning ${url} -> ${dst}`);
  await execAsync(`git clone ${JSON.stringify(url)} ${JSON.stringify(dst)}`, {
    timeout: 120000,
    maxBuffer: 10 * 1024 * 1024,
  });

  // Strip any legacy `name` field from the cloned .mica/config.json.
  // Older projects shipped the field; we now derive identity from the
  // directory (see getProjectName). Removing it on clone prevents
  // receivers from seeing a phantom uncommitted change every time.
  const clonedConfigPath = join(dst, ".mica", "config.json");
  if (existsSync(clonedConfigPath)) {
    try {
      const raw = await readFile(clonedConfigPath, "utf-8");
      const cfg = JSON.parse(raw) as Record<string, unknown>;
      if ("name" in cfg) {
        delete cfg.name;
        await writeFile(clonedConfigPath, JSON.stringify(cfg, null, 2), "utf-8");
      }
    } catch (err) {
      console.warn(`[mica] could not strip legacy name from cloned config.json: ${(err as Error).message}`);
    }
  }

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
