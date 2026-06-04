// gemini media agent tools — mica_generate_image / mica_generate_video.
//
// Thin wrappers over server/geminiMedia.ts (the verified Gemini REST core).
// They generate media and SAVE it under the project's canvas root, returning
// the path. Displaying it is the agent's job (create a media-viewer card
// instance pointing at the returned path) — keeps these tools decoupled from
// any specific card class and globally safe.
//
// KEY-GATED: registry.ts only adds these to AGENT_TOOLS when GEMINI_API_KEY is
// set, so a workspace without the key never sees them (no tool-surface or
// prelude pollution). The handlers still guard via readGeminiKey for safety.

import { z } from "zod";
import { writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import type { AgentToolDef, AgentToolResult } from "./registry.js";
import { getEffectiveWorkspaceDir, readCanvasConfig } from "../files.js";
import { generateImage, generateVideo } from "../geminiMedia.js";

function slug(s: string): string {
  // Strip any leading dir and trailing extension the agent may include in
  // `filename` (e.g. "generated/lake.png" → "lake"), then slugify.
  return String(s)
    .replace(/^.*\//, "")
    .replace(/\.[a-z0-9]{1,5}$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "media";
}

/** Write bytes under <project>/<canvasRoot>/generated/ and return both the
 *  canvas-root-relative path (what a card instance / viewer references) and
 *  the project-relative path (for the human-readable result). */
async function writeCanvasAsset(
  project: string,
  base: string,
  ext: string,
  bytes: Buffer,
): Promise<{ canvasRel: string; projectRel: string }> {
  const { canvasRoot } = await readCanvasConfig(project);
  const canvasRel = `generated/${base}.${ext}`;
  const projectRel = canvasRoot ? `${canvasRoot}/${canvasRel}` : canvasRel;
  const abs = join(getEffectiveWorkspaceDir(), project, projectRel);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, bytes);
  return { canvasRel, projectRel };
}

export const geminiImageTool: AgentToolDef<{
  prompt: z.ZodString;
  filename: z.ZodOptional<z.ZodString>;
}> = {
  name: "mica_generate_image",
  description:
    "Generate an image from a text prompt using Google Gemini (Nano Banana / gemini-2.5-flash-image) and save it under the canvas. Returns the saved path. To DISPLAY it, create a `media-viewer` card instance whose content references the returned canvas-relative path, or embed the path in a card you build. Input: { prompt, filename? }. Requires GEMINI_API_KEY.",
  inputSchema: {
    prompt: z.string().describe("Describe the image to generate."),
    filename: z.string().optional().describe("Optional base name (no extension); defaults to a slug of the prompt."),
  },
  restPath: "/api/tools/gemini-generate-image",
  handler: async (input, ctx): Promise<AgentToolResult> => {
    if (!ctx.project) return { isError: true, text: "Active project required." };
    try {
      const { bytes, mime } = await generateImage({ prompt: input.prompt, project: ctx.project });
      const ext = mime.includes("jpeg") ? "jpg" : "png";
      const base = `${input.filename ? slug(input.filename) : slug(input.prompt)}-${Date.now().toString(36)}`;
      const { canvasRel, projectRel } = await writeCanvasAsset(ctx.project, base, ext, bytes);
      return {
        text:
          `Saved image (${mime}, ${Math.round(bytes.length / 1024)}KB) to ${projectRel}\n` +
          `Canvas-relative path: ${canvasRel}\n` +
          `To show it on the canvas, create a media-viewer card instance referencing "${canvasRel}".`,
      };
    } catch (e) {
      return { isError: true, text: `Image generation failed: ${(e as Error).message}` };
    }
  },
};

export const geminiVideoTool: AgentToolDef<{
  prompt: z.ZodString;
  filename: z.ZodOptional<z.ZodString>;
}> = {
  name: "mica_generate_video",
  description:
    "Generate a short video from a text prompt using Google Veo (veo-3.0-generate-001) and save it under the canvas. This is SLOW (typically 1-3 minutes) — tell the user you're generating before you call it. Returns the saved path on success; on timeout returns an error naming the operation so you can retry. To DISPLAY it, create a `media-viewer` card instance referencing the returned canvas-relative path. Input: { prompt, filename? }. Requires GEMINI_API_KEY.",
  inputSchema: {
    prompt: z.string().describe("Describe the video to generate."),
    filename: z.string().optional().describe("Optional base name (no extension); defaults to a slug of the prompt."),
  },
  restPath: "/api/tools/gemini-generate-video",
  handler: async (input, ctx): Promise<AgentToolResult> => {
    if (!ctx.project) return { isError: true, text: "Active project required." };
    try {
      const { bytes, mime } = await generateVideo({ prompt: input.prompt, project: ctx.project });
      const base = `${input.filename ? slug(input.filename) : slug(input.prompt)}-${Date.now().toString(36)}`;
      const ext = mime.includes("webm") ? "webm" : "mp4";
      const { canvasRel, projectRel } = await writeCanvasAsset(ctx.project, base, ext, bytes);
      return {
        text:
          `Saved video (${mime}, ${Math.round(bytes.length / 1024)}KB) to ${projectRel}\n` +
          `Canvas-relative path: ${canvasRel}\n` +
          `To show it on the canvas, create a media-viewer card instance referencing "${canvasRel}".`,
      };
    } catch (e) {
      return { isError: true, text: `Video generation failed: ${(e as Error).message}` };
    }
  },
};
