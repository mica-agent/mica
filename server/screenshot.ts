// screenshot.ts — orchestrates browser-side card screenshots via WebSocket.
//
// Flow:
//   1. Server asks: captureCard(project, filename) — allocates capture_id,
//      broadcasts { type: "screenshot-request", filename, capture_id } to
//      the project's WS clients, registers a pending promise with timeout.
//   2. Frontend (src/whiteboard/screenshotClient.ts) receives the broadcast,
//      runs html2canvas on the target card's DOM element, POSTs the PNG to
//      /api/cards/:filename/screenshot/:capture_id.
//   3. That endpoint calls resolveCapture(capture_id, pngBuffer) here.
//   4. Orchestrator resolves the promise with the saved path + metadata.
//
// If no client is subscribed to the project, or the client fails to respond
// within the timeout, the promise rejects with a descriptive error.

import { randomUUID } from "crypto";
import { writeFile, mkdir } from "fs/promises";
import { join, dirname } from "path";
import { micaDir } from "./files.js";

export interface CaptureResult {
  path: string;          // absolute path on disk
  relativePath: string;  // "<project>/.mica/screenshots/<id>.png"
  width: number;
  height: number;
  bytes: number;
  captureId: string;
}

interface PendingCapture {
  resolve: (result: CaptureResult) => void;
  reject: (err: Error) => void;
  timeout: NodeJS.Timeout;
  project: string;
  filename: string;
}

const pending = new Map<string, PendingCapture>();

const DEFAULT_TIMEOUT_MS = 15000;

/** Module-level broadcast function. Set once at server startup so callers
 *  (agent-side tool handlers, RPC handler) don't need to thread it through.
 *  Lives in index.ts where the WebSocket state is owned. */
let broadcastFn: ((project: string, msg: Record<string, unknown>) => number) | null = null;

export function setBroadcast(fn: (project: string, msg: Record<string, unknown>) => number): void {
  broadcastFn = fn;
}

/** Orchestrate a capture. Resolves when the frontend uploads the PNG.
 *  Rejects on timeout or if no clients are subscribed to the project. */
export async function captureCard(
  project: string,
  filename: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<CaptureResult> {
  if (!broadcastFn) {
    throw new Error("screenshot module: setBroadcast() was not called");
  }
  const captureId = randomUUID();

  const subscribers = broadcastFn(project, {
    type: "screenshot-request",
    filename,
    capture_id: captureId,
  });

  if (subscribers === 0) {
    throw new Error(
      `No browser tab is currently viewing project "${project}". Open the ` +
      `canvas in a browser and retry.`
    );
  }

  return new Promise<CaptureResult>((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(captureId);
      reject(new Error(
        `Screenshot capture timed out after ${timeoutMs}ms. The browser tab ` +
        `may be unresponsive, the card may not exist on canvas, or html2canvas ` +
        `may have errored.`
      ));
    }, timeoutMs);

    pending.set(captureId, { resolve, reject, timeout, project, filename });
  });
}

/** Called by the upload endpoint when the PNG lands. */
export async function resolveCapture(
  captureId: string,
  png: Buffer,
  width: number,
  height: number,
): Promise<CaptureResult> {
  const entry = pending.get(captureId);
  if (!entry) {
    throw new Error(`Unknown capture_id: ${captureId}`);
  }
  pending.delete(captureId);
  clearTimeout(entry.timeout);

  // Save to .mica/screenshots/<capture_id>.png under the project.
  const screenshotsDir = join(micaDir(entry.project), "screenshots");
  const absPath = join(screenshotsDir, `${captureId}.png`);
  await mkdir(dirname(absPath), { recursive: true });
  await writeFile(absPath, png);

  const result: CaptureResult = {
    path: absPath,
    relativePath: `.mica/screenshots/${captureId}.png`,
    width,
    height,
    bytes: png.length,
    captureId,
  };
  entry.resolve(result);
  return result;
}

/** Called by the upload endpoint when the frontend reports capture failure. */
export function failCapture(captureId: string, reason: string): void {
  const entry = pending.get(captureId);
  if (!entry) return;
  pending.delete(captureId);
  clearTimeout(entry.timeout);
  entry.reject(new Error(`Client-side capture failed: ${reason}`));
}

/** `mica.render.*` RPC handler. Uses the module-level broadcast set by
 *  setBroadcast(). Only one method today: `capture`. */
export async function renderHandler(
  method: string,
  params: unknown,
  project: string | null,
): Promise<unknown> {
  if (method !== "capture") {
    throw new Error(`Unknown mica.render.${method} method`);
  }
  if (!project) {
    throw new Error(`mica.render.capture requires an open project`);
  }
  const p = (params ?? {}) as { filename?: string; timeoutMs?: number };
  if (typeof p.filename !== "string" || !p.filename) {
    throw new Error(`mica.render.capture requires { filename: string }`);
  }
  const result = await captureCard(
    project,
    p.filename,
    typeof p.timeoutMs === "number" ? p.timeoutMs : undefined,
  );
  return {
    path: result.relativePath,
    absolutePath: result.path,
    width: result.width,
    height: result.height,
    bytes: result.bytes,
    captureId: result.captureId,
  };
}
