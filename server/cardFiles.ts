// Card file management — filesystem CRUD for cards and infrastructure files.
// Every card is a directory named {name}.{class}/ containing a primary file
// and optional supporting files. Cards live inside the canvas card directory.
// Infrastructure files (.dot-prefixed) live in {project}/.mica/.

import { readdir, readFile, writeFile, unlink, mkdir, stat, rm } from "fs/promises";
import { readFileSync, existsSync, statSync, readdirSync } from "fs";
import { join, basename, extname } from "path";

import {
  getProjectPath,
  getCanvasDir,
  getInfraDir,
  listProjects as listConnectedProjects,
  getProjectConfig as getConnectedConfig,
  validateProjectCanvas as validateConnected,
  addCanvasToProject as addConnectedCanvas,
  disconnectProject as disconnectConnected,
  type ConnectedProject,
} from "./projectConnection.js";

// Re-export for backward compatibility — consumers import from canvasFiles
export type ProjectConfig = ConnectedProject;
export type CanvasId = string;

export const listProjects = listConnectedProjects;
export const getProjectConfig = getConnectedConfig;
export const validateProjectCanvas = validateConnected;
export const addCanvasToProject = addConnectedCanvas;
export const deleteProject = disconnectConnected;

// ── Dynamic extension registry ──────────────────────────────

const CARD_CLASSES_DIR = join(process.cwd(), "card-classes");
let _cachedExtensions: string[] | null = null;
let _cachedManifest: Record<string, ManifestEntry> | null = null;

interface ManifestEntry {
  extension?: string;
  primaryFile?: string;
  badge?: string;
  defaultTitle?: string;
  network?: boolean;
}

/**
 * Extract metadata from a render.js file by parsing the source text.
 * Looks for: export const metadata = { ... };
 */
function extractMetadata(renderJsPath: string): ManifestEntry | null {
  try {
    const source = readFileSync(renderJsPath, "utf-8");
    const match = source.match(/export\s+const\s+metadata\s*=\s*(\{[^}]+\})/);
    if (!match) return null;
    // Parse the object literal (it's simple key-value pairs)
    const fn = new Function(`return ${match[1]}`);
    return fn() as ManifestEntry;
  } catch {
    return null;
  }
}

/**
 * Scan card class directories and build manifest from metadata exports.
 * Scans built-in card-classes/ and optional project-level .mica/.card-classes/.
 */
function loadManifest(projectPath?: string): Record<string, ManifestEntry> {
  if (_cachedManifest && !projectPath) return _cachedManifest;

  const manifest: Record<string, ManifestEntry> = {};

  // Scan built-in card classes
  try {
    const entries = readdirSync(CARD_CLASSES_DIR);
    for (const entry of entries) {
      const renderJs = join(CARD_CLASSES_DIR, entry, "render.js");
      if (existsSync(renderJs)) {
        const meta = extractMetadata(renderJs);
        if (meta) manifest[entry] = meta;
      }
    }
  } catch { /* card-classes dir may not exist */ }

  // Scan project-level card classes (override built-in)
  if (projectPath) {
    const projectClassesDir = join(projectPath, ".mica", ".card-classes");
    try {
      const entries = readdirSync(projectClassesDir);
      for (const entry of entries) {
        const renderJs = join(projectClassesDir, entry, "render.js");
        if (existsSync(renderJs)) {
          const meta = extractMetadata(renderJs);
          if (meta) {
            manifest[entry] = { ...manifest[entry], ...meta };
          }
        }
      }
    } catch { /* no project card classes */ }
  }

  if (!projectPath) _cachedManifest = manifest;
  return manifest;
}

/** Get valid file extensions from the manifest. */
export function getValidExtensions(projectPath?: string): string[] {
  if (_cachedExtensions && !projectPath) return _cachedExtensions;
  const manifest = loadManifest(projectPath);
  const exts = new Set<string>();
  for (const entry of Object.values(manifest)) {
    if (entry.extension) exts.add(entry.extension);
  }
  exts.add(".json"); // Always valid for data files
  const result = [...exts];
  if (!projectPath) _cachedExtensions = result;
  return result;
}

/** Resolve the primary file name for a card class. */
export function getPrimaryFile(cardClass: string, projectPath?: string): string {
  const manifest = loadManifest(projectPath);
  return manifest[cardClass]?.primaryFile || "content";
}

