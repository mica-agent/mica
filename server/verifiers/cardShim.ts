// Shared helper: read CARD_SHIM from CardRuntime.tsx so verifiers that need
// to reproduce the runtime's wrapping (wrapper-parse, live-mount, etc.) stay
// in sync with the host. If CardRuntime's shim drifts (new globals shadowed,
// new fetch hook), restart the server and both verifiers see the new shim
// on next read.

import { readFile } from "node:fs/promises";
import { join } from "node:path";

let CARD_SHIM: string | null = null;

export async function getCardShim(): Promise<string> {
  if (CARD_SHIM !== null) return CARD_SHIM;
  try {
    const src = await readFile(
      join(process.cwd(), "src", "whiteboard", "CardRuntime.tsx"),
      "utf-8",
    );
    const m = src.match(/const CARD_SHIM = `([\s\S]*?)\n`;/);
    CARD_SHIM = m ? m[1] : "";
  } catch {
    // CardRuntime.tsx unreadable (test env, etc.) — empty shim degrades
    // dependent checks but does not crash them.
    CARD_SHIM = "";
  }
  return CARD_SHIM;
}
