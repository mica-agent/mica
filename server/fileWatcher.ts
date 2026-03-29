/**
 * FileWatcher — Watches project .mica/ directories and card-classes for changes.
 *
 * Emits events when files are created, modified, or deleted.
 * Debounces rapid changes (300ms per file).
 */

import fs from "fs";
import path from "path";
import { EventEmitter } from "events";
import { readWorkspaceRegistry, getProjectPath } from "./projectConnection.js";
import { getValidExtensions } from "./canvasFiles.js";

export interface FileChangeEvent {
  type: "created" | "changed" | "deleted";
  project: string;
  canvas: string;
  filename: string;
}

export interface ClassChangeEvent {
  type: "class-changed";
  className: string;
}

const CARD_CLASSES_DIR = path.resolve("card-classes");
const DEBOUNCE_MS = 300;

export class FileWatcher extends EventEmitter {
  private watchers: fs.FSWatcher[] = [];
  private debounceTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private knownFiles: Map<string, Set<string>> = new Map(); // "project/canvas" → set of filenames

  async start(): Promise<void> {
    // Read workspace registry to discover connected projects
    const registry = await readWorkspaceRegistry();

    for (const project of registry.projects) {
      // Watch .mica/ root for project-level cards
      await this.watchProjectCanvas(project.id, project.path, "_root");
      for (const canvas of project.canvases) {
        await this.watchProjectCanvas(project.id, project.path, canvas);
      }
    }

    // Watch card-classes directory
    this.watchCardClasses();

    const totalCanvases = registry.projects.reduce((sum, p) => sum + p.canvases.length, 0);
    console.log(`[file-watcher] Watching ${totalCanvases} canvas(es) across ${registry.projects.length} project(s), and card-classes.`);
  }

  /** Add a watcher for a newly connected project's canvases */
  async addProject(projectId: string, canvases: string[]): Promise<void> {
    const projectPath = await getProjectPath(projectId);
    // Watch .mica/ root for project-level cards
    await this.watchProjectCanvas(projectId, projectPath, "_root");
    for (const canvas of canvases) {
      await this.watchProjectCanvas(projectId, projectPath, canvas);
    }
  }

  private async watchProjectCanvas(projectId: string, projectPath: string, canvas: string): Promise<void> {
    const dir = canvas === "_root"
      ? path.join(projectPath, ".mica")
      : path.join(projectPath, ".mica", canvas);
    const key = `${projectId}/${canvas}`;

    try {
      await fs.promises.mkdir(dir, { recursive: true });

      // Scan existing files
      const files = new Set<string>();
      try {
        const entries = await fs.promises.readdir(dir);
        for (const entry of entries) {
          const ext = path.extname(entry);
          if (getValidExtensions().includes(ext) && !entry.startsWith(".")) {
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
        // Skip .git internals and hidden files
        if (filename.startsWith(".")) return;
        // For _root canvas, skip subdirectories (canvas dirs, .card-classes)
        if (canvas === "_root" && !filename.includes(".")) return;
        const ext = path.extname(filename);
        if (!getValidExtensions().includes(ext)) return;

        // Debounce
        const debounceKey = `${project}/${canvas}/${filename}`;
        const existing = this.debounceTimers.get(debounceKey);
        if (existing) clearTimeout(existing);

        this.debounceTimers.set(
          debounceKey,
          setTimeout(() => {
            this.debounceTimers.delete(debounceKey);
            this.handleFileChange(project, canvas, filename, dir).catch((err) => {
              console.error(`[file-watcher] Error handling ${project}/${canvas}/${filename}:`, (err as Error).message);
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
      await fs.promises.access(filePath);
      // File exists
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

  private watchCardClasses(): void {
    try {
      // Watch top-level card-classes directory for new class dirs
      const watcher = fs.watch(CARD_CLASSES_DIR, { recursive: true }, (eventType, filename) => {
        if (!filename) return;
        // Only care about render.py files
        if (!filename.endsWith("render.py") && !filename.endsWith("_manifest.json")) return;

        const parts = filename.split(path.sep);
        if (parts.length < 2) return;
        const className = parts[0];

        // Debounce
        const key = `class/${className}`;
        const existing = this.debounceTimers.get(key);
        if (existing) clearTimeout(existing);

        this.debounceTimers.set(
          key,
          setTimeout(() => {
            this.debounceTimers.delete(key);
            this.emit("class-change", { type: "class-changed", className } as ClassChangeEvent);
          }, DEBOUNCE_MS)
        );
      });

      watcher.on("error", (err: Error) => {
        console.warn(`[file-watcher] Card-classes watch error:`, err.message);
      });

      this.watchers.push(watcher);
    } catch (err) {
      console.warn(`[file-watcher] Could not watch card-classes: ${(err as Error).message}`);
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