/** Get the extension for a card class name (e.g. "simple-project" → ".project"). */
export function getCardClassExtension(cardClass: string, projectPath?: string): string | null {
  const manifest = loadManifest(projectPath);
  return manifest[cardClass]?.extension || null;
}

/** Resolve card class from a card directory name (extension lookup). */
export function resolveCardClassFromFilename(filename: string, projectPath?: string): string {
  const ext = extname(filename);
  const manifest = loadManifest(projectPath);
  for (const [className, entry] of Object.entries(manifest)) {
    if (entry.extension === ext) return className;
  }
  return "text";
}

/** Call when manifest changes to refresh caches. */
export function invalidateExtensionCache(): void {
  _cachedExtensions = null;
  _cachedManifest = null;
}

export interface CanvasFile {
  name: string;
  type: "text" | "markdown" | "mermaid";
  content: string;
  modifiedAt: string;
}

function extToType(ext: string): "text" | "markdown" | "mermaid" {
  if (ext === ".md") return "markdown";
  if (ext === ".mmd") return "mermaid";
  return "text";
}

// ── Validation ──────────────────────────────────────────────

function validateFilename(filename: string, projectPath?: string): void {
  const base = basename(filename);
  if (base !== filename || filename.includes("..") || filename.includes("/")) {
    throw new Error(`Invalid filename: ${filename}`);
  }
  // Dot-prefixed files (infrastructure) skip extension validation
  if (filename.startsWith(".")) return;
  const ext = extname(filename);
  const validExts = getValidExtensions(projectPath);
  if (!validExts.includes(ext)) {
    throw new Error(
      `Invalid extension: ${ext}. Must be one of: ${validExts.join(", ")}`
    );
  }
}

// ── File operations ────────────────────────────────────────
// Card files are directories at project root level: {name}.{class}/
// Infrastructure files (dot-prefixed) live in .mica/.

/** Resolve the directory for a file — infrastructure (.dot files) goes to .mica/, cards go to project root */
async function resolveFileDir(project: string, canvas: string, filename: string): Promise<string> {
  if (filename.startsWith(".")) {
    return getInfraDir(project, canvas);
  }
  return getCanvasDir(project, canvas);
}

export async function ensureCanvasDir(project: string, canvas: string): Promise<string> {
  const dir = await getCanvasDir(project, canvas);
  await mkdir(dir, { recursive: true });
  // Also ensure infra dir exists
  const infraDir = await getInfraDir(project, canvas);
  await mkdir(infraDir, { recursive: true });
  return dir;
}

/** Check if a path is a card directory (has a valid card extension). */
function isCardDirectory(name: string, fullPath: string, validExts: string[]): boolean {
  const ext = extname(name);
  if (!validExts.includes(ext)) return false;
  try {
    return statSync(fullPath).isDirectory();
  } catch {
    return false;
  }
}

/**
 * List all cards in a canvas. Each card is a directory — reads the primary file from inside.
 * Also includes legacy flat files for backward compatibility during migration.
 */
export async function listFiles(project: string, canvas: string): Promise<CanvasFile[]> {
  const dir = await ensureCanvasDir(project, canvas);
  let projectPath: string | undefined;
  try { projectPath = await getProjectPath(project); } catch { /* fallback */ }
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  const validExts = getValidExtensions(projectPath);
  const files: CanvasFile[] = [];

  for (const name of entries) {
    if (name.startsWith(".")) continue;
    const ext = extname(name);
    if (!validExts.includes(ext)) continue;

    const fullPath = join(dir, name);
    let content = "";
    let modifiedAt = new Date().toISOString();

    try {
      const stats = await stat(fullPath);
      if (stats.isDirectory()) {
        // Card directory — read primary file from inside
        const cardClass = resolveCardClassFromFilename(name, projectPath);
        const primaryFile = getPrimaryFile(cardClass, projectPath);
        const primaryPath = join(fullPath, primaryFile);
        try {
          content = await readFile(primaryPath, "utf-8");
          const primaryStats = await stat(primaryPath);
          modifiedAt = primaryStats.mtime.toISOString();
        } catch {
          // Primary file doesn't exist yet — empty content
          content = "";
          modifiedAt = stats.mtime.toISOString();
        }
      } else {
        // Flat file in the canvas directory — this is an internal file (e.g. the
        // canvas card's own primary file), not a child card. Skip it.
        continue;
      }
    } catch {
      continue;
    }

    files.push({
      name,
      type: extToType(ext),
      content,
      modifiedAt,
    });
  }

  return files.sort(
    (a, b) =>
      new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime()
  );
}

