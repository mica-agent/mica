// files.ts — Plain file operations for Mica Lite.
// Files are files. No card directories, no extension-based class resolution.
// Reads/writes plain files relative to the project directory.

import { readFile, writeFile, unlink, readdir, stat, mkdir } from "fs/promises";
import { join } from "path";
import { existsSync } from "fs";
import { getProjectPath, getCanvasDir } from "./projectConnection.js";

// Re-export project management functions
export {
  listProjects,
  getProjectConfig,
  validateProjectCanvas,
  addCanvasToProject,
  disconnectProject as deleteProject,
} from "./projectConnection.js";

export interface FileInfo {
  name: string;
  content: string;
  modifiedAt?: string;
}

/**
 * List all files in a project directory (non-recursive, skips dotfiles and .mica/).
 */
export async function listFiles(project: string, canvas: string): Promise<FileInfo[]> {
  const dir = await getCanvasDir(project, canvas);
  if (!existsSync(dir)) return [];

  const entries = await readdir(dir, { withFileTypes: true });
  const files: FileInfo[] = [];

  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (entry.name === ".mica") continue;
    if (!entry.isFile()) continue;

    try {
      const filePath = join(dir, entry.name);
      const content = await readFile(filePath, "utf-8");
      const fileStat = await stat(filePath);
      files.push({
        name: entry.name,
        content,
        modifiedAt: fileStat.mtime.toISOString(),
      });
    } catch {
      // Skip unreadable files
    }
  }

  return files;
}

/**
 * Read a single file from a project directory.
 */
export async function readCanvasFile(project: string, canvas: string, filename: string): Promise<FileInfo> {
  validateFilename(filename);
  const dir = await getCanvasDir(project, canvas);
  const filePath = join(dir, filename);
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
 */
export async function writeCanvasFile(project: string, canvas: string, filename: string, content: string): Promise<void> {
  validateFilename(filename);
  const dir = await getCanvasDir(project, canvas);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, filename), content, "utf-8");
}

/**
 * Delete a file from a project directory.
 */
export async function deleteCanvasFile(project: string, canvas: string, filename: string): Promise<void> {
  validateFilename(filename);
  const dir = await getCanvasDir(project, canvas);
  await unlink(join(dir, filename));
}

// ── Validation ──────────────────────────────────────────────

function validateFilename(filename: string): void {
  if (filename.includes("/") || filename.includes("\\") || filename.includes("..")) {
    throw new Error(`Invalid filename: ${filename}`);
  }
}
