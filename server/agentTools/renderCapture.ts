// render_capture — capture a card's rendered PNG and return a vision-model
// description of what's actually visible. Same logic as the previous
// SDK-embedded mica-render MCP that lived in micaAgent.ts; now extracted
// so it's reachable from any agent through the unified /api/tools/* surface.

import { z } from "zod";
import { readFile as fsReadFile } from "fs/promises";
import { captureCard } from "../screenshot.js";
import { bumpRenderCaptureCount, RENDER_CAPTURE_CAP } from "../renderCaptureCounter.js";
import { getPendingValidatorErrors } from "../validatorErrorBuffer.js";
import type { AgentToolDef, AgentToolResult } from "./registry.js";

// Settle delay before reading the error buffer. Runtime errors in card.js
// (e.g. `THREE.OrbitControls is not a constructor`) fire at page-load time,
// which can race the capture itself — the screenshot happens, then a few
// hundred ms later the JS throws. Without this wait, render_capture returns
// "looks fine" and the agent declares done while an error is fired one tick
// later. 2.5s is a balance: long enough for typical post-mount JS settling,
// short enough not to feel sluggish.
const ERROR_SETTLE_MS = 2500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Map a card instance filename ("canvas/foo.bar-baz") to a substring that
// identifies its class directory (".mica/card-classes/bar-baz"). Used to
// filter validator errors to ones relevant to THIS card.
function classNameFromInstance(filename: string): string | null {
  const dot = filename.lastIndexOf(".");
  if (dot === -1) return null;
  const ext = filename.slice(dot + 1);  // "bar-baz"
  return ext || null;
}

// When the captioner describes the canvas as blank/black, this is almost
// always the WebGL preserve-drawing-buffer case the handbook documents:
// html2canvas reads canvas.toDataURL() which returns blank for WebGL
// contexts unless explicitly preserved. The card may be rendering correctly
// on the user's screen; only the screenshot pipeline can't see it. The
// agent's natural response is to "fix" the (non-existent) bug — iterating
// CSS, dependencies, scene composition — without recognizing the symptom.
// Detect this here and append a hint at the tool-result boundary so the
// signal lands exactly when the agent reads the verification.
const BLACK_CANVAS_RX = /\b(completely\s+(?:black|blank|empty|dark)|appears?\s+(?:completely\s+)?(?:black|blank|empty|dark)|all[-\s]?black|entirely\s+black|solid\s+black|nothing\s+(?:is\s+)?visible|no\s+(?:visible\s+)?(?:content|scene|3d|imagery)|empty\s+(?:canvas|scene|area|viewport|black\s+box)|black\s+(?:rectangle|background)\s+with\s+no\s+(?:visible\s+)?(?:content|elements))\b/i;

