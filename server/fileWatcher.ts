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

interface PinnedParentEntry {
  /** The fs.watch instance rooted at this parent directory. */
  watcher: fs.FSWatcher;
  /** Set of project-relative pin paths that live in this parent dir. The
   *  watcher's filter consults this on every event; mutating it (during
   *  refreshPinned) updates the filter without rebinding the watcher. */
  pinsInDir: Set<string>;
  /** Back-reference to the SubWatch entry inside ProjectWatch.subs so we
   *  can splice it out when this parent loses its last pin. */
  sub: SubWatch;
}

interface ProjectWatch {
  projectDir: string;
  canvasRoot: string;
  pinned: string[];
  subs: SubWatch[];
  knownFiles: Set<string>;
  debounceTimers: Map<string, ReturnType<typeof setTimeout>>;
  refCount: number;
  /** Per-parent-dir pinned watch state. Keyed by ABSOLUTE path of the
   *  parent directory (so two pins sharing a parent share one watcher).
   *  Lifted out of addProject's local closure into per-project state so
   *  refreshPinned() can mutate the filter and tear down watchers. */
  pinnedParents: Map<string, PinnedParentEntry>;
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
    const pinnedParents = new Map<string, PinnedParentEntry>();

    // Pre-register the project so installPinnedWatch (called below) can find
    // the in-progress entry to mutate. The schedule callback also uses this.
    const projectWatch: ProjectWatch = {
      projectDir,
      canvasRoot: normalizedRoot,
      pinned: [...pinned],
      subs,
      knownFiles,
      debounceTimers,
      refCount: 1,
      pinnedParents,
    };
    this.projects.set(project, projectWatch);

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
      this.scheduleChange(project, projectRelative);
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
      this.scheduleChange(project, projectRelative);
    });
    cardClassesWatcher.on("error", (err: Error) => {
      console.warn(`[file-watcher] ${project}: watch error on .mica/card-classes:`, err.message);
    });
    subs.push({
      watcher: cardClassesWatcher,
      dir: cardClassesAbs,
      translate: (_r) => null,
    });

    // Pinned files outside canvasRoot — install a watcher per unique parent
    // directory, with a per-parent filter limited to that dir's pins. Lifted
    // into installPinnedWatch so refreshPinned() can also call it later.
    for (const pin of pinned) {
      await this.installPinnedWatch(project, pin);
    }

    console.log(
      `[file-watcher] addProject(${project}) ref=1 — watching ` +
      `canvas=${normalizedRoot || "(project-root)"} (${knownFiles.size} files)` +
      (pinnedParents.size ? `, pinned-dirs=${pinnedParents.size}` : ""),
    );
  }

  /** Install (or extend) the watch for a single pinned file. Idempotent —
   *  if the file's parent dir is already watched, just adds the file to the
   *  filter. If pin lives inside canvasRoot, no-op (the recursive canvas
   *  watcher already covers it). */
  private async installPinnedWatch(project: string, pin: string): Promise<void> {
    const w = this.projects.get(project);
    if (!w) return;
    const pinNorm = pin.replace(/\\/g, "/").replace(/^\//, "");
    if (w.canvasRoot !== "" && (pinNorm === w.canvasRoot || pinNorm.startsWith(`${w.canvasRoot}/`))) {
      return; // covered by the canvas-recursive watcher
    }
    const pinAbs = path.join(w.projectDir, pinNorm);
    const pinParent = path.dirname(pinAbs);

    // Pre-register known state so the first event after an existing file's
    // edit fires "changed" rather than "created".
    try {
      await fs.promises.stat(pinAbs);
      w.knownFiles.add(pinNorm);
    } catch { /* file may not exist yet */ }

    const existing = w.pinnedParents.get(pinParent);
    if (existing) {
      existing.pinsInDir.add(pinNorm);
      return;
    }

    try { await fs.promises.mkdir(pinParent, { recursive: true }); } catch { /* */ }

    const pinsInDir = new Set<string>([pinNorm]);
    const watcher = fs.watch(pinParent, { recursive: false }, (_eventType, reported) => {
      if (!reported) return;
      const reportedRel = reported.split(path.sep).join("/");
      const parentRelToProject = path.relative(w.projectDir, pinParent).split(path.sep).join("/");
      const projectRelative = parentRelToProject === ""
        ? reportedRel
        : `${parentRelToProject}/${reportedRel}`;
      // pinsInDir is mutated by refreshPinned — closure reads its current
      // contents on every event, so add/remove pin calls take effect live.
      if (!pinsInDir.has(projectRelative)) return;
      this.scheduleChange(project, projectRelative);
    });
    watcher.on("error", (err: Error) => {
      console.warn(`[file-watcher] ${project}: watch error on pinned dir ${pinParent}:`, err.message);
    });
    const sub: SubWatch = { watcher, dir: pinParent, translate: (_r) => null };
    w.subs.push(sub);
    w.pinnedParents.set(pinParent, { watcher, pinsInDir, sub });
  }

  /** Stop watching a single pinned file. Removes from the parent dir's
   *  filter; tears down the watcher entirely if it was the last pin in
   *  that dir. */
  private removePinnedWatch(project: string, pin: string): void {
    const w = this.projects.get(project);
    if (!w) return;
    const pinNorm = pin.replace(/\\/g, "/").replace(/^\//, "");
    if (w.canvasRoot !== "" && (pinNorm === w.canvasRoot || pinNorm.startsWith(`${w.canvasRoot}/`))) {
      return; // wasn't ever installed by us
    }
    const pinAbs = path.join(w.projectDir, pinNorm);
    const pinParent = path.dirname(pinAbs);
    const entry = w.pinnedParents.get(pinParent);
    if (!entry) return;
    entry.pinsInDir.delete(pinNorm);
    // Drop from knownFiles so a future re-pin of the same file produces a
    // "created" event (matching first-pin behavior) rather than a stale
    // "changed" against an absent prior state.
    w.knownFiles.delete(pinNorm);
    if (entry.pinsInDir.size === 0) {
      try { entry.watcher.close(); } catch { /* */ }
      w.pinnedParents.delete(pinParent);
      const idx = w.subs.indexOf(entry.sub);
      if (idx >= 0) w.subs.splice(idx, 1);
    }
  }

  /** Sync the watcher's pinned set to a new list. Diffs against the current
   *  state; only adds/removes the differences. Cheap to call even for
   *  identical lists. No-op if the project isn't currently watched. */
  async refreshPinned(project: string, newPinned: string[]): Promise<void> {
    const w = this.projects.get(project);
    if (!w) return;
    const newSet = new Set(newPinned);
    const oldSet = new Set(w.pinned);
    const added = newPinned.filter((p) => !oldSet.has(p));
    const removed = w.pinned.filter((p) => !newSet.has(p));
    if (added.length === 0 && removed.length === 0) return;
    for (const pin of removed) this.removePinnedWatch(project, pin);
    for (const pin of added) await this.installPinnedWatch(project, pin);
    w.pinned = [...newPinned];
    console.log(
      `[file-watcher] refreshPinned(${project}) ` +
      `+${added.length} -${removed.length} ` +
      `(now ${w.pinnedParents.size} pinned-dirs, ${newPinned.length} pins)`,
    );
  }

  /** Schedule a debounced handleFileChange call. Per-file timer keyed on
   *  project-relative path; collapses fast bursts (editors that write→
   *  close→reopen on save). */
  private scheduleChange(project: string, projectRelative: string): void {
    const w = this.projects.get(project);
    if (!w) return;
    const existingTimer = w.debounceTimers.get(projectRelative);
    if (existingTimer) clearTimeout(existingTimer);
    w.debounceTimers.set(
      projectRelative,
      setTimeout(() => {
        w.debounceTimers.delete(projectRelative);
        this.handleFileChange(project, projectRelative).catch((err) => {
          console.error(`[file-watcher] ${project}: error handling ${projectRelative}:`, (err as Error).message);
        });
      }, DEBOUNCE_MS),
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
