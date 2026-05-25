// Shared reactive-coalesce machinery: turns raw file-watcher events into
// debounced synthetic turns delivered to a chat agent. Lifted from the
// duplicated implementations in micaAgent.ts and claudeAgent.ts so all
// three chat agents (qwen, claude, opencode) go through one mechanism.
//
// Contract:
//   Server provides MECHANISM only. The synthetic-turn text is purely
//   structured signal — no policy prose, no "you should X" framing.
//   Response policy lives in the template's skill prose, where each
//   project can tailor it. This mirrors CLAUDE.md tenet 3 (pipes, not
//   policy) and tenet 1 (optimize for AI generation): a structured
//   signal is more durable across model swaps than hardcoded English.
//
// Two signals emerge from one delivery:
//   [Draft revision] — files the agent authored in this session were
//                      then edited by the user. Carries a per-file diff
//                      against the agent's last-written snapshot.
//   [File activity]  — ambient file events not tied to recent agent
//                      authorship. Filenames + change type only.
// Both fire in the same delivery if the buffer mixes both kinds.

import { readFileSync as fsReadFileSync, existsSync } from "fs";
import { join } from "path";
import type { FileWatcher } from "./fileWatcher.js";
import { formatLineDiff, hasChanges } from "./lineDiff.js";
import { WORKSPACE_DIR } from "./files.js";

const USER_IDLE_BEFORE_AGENT_MS = 30_000;
// Wait this long after the last user edit before delivering a synthetic
// turn. Each new event re-arms the timer, so continuous typing never
// fires. 30s is the sweet spot: long enough that a user typing in
// short bursts doesn't trigger mid-thought, short enough that a finished
// revision feels responsive. Was 60s previously — overly cautious for
// the iteration-with-the-agent case where the user IS waiting for
// Mica to engage. Decouples reactive-turn dispatch from cross-window
// broadcast, which still propagates in real time.

type ChangeType = "created" | "changed" | "deleted";

interface BufferEntry {
  type: ChangeType;
  count: number;
}

interface SessionState {
  project: string | null;
  sessionFilename: string;
  canvasRoot: string;
  pinnedFiles: Set<string>;
  busy: boolean;
  /** Full canvas-relative paths the agent has written this session.
   *  Each entry is consumed once by the next file-change event for that
   *  path (suppresses the agent's own writes from triggering reactivity). */
  agentWrittenFiles: Set<string>;
  /** Snapshot of the agent's last-written bytes per file (full relpath).
   *  Cleared only when the agent re-writes the file (snapshot updates)
   *  or the file is deleted. User edits do NOT clear the snapshot — the
   *  agent sees cumulative diffs across multiple user revisions until
   *  it explicitly re-authors. */
  authoredSnapshots: Map<string, string>;
  coalesceBuffer: Map<string, BufferEntry>;
  coalesceTimer: ReturnType<typeof setTimeout> | null;
  onDeliver: (message: string, source: "file-changes") => void;
}

// Module-level state. Single listener, single sessions map.
const sessions = new Map<string, SessionState>(); // key = sessionFilename
let listenerAttached = false;
// Per-project filename suppressions populated by the cascade-apply
// endpoint. The next file-change for each entry is dropped from the
// reactive flow (the cross-window broadcast is unaffected). One-shot.
const cascadeSuppression = new Map<string, Set<string>>(); // project -> filenames

function inCanvasScope(filename: string, canvasRoot: string, pinned: Set<string>): boolean {
  if (pinned.has(filename)) return true;
  if (canvasRoot === "" || canvasRoot === ".") return !filename.includes("/");
  const prefix = canvasRoot.replace(/\/$/, "") + "/";
  return filename.startsWith(prefix);
}

function consumeCascadeSuppression(project: string, filename: string): boolean {
  const set = cascadeSuppression.get(project);
  if (!set || !set.has(filename)) return false;
  set.delete(filename);
  if (set.size === 0) cascadeSuppression.delete(project);
  return true;
}

/** Project-keyed absolute path for a canvas-relative filename. */
function absPathFor(project: string | null, relPath: string): string | null {
  if (!project) return null;
  return join(WORKSPACE_DIR, project, relPath);
}

function readCurrent(project: string | null, relPath: string): string | null {
  const abs = absPathFor(project, relPath);
  if (!abs || !existsSync(abs)) return null;
  try {
    return fsReadFileSync(abs, "utf-8");
  } catch {
    return null;
  }
}

