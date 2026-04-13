// files.ts — Plain file operations for Mica Lite.
// Single project model: all operations work on PROJECT_DIR.
// No project IDs, no canvas hierarchy. Just files.

import { readFile, writeFile, unlink, readdir, stat, mkdir } from "fs/promises";
import { join, basename } from "path";
import { existsSync } from "fs";

/** The project directory. Defaults to /project (Docker mount point). */
export const PROJECT_DIR = process.env.PROJECT_DIR || "/project";

/** The .mica metadata directory inside the project. */
export function micaDir(): string {
  return join(PROJECT_DIR, ".mica");
}

/** Get the project name from the directory basename or .mica config. */
export async function getProjectName(): Promise<string> {
  try {
    const configPath = join(micaDir(), "config.json");
    const raw = await readFile(configPath, "utf-8");
    const config = JSON.parse(raw);
    return config.name || basename(PROJECT_DIR);
  } catch {
    return basename(PROJECT_DIR);
  }
}

export interface FileInfo {
  name: string;
  content: string;
  modifiedAt?: string;
}

/**
 * List all files in the project directory (non-recursive, skips dotfiles and .mica/).
 */
export async function listFiles(): Promise<FileInfo[]> {
  if (!existsSync(PROJECT_DIR)) return [];

  const entries = await readdir(PROJECT_DIR, { withFileTypes: true });
  const files: FileInfo[] = [];

  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (entry.name === ".mica") continue;
    if (!entry.isFile()) continue;

    try {
      const filePath = join(PROJECT_DIR, entry.name);
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
 * Read a single file from the project directory.
 */
export async function readProjectFile(filename: string): Promise<FileInfo> {
  validateFilename(filename);
  const filePath = join(PROJECT_DIR, filename);
  const content = await readFile(filePath, "utf-8");
  const fileStat = await stat(filePath);
  return {
    name: filename,
    content,
    modifiedAt: fileStat.mtime.toISOString(),
  };
}

/**
 * Write a file to the project directory.
 */
export async function writeProjectFile(filename: string, content: string): Promise<void> {
  validateFilename(filename);
  await mkdir(PROJECT_DIR, { recursive: true });
  await writeFile(join(PROJECT_DIR, filename), content, "utf-8");
}

/**
 * Delete a file from the project directory.
 */
export async function deleteProjectFile(filename: string): Promise<void> {
  validateFilename(filename);
  await unlink(join(PROJECT_DIR, filename));
}

// ── Validation ──────────────────────────────────────────────

function validateFilename(filename: string): void {
  if (filename.includes("/") || filename.includes("\\") || filename.includes("..")) {
    throw new Error(`Invalid filename: ${filename}`);
  }
}
