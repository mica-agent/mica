// render_capture — capture a card's rendered PNG and return a vision-model
// description of what's actually visible. Same logic as the previous
// SDK-embedded mica-render MCP that lived in micaAgent.ts; now extracted
// so it's reachable from any agent through the unified /api/tools/* surface.

import { z } from "zod";
import { readFile as fsReadFile } from "fs/promises";
import { captureCard } from "../screenshot.js";
import type { AgentToolDef, AgentToolResult } from "./registry.js";

const LLAMA_URL = process.env.LLAMA_URL || "http://127.0.0.1:8012";

const inputSchema = {
  filename: z
    .string()
    .describe("Canvas-root-relative path of the instance file (e.g. 'canvas/my.burndown')"),
} as const;

export const renderCaptureTool: AgentToolDef<typeof inputSchema> = {
  name: "render_capture",
  description:
    "Capture a PNG screenshot of a card as it is currently rendered on the " +
    "canvas, then return a TEXT verification report describing what's in the " +
    "image. The server runs the screenshot through llama-server's vision " +
    "encoder (mmproj) directly and returns a 5-15 line description as the " +
    "tool result — layout, colors, visible text, anything that looks broken " +
    "or missing. You receive TEXT, not an image (tool_result channels in " +
    "every agent SDK / MCP transport are text-only — that's why the server " +
    "captions on your behalf). Use this after building or editing a card " +
    "class to verify it rendered correctly. The browser tab must be open " +
    "to the project's canvas. The filename is the canvas-root-relative " +
    "path of the card instance file (e.g. 'canvas/my-widget.burndown'), " +
    "not the card class directory.",
  inputSchema,
  restPath: "/api/tools/render-capture",
  handler: async (input, ctx): Promise<AgentToolResult> => {
    if (!ctx.project) {
      return {
        isError: true,
        text: "render_capture requires an active project session. Ensure a project is open in the browser before calling.",
      };
    }
    try {
      const result = await captureCard(ctx.project, input.filename);
      const png = await fsReadFile(result.path);
      const base64 = png.toString("base64");

      // Caption the image via a direct llama-server call (NOT through any
      // SDK). The SDK / MCP tool_result types are text-only, so we have
      // to make the vision-bearing call ourselves and return text.
      // Bypassing the SDK here is intentional and contained: same model
      // llama-server serves; we just talk to it directly.
      let caption = "";
      try {
        const llamaUrl = LLAMA_URL.replace(/\/v1$/, "");
        const captionRes = await fetch(`${llamaUrl}/v1/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "qwen3-vl-local",
            max_tokens: 400,
            messages: [
              {
                role: "system",
                content:
                  "You are verifying a rendered Mica card class. Describe what's actually visible in the attached image — layout, colors, visible text, anything that looks broken, missing, clipped, or wrong. Look for: red error banners, blank/empty regions, overlapping elements, illegible text, missing markers/icons. Describe the IMAGE, not the source code. 5-15 lines of plain text, no markdown.",
              },
              {
                role: "user",
                content: [
                  { type: "text", text: `Verification of ${input.filename}: describe what you see.` },
                  { type: "image_url", image_url: { url: `data:image/png;base64,${base64}` } },
                ],
              },
            ],
          }),
        });
        if (captionRes.ok) {
          const data = (await captionRes.json()) as {
            choices?: Array<{ message?: { content?: string } }>;
          };
          caption = data.choices?.[0]?.message?.content?.trim() || "";
        } else {
          caption = `(captioning failed: llama-server returned ${captionRes.status})`;
        }
      } catch (capErr) {
        caption = `(captioning failed: ${(capErr as Error).message})`;
      }

      return {
        text:
          `Render verification of ${input.filename} ` +
          `(${result.width}×${result.height}, ${Math.round(result.bytes / 1024)} KiB, ` +
          `saved to ${result.relativePath}):\n\n${caption || "(no description returned)"}`,
      };
    } catch (err) {
      return {
        isError: true,
        text: `Capture failed: ${(err as Error).message}`,
      };
    }
  },
};
