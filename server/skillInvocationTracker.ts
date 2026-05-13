// skillInvocationTracker.ts — per-chat-card record of which agent
// skills have been invoked in the current session.
//
// Purpose: predicate gates in toolPrerequisites.ts ask "has the agent
// invoked skill X in this chat session?" — for example, the
// card-class-handbook gate on mica_create_class. The qwen-code SDK
// doesn't expose this information itself (skills are just markdown
// tool results from the SDK's perspective), so mica observes the
// agent's `tool_use: skill` events and records them here.
//
// Lifecycle (must match Mica's chat-thread lifecycle so the tracker
// doesn't drift out of sync with the model's working memory):
//   - Cleared on "fresh thread" — model's context after a thread
//     reset truly has no handbook content; the tracker reflects that.
//   - Cleared on chat card deletion (file removed).
//   - Cleared on project deletion (mirror of clearProjectValidatorErrors).
//   - Wiped automatically on backend restart (in-memory only).
//
// Multi-window safe: key is the chat-card filename, not the WebSocket
// session id, so multiple windows viewing the same chat card share
// the same entry. See ARCHITECTURE.md "User intent, not transport."

// Two-level Map: project name → chat-card filename → set of invoked
// skill names. Matches the validatorErrorBuffer shape so callers
// can reason about both with the same mental model.
const tracker = new Map<string, Map<string, Set<string>>>();

/** Record that the agent in <project>/<chatFilename> invoked
 *  skill(<skillName>) this session. Idempotent (re-recording is a
 *  no-op). Skips when project or chatFilename is missing so callers
 *  don't have to null-check at every call site. */
export function recordSkillInvocation(
  project: string | null,
  chatFilename: string | null,
  skillName: string,
): void {
  if (!project || !chatFilename || !skillName) return;
  let perProject = tracker.get(project);
  if (!perProject) {
    perProject = new Map();
    tracker.set(project, perProject);
  }
  let perChat = perProject.get(chatFilename);
  if (!perChat) {
    perChat = new Set();
    perProject.set(chatFilename, perChat);
  }
  perChat.add(skillName);
}

/** True if the named skill was invoked in this chat-card's session. */
export function hasSkillBeenInvoked(
  project: string | null,
  chatFilename: string | null,
  skillName: string,
): boolean {
  if (!project || !chatFilename || !skillName) return false;
  return tracker.get(project)?.get(chatFilename)?.has(skillName) ?? false;
}

/** Drop the chat-card's recorded skill invocations. Called when the
 *  chat thread is reset ("fresh thread"), when the chat card is
 *  deleted, or any time the model's context has been cleared
 *  externally. */
export function clearChatSession(
  project: string | null,
  chatFilename: string | null,
): void {
  if (!project || !chatFilename) return;
  tracker.get(project)?.delete(chatFilename);
}

/** Wipe every chat card's tracker entries for a project. Called from
 *  project-deletion paths to prevent stale entries from leaking into
 *  a fresh project that happens to reuse a name. */
export function clearProjectSkillInvocations(project: string): void {
  tracker.delete(project);
}

/** Diagnostic only — peek the recorded set for a chat card. Read-only;
 *  callers should not mutate the returned set. Returns an empty array
 *  if no entry exists. */
export function listInvokedSkills(
  project: string | null,
  chatFilename: string | null,
): string[] {
  if (!project || !chatFilename) return [];
  const set = tracker.get(project)?.get(chatFilename);
  return set ? Array.from(set).sort() : [];
}
