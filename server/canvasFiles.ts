// Canvas file management — filesystem CRUD scoped to {project}/.mica/{canvas}/
// Projects are sovereign repos; Mica metadata lives in .mica/ inside each project.

import { readdir, readFile, writeFile, unlink, mkdir, stat } from "fs/promises";
import { join, basename, extname } from "path";

import {
  getProjectPath,
  getCanvasDir,
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

const VALID_EXTENSIONS = [".txt", ".md", ".mmd", ".py", ".json", ".html"];

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

function validateFilename(filename: string): void {
  const base = basename(filename);
  if (base !== filename || filename.includes("..") || filename.includes("/")) {
    throw new Error(`Invalid filename: ${filename}`);
  }
  const ext = extname(filename);
  if (!VALID_EXTENSIONS.includes(ext)) {
    throw new Error(
      `Invalid extension: ${ext}. Must be one of: ${VALID_EXTENSIONS.join(", ")}`
    );
  }
}

// ── File operations (project-scoped, resolves via .mica/) ───

export async function ensureCanvasDir(project: string, canvas: string): Promise<string> {
  const dir = await getCanvasDir(project, canvas);
  await mkdir(dir, { recursive: true });
  return dir;
}

export async function listFiles(project: string, canvas: string): Promise<CanvasFile[]> {
  const dir = await ensureCanvasDir(project, canvas);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  const files: CanvasFile[] = [];
  for (const name of entries) {
    const ext = extname(name);
    if (!VALID_EXTENSIONS.includes(ext)) continue;

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
  validateFilename(filename);
  const dir = await getCanvasDir(project, canvas);
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
  validateFilename(filename);
  const dir = await ensureCanvasDir(project, canvas);
  await writeFile(join(dir, filename), content, "utf-8");
}

export async function deleteCanvasFile(
  project: string,
  canvas: string,
  filename: string
): Promise<void> {
  validateFilename(filename);
  const dir = await getCanvasDir(project, canvas);
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
