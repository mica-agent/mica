// sharedPin.ts — pin/unpin workspace-shared docs into a project's canvas.
//
// Centralizes the config-write + broadcast pair so both the REST endpoint
// (POST/DELETE /api/canvas/shared-pin, called by the discovery card) and
// the agent tool (mica_pin_shared_doc) hit the same code path. Mirrors
// projectActivity.ts's "registered broadcaster" pattern — index.ts wires
// `broadcastToProject` in at startup so callers outside index.ts can
// emit project-scoped broadcasts without circular imports.

import { readCanvasConfig, updateCanvasConfig, SHARED_PREFIX } from "./files.js";

export type PinSource = "agent" | "user";

type ProjectBroadcaster = (project: string, msg: Record<string, unknown>) => void;

let _broadcaster: ProjectBroadcaster | null = null;

/** Wire the project-scoped broadcaster at startup. */
export function setSharedPinBroadcast(fn: ProjectBroadcaster): void {
  _broadcaster = fn;
}

/** Pin a shared doc into a project. Idempotent — pinning twice is a no-op.
 *  Emits a `file-created` broadcast so the canvas reconciles, and (when
 *  `source = "agent"`) a separate `pin-added` toast event so the UI can
 *  surface "Mica pinned X." Returns the updated sharedPinned list. */
export async function pinSharedDoc(
  project: string,
  name: string,
  source: PinSource,
): Promise<string[]> {
  validateName(name);
  const cfg = await readCanvasConfig(project);
  if (cfg.sharedPinned.includes(name)) return cfg.sharedPinned;
  const next = [...cfg.sharedPinned, name];
  await updateCanvasConfig(project, { sharedPinned: next });
  _broadcaster?.(project, {
    type: "file-created",
    filename: `${SHARED_PREFIX}${name}`,
    source: "pin",
  });
  if (source === "agent") {
    _broadcaster?.(project, {
      type: "pin-added",
      filename: `${SHARED_PREFIX}${name}`,
      source: "agent",
    });
  }
  return next;
}

/** Unpin a shared doc from a project. Idempotent. Emits `file-deleted`
 *  so the canvas removes the card. */
export async function unpinSharedDoc(project: string, name: string): Promise<string[]> {
  validateName(name);
  const cfg = await readCanvasConfig(project);
  if (!cfg.sharedPinned.includes(name)) return cfg.sharedPinned;
  const next = cfg.sharedPinned.filter((n) => n !== name);
  await updateCanvasConfig(project, { sharedPinned: next });
  _broadcaster?.(project, {
    type: "file-deleted",
    filename: `${SHARED_PREFIX}${name}`,
  });
  return next;
}

function validateName(name: string): void {
  if (!name || typeof name !== "string" || name.includes("/") || name.includes("..")) {
    throw new Error(`Invalid shared-doc name: ${name}`);
  }
}
