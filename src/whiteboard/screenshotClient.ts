// screenshotClient.ts — listens for server-initiated screenshot requests,
// uses html2canvas on the target card's DOM element, uploads the PNG.
//
// Pipeline: see server/screenshot.ts for the full handshake. Short version:
// server broadcasts { type: "screenshot-request", filename, capture_id },
// we find the card's inner body via [data-mica-filename="..."], grab a
// PNG via html2canvas, POST back to the matching endpoint.
//
// The module self-initializes on import. Call `initScreenshotClient()` once
// from the root canvas component to kick it off per-project.

import html2canvas from "html2canvas";
import { on } from "../api/micaSocket";

const API_BASE = import.meta.env.VITE_MICA_API || "";

/** Brief delay before capture to let any in-flight card async work settle
 *  (fetches, library init, first-paint completion). Conservative MVP value.
 *  Cards with heavier async init (e.g., Mermaid, Chart.js with remote data)
 *  may still capture mid-render; future work could add an opt-in
 *  `mica.markReady()` signal. */
const STABILIZATION_DELAY_MS = 500;

interface ScreenshotRequest {
  type: "screenshot-request";
  filename: string;
  capture_id: string;
}

async function handleRequest(project: string, req: ScreenshotRequest): Promise<void> {
  const { filename, capture_id: captureId } = req;
  const uploadUrl = `${API_BASE}/api/cards/${encodeURIComponent(filename)}/screenshot/${captureId}`;
  const headers = {
    "Content-Type": "application/json",
    "X-Mica-Project": project,
  };

  async function reportFailure(reason: string): Promise<void> {
    console.warn(`[screenshotClient] capture failed for "${filename}": ${reason}`);
    try {
      await fetch(uploadUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({ error: reason }),
      });
    } catch (err) {
      console.error(`[screenshotClient] failed to report failure:`, err);
    }
  }

  // Locate the card's outer frame. CanvasCardRuntime sets
  // `.wb-card[data-filename="..."]` on every mounted card (see applyGlow()
  // in CanvasCardRuntime.tsx). Capturing the outer frame matches what the
  // user sees — includes title bar, badge, body — rather than just the
  // card-class inner body (which has data-mica-filename).
  const selector = `.wb-card[data-filename="${CSS.escape(filename)}"]`;
  const element = document.querySelector<HTMLElement>(selector);
  if (!element) {
    await reportFailure(
      `No card element with data-mica-filename="${filename}" found on this ` +
      `page. Verify the card is pinned to the canvas and the browser tab is ` +
      `showing the correct project.`
    );
    return;
  }

  // Grace period for the card's init async to settle.
  await new Promise((r) => setTimeout(r, STABILIZATION_DELAY_MS));

  let canvas: HTMLCanvasElement;
  try {
    canvas = await html2canvas(element, {
      backgroundColor: null,
      useCORS: true,
      logging: false,
    });
  } catch (err) {
    await reportFailure(`html2canvas threw: ${(err as Error).message}`);
    return;
  }

  if (canvas.width === 0 || canvas.height === 0) {
    await reportFailure(
      `Captured canvas has zero dimensions (card may be collapsed or ` +
      `off-screen). Expand the card and retry.`
    );
    return;
  }

  const dataUrl = canvas.toDataURL("image/png");
  // data:image/png;base64,AAA... — server strips the prefix.
  const body = JSON.stringify({
    data: dataUrl,
    width: canvas.width,
    height: canvas.height,
  });

  try {
    const res = await fetch(uploadUrl, { method: "POST", headers, body });
    if (!res.ok) {
      const text = await res.text().catch(() => "(no body)");
      console.error(
        `[screenshotClient] upload failed: ${res.status} ${res.statusText} — ${text}`
      );
    } else {
      console.log(`[screenshotClient] uploaded capture ${captureId} for ${filename} (${canvas.width}x${canvas.height})`);
    }
  } catch (err) {
    console.error(`[screenshotClient] upload error:`, err);
  }
}

let initialized = false;
let currentProject: string | null = null;

/** Mount the screenshot listener. Safe to call multiple times; only the
 *  first call subscribes. The `project` binding is updated on each call so
 *  project switches are reflected in the upload header. */
export function initScreenshotClient(project: string): void {
  currentProject = project;
  if (initialized) return;
  initialized = true;

  on("screenshot-request", (raw: unknown) => {
    const req = raw as ScreenshotRequest;
    if (!currentProject) {
      console.warn(`[screenshotClient] received screenshot-request with no project bound`);
      return;
    }
    void handleRequest(currentProject, req);
  });

  console.log(`[screenshotClient] listening on WS for screenshot-request`);
}
