// validatorErrorBuffer.ts — per-project, per-file accumulator of validator
// errors that the agent should see on its next turn.
//
// Why this exists: validators in cardValidators.ts (enforceCardClassPath,
// enforceCardClassMetadata, enforceCardJsLint, enforceDecompositionConsistency,
// enforceDependenciesReachable) fire on file-change events and broadcast
// `card-error` over the project's WebSocket. Those broadcasts reach the
// chat card's frontend (visible to the user) but DON'T flow back into the
// agent's prompt context. Result: the agent writes a malformed metadata.json,
// the validator catches it and tells the user, but the agent — running
// inside the same turn — never sees the error and declares "fix complete."
// Next user message has to re-prompt the agent to fix what the validator
// already diagnosed.
//
// Fix: route every `card-error` broadcast through this buffer too. On the
// agent's next turn, buildContext() injects the pending entries as a
// `## Validator errors since last turn` section in the system-prompt
// append. Self-cleaning: when a file is rewritten, the file-watcher event
// handler clears its entry BEFORE re-running validators — so a successful
// validator run leaves the buffer empty for that file (no stale errors
// after a fix), while a still-failing validator immediately re-records.
//
// In-memory only. Per-process. Errors don't survive backend restart, but
// neither do agent sessions, so the symmetry is fine — restart wipes the
// in-flight world consistently. Persist later if the same error needs to
// span restarts.

import { statSync, readdirSync, existsSync } from "node:fs";
import { join, basename } from "node:path";

interface BufferedError {
  filename: string;
  error: string;
  ts: number;
}

// project -> filename -> latest error for that file
const buffer = new Map<string, Map<string, BufferedError>>();

// Flap trail: when an error is cleared (browser POSTs /ok), we MOVE the entry
// here instead of dropping it. If the same filename re-errors within
// RECENT_TTL_MS, bump flapCount — that's the signal the agent's "fix" was a
// transient illusion. buildContext reads this as an advisory so the next turn
// after a flap-and-clear cycle still mentions the recently-seen problem.
const RECENT_TTL_MS = 2 * 60_000;
interface RecentEntry {
  filename: string;
  error: string;
  firstSeen: number;
  lastSeen: number;
  flapCount: number;
}
const recentlyCleared = new Map<string, Map<string, RecentEntry>>();

function pruneRecentlyCleared(project: string): void {
  const map = recentlyCleared.get(project);
  if (!map) return;
  const cutoff = Date.now() - RECENT_TTL_MS;
  for (const [k, v] of Array.from(map.entries())) {
    if (v.lastSeen < cutoff) map.delete(k);
  }
}

/** Append (or replace) an error for a project+filename. The latest call
 *  wins — older entries for the same file are overwritten so the buffer
 *  always reflects the validator's most recent verdict. */
export function recordValidatorError(project: string, filename: string, error: string): void {
  if (!project || !filename || !error) return;
  const now = Date.now();
  if (!buffer.has(project)) buffer.set(project, new Map());
  buffer.get(project)!.set(filename, { filename, error, ts: now });

  // Update flap trail. If a recently-cleared entry exists for this filename,
  // bump flapCount and refresh lastSeen — same error returning within the TTL
  // is the flap signal. Otherwise start a new entry at flapCount=1.
  if (!recentlyCleared.has(project)) recentlyCleared.set(project, new Map());
  const recents = recentlyCleared.get(project)!;
  const existing = recents.get(filename);
  if (existing) {
    existing.error = error;
    existing.lastSeen = now;
    existing.flapCount += 1;
  } else {
    recents.set(filename, { filename, error, firstSeen: now, lastSeen: now, flapCount: 1 });
  }
}

/** Clear any buffered error for one file. Called from the file-watcher
 *  event handler at the START of a file's change handling, before
 *  validators re-run. If the validator stays silent (file is now valid),
 *  the buffer entry stays cleared; if it re-emits, recordValidatorError
 *  immediately re-fills. Net effect: the buffer always tracks current
 *  validator verdicts. */
export function clearValidatorError(project: string, filename: string): void {
  buffer.get(project)?.delete(filename);
}

/** Peek the project's pending errors, oldest-first. Does NOT clear —
 *  errors persist until the file is rewritten (validator silence) or
 *  the next write produces a different error (overwrite). The agent's
 *  next-turn buildContext consumes via this read; persistence-until-fixed
 *  means the agent keeps seeing the error every turn until it actually
 *  fixes the file. */
export function getPendingValidatorErrors(project: string): BufferedError[] {
  const map = buffer.get(project);
  if (!map || map.size === 0) return [];
  return Array.from(map.values()).sort((a, b) => a.ts - b.ts);
}

