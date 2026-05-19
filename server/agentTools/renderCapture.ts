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

// Captioner describes the canvas as blank/black → almost always the WebGL
// preserve-drawing-buffer case: html2canvas reads canvas.toDataURL() which
// returns blank for WebGL contexts unless explicitly preserved. The card
// may be rendering correctly on the user's screen; only the capture
// pipeline can't see it. Detected here so the verdict tag becomes
// WEBGL-OPAQUE instead of CLEAN, which steers the agent away from
// phantom-chasing CSS / dependencies / scene composition.
const BLACK_CANVAS_RX = /\b(completely\s+(?:black|blank|empty|dark)|appears?\s+(?:completely\s+)?(?:black|blank|empty|dark)|all[-\s]?black|entirely\s+black|solid\s+black|nothing\s+(?:is\s+)?visible|no\s+(?:visible\s+)?(?:content|scene|3d|imagery)|empty\s+(?:canvas|scene|area|viewport|black\s+box)|black\s+(?:rectangle|background)\s+with\s+no\s+(?:visible\s+)?(?:content|elements))\b/i;

const LLAMA_URL = process.env.LLAMA_URL || "http://127.0.0.1:8012";

const inputSchema = {
  filename: z
    .string()
    .describe("Canvas-root-relative path of the instance file (e.g. 'canvas/my.burndown')"),
  user_intent: z
    .string()
    .optional()
    .describe(
      "Optional. The user's most recent UX request in your own words — what they want the visible card to look like or do (e.g. \"label should say 'Hot Dog' without the 🌭 emoji\", \"spinner should stop after analysis completes\", \"result title and reason on separate lines\"). When supplied, the captioner COMPARES the image against this intent and the verdict becomes MATCHES / MISMATCH / UNVERIFIABLE instead of the plain CLEAN. This is the antidote to declaring success when the JS-error buffer is empty but the visible UI is still wrong. Pass intent whenever the most recent user turn asked for a UX adjustment; omit on initial build verification.",
    ),
} as const;

