// Tracks who initiated a write to a given file so the next file-changed
// broadcast can carry that source. Two granularities:
//
//   source     — the *browser tab* (windowId), or "agent" / "external".
//                Backward-compat: every existing card class compares against
//                `mica.windowId`. Don't break that.
//   cardSource — the *card instance* UUID (the same UUID used as the channel
//                session key). New: lets sibling cards in the same tab tell
//                each other's writes apart from their own. Compared via the
//                bridge helper `mica.isSelfEcho(event)`.
//
// Cards may use either or both. New code should prefer `mica.isSelfEcho()`.

export interface WriteSource {
  source: string;        // windowId | "agent" | "external"
  cardSource?: string;   // per-card-instance UUID (optional)
}

const tracker = new Map<string, WriteSource>();

export function markWriteSource(filename: string, source: string, cardSource?: string): void {
  tracker.set(filename, { source, cardSource });
}

export function consumeWriteSource(filename: string): WriteSource {
  const s = tracker.get(filename) ?? { source: "external" };
  tracker.delete(filename);
  return s;
}

export function markAgentWrite(filename: string): void {
  tracker.set(filename, { source: "agent" });
}
