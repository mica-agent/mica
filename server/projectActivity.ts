// Project-level activity tracking and broadcast.
//
// Agents (mica-agent, claude-agent) call markProjectActivity(project, +1)
// when an assistant turn starts and -1 when it ends. The /api/projects
// endpoint enriches its response with these counters; ProjectList
// subscribes to project-activity-changed broadcasts to render a live
// "active" indicator on the project list page.
//
// Workspace-level events (project-list-changed: created, deleted, renamed)
// are broadcast via the same registered fn so the project-list page
// auto-refreshes without polling.

interface ActivityEntry {
  activeTurns: number;
  lastActivityAt: number;
}

const activity = new Map<string, ActivityEntry>();

let _broadcast: ((msg: Record<string, unknown>) => void) | null = null;

/** Wire the workspace-level broadcast fn. Called once at startup from
 *  index.ts with the global `broadcast()` (sends to all WS clients). */
export function setActivityBroadcast(fn: (msg: Record<string, unknown>) => void): void {
  _broadcast = fn;
}

/** Increment / decrement active-turn counter for a project. Pass +1 when an
 *  assistant turn starts, -1 when it ends. The counter is clamped at >= 0
 *  so under-counts from crashes don't leave a project stuck at activeTurns=0
 *  showing "active." */
export function markProjectActivity(project: string | null, delta: number): void {
  if (!project) return;
  const cur: ActivityEntry = activity.get(project) ?? { activeTurns: 0, lastActivityAt: 0 };
  cur.activeTurns = Math.max(0, cur.activeTurns + delta);
  cur.lastActivityAt = Date.now();
  activity.set(project, cur);
  _broadcast?.({
    type: "project-activity-changed",
    project,
    activeTurns: cur.activeTurns,
    lastActivityAt: cur.lastActivityAt,
  });
}

/** Read the current activity entry for a project. Used by the /api/projects
 *  endpoint to enrich the response with current state on first load. */
export function getProjectActivity(project: string): ActivityEntry {
  return activity.get(project) ?? { activeTurns: 0, lastActivityAt: 0 };
}

/** Forget all activity for a project. Called when a project is deleted so
 *  stale counters don't appear in future listings if the name is reused. */
export function clearProjectActivity(project: string): void {
  activity.delete(project);
}

/** Workspace-level: notify all clients that the project list has changed
 *  (a project was created, deleted, or renamed). Clients re-fetch on this
 *  event. Fired by the relevant /api/projects endpoints in index.ts. */
export function broadcastProjectListChanged(): void {
  _broadcast?.({ type: "project-list-changed" });
}
