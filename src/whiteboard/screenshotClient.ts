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
import { on, getCaptureHook } from "../api/micaSocket";

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

  // Check for a card-registered capture hook BEFORE falling back to
  // html2canvas. Required for WebGL cards (Three.js, regl, PixiJS in
  // WebGL mode, Babylon) where html2canvas → canvas.toDataURL() returns
  // blank unless the WebGL context was created with
  // preserveDrawingBuffer: true. The hook lets the card render
  // on-demand and produce a dataURL inside the same frame, so
  // preserveDrawingBuffer becomes optional. See
  // src/api/micaSocket.ts → captureHooks for the registry mechanics.
  const hook = getCaptureHook(filename);
  if (hook) {
    const HOOK_TIMEOUT_MS = 5000;
    try {
      const dataUrl = await Promise.race<string>([
        Promise.resolve(hook()),
        new Promise<string>((_, rej) =>
          setTimeout(() => rej(new Error(`onCapture hook timed out after ${HOOK_TIMEOUT_MS}ms`)), HOOK_TIMEOUT_MS),
        ),
      ]);
      if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/")) {
        throw new Error(`onCapture returned non-dataURL (got ${typeof dataUrl})`);
      }
      const body = JSON.stringify({ data: dataUrl });
      try {
        const res = await fetch(uploadUrl, { method: "POST", headers, body });
        if (!res.ok) {
          const text = await res.text().catch(() => "(no body)");
          console.error(`[screenshotClient] hook upload failed: ${res.status} ${res.statusText} — ${text}`);
        } else {
          console.log(`[screenshotClient] uploaded hook capture ${captureId} for ${filename}`);
        }
      } catch (err) {
        console.error(`[screenshotClient] hook upload error:`, err);
      }
      return;
    } catch (err) {
      console.warn(
        `[screenshotClient] onCapture hook for ${filename} failed (${(err as Error).message}); falling back to html2canvas`,
      );
      // Fall through to html2canvas.
    }
  }

  let canvas: HTMLCanvasElement;
  try {
    canvas = await html2canvas(element, {
      backgroundColor: null,
      useCORS: true,
      logging: false,
    });
  } catch (err) {
    const msg = (err as Error).message || String(err);
    // Filter html2canvas internal parser limitations that are NOT card bugs.
    // Reporting these to /api/cards/<file>/error pollutes the validator buffer
    // and causes the chat agent to chase phantom card bugs (observed: 15-turn
    // debug loop chasing a `color()` CSS4 warning from Mica's GLOBAL stylesheet
    // that the card itself doesn't even use). Log to console for inspection
    // but don't surface to the agent as a card-content error.
    const HTML2CANVAS_TOOL_LIMITATIONS = [
      /Attempting to parse an unsupported color function/i,  // CSS4 color()
      /Unable to parse color/i,                              // generic CSS color parser failure
      /CSSStyleSheet.*cssRules/i,                            // cross-origin stylesheet read
    ];
    if (HTML2CANVAS_TOOL_LIMITATIONS.some(re => re.test(msg))) {
      console.warn(
        `[screenshotClient] html2canvas tool limitation (NOT a card bug): ${msg}. ` +
        `Card may render correctly; screenshot capture is unreliable. Skipping error report.`,
      );
      return;
    }
    await reportFailure(`html2canvas threw: ${msg}`);
    return;
  }

  if (canvas.width === 0 || canvas.height === 0) {
    await reportFailure(
      `Captured canvas has zero dimensions (card may be collapsed or ` +
      `off-screen). Expand the card and retry.`
    );
    return;
  }

  // Downscale before encoding. Qwen3-VL's processor maps image pixels to
  // tokens at a fixed rate (~28×28 patches); a 3092×1438 capture produces
  // 4365 image tokens and overruns the per-image token budget (cap 4095),
  // which surfaces as a 400 from vLLM. 1280px on the long side keeps
  // description quality intact and stays comfortably under the cap.
  const MAX_LONG_SIDE = 1280;
  const longSide = Math.max(canvas.width, canvas.height);
  let outCanvas: HTMLCanvasElement = canvas;
  if (longSide > MAX_LONG_SIDE) {
    const scale = MAX_LONG_SIDE / longSide;
    const w = Math.max(1, Math.round(canvas.width * scale));
    const h = Math.max(1, Math.round(canvas.height * scale));
    const scaled = document.createElement("canvas");
    scaled.width = w;
    scaled.height = h;
    const ctx = scaled.getContext("2d");
    if (ctx) {
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(canvas, 0, 0, w, h);
      outCanvas = scaled;
    }
  }
  const dataUrl = outCanvas.toDataURL("image/png");
  // data:image/png;base64,AAA... — server strips the prefix.
  const body = JSON.stringify({
    data: dataUrl,
    width: outCanvas.width,
    height: outCanvas.height,
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