/** Wipe the entire project's buffer. Called from project-deletion paths
 *  to prevent stale entries from leaking into a fresh project with the
 *  same name. */
export function clearProjectValidatorErrors(project: string): void {
  buffer.delete(project);
  recentlyCleared.delete(project);
}

/** Read the recently-cleared trail for a project. Entries older than
 *  RECENT_TTL_MS are pruned in-place before returning. Only entries with
 *  flapCount >= 2 are returned — first-time-and-cleared errors are
 *  presumed genuinely fixed; flaps mean the agent's previous fix didn't
 *  hold. Returned in oldest-first order. */
export function getRecentlyClearedFlaps(project: string): RecentEntry[] {
  pruneRecentlyCleared(project);
  const map = recentlyCleared.get(project);
  if (!map || map.size === 0) return [];
  return Array.from(map.values())
    .filter((e) => e.flapCount >= 2)
    .sort((a, b) => a.firstSeen - b.firstSeen);
}

/** Peek whether a project+filename currently has a buffered error. Used by
 *  the file-watcher to decide whether to broadcast `card-error-cleared`
 *  after validators settle: only fire the cleared event when the file
 *  GOES from errored → clean, not on every clean write. */
export function hasValidatorError(project: string, filename: string): boolean {
  return buffer.get(project)?.has(filename) ?? false;
}

/** Derive the absolute path of the card class directory associated with
 *  an errored file, or null if the filename doesn't map to a class.
 *  - Instance file (`canvas/foo.bar`) → `<projectDir>/.mica/card-classes/bar/`.
 *    Uses the dotted-extension convention; the extension after the LAST
 *    dot is the class name.
 *  - Class file (`.mica/card-classes/bar/card.js`) → its own directory.
 *  - Anything else → null. */
function deriveClassDir(filename: string, projectDir: string): string | null {
  if (!filename || !projectDir) return null;
  if (filename.includes("card-classes/")) {
    // ".mica/card-classes/bar/card.js" → projectDir/.mica/card-classes/bar
    const m = filename.match(/(.*card-classes\/[^/]+)\/[^/]+$/);
    if (m) return join(projectDir, m[1]);
    return null;
  }
  // Instance: extension after the last dot is the class name.
  const base = basename(filename);
  const lastDot = base.lastIndexOf(".");
  if (lastDot <= 0) return null;
  const ext = base.slice(lastDot + 1);
  if (!ext || ext.includes("/")) return null;
  return join(projectDir, ".mica", "card-classes", ext);
}

/** True if any file inside the class directory associated with `filename`
 *  was modified after `errorTs`. Used to skip stale validator/runtime
 *  errors when the agent has rewritten class files since the error was
 *  recorded — typically the window between an agent edit and the next
 *  browser remount (which would POST /ok to clear the buffer entry).
 *  Returns false (treat as fresh) when no class directory can be derived
 *  or it doesn't exist on disk: do not silently drop errors we can't
 *  reason about. */
function classWasEditedAfter(
  filename: string,
  errorTs: number,
  projectDir: string,
): boolean {
  const classDir = deriveClassDir(filename, projectDir);
  if (!classDir || !existsSync(classDir)) return false;
  try {
    for (const entry of readdirSync(classDir)) {
      const fullPath = join(classDir, entry);
      try {
        if (statSync(fullPath).mtimeMs > errorTs) return true;
      } catch { /* unreadable entry, skip */ }
    }
  } catch { /* unreadable directory, treat as not-edited */ }
  return false;
}

/** Like getPendingValidatorErrors, but filters out entries where any
 *  file in the related card class directory has mtime newer than the
 *  error timestamp. Those errors are pending re-verification — the
 *  agent has edited the class but the browser hasn't yet remounted to
 *  POST `/ok` (which would clear the entry) or POST `/error` again
 *  (which would refresh `ts`). Dispatching a reactivity turn against
 *  such errors leads the model to debug phantoms.
 *
 *  Returns `{ fresh, filteredStale }` so the caller can log the
 *  filtered count for observability — agents see only `fresh`. */
export function getFreshPendingValidatorErrors(
  project: string,
  projectDir: string,
): { fresh: BufferedError[]; filteredStale: BufferedError[] } {
  const all = getPendingValidatorErrors(project);
  const fresh: BufferedError[] = [];
  const filteredStale: BufferedError[] = [];
  for (const e of all) {
    if (classWasEditedAfter(e.filename, e.ts, projectDir)) {
      filteredStale.push(e);
    } else {
      fresh.push(e);
    }
  }
  return { fresh, filteredStale };
}
