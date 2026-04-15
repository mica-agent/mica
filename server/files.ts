// files.ts — File operations for Mica.
// Multi-project model: WORKSPACE_DIR contains project subdirectories.
// Each project has its own .mica/ metadata directory.
// File operations are scoped to a specific project within the workspace.

import { readFile, writeFile, unlink, readdir, stat, mkdir, rename, rm } from "fs/promises";
import { join, relative, dirname, basename, sep } from "path";
import { existsSync } from "fs";

/** The workspace root. Defaults to /project (Docker mount point). */
export const WORKSPACE_DIR = process.env.PROJECT_DIR || "/project";

// Backwards-compatible alias used by other modules
export const PROJECT_DIR = WORKSPACE_DIR;

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
export async function initProject(projectName: string, docsDir?: string): Promise<void> {
  const dir = micaDir(projectName);
  await mkdir(dir, { recursive: true });
  await mkdir(join(dir, "cards"), { recursive: true });
  await mkdir(join(dir, "chats"), { recursive: true });

  // Create config.json if it doesn't exist
  const configPath = join(dir, "config.json");
  if (!existsSync(configPath)) {
    const config: Record<string, unknown> = {
      name: projectName,
      canvasClass: "canvas",
    };
    if (docsDir) config.docsDir = docsDir;
    await writeFile(configPath, JSON.stringify(config, null, 2), "utf-8");
  }

  // Create canvas-back.md if it doesn't exist
  const canvasBackPath = join(dir, "canvas-back.md");
  if (!existsSync(canvasBackPath)) {
    await writeFile(canvasBackPath, "", "utf-8");
  }

  // Create docs directory if configured
  if (docsDir) {
    await mkdir(join(WORKSPACE_DIR, projectName, docsDir), { recursive: true });
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
}

/** Backwards-compatible interface for server-side consumers that need content. */
export interface FileInfo {
  name: string;
  content: string;
  modifiedAt?: string;
}

/**
 * List all files in a project directory (recursive, metadata only).
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