/**
 * Read a card's primary content. Handles both directory cards and legacy flat files.
 * For dot-prefixed files (infrastructure), reads directly from .mica/.
 */
export async function readCanvasFile(
  project: string,
  canvas: string,
  filename: string
): Promise<CanvasFile> {
  let projectPath: string | undefined;
  try { projectPath = await getProjectPath(project); } catch { /* fallback */ }
  validateFilename(filename, projectPath);

  const dir = await resolveFileDir(project, canvas, filename);
  const fullPath = join(dir, filename);

  // Dot-prefixed infrastructure files — read directly
  if (filename.startsWith(".")) {
    const content = await readFile(fullPath, "utf-8");
    const stats = await stat(fullPath);
    return {
      name: filename,
      type: extToType(extname(filename)),
      content,
      modifiedAt: stats.mtime.toISOString(),
    };
  }

  // Card directory — read primary file from inside
  let content = "";
  let modifiedAt = new Date().toISOString();

  try {
    const stats = await stat(fullPath);
    if (stats.isDirectory()) {
      const cardClass = resolveCardClassFromFilename(filename, projectPath);
      const primaryFile = getPrimaryFile(cardClass, projectPath);
      const primaryPath = join(fullPath, primaryFile);
      try {
        content = await readFile(primaryPath, "utf-8");
        const primaryStats = await stat(primaryPath);
        modifiedAt = primaryStats.mtime.toISOString();
      } catch {
        content = "";
        modifiedAt = stats.mtime.toISOString();
      }
    } else {
      // Legacy flat file
      content = await readFile(fullPath, "utf-8");
      modifiedAt = stats.mtime.toISOString();
    }
  } catch (err) {
    throw new Error(`Card not found: ${filename}`);
  }

  return {
    name: filename,
    type: extToType(extname(filename)),
    content,
    modifiedAt,
  };
}

/**
 * Write a card's primary content. Creates the card directory if needed.
 * For dot-prefixed files (infrastructure), writes directly to .mica/.
 */
export async function writeCanvasFile(
  project: string,
  canvas: string,
  filename: string,
  content: string
): Promise<void> {
  let projectPath: string | undefined;
  try { projectPath = await getProjectPath(project); } catch { /* fallback */ }
  validateFilename(filename, projectPath);

  const dir = await resolveFileDir(project, canvas, filename);

  // Dot-prefixed infrastructure files — write directly
  if (filename.startsWith(".")) {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, filename), content, "utf-8");
    return;
  }

  // Card directory — ensure directory exists, write primary file inside
  const cardDir = join(dir, filename);
  await mkdir(cardDir, { recursive: true });
  const cardClass = resolveCardClassFromFilename(filename, projectPath);
  const primaryFile = getPrimaryFile(cardClass, projectPath);
  await writeFile(join(cardDir, primaryFile), content, "utf-8");
}

/**
 * Delete a card. Removes the entire card directory (or legacy flat file).
 */
export async function deleteCanvasFile(
  project: string,
  canvas: string,
  filename: string
): Promise<void> {
  let projectPath: string | undefined;
  try { projectPath = await getProjectPath(project); } catch { /* fallback */ }
  validateFilename(filename, projectPath);

  const dir = await resolveFileDir(project, canvas, filename);
  const fullPath = join(dir, filename);

  try {
    const stats = await stat(fullPath);
    if (stats.isDirectory()) {
      await rm(fullPath, { recursive: true, force: true });
    } else {
      await unlink(fullPath);
    }
  } catch {
    // Already gone
  }
}

/**
 * Read a file from inside a card's directory. Used by MicaBridge.read().
 * If the target is a card subdirectory, reads the primary file inside it.
 */
export async function readCardFile(
  project: string,
  canvas: string,
  cardName: string,
  filename: string
): Promise<string> {
  let projectPath: string | undefined;
  try { projectPath = await getProjectPath(project); } catch { /* fallback */ }
  const dir = await getCanvasDir(project, canvas);
  const filepath = join(dir, cardName, filename);
  try {
    const stats = await stat(filepath);
    if (stats.isDirectory()) {
      // Card subdirectory — read its primary file
      const cardClass = resolveCardClassFromFilename(filename, projectPath);
      const primaryFile = getPrimaryFile(cardClass, projectPath);
      return readFile(join(filepath, primaryFile), "utf-8");
    }
    return readFile(filepath, "utf-8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "EISDIR") {
      const cardClass = resolveCardClassFromFilename(filename, projectPath);
      const primaryFile = getPrimaryFile(cardClass, projectPath);
      return readFile(join(filepath, primaryFile), "utf-8");
    }
    throw err;
  }
}

