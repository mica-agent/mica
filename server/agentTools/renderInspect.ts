// mica_inspect_card — text-only debug snapshot of a card class.
//
// Peer to render_capture, but produces NO image and never calls a vision
// model. Instead, mounts the card in headless Chromium (same Playwright
// path the live-mount verifier uses) and extracts structured page state as
// TEXT: console output, page errors, failed network requests, visible text,
// DOM inventory (buttons / inputs / canvases / images / headings / overlays),
// accessibility tree, and dimensions.
//
// Intended for text-only chat models that can't use render_capture's vision
// captioner. Also useful as a parallel signal for vision-capable models —
// the inventory + console output is OBJECTIVE (no interpretation) and
// catches failure modes the captioner can miss (a button labeled "Submit"
// is either present in the inventory or not; the captioner might confabulate
// either way).
//
// Returns a stable, sectioned text block — keyed headings so the agent can
// scan quickly. Caps applied per-section so the result tops out around 2-3KB
// even on a busy card.

import { z } from "zod";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { canonicalizeCardPath, readCanvasConfig, micaDir, findCardClassInLibraries } from "../files.js";
import { runCardIntrospect, type IntrospectResult } from "../verifiers/cardIntrospect.js";
import type { AgentToolDef, AgentToolResult } from "./registry.js";

// Map a card instance filename ("canvas/foo.bar-baz") to a substring that
// identifies its class directory (".mica/card-classes/bar-baz").
// Same logic as renderCapture's classNameFromInstance.
function classNameFromInstance(filename: string): string | null {
  const dot = filename.lastIndexOf(".");
  if (dot === -1) return null;
  const ext = filename.slice(dot + 1);
  return ext || null;
}

// Resolve a card-class directory: project-scoped first, then library
// projects, then the built-in `card-classes/` folder. Same lookup chain
// renderCapture uses.
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

const inputSchema = {
  filename: z
    .string()
    .describe(
      "Canvas-root-relative path of the instance file (e.g. 'canvas/my.burndown'). The class is " +
      "resolved from the file extension. Same convention as render_capture.",
    ),
  observation_ms: z
    .number()
    .int()
    .min(500)
    .max(15_000)
    .optional()
    .describe(
      "Settle window after the page loads, in ms. Default 2000. Increase up to 15000 for cards " +
      "that do slow async init (large texture loads, multiple network fetches). Most cards finish " +
      "first paint inside 2000ms.",
    ),
} as const;

export const renderInspectTool: AgentToolDef<typeof inputSchema> = {
  name: "mica_inspect_card",
  description:
    "Get a TEXT-ONLY debug snapshot of a card class. Mounts the card in headless Chromium, " +
    "observes for a settle window, and returns: console errors / warnings / logs, uncaught " +
    "page errors, failed network requests, the visible page text, DOM inventory (buttons / " +
    "inputs / canvases / images / headings / overlay-shaped elements), accessibility tree, " +
    "page dimensions, and network counts. NO vision model is called — the output is purely " +
    "factual extraction. Use this when the chat model is text-only (can't use render_capture's " +
    "vision captioner), OR alongside render_capture for an objective second signal on whether " +
    "expected UI elements are present. Input: { filename, observation_ms? }. The browser tab does " +
    "NOT need to be open — this runs in a fresh headless mount, like the live-mount verifier.",
  inputSchema,
  restPath: "/api/tools/render-inspect",
  handler: async (input, ctx): Promise<AgentToolResult> => {
    if (!ctx.project) {
      return {
        isError: true,
        text: "mica_inspect_card requires an active project session. Ensure a project is open before calling.",
      };
    }
    let canonicalFilename: string;
    try {
      const { canvasRoot } = await readCanvasConfig(ctx.project);
      canonicalFilename = canonicalizeCardPath(input.filename, canvasRoot);
    } catch {
      canonicalFilename = input.filename;
    }
    const className = classNameFromInstance(canonicalFilename);
    if (!className) {
      return {
        isError: true,
        text: `mica_inspect_card: could not infer card class from filename "${input.filename}". Pass a canvas-relative instance path like "canvas/my.burndown".`,
      };
    }
    const classDir = resolveLocalClassDir(className, ctx.project);
    if (!classDir) {
      return {
        isError: true,
        text: `mica_inspect_card: card class "${className}" not found in this project, any library project, or the built-in card-classes/. Did you mean to create it first?`,
      };
    }

    const result = await runCardIntrospect(classDir, {
      observationMs: input.observation_ms,
    });

    return { text: renderIntrospectionAsText(input.filename, className, result) };
  },
};

/** Format the IntrospectResult as a sectioned text block. Sections are
 *  always emitted in the same order so the agent's pattern-matching is
 *  stable. Empty sections render as "(none)" rather than disappearing,
 *  so the agent can tell "nothing here" apart from "I forgot to look". */
