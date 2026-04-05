/**
 * FileWatcher — Watches project directories for card file changes and card-classes for updates.
 *
 * Card files live at {project}/{canvas}/ (project root level).
 * Infrastructure (.chat-history.json, .layout.json) lives in {project}/.mica/{canvas}/.
 * Card classes live in {project}/.mica/card-classes/ and the built-in card-classes/.
 *
 * Emits events when files are created, modified, or deleted.
 * Debounces rapid changes (300ms per file).
 */

import fs from "fs";
import path from "path";
import { EventEmitter } from "events";
import { readWorkspaceRegistry, getProjectPath, getCanvasDir } from "./projectConnection.js";
import { getValidExtensions, getPrimaryFile, resolveCardClassFromFilename } from "./canvasFiles.js";

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
    // Resolve canvas directory — for _root, this reads canvasCard from config
    const dir = await getCanvasDir(projectId, canvas);
    const key = `${projectId}/${canvas}`;

    try {
      await fs.promises.mkdir(dir, { recursive: true });

      // Scan existing cards (files or directories with valid extensions)
      const files = new Set<string>();
      try {
        const entries = await fs.promises.readdir(dir);
        for (const entry of entries) {
          if (entry.startsWith(".")) continue;
          const ext = path.extname(entry);
          if (getValidExtensions(projectPath).includes(ext)) {
            files.add(entry);
          }
        }
      } catch {
        // Directory doesn't exist yet
      }
      this.knownFiles.set(key, files);

      this.watchDirectory(dir, projectId, canvas, projectPath);

      // Watch project card classes (.mica/.card-classes/) for render.js and manifest changes.
      if (canvas === "_root") {
        this.watchProjectCardClasses(path.join(projectPath, ".mica", ".card-classes"), projectId);
      }
    } catch (err) {
      console.warn(`[file-watcher] Could not watch ${dir}: ${(err as Error).message}`);
    }
  }

  private watchDirectory(dir: string, project: string, canvas: string, projectPath?: string): void {
    try {
      // Use recursive: true to catch changes inside card directories
      const watcher = fs.watch(dir, { recursive: true }, (eventType, filename) => {
        if (!filename) return;

        // filename may be "card.md/document.md" (path inside card dir).
        // Extract the top-level card directory name.
        const parts = filename.split(path.sep);
        const topLevel = parts[0];

        // Skip .git internals and hidden files
        if (topLevel.startsWith(".")) return;
        // Skip files inside .mica/
        if (topLevel === ".mica") return;

        const ext = path.extname(topLevel);
        if (!getValidExtensions(projectPath).includes(ext)) return;

        // If it's a file inside a card directory (e.g., "card.md/document.md"),
        // skip dot-prefixed internal files (infrastructure)
        if (parts.length > 1 && parts[parts.length - 1].startsWith(".")) return;

        // If it's a file inside a card directory, only trigger re-render
        // for the primary file. Other files (conversation.json, transcript.log)
        // are supplementary state that shouldn't cause re-renders.
        if (parts.length > 1) {
          const changedFile = parts[parts.length - 1];
          const cardExt = path.extname(topLevel);
          // Quick extension → class lookup
          const cardClass = resolveCardClassFromFilename(topLevel, projectPath);
          const primaryFile = getPrimaryFile(cardClass, projectPath);
          if (changedFile !== primaryFile) return;
        }

        // The card name is the top-level directory name
        const cardName = topLevel;

        // Debounce
        const debounceKey = `${project}/${canvas}/${cardName}`;
        const existing = this.debounceTimers.get(debounceKey);
        if (existing) clearTimeout(existing);

        this.debounceTimers.set(
          debounceKey,
          setTimeout(() => {
            this.debounceTimers.delete(debounceKey);
            this.handleFileChange(project, canvas, cardName, dir).catch((err) => {
              console.error(`[file-watcher] Error handling ${project}/${canvas}/${cardName}:`, (err as Error).message);
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
      // Card exists (file or directory)
      if (known.has(filename)) {
        this.emit("file-change", { type: "changed", project, canvas, filename } as FileChangeEvent);
      } else {
        known.add(filename);
        this.knownFiles.set(key, known);
        this.emit("file-change", { type: "created", project, canvas, filename } as FileChangeEvent);
      }
    } catch {
      // Card was deleted (file or directory removed)
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
        // Only care about render.js files and manifest
        if (!filename.endsWith("render.js") && !filename.endsWith("_manifest.json")) return;

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

  /** Watch project-specific card classes (.mica/.card-classes/) for render.js and manifest edits. */
  private watchProjectCardClasses(dir: string, projectId: string): void {
    try {
      // Ensure dir exists
      if (!fs.existsSync(dir)) return;

      const watcher = fs.watch(dir, { recursive: true }, (eventType, filename) => {
        if (!filename) return;
        if (!filename.endsWith("render.js") && !filename.endsWith("_manifest.json")) return;

        const parts = filename.split(path.sep);
        if (parts.length < 2 && !filename.endsWith("_manifest.json")) return;
        const className = parts[0];

        const key = `project-class/${projectId}/${className}`;
        const existing = this.debounceTimers.get(key);
        if (existing) clearTimeout(existing);

        this.debounceTimers.set(
          key,
          setTimeout(() => {
            this.debounceTimers.delete(key);
            console.log(`[file-watcher] Project card class changed: ${projectId}/.card-classes/${className}`);
            this.emit("class-change", { type: "class-changed", className } as ClassChangeEvent);
          }, DEBOUNCE_MS)
        );
      });

      watcher.on("error", (err: Error) => {
        console.warn(`[file-watcher] Project card-classes watch error for ${projectId}:`, err.message);
      });

      this.watchers.push(watcher);
    } catch {
      // .card-classes may not exist yet — that's fine
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