/**
 * Write a file inside a card's directory. Used by MicaBridge.write().
 * If the target is a card subdirectory, writes to the primary file inside it.
 */
export async function writeCardFile(
  project: string,
  canvas: string,
  cardName: string,
  filename: string,
  content: string
): Promise<void> {
  let projectPath: string | undefined;
  try { projectPath = await getProjectPath(project); } catch { /* fallback */ }
  const dir = await getCanvasDir(project, canvas);
  const filepath = join(dir, cardName, filename);
  try {
    const stats = await stat(filepath);
    if (stats.isDirectory()) {
      const cardClass = resolveCardClassFromFilename(filename, projectPath);
      const primaryFile = getPrimaryFile(cardClass, projectPath);
      await writeFile(join(filepath, primaryFile), content, "utf-8");
      return;
    }
  } catch { /* doesn't exist yet — write as flat file */ }
  const cardDir = join(dir, cardName);
  await mkdir(cardDir, { recursive: true });
  await writeFile(filepath, content, "utf-8");
}

// ── Card class directory resolution ──────────────────────

const BUILT_IN_CLASSES_DIR = join(process.cwd(), "card-classes");

export function resolveCardClassDir(cardClass: string, projectPath?: string): string | null {
  // Project-level override first
  if (projectPath) {
    const projectDir = join(projectPath, ".mica", ".card-classes", cardClass);
    if (existsSync(projectDir)) return projectDir;
  }
  // Built-in
  const builtinDir = join(BUILT_IN_CLASSES_DIR, cardClass);
  if (existsSync(builtinDir)) return builtinDir;
  return null;
}

/**
 * Copy seed files from a card class directory into a card instance directory.
 *
 * Three seed prefixes:
 * - `_` (underscore) — card seed. Files with card extensions become child card
 *   subdirectories. Files without card extensions become flat internal files.
 * - `~` (tilde) — flat file seed. Always copied as a flat file, never a card directory.
 *   Used for config/metadata files (brief.md, conversation.json).
 * - Directories prefixed with `_` are recursively copied.
 */
export async function copySeedFiles(classDir: string, instanceDir: string, projectPath?: string): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(classDir);
  } catch {
    return;
  }

  const validExts = getValidExtensions(projectPath);

  for (const entry of entries) {
    // Determine prefix type
    let seedName: string;
    let isFlat = false;

    if (entry.startsWith("~")) {
      seedName = entry.slice(1);
      isFlat = true;
    } else if (entry.startsWith("_")) {
      seedName = entry.slice(1);
    } else {
      continue; // Not a seed file
    }

    const srcPath = join(classDir, entry);
    const destPath = join(instanceDir, seedName);

    // Skip if already exists (don't overwrite user edits)
    if (existsSync(destPath)) continue;

    const srcStat = await stat(srcPath);
    if (srcStat.isDirectory()) {
      // Recursively copy seed directory
      await mkdir(destPath, { recursive: true });
      const subEntries = await readdir(srcPath);
      for (const sub of subEntries) {
        const subSrc = join(srcPath, sub);
        const subDest = join(destPath, sub);
        const subStat = await stat(subSrc);
        if (subStat.isFile()) {
          await writeFile(subDest, await readFile(subSrc, "utf-8"), "utf-8");
        }
      }
    } else if (isFlat) {
      // ~ prefix: always copy as flat file
      await writeFile(destPath, await readFile(srcPath, "utf-8"), "utf-8");
    } else {
      // _ prefix: check if this has a card extension → create as card subdirectory
      const ext = extname(seedName);
      if (ext && validExts.includes(ext) && ext !== ".json") {
        const cardClass = resolveCardClassFromFilename(seedName, projectPath);
        const primaryFile = getPrimaryFile(cardClass, projectPath);
        const cardDir = destPath;
        await mkdir(cardDir, { recursive: true });
        await writeFile(join(cardDir, primaryFile), await readFile(srcPath, "utf-8"), "utf-8");
        // Also copy the child card class's own seed files
        const childClassDir = resolveCardClassDir(cardClass, projectPath);
        if (childClassDir) {
          await copySeedFiles(childClassDir, cardDir, projectPath);
        }
      } else {
        // _ prefix without card extension — use ~ prefix for flat files instead
        console.warn(`[seed] ${entry} has _ prefix but no card extension — use ~ prefix for flat files`);
        await writeFile(destPath, await readFile(srcPath, "utf-8"), "utf-8");
      }
    }
  }
}