const WEBGL_HINT =
  "\n\n[Mica hint — read this BEFORE iterating]\n" +
  "The captioner describes the canvas as blank/black. If this card uses Three.js, WebGL, regl, Babylon, or any GPU rendering library, that's almost certainly a SCREENSHOT-PIPELINE limitation, NOT a bug in your card. html2canvas reads canvas.toDataURL() which returns blank for WebGL contexts unless explicitly preserved — the card may be rendering correctly on the user's screen. Two fixes (handbook § \"render_capture screenshot is black for WebGL / Three.js cards\"):\n" +
  "  1. PREFERRED — register `mica.onCapture(() => canvasEl.toDataURL('image/png'))` in card.js. The shim calls this before falling back to html2canvas. Wrap your render call inside so the back buffer is current at capture time.\n" +
  "  2. FALLBACK — construct the WebGL renderer with `preserveDrawingBuffer: true`.\n" +
  "DO NOT iterate on CSS heights, dependency URLs, scene composition, or library versions based on this screenshot — that's the recurring phantom-chase failure mode. Apply one of the two fixes above OR verify with the user that they see content on screen, then re-capture. If you're already past that and the user confirms the card looks good, END THIS TURN with a concise summary — don't keep calling render_capture.";

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
    "not the card class directory. " +
    "The tool result combines THREE signals you must read before declaring " +
    "done: (1) the captioner's visual description, (2) a WebGL hint if the " +
    "screenshot looks blank/black (which is often a capture-pipeline limit, " +
    "not a real bug), and (3) a ⚠️ pending-errors block listing any runtime " +
    "errors or validator failures (Tier-1 dependency 404s, card.js throw at " +
    "init, schema mismatches) buffered for this card. If the error block is " +
    "present, the build is NOT complete regardless of how the screenshot " +
    "looks — fix every listed error and re-capture. " +
    "PER-TURN CAP: 5 calls per user message. Past the cap the tool refuses " +
    "with a message asking you to end the turn — re-capturing the same card " +
    "many times in one turn is almost always a phantom-chase loop " +
    "(typically WebGL/Three.js where the captioner can't read GPU output). " +
    "The cap resets on the user's next message.",
  inputSchema,
  restPath: "/api/tools/render-capture",
  handler: async (input, ctx): Promise<AgentToolResult> => {
    if (!ctx.project) {
      return {
        isError: true,
        text: "render_capture requires an active project session. Ensure a project is open in the browser before calling.",
      };
    }
    // Per-turn cap. The agent reflexively re-captures every time a card
    // changes; combined with a false-negative (WebGL blank canvas) it can
    // loop indefinitely. Refuse past the cap with the same WebGL hint —
    // if the agent kept iterating despite the hint, this forces the turn
    // to wind down.
    const count = bumpRenderCaptureCount(ctx.project);
    if (count > RENDER_CAPTURE_CAP) {
      return {
        isError: true,
        text:
          `render_capture refused: this turn has already captured ${count - 1} time${count - 1 === 1 ? "" : "s"} ` +
          `(cap ${RENDER_CAPTURE_CAP}). The cap exists because re-capturing the same card multiple times in one turn is ` +
          `almost always a sign of a phantom-chase loop — typically the WebGL false-negative case where the captioner ` +
          `can't read GPU output and the card may already be rendering correctly on screen. END THIS TURN with a plain-text ` +
          `summary of what you built, what you verified, and any open questions. The user will reply 'looks good' or 'fix X'. ` +
          `If you genuinely believe the card is broken in a way the user must see, ask them to confirm in your reply rather ` +
          `than capturing again. The cap resets on their next message.` +
          WEBGL_HINT,
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
            model: "qwen-vl",
            max_tokens: 400,
            // Captioning is descriptive, not reasoning. Disable thinking so
            // the 400-token budget goes to the actual description instead
            // of `<think>` content that ends up in reasoning_content and
            // leaves `choices[0].message.content` empty. Mirrors voiceAgent.
            chat_template_kwargs: { enable_thinking: false },
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

      // Settle window: let any runtime errors in card.js fire AFTER the
      // capture itself. Without this, `render_capture` returns "looks fine"
      // and the agent declares done one tick before the browser throws
      // `THREE.OrbitControls is not a constructor` (or similar). The wait
      // catches that race.
      await sleep(ERROR_SETTLE_MS);

      // Pull every validator/runtime error currently buffered for this
      // project, then filter to ones relevant to THIS card — either the
      // instance file itself or any file under this card's class directory
      // (metadata.json's Tier-1 dependency check, card.js lint, etc.).
      // Both validatorErrorBuffer entries (validator) and the runtime
      // /api/cards/:filename/error path record into the same buffer, so a
      // single query covers both code paths.
      const className = classNameFromInstance(input.filename);
      const allErrors = ctx.project ? getPendingValidatorErrors(ctx.project) : [];
      const relevantErrors = allErrors.filter((e) => {
        if (e.filename === input.filename) return true;
        if (className && e.filename.includes(`/card-classes/${className}/`)) return true;
        if (className && e.filename.includes(`/card-classes/${className}.`)) return true;
        return false;
      });

      // WebGL black-canvas detection. If the captioner described the
      // image as blank/black, append the canonical fix-or-trust-the-user
      // guidance. The hint lands at the tool-result boundary so the
      // agent reads it in the same iteration it processes the caption.
      const blackish = caption && BLACK_CANVAS_RX.test(caption);

      // Error report block. If we found pending errors, surface them as a
      // distinct, hard-to-miss section appended to the caption. This is
      // the signal the agent uses to decide "done vs not done" — a clean
      // caption + zero errors = safe to declare done; ANY error block
      // here means the build is NOT complete regardless of how the
      // screenshot looks.
      let errorBlock = "";
      if (relevantErrors.length > 0) {
        const lines = relevantErrors
          .map((e, i) => `  ${i + 1}. [${e.filename}] ${e.error.slice(0, 400)}`)
          .join("\n");
        errorBlock =
          "\n\n⚠️ [Pending errors on this card — DO NOT declare done until resolved]\n" +
          `${relevantErrors.length} error${relevantErrors.length === 1 ? "" : "s"} are currently buffered for this card. The captioned image above shows what the canvas LOOKS like at capture time, but these errors mean the card has runtime or validator failures the screenshot may not visualize (e.g. a script tag returns 404, a card.js throws during init, metadata.json fails Tier-1 dependency reachability). The build is NOT complete:\n\n` +
          lines +
          "\n\nFix each error before declaring the card done. Re-call render_capture after the fix to verify the buffer clears.";
      }

      const finalCaption = (caption || "(no description returned)") + (blackish ? WEBGL_HINT : "") + errorBlock;

      return {
        text:
          `Render verification of ${input.filename} ` +
          `(${result.width}×${result.height}, ${Math.round(result.bytes / 1024)} KiB, ` +
          `saved to ${result.relativePath}):\n\n${finalCaption}`,
      };
    } catch (err) {
      return {
        isError: true,
        text: `Capture failed: ${(err as Error).message}`,
      };
    }
  },
};
