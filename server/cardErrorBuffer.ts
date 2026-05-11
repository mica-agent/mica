// cardErrorBuffer.ts — per-project, per-file accumulator of card-error
// broadcasts that are HELD back from the chat UI until the agent finishes
// its turn.
//
// Why this exists: a card class under active build re-mounts on every save,
// throws on intermediate states the agent is about to fix, and recovers a
// second or two later. Surfacing those transient errors to the chat UI is
// noise — the agent already sees the runtime error via the validator
// buffer (validatorErrorBuffer.ts) and self-heals through render_capture
// / next-turn buildContext.
//
// Milestone, not timer: the user-facing broadcast fires at agent turn-end,
// not after a fixed delay. If the card POSTs /ok during the turn (error
// healed), we cancel the pending broadcast. If the turn ends with the error
// still active, we surface it — that's the signal the agent stopped and
// couldn't fix the issue on its own. A safety-net fallback timer fires after
// FALLBACK_MS in case the turn-end signal never arrives (agent crash,
// external errors not associated with any turn).
//
// In-memory only. Per-process.

const FALLBACK_MS = 60_000;

type CardErrorEntry = { project: string; filename: string; error: string };
type CardErrorBroadcaster = (entry: CardErrorEntry) => void;

interface Pending {
  error: string;
  project: string;
  filename: string;
  fallbackTimer: NodeJS.Timeout;
}

const pending = new Map<string, Pending>();
let broadcaster: CardErrorBroadcaster | null = null;

/** Wire the surface callback. Called once at module-init from index.ts.
 *  Keeps the buffer module decoupled from broadcastToProject + the broadcast
 *  shape — the caller owns those concerns. */
export function setCardErrorBroadcaster(fn: CardErrorBroadcaster): void {
  broadcaster = fn;
}

function surface(entry: CardErrorEntry): void {
  if (broadcaster) broadcaster(entry);
}

/** Hold a card-error broadcast pending. If the same error is already pending,
 *  this is a no-op (don't reset the fallback). If a different error is pending
 *  for the same file, replace it (the new error is what's now relevant). */
export function recordPendingError(project: string, filename: string, error: string): void {
  if (!project || !filename || !error) return;
  const key = `${project}:${filename}`;
  const existing = pending.get(key);
  if (existing && existing.error === error) return;
  if (existing) clearTimeout(existing.fallbackTimer);
  const fallbackTimer = setTimeout(() => {
    pending.delete(key);
    surface({ project, filename, error });
  }, FALLBACK_MS);
  pending.set(key, { error, project, filename, fallbackTimer });
}

/** Cancel a pending broadcast — the card now renders cleanly, so the prior
 *  error self-healed. The user should not be told about a resolved error. */
export function clearPendingError(project: string, filename: string): void {
  const key = `${project}:${filename}`;
  const entry = pending.get(key);
  if (entry) {
    clearTimeout(entry.fallbackTimer);
    pending.delete(key);
  }
}

/** Surface and remove all pending broadcasts for a project. Called at
 *  agent turn-end (from micaAgent + opencodeAgent finally blocks). Errors
 *  that survived a full turn without /ok firing reach the user UI here. */
export function flushProjectPendingErrors(project: string): void {
  for (const [key, entry] of Array.from(pending.entries())) {
    if (entry.project === project) {
      clearTimeout(entry.fallbackTimer);
      pending.delete(key);
      surface({ project, filename: entry.filename, error: entry.error });
    }
  }
}
