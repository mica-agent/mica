// turnEvents.ts — per-turn structured event log for retrospective analysis.
//
// Sidecar to turnSnapshots.ts. Each chat turn appends every SDK event
// (tool_use, thinking, result) as one JSON line to
//   `.mica/chats/<chatId>/turn-<turnId>.events.jsonl`
//
// Purpose: keep a complete record of what the agent DID and THOUGHT for any
// turn — full tool_use inputs, full thinking-block contents, full result
// text. The existing backend.log truncates thinking to 120 chars and
// tool_use to ~200 chars; this file is the full-fidelity record.
//
// Strictly an OBSERVABILITY artifact. NOT fed back into the agent's
// context on future turns. The token-budget posture is unchanged — these
// files live on disk for humans (the user looking back, an investigator
// debugging exit-53 loops) and tooling (grep, jq, future replay UIs).
// Compare turnSnapshots.ts: same pattern, complementary content (snapshot
// = what the agent SAW; events = what the agent DID).
//
// Format: one JSON object per line. Fields always include `ts` (Unix-ms)
// and `type`; remaining fields per type:
//   { ts, type: "tool_use", name, input }
//   { ts, type: "thinking", text }
//   { ts, type: "result",   text?, is_error?, error?, usage? }
//
// Writes are append-only and fire-and-forget. Errors during writes are
// logged once-per-process at warn level (so a broken FS doesn't spam) and
// never thrown — turn behavior is preserved if the log can't write.

import { mkdir, appendFile, readFile, rename } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { micaDir } from "./files.js";

function eventsDir(project: string | null, chatId: string): string {
  return join(micaDir(project ?? undefined), "chats", chatId);
}

function eventsPath(project: string | null, chatId: string, turnId: string): string {
  return join(eventsDir(project, chatId), `turn-${turnId}.events.jsonl`);
}

let warnedOnce = false;
function warn(msg: string): void {
  if (warnedOnce) return;
  warnedOnce = true;
  console.warn(`[turn-events] ${msg} (this message is logged once per process)`);
}

/** Append one event line to the per-turn jsonl. Fire-and-forget. Errors
 *  swallowed after first warn so they don't drown other logging. */
export async function appendTurnEvent(
  project: string | null,
  chatId: string,
  turnId: string,
  event: Record<string, unknown>,
): Promise<void> {
  if (!chatId || !turnId) return;
  try {
    const dir = eventsDir(project, chatId);
    if (!existsSync(dir)) await mkdir(dir, { recursive: true });
    const line = JSON.stringify({ ts: Date.now(), ...event }) + "\n";
    await appendFile(eventsPath(project, chatId, turnId), line, "utf-8");
  } catch (err) {
    warn(`appendTurnEvent ${chatId}/${turnId} failed: ${(err as Error).message}`);
  }
}

/** Read all events for a turn. Returns parsed lines, or empty array if the
 *  file doesn't exist (turn predates this mechanism, or was archived).
 *  Bad lines are skipped silently. */
export async function readTurnEvents(
  project: string | null,
  chatId: string,
  turnId: string,
): Promise<Array<Record<string, unknown>>> {
  try {
    const raw = await readFile(eventsPath(project, chatId, turnId), "utf-8");
    return raw.split("\n").filter(Boolean).flatMap((line) => {
      try { return [JSON.parse(line) as Record<string, unknown>]; } catch { return []; }
    });
  } catch {
    return [];
  }
}

/** Move all turn-*.events.jsonl files for a chat into the archive stamp dir.
 *  Mirrors archiveSnapshots in turnSnapshots.ts. Called from archiveChat. */
export async function archiveTurnEvents(
  project: string | null,
  chatId: string,
  archiveDirAbs: string,
): Promise<void> {
  const srcDir = eventsDir(project, chatId);
  if (!existsSync(srcDir)) return;
  try {
    const { readdir } = await import("fs/promises");
    const entries = await readdir(srcDir);
    const eventFiles = entries.filter((n) => /^turn-.*\.events\.jsonl$/.test(n));
    if (eventFiles.length === 0) return;
    const destDir = `${archiveDirAbs}-events`;
    await mkdir(destDir, { recursive: true });
    for (const f of eventFiles) {
      await rename(join(srcDir, f), join(destDir, f));
    }
  } catch (err) {
    warn(`archiveTurnEvents ${chatId} failed: ${(err as Error).message}`);
  }
}