function renderIntrospectionAsText(filename: string, className: string, r: IntrospectResult): string {
  if (r.skipped) {
    return (
      `[mica_inspect_card: SKIPPED] Could not mount ${className} headlessly.\n` +
      `Reason: ${r.skipReason ?? "unknown"}\n` +
      `This is not an error in your card — it means the introspection harness can't run here. ` +
      `Use render_capture (or another verifier) to check the build.`
    );
  }

  const lines: string[] = [];
  // Verdict header — first line is what the agent scans. Heuristics:
  //   ERRORS: any pageError or consoleError
  //   WARNINGS: warnings or failed requests but no errors
  //   CLEAN: nothing flagged
  const hasErrors = r.pageErrors.length > 0 || r.consoleErrors.length > 0;
  const hasWarnings = r.consoleWarnings.length > 0 || r.failedRequests.length > 0;
  const tag = hasErrors ? "ERRORS" : hasWarnings ? "WARNINGS" : "CLEAN";
  lines.push(
    `[mica_inspect_card: ${tag}] Headless mount of ${className} (${r.elapsedMs}ms, ` +
    `observation window ${r.observationMs}ms). Inspection of ${filename}:`,
  );
  lines.push("");

  // PAGE ERRORS
  lines.push("## Page errors (uncaught throws)");
  lines.push(r.pageErrors.length > 0 ? r.pageErrors.map((e) => `  - ${truncate(e, 400)}`).join("\n") : "(none)");
  lines.push("");

  // CONSOLE ERRORS
  lines.push("## Console errors");
  lines.push(r.consoleErrors.length > 0 ? r.consoleErrors.map((e) => `  - ${truncate(e, 400)}`).join("\n") : "(none)");
  lines.push("");

  // CONSOLE WARNINGS — only if any
  if (r.consoleWarnings.length > 0) {
    lines.push("## Console warnings");
    lines.push(r.consoleWarnings.map((w) => `  - ${truncate(w, 400)}`).join("\n"));
    lines.push("");
  }

  // CONSOLE LOG — only if any (often debug output from the card author)
  if (r.consoleLog.length > 0) {
    lines.push(`## Console log (${r.consoleLog.length} entries)`);
    lines.push(r.consoleLog.map((l) => `  - ${truncate(l, 300)}`).join("\n"));
    lines.push("");
  }

  // FAILED REQUESTS
  lines.push("## Failed network requests");
  lines.push(
    r.failedRequests.length > 0
      ? r.failedRequests.map((f) => `  - ${truncate(f.url, 200)} (${f.reason})`).join("\n")
      : "(none)",
  );
  lines.push("");

  // NETWORK
  lines.push("## Network");
  lines.push(`  total=${r.network.total}, failed=${r.network.failed}, bytesTransferred=${r.network.bytesTransferred}`);
  lines.push("");

  // DIMENSIONS
  lines.push("## Dimensions");
  lines.push(`  viewport=${r.dimensions.viewportW}x${r.dimensions.viewportH}, bodyScrollH=${r.dimensions.bodyScrollH}`);
  lines.push("");

  // DOM INVENTORY
  lines.push("## DOM inventory");
  const inv = r.domInventory;
  lines.push(`### Headings (${inv.headings.length})`);
  lines.push(inv.headings.length > 0 ? inv.headings.map((h) => `  - h${h.level}: ${h.text || "(empty)"}`).join("\n") : "(none)");
  lines.push(`### Buttons (${inv.buttons.length})`);
  lines.push(
    inv.buttons.length > 0
      ? inv.buttons.map((b) => `  - "${b.text || b.ariaLabel || "(unnamed)"}"${b.disabled ? " [disabled]" : ""}`).join("\n")
      : "(none)",
  );
  lines.push(`### Inputs (${inv.inputs.length})`);
  lines.push(
    inv.inputs.length > 0
      ? inv.inputs
          .map((i) => {
            const tail = [
              i.placeholder ? `placeholder="${i.placeholder}"` : null,
              i.value ? `value="${i.value}"` : null,
              i.ariaLabel ? `aria-label="${i.ariaLabel}"` : null,
            ]
              .filter(Boolean)
              .join(" ");
            return `  - <${i.type}> ${tail}`;
          })
          .join("\n")
      : "(none)",
  );
  lines.push(`### Canvases (${inv.canvases.length})`);
  lines.push(
    inv.canvases.length > 0
      ? inv.canvases.map((c) => `  - ${c.width}x${c.height}${c.webgl ? " [WebGL]" : ""}`).join("\n")
      : "(none)",
  );
  lines.push(`### Images (${inv.images.length})`);
  lines.push(
    inv.images.length > 0
      ? inv.images.map((i) => `  - ${truncate(i.src, 120)}${i.alt ? ` alt="${i.alt}"` : ""}${i.visible ? "" : " [hidden]"}`).join("\n")
      : "(none)",
  );
  lines.push(`### Overlay-shaped elements (${inv.overlays.length})`);
  lines.push(
    inv.overlays.length > 0
      ? inv.overlays.map((o) => `  - ${o.selector}: "${o.text || "(empty)"}"`).join("\n")
      : "(none)",
  );
  lines.push("");
  lines.push(
    "Note on overlays: these are visible elements whose class/id matches /error|loading|overlay|spinner|placeholder|fallback|warning/i. " +
    "Static-fallback text in error overlays (e.g. '<div class=\"error\">Failed to load</div>') often becomes visible whenever init throws ANYTHING, " +
    "and the text usually lies about what actually broke. Treat overlay text as a HINT, not a diagnosis — read the actual console errors above.",
  );
  lines.push("");

  // VISIBLE TEXT
  lines.push("## Visible text (body innerText)");
  lines.push(r.pageText ? indent(r.pageText, "  ") : "(empty)");
  lines.push("");

  // A11Y TREE
  lines.push("## Accessibility tree");
  lines.push(r.a11ySummary ? indent(r.a11ySummary, "  ") : "(empty)");

  return lines.join("\n");
}

function truncate(s: string, n: number): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length > n ? oneLine.slice(0, n) + "…" : oneLine;
}
function indent(s: string, pad: string): string {
  return s
    .split("\n")
    .map((l) => pad + l)
    .join("\n");
}
