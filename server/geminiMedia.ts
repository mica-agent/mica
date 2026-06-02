// geminiMedia.ts — Mica-owned Google generative-media core.
//
// Thin, dependency-free wrapper over the Gemini REST API for IMAGE and VIDEO
// generation, behind a single GEMINI_API_KEY (readGeminiKey). No Express, no
// opencode coupling — pure async functions so the agent-tool surface
// (server/agentTools/gemini{Image,Video}.ts) and any future channel-handler
// surface stay thin.
//
// Verified against the live API (2026-06-02):
//   - image: models/gemini-2.5-flash-image:generateContent → inline base64 PNG
//            at candidates[0].content.parts[].inlineData.{mimeType,data}
//   - video: models/veo-3.0-generate-001:predictLongRunning → operation name;
//            poll the operation until done; download the returned file URI
//            (key appended) → mp4 bytes. (predictLongRunning = async.)
//
// Model ids confirmed present via /v1beta/models: gemini-2.5-flash-image (GA),
// veo-3.0-generate-001 (GA), gemini-3.5-flash (chat).

import { readGeminiKey } from "./files.js";

const API_BASE = "https://generativelanguage.googleapis.com/v1beta";

export const DEFAULT_IMAGE_MODEL = "gemini-2.5-flash-image";
export const DEFAULT_VIDEO_MODEL = "veo-3.0-generate-001";

export interface MediaBytes {
  bytes: Buffer;
  mime: string;
}

export class GeminiKeyMissingError extends Error {
  constructor() {
    super(
      "GEMINI_API_KEY is not set. Add it to the workspace (.env GEMINI_API_KEY, " +
        ".mica/credentials.json `gemini`, or the project config) to enable image/video generation.",
    );
    this.name = "GeminiKeyMissingError";
  }
}

async function requireKey(project: string | undefined): Promise<string> {
  const key = await readGeminiKey(project);
  if (!key) throw new GeminiKeyMissingError();
  return key;
}

/** Generate a single image from a text prompt. Returns the raw bytes + mime.
 *  Uses the Gemini-native image model (generateContent → inline base64). */
export async function generateImage(opts: {
  prompt: string;
  project?: string;
  model?: string;
  timeoutMs?: number;
}): Promise<MediaBytes> {
  const key = await requireKey(opts.project);
  const model = opts.model || DEFAULT_IMAGE_MODEL;
  const res = await fetch(`${API_BASE}/models/${model}:generateContent?key=${key}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents: [{ parts: [{ text: opts.prompt }] }] }),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000),
  });
  const json = (await res.json()) as GeminiGenerateContentResponse;
  if (!res.ok || json.error) {
    throw new Error(`gemini image gen failed (${res.status}): ${json.error?.message || JSON.stringify(json).slice(0, 300)}`);
  }
  const parts = json.candidates?.[0]?.content?.parts ?? [];
  for (const p of parts) {
    if (p.inlineData?.data) {
      return { bytes: Buffer.from(p.inlineData.data, "base64"), mime: p.inlineData.mimeType || "image/png" };
    }
  }
  // No image part — surface any text the model returned instead (safety blocks,
  // refusals) so the caller can show a meaningful message.
  const text = parts.map((p) => p.text).filter(Boolean).join(" ").slice(0, 300);
  throw new Error(`gemini image gen returned no image${text ? ` — model said: "${text}"` : ""}`);
}

/** Submit a video generation job (Veo, async). Returns the operation name to
 *  poll. Does NOT wait — see generateVideo for the orchestrated submit→poll→
 *  download. */
export async function submitVideo(opts: {
  prompt: string;
  project?: string;
  model?: string;
}): Promise<string> {
  const key = await requireKey(opts.project);
  const model = opts.model || DEFAULT_VIDEO_MODEL;
  const res = await fetch(`${API_BASE}/models/${model}:predictLongRunning?key=${key}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ instances: [{ prompt: opts.prompt }] }),
    signal: AbortSignal.timeout(30_000),
  });
  const json = (await res.json()) as { name?: string; error?: { message?: string } };
  if (!res.ok || json.error || !json.name) {
    throw new Error(`veo submit failed (${res.status}): ${json.error?.message || JSON.stringify(json).slice(0, 300)}`);
  }
  return json.name;
}

export interface VideoPoll {
  done: boolean;
  videoUri?: string;
  error?: string;
}

