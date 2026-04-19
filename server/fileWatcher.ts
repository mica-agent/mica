// FileWatcher — multi-project, ref-counted directory watcher.
//
// Each project is watched independently. addProject(p, dir) starts a watcher
// for that project (idempotent; ref-counts subscribers). releaseProject(p)
// drops one ref and tears down the watcher when the count hits zero.
//
// File-change events carry the originating project so listeners can route
// broadcasts to subscribed clients only.

import fs from "fs";
import path from "path";
import { EventEmitter } from "events";

export interface FileChangeEvent {
  type: "created" | "changed" | "deleted";
  filename: string;  // Relative path from project root (e.g., "docs/spec.md")
  project: string;   // Project name the event belongs to
}

/** Directories to skip while watching. */
const IGNORE_DIRS = new Set([
  ".mica", ".git", ".svn", ".hg",
  "node_modules", "__pycache__", ".venv", "venv",
  ".next", ".nuxt", "dist", "build", ".cache",
  ".qwen",
]);

const DEBOUNCE_MS = 300;

interface ProjectWatch {
  watcher: fs.FSWatcher;
  watchDir: string;
  knownFiles: Set<string>;
  debounceTimers: Map<string, ReturnType<typeof setTimeout>>;
  refCount: number;
}

export class FileWatcher extends EventEmitter {
  private projects: Map<string, ProjectWatch> = new Map();

  /** Add a watcher for a project (idempotent). Increments ref count. */
  async addProject(project: string, dir: string): Promise<void> {
    const existing = this.projects.get(project);
    if (existing) {
      existing.refCount++;
      console.log(`[file-watcher] addProject(${project}) ref=${existing.refCount} (already watching)`);
      return;
    }

    await fs.promises.mkdir(dir, { recursive: true });

    const knownFiles = new Set<string>();
    await this.scanDir(dir, dir, knownFiles);

    const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

    const watcher = fs.watch(dir, { recursive: true }, (_eventType, filename) => {
      if (!filename) return;

      const normalized = filename.split(path.sep).join("/");
      const parts = normalized.split("/");
      if (parts.some((p) => p.startsWith(".") || IGNORE_DIRS.has(p))) return;

      const existingTimer = debounceTimers.get(normalized);
      if (existingTimer) clearTimeout(existingTimer);

      debounceTimers.set(
        normalized,
        setTimeout(() => {
          debounceTimers.delete(normalized);
          this.handleFileChange(project, normalized).catch((err) => {
            console.error(`[file-watcher] ${project}: error handling ${normalized}:`, (err as Error).message);
          });
        }, DEBOUNCE_MS),
      );
    });

    watcher.on("error", (err: Error) => {
      console.warn(`[file-watcher] ${project}: watch error:`, err.message);
    });

    this.projects.set(project, { watcher, watchDir: dir, knownFiles, debounceTimers, refCount: 1 });
    console.log(`[file-watcher] addProject(${project}) ref=1 — watching ${dir} (${knownFiles.size} files)`);
  }

  /** Decrement ref count for a project. Stops the watcher when count hits zero. */
  releaseProject(project: string): void {
    const w = this.projects.get(project);
    if (!w) return;
    w.refCount--;
    if (w.refCount > 0) {
      console.log(`[file-watcher] releaseProject(${project}) ref=${w.refCount}`);
      return;
    }
    w.watcher.close();
    for (const t of w.debounceTimers.values()) clearTimeout(t);
    w.debounceTimers.clear();
    w.knownFiles.clear();
    this.projects.delete(project);
    console.log(`[file-watcher] releaseProject(${project}) ref=0 — stopped`);
  }

  /** Currently watched project names. */
  watchedProjects(): string[] {
    return Array.from(this.projects.keys());
  }

  /** Tear down all watchers. */
  stopAll(): void {
    for (const project of Array.from(this.projects.keys())) {
      const w = this.projects.get(project)!;
      w.refCount = 0;
      w.watcher.close();
      for (const t of w.debounceTimers.values()) clearTimeout(t);
    }
    this.projects.clear();
  }

  private async scanDir(rootDir: string, dir: string, knownFiles: Set<string>): Promise<void> {
    try {
      const entries = await fs.promises.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith(".")) continue;
        if (IGNORE_DIRS.has(entry.name)) continue;
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await this.scanDir(rootDir, fullPath, knownFiles);
        } else if (entry.isFile()) {
          const relPath = path.relative(rootDir, fullPath).split(path.sep).join("/");
          knownFiles.add(relPath);
        }
      }
    } catch {
      // Directory may not exist yet
    }
  }

  private async handleFileChange(project: string, filename: string): Promise<void> {
    const w = this.projects.get(project);
    if (!w) return;
    const filePath = path.join(w.watchDir, filename);

    try {
      const s = await fs.promises.stat(filePath);
      if (s.isDirectory()) return;

      if (w.knownFiles.has(filename)) {
        this.emit("file-change", { type: "changed", filename, project } as FileChangeEvent);
      } else {
        w.knownFiles.add(filename);
        this.emit("file-change", { type: "created", filename, project } as FileChangeEvent);
      }
    } catch {
      if (w.knownFiles.has(filename)) {
        w.knownFiles.delete(filename);
        this.emit("file-change", { type: "deleted", filename, project } as FileChangeEvent);
      }
    }
  }
}
