// renderCaptureCounter.ts — per-turn cap on render_capture invocations.
//
// The agent reflexively calls render_capture every time it changes a card,
// and when a card returns a black/empty screenshot (the WebGL false-negative
// case the handbook documents) it can loop indefinitely — iterating CSS,
// dependencies, scene composition — without recognizing that the captioner
// just can't read GPU output. This counter refuses the call past CAP per
// turn with a message pointing at the canonical fix.
//
// Per-process, in-memory. Keyed by project. Reset on each processMessage
// START in micaAgent / opencodeAgent.
//
// Why a hard cap, not a soft warning: warnings are advisory and the agent
// has already shown it'll keep iterating against the same render_capture
// result. A refusal at the tool boundary is the same shape as
// checkCardClassPrecondition / per-turn write caps — convert the recurring
// failure mode into a deterministic same-turn signal.

const CAP = 5;

const counts = new Map<string, number>();

/** Reset the counter for a project at processMessage START. Called by both
 *  micaAgent and opencodeAgent before a new turn begins. */
export function resetRenderCaptureCount(project: string | null | undefined): void {
  if (!project) return;
  counts.delete(project);
}

/** Increment and return the new count for a project. */
export function bumpRenderCaptureCount(project: string | null | undefined): number {
  if (!project) return 0;
  const next = (counts.get(project) || 0) + 1;
  counts.set(project, next);
  return next;
}

/** Current count for a project (no side effect). */
export function getRenderCaptureCount(project: string | null | undefined): number {
  if (!project) return 0;
  return counts.get(project) || 0;
}

export const RENDER_CAPTURE_CAP = CAP;