/** Compose the synthetic-turn text from a session's coalesced buffer.
 *  Returns null if everything netted out to a no-op (e.g. created then
 *  deleted within the window). */
function composeDelivery(state: SessionState): { message: string } | null {
  if (state.coalesceBuffer.size === 0) return null;

  const draftSections: string[] = [];
  const activityLines: string[] = [];

  const label = { created: "added", changed: "modified", deleted: "deleted" } as const;

  for (const [relPath, entry] of state.coalesceBuffer) {
    const snapshot = state.authoredSnapshots.get(relPath);
    if (entry.type === "deleted") {
      // Deletion of an authored file → it's just gone; no diff to show.
      // List it under [File activity] and drop the snapshot.
      if (snapshot !== undefined) state.authoredSnapshots.delete(relPath);
      activityLines.push(`- ${relPath} (deleted)`);
      continue;
    }
    if (snapshot !== undefined) {
      const current = readCurrent(state.project, relPath);
      if (current !== null && hasChanges(snapshot, current)) {
        const diff = formatLineDiff(snapshot, current);
        const suffix = entry.count > 1 ? ` (modified, ${entry.count}x)` : "";
        draftSections.push(`### ${relPath}${suffix}\n\`\`\`diff\n${diff}\n\`\`\``);
        continue;
      }
      // Snapshot exists but content matches (FS noise) or unreadable —
      // fall through to ambient bucket.
    }
    const suffix = entry.count > 1 ? ` (${label[entry.type]}, ${entry.count}x)` : ` (${label[entry.type]})`;
    activityLines.push(`- ${relPath}${suffix}`);
  }

  state.coalesceBuffer.clear();

  const parts: string[] = [];
  if (draftSections.length > 0) {
    parts.push(
      "[Draft revision] You authored these files in this session; the user has since edited them.\n\n" +
        draftSections.join("\n\n"),
    );
  }
  if (activityLines.length > 0) {
    parts.push(
      "[File activity] These canvas files changed since your last reply:\n" + activityLines.join("\n"),
    );
  }
  if (parts.length === 0) return null;
  return { message: parts.join("\n\n") };
}

/** Run the deliver flow for a session: compose, dispatch via the
 *  session's onDeliver callback. No-op on empty buffer. */
function flushSession(state: SessionState): void {
  if (state.coalesceTimer) {
    clearTimeout(state.coalesceTimer);
    state.coalesceTimer = null;
  }
  const composed = composeDelivery(state);
  if (!composed) return;
  state.onDeliver(composed.message, "file-changes");
}

/** Attach a single file-change listener to the shared file watcher.
 *  Idempotent — safe to call from each agent's module load. */
export function attachReactiveCoalesce(fileWatcher: FileWatcher): void {
  if (listenerAttached) return;
  listenerAttached = true;
  fileWatcher.on("file-change", (event: { type: string; filename: string; project: string }) => {
    if (event.filename.startsWith(".")) return;
    for (const [sessionFilename, state] of sessions) {
      if (state.project && state.project !== event.project) continue;
      if (event.filename === sessionFilename) continue;          // ignore the agent's own chat file
      // NOTE: we no longer drop events while busy. Events accumulate
      // in the coalesce buffer regardless of busy state; only the
      // delivery timer waits for busy to release. Previously these
      // events were lost entirely, which meant a user editing a spec
      // DURING the agent's mid-turn produced nothing — no [Draft
      // revision] ever fired, because the buffer was empty at
      // busy-release time. Now: accumulate now, deliver later.
      if (!inCanvasScope(event.filename, state.canvasRoot, state.pinnedFiles)) continue;
      if (state.agentWrittenFiles.has(event.filename)) {
        state.agentWrittenFiles.delete(event.filename);
        continue;                                                // agent's own write — one-shot suppress
      }
      if (state.project && consumeCascadeSuppression(state.project, event.filename)) {
        continue;                                                // user-approved cascade write — one-shot suppress
      }

      const existing = state.coalesceBuffer.get(event.filename);
      const newType = event.type as ChangeType;
      if (existing?.type === "created" && newType === "deleted") {
        state.coalesceBuffer.delete(event.filename);             // net nothing in window
      } else if (existing?.type === "deleted" && newType === "created") {
        state.coalesceBuffer.set(event.filename, { type: "changed", count: existing.count + 1 });
      } else {
        state.coalesceBuffer.set(event.filename, {
          type: newType,
          count: (existing?.count ?? 0) + 1,
        });
      }

      // If the file was authored and is now deleted, drop the snapshot.
      if (newType === "deleted") state.authoredSnapshots.delete(event.filename);

      // Only arm the idle timer when the agent is NOT busy. If busy,
      // setBusy(false) will start the timer once the turn ends. This
      // preserves the "don't deliver mid-turn" invariant while keeping
      // the buffer accurate.
      if (!state.busy) {
        if (state.coalesceTimer) clearTimeout(state.coalesceTimer);
        state.coalesceTimer = setTimeout(() => {
          state.coalesceTimer = null;
          flushSession(state);
        }, USER_IDLE_BEFORE_AGENT_MS);
      }
    }
  });
}

