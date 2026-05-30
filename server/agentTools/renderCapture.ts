// render_capture — capture a card's rendered PNG and return a vision-model
// description of what's actually visible. Same logic as the previous
// SDK-embedded mica-render MCP that lived in micaAgent.ts; now extracted
// so it's reachable from any agent through the unified /api/tools/* surface.

import { z } from "zod";
import { createHash } from "node:crypto";
import { readFile as fsReadFile } from "fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { captureCard } from "../screenshot.js";
import { bumpRenderCaptureCount, RENDER_CAPTURE_CAP } from "../renderCaptureCounter.js";
import { getPendingValidatorErrors } from "../validatorErrorBuffer.js";
import { canonicalizeCardPath, readCanvasConfig, micaDir, findCardClassInLibraries, readCardSettings, resolveDefaultModel, resolveDefaultProvider, readOpenRouterKey, readOpenAICompatConfig } from "../files.js";
import { runLiveMount } from "../verifiers/cardLiveMount.js";
import type { AgentToolDef, AgentToolResult } from "./registry.js";

// Captioner output cache (pixel-diff gate). Skip the multimodal LLM call when
// the rendered PNG hasn't changed since the last call. Keyed by
// "<project>|<filename>|<user_intent>" → { pngHash, caption }. We cache the
// captioner's TEXT output, not the verdict tag — the tag is always recomputed
// from current validator state so errors/MISMATCH that surfaced between calls
// aren't masked. On cache hit, the verdict still flows through the normal
// error-buffer check; only the LLM call is short-circuited.
//
// Pure in-memory, resets on backend restart. Implicitly invalidated by the
// PNG hash itself: any card-source change that affects rendering produces a
// different PNG → different hash → cache miss. LRU-bounded to MAX entries.
const CAPTION_CACHE_MAX_ENTRIES = 50;
const captionerCache = new Map<string, { pngHash: string; caption: string }>();
function captionerCacheKey(project: string, filename: string, userIntent: string): string {
  return `${project}|${filename}|${userIntent}`;
}
function captionerCacheGet(key: string, pngHash: string): string | null {
  const entry = captionerCache.get(key);
  if (!entry || entry.pngHash !== pngHash) return null;
  // Refresh LRU position — re-insertion moves the key to the end on Map.
  captionerCache.delete(key);
  captionerCache.set(key, entry);
  return entry.caption;
}
function captionerCacheSet(key: string, pngHash: string, caption: string): void {
  if (captionerCache.size >= CAPTION_CACHE_MAX_ENTRIES) {
    // Drop oldest (first-inserted) entry.
    const oldest = captionerCache.keys().next().value;
    if (oldest) captionerCache.delete(oldest);
  }
  captionerCache.set(key, { pngHash, caption });
}
function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}
// Caption payload knobs. The vision call dominates wall-clock + GPU/cost,
// and previous defaults (full-resolution PNG + 400 max_tokens) were tuned
// without measurement. Empirical: 768px-wide captures with 200 max_tokens
// produce equivalent verdicts (CLEAN/MATCHES/MISMATCH parses identically),
// at ~2-3x lower inference cost. Override via env if you need higher
// resolution for a specific debug pass.
const CAPTION_MAX_WIDTH = Number(process.env.RENDER_CAPTURE_MAX_WIDTH ?? 768);
const CAPTION_MAX_TOKENS = Number(process.env.RENDER_CAPTURE_MAX_TOKENS ?? 200);
/** Downscale a captured PNG to at most CAPTION_MAX_WIDTH wide for the vision
 *  call. Sharp's resize is no-op when the image is already smaller. Falls
 *  back to the original bytes on any sharp error so we never lose the
 *  ability to caption when the optimizer fails. */
async function downscaleForCaption(png: Buffer): Promise<Buffer> {
  try {
    const meta = await sharp(png).metadata();
    if (!meta.width || meta.width <= CAPTION_MAX_WIDTH) return png;
    return await sharp(png).resize({ width: CAPTION_MAX_WIDTH, withoutEnlargement: true }).png().toBuffer();
  } catch {
    return png;
  }
}

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

