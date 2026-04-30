// turnSnapshots.ts — per-turn rendered system prompt snapshots.
//
// Each chat turn captures the FINAL rendered prompt the agent sees (canvas
// baseline + skills + tool descriptions + Detected runtime banner) at
// `.mica/chats/<chatId>/snapshots/<turnId>.txt`. The chat card's per-turn
// footer surfaces a "view snapshot" link that opens the file in a new tab
// via /api/agent/turn-snapshot/<chatId>/<turnId>.
//
// Sidecar — NOT inline in TurnRecord. Prompts are 50KB+ and turns.jsonl
// must stay grep-friendly. Writes are fire-and-forget; errors swallowed.
// Snapshots live alongside the chat thread; on chat clear (archiveChat),
// they move to .mica/chats/archived/<chatId>/<stamp>-snapshots/.

import { mkdir, readFile, writeFile, readdir, rename } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { micaDir } from "./files.js";

function snapshotsDir(project: string | null, chatId: string): string {
  // micaDir(project) is `.mica` for the workspace fallback; project-scoped otherwise.
  return join(micaDir(project ?? undefined), "chats", chatId, "snapshots");
}

function snapshotPath(project: string | null, chatId: string, turnId: string): string {
  return join(snapshotsDir(project, chatId), `${turnId}.txt`);
}

/** Persist the rendered system-prompt context for a turn. Fire-and-forget
 *  — caller does `void writeSnapshot(...)`. Errors are logged, never thrown. */
export async function writeSnapshot(
  project: string | null,
  chatId: string,
  turnId: string,
  content: string,
): Promise<void> {
  if (!chatId || !turnId) return;
  try {
    const dir = snapshotsDir(project, chatId);
    await mkdir(dir, { recursive: true });
    await writeFile(snapshotPath(project, chatId, turnId), content, "utf-8");
  } catch (err) {
    console.warn(`[turn-snapshots] writeSnapshot ${chatId}/${turnId} failed:`, (err as Error).message);
  }
}

/** Read a turn's rendered-prompt snapshot. Returns null if absent (turn
 *  predates the snapshot mechanism, or was archived, or write failed). */
export async function readSnapshot(
  project: string | null,
  chatId: string,
  turnId: string,
): Promise<string | null> {
  try {
    return await readFile(snapshotPath(project, chatId, turnId), "utf-8");
  } catch {
    return null;
  }
}

/** Archive a chat's snapshots directory alongside the chat archive itself.
 *  Called from server/files.ts archiveChat() after the chat JSON is moved.
 *  `archiveDirAbs` is the per-stamp archive root (e.g.
 *  `.mica/chats/archived/<chatId>/2026-04-29T16-45-00`). The snapshots
 *  directory becomes `<archiveDirAbs>-snapshots/`. Returns the list of
 *  archived turn_ids (for filtering metrics) — empty if no snapshots existed. */
export async function archiveSnapshots(
  project: string | null,
  chatId: string,
  archiveDirAbs: string,
): Promise<string[]> {
  const srcDir = snapshotsDir(project, chatId);
  if (!existsSync(srcDir)) return [];
  let turnIds: string[] = [];
  try {
    const entries = await readdir(srcDir);
    turnIds = entries.filter((n) => n.endsWith(".txt")).map((n) => n.replace(/\.txt$/, ""));
    if (turnIds.length === 0) return [];
    const dest = `${archiveDirAbs}-snapshots`;
    await rename(srcDir, dest);
  } catch (err) {
    console.warn(`[turn-snapshots] archiveSnapshots ${chatId} failed:`, (err as Error).message);
  }
  return turnIds;
}