export interface ReactiveSessionOptions {
  project: string | null;
  sessionFilename: string;
  canvasRoot: string;
  pinnedFiles: Iterable<string>;
  /** Agent callback. Receives the structured synthetic-turn message
   *  text and a source tag. The agent decides whether to enqueue
   *  (busy) or process immediately. */
  onDeliver: (message: string, source: "file-changes") => void;
}

export interface ReactiveSessionHandle {
  /** Called by the agent when its tool loop writes a canvas file.
   *  relPath is canvas-relative (e.g. "canvas/hotdog-spec.md"). */
  markAgentWrite(relPath: string): void;
  /** Reflect the agent's busy state — buffer accumulates without firing
   *  while busy=true, then the next event after busy=false re-arms the
   *  timer. */
  setBusy(busy: boolean): void;
  /** If there are pending events, flush them now (don't wait for the
   *  idle timer). Useful when the agent transitions from busy→idle and
   *  there's accumulated activity to deliver. */
  flushIfPending(): void;
  /** Detach the session from the shared listener. Idempotent. */
  destroy(): void;
}

export function registerReactiveSession(opts: ReactiveSessionOptions): ReactiveSessionHandle {
  const state: SessionState = {
    project: opts.project,
    sessionFilename: opts.sessionFilename,
    canvasRoot: opts.canvasRoot,
    pinnedFiles: new Set(opts.pinnedFiles),
    busy: false,
    agentWrittenFiles: new Set(),
    authoredSnapshots: new Map(),
    coalesceBuffer: new Map(),
    coalesceTimer: null,
    onDeliver: opts.onDeliver,
  };
  // Replace any prior registration with the same filename (StrictMode
  // remount or fresh-thread reuse). The old timer is dropped — its
  // callback would reference the old state object, harmless.
  sessions.set(opts.sessionFilename, state);

  return {
    markAgentWrite(relPath: string): void {
      state.agentWrittenFiles.add(relPath);
      const current = readCurrent(state.project, relPath);
      if (current !== null) state.authoredSnapshots.set(relPath, current);
      else state.authoredSnapshots.delete(relPath);             // file gone (rare race) — no snapshot to keep
    },
    setBusy(busy: boolean): void {
      const wasBusy = state.busy;
      state.busy = busy;
      // On busy→idle transition: if events accumulated during the turn,
      // arm the 30s idle timer now. (The listener doesn't arm it while
      // busy.) If the user kept typing after busy-release, subsequent
      // events will reset the timer in the listener path.
      if (wasBusy && !busy && state.coalesceBuffer.size > 0 && !state.coalesceTimer) {
        state.coalesceTimer = setTimeout(() => {
          state.coalesceTimer = null;
          flushSession(state);
        }, USER_IDLE_BEFORE_AGENT_MS);
      }
    },
    flushIfPending(): void {
      if (state.coalesceBuffer.size === 0) return;
      flushSession(state);
    },
    destroy(): void {
      if (state.coalesceTimer) clearTimeout(state.coalesceTimer);
      state.coalesceTimer = null;
      sessions.delete(opts.sessionFilename);
    },
  };
}

/** Add a (project, filename) pair to the cascade-suppression set. The
 *  next file-change event for that filename will be dropped from the
 *  reactive flow exactly once. Called by the cascade-apply endpoint
 *  before writing a sibling file the user has approved. */
export function suppressNextCascadeWrite(project: string, filename: string): void {
  let set = cascadeSuppression.get(project);
  if (!set) {
    set = new Set();
    cascadeSuppression.set(project, set);
  }
  set.add(filename);
}
