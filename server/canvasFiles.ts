// Canvas file management — filesystem CRUD for card and infrastructure files.
// Card files (*.md, *.goal, *.agent, etc.) live at {project}/{canvas}/.
// Infrastructure files (.chat-history.json, .layout.json, etc.) live in {project}/.mica/{canvas}/.
// Card classes live in {project}/.mica/card-classes/.

import { readdir, readFile, writeFile, unlink, mkdir, stat } from "fs/promises";
import { readFileSync } from "fs";
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
// Valid extensions are derived from the card class manifest.
// .json is always valid (for data files). Extensions are cached and
// refreshed when getValidExtensions() is called.

const MANIFEST_PATH = join(process.cwd(), "card-classes", "_manifest.json");
let _cachedExtensions: string[] | null = null;

export function getValidExtensions(projectPath?: string): string[] {
  if (_cachedExtensions && !projectPath) return _cachedExtensions;
  const exts = new Set<string>();
  try {
    const raw = readFileSync(MANIFEST_PATH, "utf-8");
    const manifest = JSON.parse(raw) as Record<string, { extension?: string }>;
    for (const entry of Object.values(manifest)) {
      if (entry.extension) exts.add(entry.extension);
    }
  } catch {
    // Fallback if manifest unreadable
    for (const e of [".txt", ".md", ".mmd", ".html", ".goal", ".todo", ".brief", ".log", ".agent", ".canvas", ".project"]) {
      exts.add(e);
    }
  }
  // Merge project-level manifest extensions
  if (projectPath) {
    try {
      const raw = readFileSync(join(projectPath, ".mica", ".card-classes", "_manifest.json"), "utf-8");
      const manifest = JSON.parse(raw) as Record<string, { extension?: string }>;
      for (const entry of Object.values(manifest)) {
        if (entry.extension) exts.add(entry.extension);
      }
    } catch { /* no project manifest */ }
  }
  exts.add(".json"); // Always valid for data files
  const result = [...exts];
  if (!projectPath) _cachedExtensions = result;
  return result;
}

/** Call when manifest changes to refresh the extension cache. */
export function invalidateExtensionCache(): void {
  _cachedExtensions = null;
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
  const ext = extname(filename);
  const validExts = getValidExtensions(projectPath);
  if (!validExts.includes(ext)) {
    throw new Error(
      `Invalid extension: ${ext}. Must be one of: ${validExts.join(", ")}`
    );
  }
}

// ── File operations ────────────────────────────────────────
// Card files (*.md, *.goal, etc.) live at project root level.
// Infrastructure files (dot-prefixed: .chat-history.json, .layout.json) live in .mica/.

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
  // Also ensure infra dir exists (for .chat-history.json etc.)
  const infraDir = await getInfraDir(project, canvas);
  await mkdir(infraDir, { recursive: true });
  return dir;
}

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
    const ext = extname(name);
    if (!validExts.includes(ext) || name.startsWith(".")) continue;

    const filepath = join(dir, name);
    const content = await readFile(filepath, "utf-8");
    const stats = await stat(filepath);
    files.push({
      name,
      type: extToType(ext),
      content,
      modifiedAt: stats.mtime.toISOString(),
    });
  }

  return files.sort(
    (a, b) =>
      new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime()
  );
}

export async function readCanvasFile(
  project: string,
  canvas: string,
  filename: string
): Promise<CanvasFile> {
  let projectPath: string | undefined;
  try { projectPath = await getProjectPath(project); } catch { /* fallback */ }
  validateFilename(filename, projectPath);
  const dir = await resolveFileDir(project, canvas, filename);
  const filepath = join(dir, filename);
  const content = await readFile(filepath, "utf-8");
  const stats = await stat(filepath);
  return {
    name: filename,
    type: extToType(extname(filename)),
    content,
    modifiedAt: stats.mtime.toISOString(),
  };
}

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
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, filename), content, "utf-8");
}

export async function deleteCanvasFile(
  project: string,
  canvas: string,
  filename: string
): Promise<void> {
  let projectPath: string | undefined;
  try { projectPath = await getProjectPath(project); } catch { /* fallback */ }
  validateFilename(filename, projectPath);
  const dir = await resolveFileDir(project, canvas, filename);
  await unlink(join(dir, filename));
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
