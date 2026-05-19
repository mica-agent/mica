// userMessageTracker.ts — per-session record of when the last REAL
// user message arrived.
//
// Used by toolPrerequisites.ts to enforce the spec-approval gate:
// after the agent writes canvas/<class>-spec.md, mica_create_class
// must wait for an actual user message before firing. Without this,
// the agent can confabulate "the user said 'go ahead'" inside its
// own thinking block and proceed to build immediately, skipping the
// human-in-the-loop checkpoint (observed in the orbit4 build).
//
// "Real user message" means source `"user"` or `"voice"` — typed in
// chat or transcribed from a voice turn. Excludes:
//   - `"file-changes"` — Mica injects when the agent's canvas-scoped
//     files change, not a user reply.
//   - `"recovery"` — Mica injects when a recovery heuristic fires
//     (thinking-only, skill-followthrough, etc.), not a user reply.
//
// Recorded at `processMessage` start in both micaAgent.ts and
// claudeAgent.ts. Cleared on chat archive (handled implicitly — the
// map key includes the chat filename which goes stale after a clear,
// and a fresh chat starts at timestamp 0).

const lastUserMessageAt = new Map<string, number>();

function key(project: string, chatFilename: string): string {
  return `${project}::${chatFilename}`;
}

/** Record that a real user message just arrived. Call at processMessage
 *  start when source is `"user"` or `"voice"`. */
export function recordUserMessage(
  project: string | null,
  chatFilename: string | null,
): void {
  if (!project || !chatFilename) return;
  lastUserMessageAt.set(key(project, chatFilename), Date.now());
}

/** Return the timestamp (ms since epoch) of the most recent real user
 *  message for this session, or null if none has been recorded. */
export function getLastUserMessageAt(
  project: string,
  chatFilename: string,
): number | null {
  return lastUserMessageAt.get(key(project, chatFilename)) ?? null;
}