// Resolve a card-class directory: project-scoped first, then library
// projects, then the built-in `card-classes/` folder shipped with mica.
// Mirrors `resolveCardClassDir` in server/index.ts (which is not exported);
// duplicating the four-line resolver here is lighter than restructuring
// imports across the boundary. Returns null if the class doesn't have a
// card.html anywhere — caller treats null as "skip live mount."
function resolveLocalClassDir(className: string, project: string | null): string | null {
  if (project) {
    const projectScoped = join(micaDir(project), "card-classes", className);
    if (existsSync(join(projectScoped, "card.html"))) return projectScoped;
  }
  const lib = findCardClassInLibraries(className);
  if (lib) return lib.dir;
  const builtIn = join(process.cwd(), "card-classes", className);
  if (existsSync(join(builtIn, "card.html"))) return builtIn;
  return null;
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

interface CaptionerConfig {
  url: string;
  headers: Record<string, string>;
  model: string;
  localKwargs: boolean;  // vLLM-specific `chat_template_kwargs.enable_thinking`
  label: string;         // human-readable for log/error messages
}

/** Resolve the captioning endpoint for the calling card's session.
 *
 *  Try-then-fallback pattern: route render_capture through the SAME provider
 *  the card uses for chat, with the card's chat model. If that call fails,
 *  retry with a known-multimodal fallback model (env-settable per provider).
 *  This avoids hardcoding assumptions about which models accept images —
 *  trust the chat model first, fall back only when it actually fails.
 *
 *  Returns { primary, fallback } where:
 *    - `primary` is the first request to try (card's chat model + provider).
 *    - `fallback` is a same-provider retry with a different model, or null
 *      when there's no useful fallback (e.g. local already uses the
 *      dedicated qwen-vl; no second attempt would help).
 *
 *  Providers:
 *    - openrouter:
 *        primary  = card's chat model on openrouter.ai
 *        fallback = OPENROUTER_VISION_FALLBACK env (default
 *                   `google/gemini-3.5-flash`)
 *    - openai-compat:
 *        primary  = card's chat model on user's baseUrl
 *        fallback = OPENAI_VISION_FALLBACK env (default `gpt-4o-mini`).
 *                   NOTE: openai-compat is user-configured. The fallback
 *                   MUST be a model their endpoint actually serves and
 *                   that accepts images. If your endpoint has no
 *                   multimodal model, leave the fallback unset and the
 *                   captioner will fail loudly with a clear message.
 *    - local (or unset): LLAMA_URL + `qwen-vl`. No fallback — qwen-vl
 *      is already the dedicated vision model on the bundled vLLM.
 *
 *  localKwargs is the vLLM-specific `chat_template_kwargs.enable_thinking`
 *  flag — only included for the local-vLLM path. */
async function resolveCaptionerConfig(
  project: string | null,
  chatFilename: string | null,
): Promise<{ primary: CaptionerConfig; fallback: CaptionerConfig | null }> {
  const localBase = LLAMA_URL.replace(/\/v1$/, "");
  const localConfig: CaptionerConfig = {
    url: `${localBase}/v1/chat/completions`,
    headers: { "Content-Type": "application/json" },
    model: "qwen-vl",
    localKwargs: true,
    label: `local vLLM (${localBase})`,
  };

  // No session context → local only (direct CLI / sidecar callers that
  // don't have a card to resolve from).
  if (!project || !chatFilename) {
    return { primary: localConfig, fallback: null };
  }

  const settings = await readCardSettings(project, chatFilename);
  // Resolution order matches the rest of the agent path: explicit sidecar
  // setting → workspace-level MICA_DEFAULT_PROVIDER → "local". Reading
  // `settings.provider ?? "local"` was a bug — it ignored the workspace
  // default for cards that don't pin a provider via the gear UI.
  const provider = settings.provider ?? resolveDefaultProvider();

  if (provider === "openrouter") {
    const key = await readOpenRouterKey(project);
    if (!key) {
      // OpenRouter selected but no key — the health-gate already surfaced this
      // at chat time. Fall back to local for vision so we at least produce a
      // caption; the agent will see the chat-side error separately.
      return {
        primary: { ...localConfig, label: `local vLLM (OpenRouter selected but no key)` },
        fallback: null,
      };
    }
    const chatModel = (settings.model || "").trim() || resolveDefaultModel("openrouter");
    const fallbackModel = process.env.OPENROUTER_VISION_FALLBACK || "google/gemini-3.5-flash";
    const baseHeaders = { "Content-Type": "application/json", Authorization: `Bearer ${key}` };
    const primary: CaptionerConfig = {
      url: "https://openrouter.ai/api/v1/chat/completions",
      headers: baseHeaders,
      model: chatModel,
      localKwargs: false,
      label: `OpenRouter (${chatModel}, card's chat model)`,
    };
    // Skip the fallback when the chat model IS the fallback — no point
    // retrying the same model on the same provider.
    const fallback: CaptionerConfig | null = chatModel === fallbackModel ? null : {
      url: "https://openrouter.ai/api/v1/chat/completions",
      headers: baseHeaders,
      model: fallbackModel,
      localKwargs: false,
      label: `OpenRouter (${fallbackModel}, OPENROUTER_VISION_FALLBACK)`,
    };
    return { primary, fallback };
  }

  if (provider === "openai-compat") {
    const cfg = await readOpenAICompatConfig(project);
    if (!cfg.baseUrl || !cfg.key) {
      return {
        primary: { ...localConfig, label: `local vLLM (openai-compat misconfigured)` },
        fallback: null,
      };
    }
    const baseClean = cfg.baseUrl.replace(/\/+$/, "");
    const v1 = /\/v\d+$/.test(baseClean) ? baseClean : `${baseClean}/v1`;
    const chatModel = (settings.model || "").trim() || resolveDefaultModel("openai-compat");
    const fallbackModel = process.env.OPENAI_VISION_FALLBACK || "gpt-4o-mini";
    const baseHeaders = { "Content-Type": "application/json", Authorization: `Bearer ${cfg.key}` };
    const primary: CaptionerConfig = {
      url: `${v1}/chat/completions`,
      headers: baseHeaders,
      model: chatModel,
      localKwargs: false,
      label: `openai-compat ${v1} (${chatModel}, card's chat model)`,
    };
    const fallback: CaptionerConfig | null = chatModel === fallbackModel ? null : {
      url: `${v1}/chat/completions`,
      headers: baseHeaders,
      model: fallbackModel,
      localKwargs: false,
      label: `openai-compat ${v1} (${fallbackModel}, OPENAI_VISION_FALLBACK)`,
    };
    return { primary, fallback };
  }

  // provider === "local" or anything unknown → local vLLM, no fallback.
  return { primary: localConfig, fallback: null };
}

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
    // Canonicalize the filename. The agent commonly passes either the bare
    // class-instance form ("moon-orbit.moon-orbit") or the canvas-relative
    // form ("canvas/moon-orbit.moon-orbit"). The frontend's card lookup
    // expects the canvas-relative form. Without normalization, the
    // bare-form call returns "card not found on page" and the agent
    // burns 1-3 turns guessing the right shape before landing on the
    // form the frontend wants. canonicalizeCardPath is idempotent on
    // already-canonical paths, so this is safe for both inputs.
    let canonicalFilename: string;
    try {
      const { canvasRoot } = await readCanvasConfig(ctx.project);
      canonicalFilename = canonicalizeCardPath(input.filename, canvasRoot);
    } catch {
      // Fall back to the raw input if canonicalization throws (e.g. path
      // escapes project root). Let captureCard surface the real error.
      canonicalFilename = input.filename;
    }

    // Live-mount check (Verifier #2): before paying for the screenshot +
    // vision-model captioning, mount the card in headless Chromium and
    // watch for runtime errors. Catches the failure class render_capture's
    // existing buffer-read step misses — namely, when card.js wraps init
    // in defensive try/catch that logs to console but doesn't rethrow
    // (orbit200's `init failed:` swallow). The static verifiers don't
    // reach this either (the card.js parses cleanly; the failure is at
    // dynamic-import resolution time). If it fails, we return early with
    // a LIVE-MOUNT-FAILED verdict so the agent iterates without burning
    // a screenshot turn on a card we already know is broken.
    const className = classNameFromInstance(canonicalFilename);
    if (className) {
      const classDir = resolveLocalClassDir(className, ctx.project);
      if (classDir) {
        const mountResult = await runLiveMount(classDir);
        if (!mountResult.ok) {
          const lines = mountResult.problems
            .map((p, i) => `  ${i + 1}. ${p.problem}\n     Fix: ${p.fix_hint}`)
            .join("\n");
          return {
            isError: true,
            text:
              `[render_capture: LIVE-MOUNT-FAILED] Build is NOT complete. The card threw runtime errors when mounted in headless Chromium. ` +
              `Fix each error below (use mica_edit_class_file), then re-call render_capture. The screenshot pipeline is skipped on live-mount ` +
              `failure — there's no point captioning a card we already know is broken.\n\nErrors:\n${lines}`,
          };
        }
      }
    }

    try {
      const result = await captureCard(ctx.project, canonicalFilename);
      const png = await fsReadFile(result.path);
      const pngHash = sha256(png);

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

      // Pixel-diff gate: if we already captioned an identical PNG for this
      // (card, intent), skip the vision call entirely. Validator errors and
      // the verdict tag are recomputed below from current state, so this
      // doesn't mask new errors that appeared between calls — it only saves
      // the LLM round-trip when the agent re-verifies an unchanged card
      // (the most common "verify, then verify again" pattern).
      const cacheKey = ctx.project ? captionerCacheKey(ctx.project, canonicalFilename, userIntent) : null;
      const cachedCaption = cacheKey ? captionerCacheGet(cacheKey, pngHash) : null;

      const systemPrompt = compareMode
        ? "You are verifying a rendered Mica card against a specific user request. Look at the attached image and judge whether the visible content satisfies the request. Reply in EXACTLY this two-line format and nothing else:\nVERDICT: MATCHES or MISMATCH or UNVERIFIABLE\nEVIDENCE: <one short sentence describing what you see that supports the verdict>\n\nVerdict guide:\n- MATCHES: the visible card shows what the user asked for. STRICT: every concrete element the user explicitly named (e.g. \"planets\", \"speed slider\", \"Saturn rings\", \"day/night overlay\") must be visible in the image. If even ONE named element is missing, you cannot return MATCHES — return MISMATCH or UNVERIFIABLE instead. The captioner cannot predict future frames; \"it looks like it's loading and will probably show that later\" is NOT valid evidence for MATCHES.\n- MISMATCH: the visible card is missing one or more elements the user explicitly named, OR shows wrong text / wrong icons / wrong layout / extra elements that contradict the request. INCLUDES: cards where the main content is occluded by a \"Loading...\" overlay, progress bar, error overlay, or similar transient chrome that prevents the named content from being visible — the user asked for the loaded state, not the in-progress state. Use this ONLY when the request describes the INITIAL visible state and the screenshot disagrees. Do NOT use this when the request describes content that appears AFTER user interaction — see UNVERIFIABLE.\n- UNVERIFIABLE: the request is about content or state that requires user interaction to reach (a preview that appears after uploading a file, a result that shows after clicking a button, output that appears after submitting a form, text typed into an input) AND the screenshot shows the card in its initial idle state with no interaction performed yet. ALSO use for behavior a still image can't show (animations, spinners, transient overlays). The cue: ask 'does the request reference an action the user has to perform first?' — if yes and the screenshot is pre-action, the answer is UNVERIFIABLE, not MISMATCH. Do not use UNVERIFIABLE just because you're unsure on a verifiable initial-state request, and do not use it as an escape hatch to avoid returning MISMATCH on cards stuck loading."
        : "You are verifying a rendered Mica card class. Describe what's actually visible in the attached image — layout, colors, visible text, anything that looks broken, missing, clipped, or wrong. Look for: red error banners, blank/empty regions, overlapping elements, illegible text, missing markers/icons. Describe the IMAGE, not the source code. 5-15 lines of plain text, no markdown.";

      const userText = compareMode
        ? `User's request:\n${userIntent}\n\nDoes the image satisfy this request? Reply in the VERDICT / EVIDENCE format described.`
        : `Verification of ${input.filename}: describe what you see.`;

      let caption = "";
      let cacheHit = false;
      if (cachedCaption !== null) {
        caption = cachedCaption;
        cacheHit = true;
        console.log(`[render_capture] cache hit for ${ctx.project}|${canonicalFilename} — skipping vision call (pixel-diff matched prior caption)`);
      } else {
        // Downscale the PNG before sending to the vision model. Sharp falls
        // through to the original buffer on any error, so this never breaks
        // captioning — worst case is sending the larger image.
        const captionPng = await downscaleForCaption(png);
        const base64 = captionPng.toString("base64");
        // Try the card's chat model first (the user-picked model) for vision.
        // If it errors (e.g. provider rejects images for that model), retry
        // once with the env-set fallback. This trusts the user's choice (no
        // hardcoded multimodal allowlist) and surfaces the failure clearly
        // when both attempts fail.
        const { primary, fallback } = await resolveCaptionerConfig(ctx.project, ctx.chatFilename);
        console.log(`[render_capture] ctx: project=${ctx.project ?? "(null)"} chatFilename=${ctx.chatFilename ?? "(null)"} → route: primary=${primary.label}${fallback ? ` (fallback=${fallback.label})` : ""}`);
        const attemptCaption = async (cfg: CaptionerConfig): Promise<{ ok: true; text: string } | { ok: false; reason: string }> => {
          const body: Record<string, unknown> = {
            model: cfg.model,
            max_tokens: CAPTION_MAX_TOKENS,
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
          };
          // vLLM-specific knob: disable thinking so the token budget goes to
          // the description instead of <think> blocks that land in
          // reasoning_content. Cloud providers may error if this kwarg is
          // included — only send for local.
          if (cfg.localKwargs) body.chat_template_kwargs = { enable_thinking: false };
          try {
            const res = await fetch(cfg.url, {
              method: "POST",
              headers: cfg.headers,
              // 60s accommodates OpenRouter routing + multimodal inference.
              signal: AbortSignal.timeout(60000),
              body: JSON.stringify(body),
            });
            if (!res.ok) {
              // Read body for context (vision-reject errors usually include a
              // useful message). Capped to keep log lines manageable.
              let detail = "";
              try { detail = (await res.text()).slice(0, 200); } catch { /* ignore */ }
              return { ok: false, reason: `${cfg.label}: HTTP ${res.status}${detail ? ` — ${detail}` : ""}` };
            }
            const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
            const text = data.choices?.[0]?.message?.content?.trim() || "";
            return { ok: true, text };
          } catch (err) {
            const reason = (err as Error).name === "TimeoutError" || (err as Error).name === "AbortError"
              ? "timed out"
              : (err as Error).message;
            return { ok: false, reason: `${cfg.label}: ${reason}` };
          }
        };

        const first = await attemptCaption(primary);
        if (first.ok) {
          caption = first.text;
        } else if (fallback) {
          console.log(`[render_capture] primary captioner failed (${first.reason}); retrying via fallback`);
          const second = await attemptCaption(fallback);
          if (second.ok) {
            caption = second.text;
          } else {
            caption = `(captioning unavailable: both primary [${first.reason}] and fallback [${second.reason}] failed. This card was NOT visually verified.)`;
          }
        } else {
          caption = `(captioning unavailable: ${first.reason}. This card was NOT visually verified.)`;
        }

        // Store the caption for the next pixel-diff-equal call. Skip the
        // captioning-failed marker — a retry of that should re-attempt the
        // LLM call, not return the same failure.
        if (cacheKey && caption && !caption.startsWith("(captioning")) {
          captionerCacheSet(cacheKey, pngHash, caption);
        }
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
      // `className` was already computed up-top for the live-mount gate;
      // reuse it here for the validator-error filter.
      const allErrors = ctx.project ? getPendingValidatorErrors(ctx.project) : [];
      const relevantErrors = allErrors.filter((e) => {
        if (e.filename === canonicalFilename) return true;
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

      const cacheNote = cacheHit ? "\n\n(Caption reused from prior call — the rendered PNG hashed identically to a previous render_capture, so the vision model was skipped. The verdict tag above reflects current validator state.)" : "";
      return {
        text: `${verdictHeader}\n\nCaption of ${input.filename} (${meta}):\n${captionBody}${cacheNote}`,
      };
    } catch (err) {
      return {
        isError: true,
        text: `Capture failed: ${(err as Error).message}`,
      };
    }
  },
};
