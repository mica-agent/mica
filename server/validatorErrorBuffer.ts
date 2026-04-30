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

interface BufferedError {
  filename: string;
  error: string;
  ts: number;
}

// project -> filename -> latest error for that file
const buffer = new Map<string, Map<string, BufferedError>>();

/** Append (or replace) an error for a project+filename. The latest call
 *  wins — older entries for the same file are overwritten so the buffer
 *  always reflects the validator's most recent verdict. */
export function recordValidatorError(project: string, filename: string, error: string): void {
  if (!project || !filename || !error) return;
  if (!buffer.has(project)) buffer.set(project, new Map());
  buffer.get(project)!.set(filename, { filename, error, ts: Date.now() });
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
}