/**
 * Create a new card instance with seed files from the card class.
 * The card name includes the extension (e.g., "my-task.todo").
 * The extension determines the card class.
 */
export async function createCard(
  project: string,
  canvas: string,
  cardName: string
): Promise<void> {
  let projectPath: string | undefined;
  try { projectPath = await getProjectPath(project); } catch { /* fallback */ }
  validateFilename(cardName, projectPath);

  const dir = await getCanvasDir(project, canvas);
  const cardDir = join(dir, cardName);

  // Create the card directory
  await mkdir(cardDir, { recursive: true });

  // Resolve card class and copy seeds
  const cardClass = resolveCardClassFromFilename(cardName, projectPath);
  const classDir = resolveCardClassDir(cardClass, projectPath);
  if (classDir) {
    await copySeedFiles(classDir, cardDir, projectPath);
  }

  // Ensure primary file exists (even if no seed for it)
  const primaryFile = getPrimaryFile(cardClass, projectPath);
  const primaryPath = join(cardDir, primaryFile);
  if (!existsSync(primaryPath)) {
    await writeFile(primaryPath, "", "utf-8");
  }
}

/**
 * Migrate flat card files to card directories.
 * For each file with a valid card extension that is NOT a directory,
 * move it into a directory with the primary file name.
 */
export async function migrateToCardDirectories(projectPath: string, canvas: string): Promise<number> {
  const dir = canvas === "_root" ? projectPath : join(projectPath, canvas);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return 0;
  }

  const validExts = getValidExtensions(projectPath);
  let migrated = 0;

  for (const name of entries) {
    if (name.startsWith(".")) continue;
    const ext = extname(name);
    if (!validExts.includes(ext)) continue;

    const fullPath = join(dir, name);
    try {
      const stats = await stat(fullPath);
      if (stats.isFile()) {
        // Flat file → convert to directory
        const content = await readFile(fullPath, "utf-8");
        const cardClass = resolveCardClassFromFilename(name, projectPath);
        const primaryFile = getPrimaryFile(cardClass, projectPath);

        // Create card directory
        const cardDir = join(dir, name);
        // Rename file to temp, mkdir, write primary, remove temp
        const tmpPath = fullPath + ".migrating";
        const { rename } = await import("fs/promises");
        await rename(fullPath, tmpPath);
        await mkdir(cardDir, { recursive: true });
        await writeFile(join(cardDir, primaryFile), content, "utf-8");
        await unlink(tmpPath);

        migrated++;
      }
    } catch (err) {
      console.warn(`[migration] Failed to migrate ${name}: ${(err as Error).message}`);
    }
  }

  return migrated;
}

/**
 * Migrate underscore-prefixed cards and .brief/.log extensions.
 * _goal.goal → goal.goal, _brief.brief → brief.md, _log.log → log.md, etc.
 */
export async function migrateCardNames(projectPath: string, canvas: string): Promise<number> {
  const dir = canvas === "_root" ? projectPath : join(projectPath, canvas);
  const { rename } = await import("fs/promises");
  let migrated = 0;

  const renames: [string, string][] = [
    // Underscore prefix removal
    ["_project.project", "project.project"],
    ["_goal.goal", "goal.goal"],
    ["_todo.todo", "todo.todo"],
    // Extension changes (brief/log become .md)
    ["_brief.brief", "brief.md"],
    ["_log.log", "log.md"],
  ];

  for (const [oldName, newName] of renames) {
    const oldPath = join(dir, oldName);
    const newPath = join(dir, newName);
    if (existsSync(oldPath) && !existsSync(newPath)) {
      try {
        await rename(oldPath, newPath);
        migrated++;
      } catch (err) {
        console.warn(`[migration] Failed to rename ${oldName} → ${newName}: ${(err as Error).message}`);
      }
    }
  }

  return migrated;
}

export async function getAllFilesAsContext(project: string, canvas: string): Promise<string> {
  const files = await listFiles(project, canvas);
  if (files.length === 0) {
    return "(No files yet in this canvas.)";
  }

  return files
    .map(
      (f) =>
        `--- ${f.name} (${f.type}) ---\n${f.content}\n--- end ${f.name} ---`
    )
    .join("\n\n");
}
