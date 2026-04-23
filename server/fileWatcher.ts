// FileWatcher — multi-project, ref-counted directory watcher scoped to canvas.
//
// Each project is watched independently. addProject(p, dir, canvasRoot, pinned)
// registers inotify watches only for the canvas subtree (e.g. `docs/`) plus
// any directories containing pinned files. Files outside that scope are
// invisible to Mica — by design: the canvas is the unit of attention, and
// watching the whole project root would register an inotify watch for every
// subdirectory (including node_modules-style large trees the user happens to
// have in the project dir), blowing the system-wide fs.inotify.max_user_watches
// limit.
//
// File-change events carry the originating project so listeners can route
// broadcasts to subscribed clients only. Emitted filenames are always
// project-relative (e.g. "docs/spec.md") regardless of which sub-watcher
// fired them.

import fs from "fs";
import path from "path";
import { EventEmitter } from "events";
import { DEFAULT_CANVAS_ROOT } from "./files.js";

export interface FileChangeEvent {
  type: "created" | "changed" | "deleted";
  filename: string;  // Relative path from project root (e.g., "docs/spec.md")
  project: string;   // Project name the event belongs to
}

/** Directories to skip while scanning. */
const IGNORE_DIRS = new Set([
  ".mica", ".git", ".svn", ".hg",
  "node_modules", "__pycache__", ".venv", "venv",
  ".next", ".nuxt", "dist", "build", ".cache",
  ".qwen",
]);

const DEBOUNCE_MS = 300;

interface SubWatch {
  watcher: fs.FSWatcher;
  /** Directory this watcher is attached to (absolute path). */
  dir: string;
  /** Translate a filename reported by this watcher (relative to `dir`) into
   *  a project-relative path, or null if the file should be ignored. */
  translate: (reported: string) => string | null;
}

interface ProjectWatch {
  projectDir: string;
  canvasRoot: string;
  pinned: string[];
  subs: SubWatch[];
  knownFiles: Set<string>;
  debounceTimers: Map<string, ReturnType<typeof setTimeout>>;
  refCount: number;
}

export class FileWatcher extends EventEmitter {
  private projects: Map<string, ProjectWatch> = new Map();