export const renderCaptureTool: AgentToolDef<typeof inputSchema> = {
  name: "render_capture",
  description:
    "Verify a rendered card. Captures a PNG of the card on the canvas and " +
    "returns a text caption + verdict tag (CLEAN / ERRORS / WEBGL-OPAQUE / " +
    "CAP-REACHED / MATCHES / MISMATCH / UNVERIFIABLE). Call once after " +
    "building or editing a card class. The first line of the result tells " +
    "you the next move; follow it. Input: { filename, user_intent? } — " +
    "filename is the instance file (not the class directory); pass " +
    "user_intent whenever the user just made a UX request so the captioner " +
    "can verify the visible output against what they asked for. The browser " +
    "tab must be open to the project's canvas.",
  inputSchema,
  restPath: "/api/tools/render-capture",
  handler: async (input, ctx): Promise<AgentToolResult> => {
    if (!ctx.project) {
      return {
        isError: true,
        text: "render_capture requires an active project session. Ensure a project is open in the browser before calling.",
      };
    }
    // Per-turn cap. The agent can loop on re-captures when a false-negative
    // (WebGL blank canvas) trains it to "fix" what isn't actually broken.
    // Past the cap, refuse with a CAP-REACHED verdict so the agent ends
    // the turn cleanly instead of relitigating the screenshot.
    const count = bumpRenderCaptureCount(ctx.project);
    if (count > RENDER_CAPTURE_CAP) {
      return {
        isError: true,
        text:
          `[render_capture: CAP-REACHED] This turn already captured ${count - 1} time${count - 1 === 1 ? "" : "s"} (cap ${RENDER_CAPTURE_CAP}). ` +
          `End the turn now with a plain-text summary of what you built, what you verified, and any open questions. ` +
          `The cap resets on the user's next message.`,
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
      //
      // Two prompt modes:
      //   - Describe mode (no user_intent) — free-form description of what's
      //     visible. Preserves prior behavior for initial build verification.
      //   - Compare mode (user_intent supplied) — captioner explicitly judges
      //     whether the visible content satisfies the user's request and
      //     returns a structured VERDICT line. This closes the loop where
      //     the agent currently treats "no JS errors" as "UI is correct" —
      //     the visible UI being wrong is its own failure mode, and the
      //     captioner is the only signal that catches it pre-user.
      const userIntent = (input.user_intent || "").trim();
      const compareMode = userIntent.length > 0;

      const systemPrompt = compareMode
        ? "You are verifying a rendered Mica card against a specific user request. Look at the attached image and judge whether the visible content satisfies the request. Reply in EXACTLY this two-line format and nothing else:\nVERDICT: MATCHES or MISMATCH or UNVERIFIABLE\nEVIDENCE: <one short sentence describing what you see that supports the verdict>\n\nVerdict guide:\n- MATCHES: the visible card shows what the user asked for.\n- MISMATCH: the visible card does NOT show what the user asked for (wrong text, wrong icon, wrong layout, missing element, extra element).\n- UNVERIFIABLE: the request is about behavior, state, or interaction that a still image of the current state can't show (e.g. 'spinner stops after click', 'animation runs smoothly'). Do NOT use this just because you're unsure — use it only when the static image can't possibly answer the question."
        : "You are verifying a rendered Mica card class. Describe what's actually visible in the attached image — layout, colors, visible text, anything that looks broken, missing, clipped, or wrong. Look for: red error banners, blank/empty regions, overlapping elements, illegible text, missing markers/icons. Describe the IMAGE, not the source code. 5-15 lines of plain text, no markdown.";

      const userText = compareMode
        ? `User's request:\n${userIntent}\n\nDoes the image satisfy this request? Reply in the VERDICT / EVIDENCE format described.`
        : `Verification of ${input.filename}: describe what you see.`;

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
              { role: "system", content: systemPrompt },
              {
                role: "user",
                content: [
                  { type: "text", text: userText },
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

      // Parse the compare-mode verdict line. Tolerant of minor format drift
      // (extra whitespace, surrounding quotes, model-added preamble): we
      // search for the first occurrence of one of the three verdict tokens
      // after the literal "VERDICT:" marker. The EVIDENCE line is best-effort.
      let intentVerdict: "MATCHES" | "MISMATCH" | "UNVERIFIABLE" | null = null;
      let intentEvidence = "";
      if (compareMode && caption && !caption.startsWith("(captioning")) {
        const verdictMatch = caption.match(/VERDICT\s*:\s*(MATCHES|MISMATCH|UNVERIFIABLE)/i);
        if (verdictMatch) {
          intentVerdict = verdictMatch[1].toUpperCase() as typeof intentVerdict;
        }
        const evidenceMatch = caption.match(/EVIDENCE\s*:\s*(.+?)(?:\n|$)/is);
        if (evidenceMatch) {
          intentEvidence = evidenceMatch[1].trim();
        }
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

      // Compute the verdict tag the agent dispatches on. Priority: errors
      // win (build is not complete regardless of visual), then WebGL-opaque
      // (visual is unreliable), then CLEAN. The tag is the FIRST thing the
      // agent reads in the result; the body that follows tells it the next
      // move. This replaces the older "agent reads caption + warnings and
      // decides what to do" shape, which had no terminal-state signal and
      // tended to land the model in long thinking blocks without action.
      const blackish = !!caption && BLACK_CANVAS_RX.test(caption);
      const captionBody = caption || "(no description returned)";
      const meta = `${result.width}×${result.height}, ${Math.round(result.bytes / 1024)} KiB, saved to ${result.relativePath}`;

      let verdictHeader: string;
      if (relevantErrors.length > 0) {
        const lines = relevantErrors
          .map((e, i) => `  ${i + 1}. [${e.filename}] ${e.error.slice(0, 400)}`)
          .join("\n");
        verdictHeader =
          `[render_capture: ERRORS — ${relevantErrors.length} buffered] Build is NOT complete. ` +
          `Fix each listed error (use mica_edit_class_file), then re-call render_capture to verify the buffer clears.\n\n` +
          `Errors:\n${lines}`;
      } else if (blackish) {
        verdictHeader =
          `[render_capture: WEBGL-OPAQUE] Captioner sees a blank/black canvas. This is almost always a CAPTURE-PIPELINE ` +
          `limitation, NOT a real bug — html2canvas can't read WebGL back buffers unless preserved. Two fixes:\n` +
          `  1. PREFERRED — register \`mica.onCapture(() => canvasEl.toDataURL('image/png'))\` in card.js. Wrap your render ` +
          `call inside so the back buffer is current at capture time.\n` +
          `  2. FALLBACK — construct the WebGL renderer with \`preserveDrawingBuffer: true\`.\n` +
          `DO NOT iterate on CSS heights, dependency URLs, scene composition, or library versions based on this screenshot. ` +
          `If the user has already confirmed the card looks good on their screen, end the turn with a concise summary — don't ` +
          `keep calling render_capture.`;
      } else if (compareMode && intentVerdict === "MISMATCH") {
        verdictHeader =
          `[render_capture: MISMATCH] Build is NOT complete — the visible card does not match the user's request. ` +
          `Do NOT declare done. Edit the card (mica_edit_class_file) to fix what's wrong, then re-call render_capture ` +
          `with the same user_intent to re-verify.\n\n` +
          `User intent: ${userIntent}\n` +
          `Captioner evidence: ${intentEvidence || "(no evidence line returned)"}`;
      } else if (compareMode && intentVerdict === "UNVERIFIABLE") {
        verdictHeader =
          `[render_capture: UNVERIFIABLE] No JS errors and the captioner can't judge from a still image — ` +
          `the request is about behavior, state, or interaction that the current screenshot can't show ` +
          `(e.g. "spinner stops after click", "result updates on submit"). Three valid moves:\n` +
          `  1. Re-capture after a state change you can trigger (e.g. you just edited the post-submit handler — ` +
          `there's no static-image check; describe the expected behavior to the user and ask them to verify).\n` +
          `  2. If the code change is logic-only and unambiguous, end the turn with a concise summary describing ` +
          `what should happen — the user will test on their screen and report back.\n` +
          `  3. If you misread the request as visual, re-read what the user asked and decide if the intent was ` +
          `actually about static appearance after all.\n` +
          `User intent: ${userIntent}\n` +
          `Captioner evidence: ${intentEvidence || "(no evidence line returned)"}`;
      } else if (compareMode && intentVerdict === "MATCHES") {
        verdictHeader =
          `[render_capture: MATCHES] Build verified — the visible card matches the user's request and there are ` +
          `no pending errors. Write your final summary to the user and end the turn.\n\n` +
          `User intent: ${userIntent}\n` +
          `Captioner evidence: ${intentEvidence || "(no evidence line returned)"}`;
      } else if (compareMode) {
        // user_intent was supplied but the captioner didn't return a parseable
        // verdict. Treat as a soft-fail — the agent should re-call without
        // user_intent or interpret the caption manually. Tag explicitly so we
        // can spot prompt drift in logs.
        verdictHeader =
          `[render_capture: INTENT-UNPARSED] user_intent was supplied but the captioner's reply did not ` +
          `match the VERDICT/EVIDENCE format. Treat the caption below as a plain description and decide ` +
          `manually whether the user's request is satisfied. If it is, end the turn; if not, edit + re-capture.\n\n` +
          `User intent: ${userIntent}`;
      } else {
        verdictHeader =
          `[render_capture: CLEAN] No pending errors. Build verified. Write your final summary to the user and end the turn — ` +
          `do not call render_capture again unless the user reports a problem.`;
      }

      return {
        text: `${verdictHeader}\n\nCaption of ${input.filename} (${meta}):\n${captionBody}`,
      };
    } catch (err) {
      return {
        isError: true,
        text: `Capture failed: ${(err as Error).message}`,
      };
    }
  },
};
