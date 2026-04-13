// FileWatcher — watches the project directory for file changes.
// Single project model: watches PROJECT_DIR only.

import fs from "fs";
import path from "path";
import { EventEmitter } from "events";
import { PROJECT_DIR } from "./files.js";

export interface FileChangeEvent {
  type: "created" | "changed" | "deleted";
  filename: string;
}

const DEBOUNCE_MS = 300;

export class FileWatcher extends EventEmitter {
  private watcher: fs.FSWatcher | null = null;
  private debounceTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private knownFiles: Set<string> = new Set();

  async start(): Promise<void> {
    await fs.promises.mkdir(PROJECT_DIR, { recursive: true });

    // Scan existing files
    try {
      const entries = await fs.promises.readdir(PROJECT_DIR);
      for (const entry of entries) {
        if (entry.startsWith(".")) continue;
        if (entry === ".mica") continue;
        const filePath = path.join(PROJECT_DIR, entry);
        const s = await fs.promises.stat(filePath);
        if (s.isFile()) {
          this.knownFiles.add(entry);
        }
      }
    } catch {
      // Directory may not exist yet
    }

    try {
      this.watcher = fs.watch(PROJECT_DIR, (eventType, filename) => {
        if (!filename) return;
        if (filename.startsWith(".")) return;
        if (filename === ".mica") return;

        const debounceKey = filename;
        const existing = this.debounceTimers.get(debounceKey);
        if (existing) clearTimeout(existing);

        this.debounceTimers.set(
          debounceKey,
          setTimeout(() => {
            this.debounceTimers.delete(debounceKey);
            this.handleFileChange(filename).catch((err) => {
              console.error(`[file-watcher] Error handling ${filename}:`, (err as Error).message);
            });
          }, DEBOUNCE_MS)
        );
      });

      this.watcher.on("error", (err: Error) => {
        console.warn(`[file-watcher] Watch error:`, err.message);
      });

      console.log(`[file-watcher] Watching ${PROJECT_DIR} (${this.knownFiles.size} files)`);
    } catch (err) {
      console.warn(`[file-watcher] Could not watch ${PROJECT_DIR}: ${(err as Error).message}`);
    }
  }

  private async handleFileChange(filename: string): Promise<void> {
    const filePath = path.join(PROJECT_DIR, filename);

    try {
      const s = await fs.promises.stat(filePath);
      if (!s.isFile()) return;

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
  }
}
