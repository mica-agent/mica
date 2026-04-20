// Tracks who initiated a write to a given file so the next file-changed
// broadcast can carry that source. Clients use it for:
//   - self-echo suppression (when the source is their own windowId)
//   - UI cues (e.g. the agent-write glow when source === "agent")

const tracker = new Map<string, string>();

export function markWriteSource(filename: string, source: string): void {
  tracker.set(filename, source);
}

export function consumeWriteSource(filename: string): string {
  const s = tracker.get(filename) ?? "external";
  tracker.delete(filename);
  return s;
}

export function markAgentWrite(filename: string): void {
  tracker.set(filename, "agent");
}
