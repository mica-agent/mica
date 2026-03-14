/**
 * FileWatcher — Watches layer directories and card-classes for changes.
 *
 * Emits events when files are created, modified, or deleted.
 * Debounces rapid changes (300ms per file).
 */

import fs from "fs";
import path from "path";
import { EventEmitter } from "events";

export interface FileChangeEvent {
  type: "created" | "changed" | "deleted";
  layer: string;
  filename: string;
}

export interface ClassChangeEvent {
  type: "class-changed";
  className: string;
}

const LAYERS_DIR = path.resolve("layers");
const CARD_CLASSES_DIR = path.resolve("card-classes");
const DEBOUNCE_MS = 300;
const VALID_EXTENSIONS = [".txt", ".md", ".mmd", ".py", ".json"];

export class FileWatcher extends EventEmitter {
  private watchers: fs.FSWatcher[] = [];
  private debounceTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private knownFiles: Map<string, Set<string>> = new Map(); // layer → set of filenames

  async start(): Promise<void> {
    // Scan existing files
    await this.scanExisting();

    // Watch each layer directory
    const layers = ["mission", "experience", "architecture", "implementation"];
    for (const layer of layers) {
      const dir = path.join(LAYERS_DIR, layer);
      try {
        await fs.promises.mkdir(dir, { recursive: true });
        this.watchDirectory(dir, layer);
      } catch (err) {
        console.warn(`[file-watcher] Could not watch ${dir}: ${(err as Error).message}`);
      }
    }

    // Watch card-classes directory
    this.watchCardClasses();

    console.log("[file-watcher] Watching layer directories and card-classes.");
  }

  private async scanExisting(): Promise<void> {
    const layers = ["mission", "experience", "architecture", "implementation"];
    for (const layer of layers) {
      const dir = path.join(LAYERS_DIR, layer);
      const files = new Set<string>();
      try {
        const entries = await fs.promises.readdir(dir);
        for (const entry of entries) {
          const ext = path.extname(entry);
          if (VALID_EXTENSIONS.includes(ext) || entry === "_chat-history.json") {
            files.add(entry);
          }
        }
      } catch {
        // Directory doesn't exist yet
      }
      this.knownFiles.set(layer, files);
    }
  }

  private watchDirectory(dir: string, layer: string): void {
    try {
      const watcher = fs.watch(dir, (eventType, filename) => {
        if (!filename) return;
        const ext = path.extname(filename);
        if (!VALID_EXTENSIONS.includes(ext) && filename !== "_chat-history.json") return;

        // Debounce
        const key = `${layer}/${filename}`;
        const existing = this.debounceTimers.get(key);
        if (existing) clearTimeout(existing);

        this.debounceTimers.set(
          key,
          setTimeout(() => {
            this.debounceTimers.delete(key);
            this.handleFileChange(layer, filename, dir).catch((err) => {
              console.error(`[file-watcher] Error handling ${layer}/${filename}:`, (err as Error).message);
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

  private async handleFileChange(layer: string, filename: string, dir: string): Promise<void> {
    const filePath = path.join(dir, filename);
    const known = this.knownFiles.get(layer) || new Set();

    try {
      await fs.promises.access(filePath);
      // File exists
      if (known.has(filename)) {
        this.emit("file-change", { type: "changed", layer, filename } as FileChangeEvent);
      } else {
        known.add(filename);
        this.knownFiles.set(layer, known);
        this.emit("file-change", { type: "created", layer, filename } as FileChangeEvent);
      }
    } catch {
      // File was deleted
      if (known.has(filename)) {
        known.delete(filename);
        this.knownFiles.set(layer, known);
        this.emit("file-change", { type: "deleted", layer, filename } as FileChangeEvent);
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