  /** Add a watcher for a project (idempotent). Increments ref count.
   *
   *  `canvasRoot` is the subdirectory that hosts the canvas (e.g. "canvas").
   *  An empty string or "." means "project root" — watches everything, which
   *  is the old behavior and should be avoided for projects with lots of
   *  unrelated files.
   *
   *  `pinned` is the list of project-relative paths to pinned files that
   *  live outside canvasRoot. We watch their parent directories non-recursively
   *  and filter events to just those files. */
  async addProject(
    project: string,
    projectDir: string,
    canvasRoot: string = DEFAULT_CANVAS_ROOT,
    pinned: string[] = [],
  ): Promise<void> {
    const existing = this.projects.get(project);
    if (existing) {
      existing.refCount++;
      console.log(`[file-watcher] addProject(${project}) ref=${existing.refCount} (already watching)`);
      return;
    }

    const normalizedRoot = canvasRoot === "." ? "" : canvasRoot.replace(/\/$/, "");
    const canvasAbs = normalizedRoot === "" ? projectDir : path.join(projectDir, normalizedRoot);
    await fs.promises.mkdir(canvasAbs, { recursive: true });

    const knownFiles = new Set<string>();
    const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
    const subs: SubWatch[] = [];

    // Helper: schedule a debounced handleFileChange for a project-relative path.
    const schedule = (projectRelative: string) => {
      const existingTimer = debounceTimers.get(projectRelative);
      if (existingTimer) clearTimeout(existingTimer);
      debounceTimers.set(
        projectRelative,
        setTimeout(() => {
          debounceTimers.delete(projectRelative);
          this.handleFileChange(project, projectRelative).catch((err) => {
            console.error(`[file-watcher] ${project}: error handling ${projectRelative}:`, (err as Error).message);
          });
        }, DEBOUNCE_MS),
      );
    };

    // Primary canvas-subtree watch (recursive).
    await this.scanDir(canvasAbs, projectDir, knownFiles);
    const canvasWatcher = fs.watch(canvasAbs, { recursive: true }, (_eventType, reported) => {
      if (!reported) return;
      const rel = reported.split(path.sep).join("/");
      const parts = rel.split("/");
      // Reject hidden-prefix segments and ignored dirs. `.mica/card-classes/`
      // has its own dedicated watcher below — it isn't reachable from this
      // canvas-root subtree anyway.
      if (parts.some((p) => p.startsWith(".") || IGNORE_DIRS.has(p))) return;
      const projectRelative = normalizedRoot === "" ? rel : `${normalizedRoot}/${rel}`;
      schedule(projectRelative);
    });
    canvasWatcher.on("error", (err: Error) => {
      console.warn(`[file-watcher] ${project}: watch error on canvas:`, err.message);
    });
    subs.push({
      watcher: canvasWatcher,
      dir: canvasAbs,
      translate: (r) => r, // canvas watcher's translation is inlined in the callback
    });

    // Card-classes watch (recursive). The canvas watcher above is rooted at
    // `<project>/<canvasRoot>/`, so it never sees `.mica/card-classes/`
    // events even though handleFileChange knows how to route them. Without
    // this watcher, when an agent writes a brand-new card class directory,
    // the client's on('card-class-changed') listener never fires and any
    // instance rendered before the class was complete keeps showing "???"
    // until a manual refresh.
    const cardClassesAbs = path.join(projectDir, ".mica", "card-classes");
    await fs.promises.mkdir(cardClassesAbs, { recursive: true });
    const cardClassesWatcher = fs.watch(cardClassesAbs, { recursive: true }, (_eventType, reported) => {
      if (!reported) return;
      const rel = reported.split(path.sep).join("/");
      const projectRelative = `.mica/card-classes/${rel}`;
      schedule(projectRelative);
    });
    cardClassesWatcher.on("error", (err: Error) => {
      console.warn(`[file-watcher] ${project}: watch error on .mica/card-classes:`, err.message);
    });
    subs.push({
      watcher: cardClassesWatcher,
      dir: cardClassesAbs,
      translate: (_r) => null,
    });

    // Pinned files outside canvasRoot: watch each parent directory non-recursively,
    // and only fire for the specific pinned file (filter out siblings).
    const pinnedParents = new Set<string>();
    for (const pin of pinned) {
      const pinNorm = pin.replace(/\\/g, "/").replace(/^\//, "");
      if (normalizedRoot !== "" && (pinNorm === normalizedRoot || pinNorm.startsWith(`${normalizedRoot}/`))) {
        // Inside canvasRoot — already covered.
        continue;
      }
      const pinAbs = path.join(projectDir, pinNorm);
      const pinParent = path.dirname(pinAbs);
      if (pinnedParents.has(pinParent)) continue;
      pinnedParents.add(pinParent);

      try {
        await fs.promises.mkdir(pinParent, { recursive: true });
      } catch { /* best-effort */ }

      // Pre-register known state for pinned file if it exists.
      try {
        await fs.promises.stat(pinAbs);
        knownFiles.add(pinNorm);
      } catch { /* doesn't exist yet */ }

      // Compute the set of pinned files living in this parent dir so we only
      // fire for those, ignoring siblings.
      const pinsInDir = new Set(
        pinned
          .map((p) => p.replace(/\\/g, "/").replace(/^\//, ""))
          .filter((p) => path.dirname(path.join(projectDir, p)) === pinParent),
      );

      const pinWatcher = fs.watch(pinParent, { recursive: false }, (_eventType, reported) => {
        if (!reported) return;
        const reportedRel = reported.split(path.sep).join("/");
        const parentRelToProject = path.relative(projectDir, pinParent).split(path.sep).join("/");
        const projectRelative = parentRelToProject === ""
          ? reportedRel
          : `${parentRelToProject}/${reportedRel}`;
        if (!pinsInDir.has(projectRelative)) return;
        schedule(projectRelative);
      });
      pinWatcher.on("error", (err: Error) => {
        console.warn(`[file-watcher] ${project}: watch error on pinned dir ${pinParent}:`, err.message);
      });
      subs.push({
        watcher: pinWatcher,
        dir: pinParent,
        translate: (_r) => null,
      });
    }

    this.projects.set(project, {
      projectDir,
      canvasRoot: normalizedRoot,
      pinned,
      subs,
      knownFiles,
      debounceTimers,
      refCount: 1,
    });
    console.log(
      `[file-watcher] addProject(${project}) ref=1 — watching ` +
      `canvas=${normalizedRoot || "(project-root)"} (${knownFiles.size} files)` +
      (pinnedParents.size ? `, pinned-dirs=${pinnedParents.size}` : ""),
    );
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
    for (const s of w.subs) s.watcher.close();
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
      for (const s of w.subs) s.watcher.close();
      for (const t of w.debounceTimers.values()) clearTimeout(t);
    }
    this.projects.clear();
  }

  /** Scan `dir` (absolute) and populate knownFiles with paths relative to `projectRoot`. */
  private async scanDir(dir: string, projectRoot: string, knownFiles: Set<string>): Promise<void> {
    try {
      const entries = await fs.promises.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith(".")) continue;
        if (IGNORE_DIRS.has(entry.name)) continue;
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await this.scanDir(fullPath, projectRoot, knownFiles);
        } else if (entry.isFile()) {
          const relPath = path.relative(projectRoot, fullPath).split(path.sep).join("/");
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
    const filePath = path.join(w.projectDir, filename);
    const eventName = filename.startsWith(".mica/card-classes/") ? "card-class-change" : "file-change";

    try {
      const s = await fs.promises.stat(filePath);
      if (s.isDirectory()) return;

      if (w.knownFiles.has(filename)) {
        this.emit(eventName, { type: "changed", filename, project } as FileChangeEvent);
      } else {
        w.knownFiles.add(filename);
        this.emit(eventName, { type: "created", filename, project } as FileChangeEvent);
      }
    } catch {
      if (w.knownFiles.has(filename)) {
        w.knownFiles.delete(filename);
        this.emit(eventName, { type: "deleted", filename, project } as FileChangeEvent);
      }
    }
  }
}
