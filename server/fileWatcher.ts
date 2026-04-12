/**
 * FileWatcher — Watches project directories for file changes.
 *
 * Simplified for Mica Lite: watches plain files, no card directory model,
 * no card class extension filtering.
 *
 * Emits "file-change" events when files are created, modified, or deleted.
 * Debounces rapid changes (300ms per file).
 */

import fs from "fs";
import path from "path";
import { EventEmitter } from "events";
import { listProjects, getProjectPath, getCanvasDir } from "./projectConnection.js";

export interface FileChangeEvent {
  type: "created" | "changed" | "deleted";
  project: string;
  canvas: string;
  filename: string;
}

const DEBOUNCE_MS = 300;

export class FileWatcher extends EventEmitter {
  private watchers: fs.FSWatcher[] = [];
  private debounceTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private knownFiles: Map<string, Set<string>> = new Map();

  async start(): Promise<void> {
    const projects = await listProjects();

    for (const project of projects) {
      await this.watchProjectCanvas(project.id, project.path, "_root");
      for (const canvas of project.canvases) {
        await this.watchProjectCanvas(project.id, project.path, canvas);
      }
    }

    const totalCanvases = projects.reduce((sum, p) => sum + p.canvases.length, 0);
    console.log(`[file-watcher] Watching ${totalCanvases} canvas(es) across ${projects.length} project(s).`);
  }

  async addProject(projectId: string, canvases: string[]): Promise<void> {
    const projectPath = await getProjectPath(projectId);
    await this.watchProjectCanvas(projectId, projectPath, "_root");
    for (const canvas of canvases) {
      await this.watchProjectCanvas(projectId, projectPath, canvas);
    }
  }

  private async watchProjectCanvas(projectId: string, projectPath: string, canvas: string): Promise<void> {
    const dir = await getCanvasDir(projectId, canvas);
    const key = `${projectId}/${canvas}`;

    try {
      await fs.promises.mkdir(dir, { recursive: true });

      // Scan existing files
      const files = new Set<string>();
      try {
        const entries = await fs.promises.readdir(dir);
        for (const entry of entries) {
          if (entry.startsWith(".")) continue;
          if (entry === ".mica") continue;
          // Only track regular files
          const filePath = path.join(dir, entry);
          const stat = await fs.promises.stat(filePath);
          if (stat.isFile()) {
            files.add(entry);
          }
        }
      } catch {
        // Directory doesn't exist yet
      }
      this.knownFiles.set(key, files);

      this.watchDirectory(dir, projectId, canvas);
    } catch (err) {
      console.warn(`[file-watcher] Could not watch ${dir}: ${(err as Error).message}`);
    }
  }

  private watchDirectory(dir: string, project: string, canvas: string): void {
    try {
      const watcher = fs.watch(dir, (eventType, filename) => {
        if (!filename) return;
        // Skip dotfiles and .mica directory
        if (filename.startsWith(".")) return;
        if (filename === ".mica") return;

        // Debounce
        const debounceKey = `${project}/${canvas}/${filename}`;
        const existing = this.debounceTimers.get(debounceKey);
        if (existing) clearTimeout(existing);

        this.debounceTimers.set(
          debounceKey,
          setTimeout(() => {
            this.debounceTimers.delete(debounceKey);
            this.handleFileChange(project, canvas, filename, dir).catch((err) => {
              console.error(`[file-watcher] Error handling ${debounceKey}:`, (err as Error).message);
            });
          }, DEBOUNCE_MS)
        );
      });

      watcher.on("error", (err: Error) => {
        console.warn(`[file-watcher] Watch error for ${dir}:`, err.message);
      });

      this.watchers.push(watcher);
    } catch (err) {
      console.warn(`[file-watcher] fs.watch failed for ${dir}: ${(err as Error).message}`);
    }
  }

  private async handleFileChange(project: string, canvas: string, filename: string, dir: string): Promise<void> {
    const filePath = path.join(dir, filename);
    const key = `${project}/${canvas}`;
    const known = this.knownFiles.get(key) || new Set();

    try {
      const stat = await fs.promises.stat(filePath);
      if (!stat.isFile()) return; // Skip directories

      if (known.has(filename)) {
        this.emit("file-change", { type: "changed", project, canvas, filename } as FileChangeEvent);
      } else {
        known.add(filename);
        this.knownFiles.set(key, known);
        this.emit("file-change", { type: "created", project, canvas, filename } as FileChangeEvent);
      }
    } catch {
      // File was deleted
      if (known.has(filename)) {
        known.delete(filename);
        this.knownFiles.set(key, known);
        this.emit("file-change", { type: "deleted", project, canvas, filename } as FileChangeEvent);
      }
    }
  }

  stop(): void {
    for (const w of this.watchers) {
      w.close();
    }
    this.watchers = [];
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
  }
}
