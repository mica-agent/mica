// FileWatcher — watches a project directory for file changes (recursive).
// Supports watching a specific project subdirectory within the workspace.

import fs from "fs";
import path from "path";
import { EventEmitter } from "events";
import { WORKSPACE_DIR } from "./files.js";

export interface FileChangeEvent {
  type: "created" | "changed" | "deleted";
  filename: string;  // Relative path from project root (e.g., "docs/spec.md")
}

/** Directories to skip while watching. */
const IGNORE_DIRS = new Set([
  ".mica", ".git", ".svn", ".hg",
  "node_modules", "__pycache__", ".venv", "venv",
  ".next", ".nuxt", "dist", "build", ".cache",
  ".qwen",
]);

const DEBOUNCE_MS = 300;

export class FileWatcher extends EventEmitter {
  private watcher: fs.FSWatcher | null = null;
  private debounceTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private knownFiles: Set<string> = new Set();
  private watchDir: string = WORKSPACE_DIR;

  /** Set the directory to watch (a specific project directory). */
  setWatchDir(dir: string): void {
    this.watchDir = dir;
  }

  async start(): Promise<void> {
    await fs.promises.mkdir(this.watchDir, { recursive: true });

    // Scan existing files recursively
    await this.scanDir(this.watchDir);

    try {
      // Use recursive option (supported on macOS and Linux 5.9+)
      this.watcher = fs.watch(this.watchDir, { recursive: true }, (eventType, filename) => {
        if (!filename) return;

        // Normalize path separators
        const normalized = filename.split(path.sep).join("/");

        // Skip dotfiles and ignored directories
        const parts = normalized.split("/");
        if (parts.some(p => p.startsWith(".") || IGNORE_DIRS.has(p))) return;

        const debounceKey = normalized;
        const existing = this.debounceTimers.get(debounceKey);
        if (existing) clearTimeout(existing);

        this.debounceTimers.set(
          debounceKey,
          setTimeout(() => {
            this.debounceTimers.delete(debounceKey);
            this.handleFileChange(normalized).catch((err) => {
              console.error(`[file-watcher] Error handling ${normalized}:`, (err as Error).message);
            });
          }, DEBOUNCE_MS)
        );
      });

      this.watcher.on("error", (err: Error) => {
        console.warn(`[file-watcher] Watch error:`, err.message);
      });

      console.log(`[file-watcher] Watching ${this.watchDir} (${this.knownFiles.size} files, recursive)`);
    } catch (err) {
      console.warn(`[file-watcher] Could not watch ${this.watchDir}: ${(err as Error).message}`);
    }
  }

  private async scanDir(dir: string): Promise<void> {
    try {
      const entries = await fs.promises.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith(".")) continue;
        if (IGNORE_DIRS.has(entry.name)) continue;

        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          await this.scanDir(fullPath);
        } else if (entry.isFile()) {
          const relPath = path.relative(this.watchDir, fullPath).split(path.sep).join("/");
          this.knownFiles.add(relPath);
        }
      }
    } catch {
      // Directory may not exist yet
    }
  }

  private async handleFileChange(filename: string): Promise<void> {
    const filePath = path.join(this.watchDir, filename);

    try {
      const s = await fs.promises.stat(filePath);
      if (s.isDirectory()) return;

      if (this.knownFiles.has(filename)) {
        this.emit("file-change", { type: "changed", filename } as FileChangeEvent);
      } else {
        this.knownFiles.add(filename);
        this.emit("file-change", { type: "created", filename } as FileChangeEvent);
      }
    } catch {
      if (this.knownFiles.has(filename)) {
        this.knownFiles.delete(filename);
        this.emit("file-change", { type: "deleted", filename } as FileChangeEvent);
      }
    }
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = null;
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
    this.knownFiles.clear();
  }
}