/** Poll a Veo operation once. When done, extracts the generated video's file
 *  URI. The response shape has drifted across API versions, so the extractor
 *  checks the known locations defensively. */
export async function pollVideo(operationName: string, project?: string): Promise<VideoPoll> {
  const key = await requireKey(project);
  const res = await fetch(`${API_BASE}/${operationName}?key=${key}`, {
    signal: AbortSignal.timeout(30_000),
  });
  const json = (await res.json()) as VeoOperation;
  if (!res.ok || json.error) {
    return { done: true, error: json.error?.message || `poll failed (${res.status})` };
  }
  if (!json.done) return { done: false };
  const uri = extractVideoUri(json.response);
  if (!uri) return { done: true, error: "operation done but no video URI in response" };
  return { done: true, videoUri: uri };
}

/** Download a generated video file. Appends the key to the URI (Gemini's file
 *  download URIs require it). Returns mp4 bytes. */
export async function downloadVideo(uri: string, project?: string): Promise<MediaBytes> {
  const key = await requireKey(project);
  const sep = uri.includes("?") ? "&" : "?";
  const url = /[?&]key=/.test(uri) ? uri : `${uri}${sep}key=${key}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`veo download failed (${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  return { bytes: buf, mime: res.headers.get("content-type") || "video/mp4" };
}

/** Orchestrated video generation: submit → poll until done (capped) → download.
 *  Veo typically takes ~1-3 min. onProgress fires per poll so callers can keep
 *  the user informed. Throws (with the operation name) on timeout so the caller
 *  can offer a retry. */
export async function generateVideo(
  opts: { prompt: string; project?: string; model?: string },
  poll: { everyMs?: number; timeoutMs?: number; onProgress?: (op: string, elapsedMs: number) => void } = {},
): Promise<MediaBytes> {
  const everyMs = poll.everyMs ?? 15_000;
  const timeoutMs = poll.timeoutMs ?? 6 * 60_000;
  const op = await submitVideo(opts);
  const start = Date.now();
  for (;;) {
    const elapsed = Date.now() - start;
    if (elapsed > timeoutMs) {
      const e = new Error(`veo generation timed out after ${Math.round(timeoutMs / 1000)}s (operation ${op} may still complete — retry by polling it)`);
      (e as { operationName?: string }).operationName = op;
      throw e;
    }
    poll.onProgress?.(op, elapsed);
    await new Promise((r) => setTimeout(r, everyMs));
    const status = await pollVideo(op, opts.project);
    if (status.error) throw new Error(`veo generation failed: ${status.error}`);
    if (status.done && status.videoUri) return downloadVideo(status.videoUri, opts.project);
  }
}

// ── Response types ─────────────────────────────────────────────────────

interface GeminiGenerateContentResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string; inlineData?: { mimeType?: string; data?: string } }> } }>;
  error?: { message?: string };
}

interface VeoOperation {
  done?: boolean;
  response?: unknown;
  error?: { message?: string };
}

/** Defensive extraction of the video file URI from a done Veo operation.
 *  Known shapes:
 *    response.generateVideoResponse.generatedSamples[].video.uri
 *    response.generateVideoResponse.generatedVideos[].video.uri
 *    response.generatedVideos[].video.uri
 *  Falls back to a recursive search for any string field named "uri"/"fileUri". */
function extractVideoUri(response: unknown): string | undefined {
  if (!response || typeof response !== "object") return undefined;
  const r = response as Record<string, unknown>;
  const gvr = (r.generateVideoResponse as Record<string, unknown> | undefined) ?? r;
  const samples =
    (gvr.generatedSamples as unknown[] | undefined) ??
    (gvr.generatedVideos as unknown[] | undefined);
  if (Array.isArray(samples) && samples[0]) {
    const v = (samples[0] as Record<string, unknown>).video as Record<string, unknown> | undefined;
    const uri = (v?.uri ?? v?.fileUri) as string | undefined;
    if (typeof uri === "string") return uri;
  }
  // Last resort: recursive scan for a uri-like string.
  let found: string | undefined;
  const seen = new Set<unknown>();
  const walk = (o: unknown): void => {
    if (found || !o || typeof o !== "object" || seen.has(o)) return;
    seen.add(o);
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
      if (found) return;
      if (typeof v === "string" && /^(uri|fileUri)$/i.test(k) && /^https?:\/\//.test(v)) { found = v; return; }
      if (v && typeof v === "object") walk(v);
    }
  };
  walk(response);
  return found;
}
