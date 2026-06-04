// Card introspection — mount a card class in headless Chromium and extract
// rich TEXT debug info. Sister tool to cardLiveMount (which only collects
// errors); this one collects post-mount page state so text-only LLMs can
// "see" what's on the rendered card without the vision-captioner path.
//
// What it captures (all text):
//   - Errors / warnings / log lines from the console
//   - Uncaught page errors + sync-wrap failures (same as live-mount)
//   - Failed network requests (URL + reason)
//   - The card's visible text (innerText of the container, capped)
//   - A structured DOM inventory: buttons, inputs, canvases, images,
//     headings, and "overlay-shaped" elements (elements whose class/id
//     suggests an error overlay, loading state, etc.)
//   - Page dimensions + scroll height (does the card fit?)
//   - A compact accessibility-tree summary (roles + labels)
//   - Network counts (total requests, failed, total bytes)
//
// Reuses cardLiveMount's buildMountPage + loadCardMountSources so the mount
// semantics are identical — same shim, same error globals, same async-IIFE
// wrap. The only difference is the listener set + the post-settle evaluate.
//
// Output is rendered to a stable text block by the MCP tool surface in
// server/agentTools/renderInspect.ts. Caps applied per-section so the
// result tops out around 2-3KB even on a busy card.

import { join } from "node:path";
import { getBrowser } from "./playwrightContext.js";
import { buildMountPage, loadCardMountSources } from "./cardLiveMount.js";

export interface IntrospectOptions {
  /** Settle window after the page loads. Default 2000 — same as live-mount.
   *  Most cards finish init + first paint inside this window; under it,
   *  the inventory captures only the loading state. */
  observationMs?: number;
}

export interface IntrospectButton { text: string; ariaLabel?: string; disabled: boolean }
export interface IntrospectInput   { type: string; placeholder?: string; value?: string; ariaLabel?: string }
export interface IntrospectCanvas  { width: number; height: number; webgl: boolean }
export interface IntrospectImage   { src: string; alt?: string; visible: boolean }
export interface IntrospectHeading { level: 1 | 2 | 3 | 4 | 5 | 6; text: string }
export interface IntrospectOverlay { selector: string; text: string }

export interface IntrospectResult {
  /** Skip flag — true when the class is missing card.html / card.js, or
   *  when Chromium isn't installed. Caller treats this as "no debug info"
   *  rather than a failure. */
  skipped: boolean;
  skipReason?: string;
  observationMs: number;
  elapsedMs: number;
  // Error / log collectors (post-settle)
  pageErrors: string[];
  consoleErrors: string[];
  consoleWarnings: string[];
  consoleLog: string[];
  failedRequests: { url: string; reason: string }[];
  network: { total: number; failed: number; bytesTransferred: number };
  // Post-settle page state (from page.evaluate)
  pageText: string;
  dimensions: { viewportW: number; viewportH: number; bodyScrollH: number };
  domInventory: {
    buttons: IntrospectButton[];
    inputs: IntrospectInput[];
    canvases: IntrospectCanvas[];
    images: IntrospectImage[];
    headings: IntrospectHeading[];
    overlays: IntrospectOverlay[];
  };
  /** Compact accessibility tree from page.accessibility.snapshot, rendered
   *  as indented role + name lines. Capped. */
  a11ySummary: string;
}

const LOG_CAP = 50;          // max console.log entries to keep
const ERR_CAP = 30;          // max console.error entries
const WARN_CAP = 30;         // max console.warn entries
const NET_FAILED_CAP = 20;   // max failed-request entries
const INV_CAP = 20;          // max entries per inventory list (buttons, inputs, etc.)
const TEXT_CAP = 4000;       // pageText byte cap
const A11Y_CAP = 2000;       // accessibility summary byte cap
const OVERLAY_RX = /error|loading|overlay|spinner|placeholder|fallback|warning/i;

/** Mount the card in headless Chromium and return rich post-mount page state.
 *  Identical mount semantics to cardLiveMount.runLiveMount — same shim, same
 *  error globals — so a card that passes live-mount will introspect cleanly,
 *  and a card that fails live-mount will also surface those errors here. */
export async function runCardIntrospect(
  classDir: string,
  opts: IntrospectOptions = {},
): Promise<IntrospectResult> {
  const t0 = Date.now();
  const observationMs = opts.observationMs ?? 2000;
  const shortDir = classDir.replace(/^.*\//, "");

  const sources = await loadCardMountSources(classDir);
  if (!sources) {
    return makeSkipped(observationMs, t0, "card.html or card.js missing");
  }
  const pageHtml = buildMountPage(sources);

  let browser;
  try {
    browser = await getBrowser();
  } catch (err) {
    return makeSkipped(observationMs, t0, `Chromium unavailable: ${(err as Error).message}`);
  }
  console.log(`[introspect:${shortDir}] mounting`);

  const ctx = await browser.newContext();
  const tab = await ctx.newPage();

  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  const consoleWarnings: string[] = [];
  const consoleLog: string[] = [];
  const failedRequests: { url: string; reason: string }[] = [];
  let totalRequests = 0;
  let bytesTransferred = 0;

  tab.on("pageerror", (err) => { pageErrors.push(err.message); });
  tab.on("console", (msg) => {
    const text = msg.text();
    const type = msg.type();
    if (type === "error") {
      if (/Failed to load resource/i.test(text)) return; // we capture failed requests separately
      if (consoleErrors.length < ERR_CAP) consoleErrors.push(text);
    } else if (type === "warning") {
      if (consoleWarnings.length < WARN_CAP) consoleWarnings.push(text);
    } else if (type === "log" || type === "info" || type === "debug") {
      if (consoleLog.length < LOG_CAP) consoleLog.push(text);
    }
  });
  tab.on("request", () => { totalRequests++; });
  tab.on("response", (resp) => {
    const len = Number(resp.headers()["content-length"] ?? 0);
    if (Number.isFinite(len) && len > 0) bytesTransferred += len;
  });
  tab.on("requestfailed", (req) => {
    if (failedRequests.length < NET_FAILED_CAP) {
      failedRequests.push({ url: req.url(), reason: req.failure()?.errorText ?? "unknown" });
    }
  });

  // Defaults, overwritten by the page.evaluate below.
  let pageText = "";
  let dimensions = { viewportW: 0, viewportH: 0, bodyScrollH: 0 };
  let domInventory: IntrospectResult["domInventory"] = {
    buttons: [], inputs: [], canvases: [], images: [], headings: [], overlays: [],
  };
  let a11ySummary = "";

  try {
    // Polyfill esbuild's `keepNames` helpers BEFORE setContent. When tsx
    // transpiles the page.evaluate callback below, the resulting function
    // string contains `__name(fn, "fn")` wrappers to preserve Function.name.
    // Playwright serializes that string and runs it in the page; with no
    // global `__name` defined, every call throws `ReferenceError: __name
    // is not defined`. The error fires from inside the Playwright eval
    // chain (`eval at eval at eval`), so it looks like a card bug to the
    // agent — observed empirically (sfo-airtraffic in zing2, 1200+ log
    // lines of the agent chasing a phantom `__name` issue that was the
    // harness's own transpile artifact). Defining the helpers globally
    // before any page activity makes the introspector transparent again.
    await tab.addInitScript({
      content:
        "globalThis.__name = globalThis.__name || ((target, value) => { try { Object.defineProperty(target, 'name', { value, configurable: true }); } catch {} return target; });" +
        "globalThis.__defProp = globalThis.__defProp || Object.defineProperty;" +
        "globalThis.__publicField = globalThis.__publicField || ((obj, key, value) => { obj[key] = value; return value; });",
    });
    await tab.setContent(pageHtml, { waitUntil: "load", timeout: 10_000 });
    await tab.waitForTimeout(observationMs);

    // Drain shim errors recorded by the in-page try/catch and the
    // unhandledrejection listener (same as cardLiveMount).
    const shimErrors: string[] = await tab.evaluate(() => {
      // @ts-expect-error injected by buildMountPage
      return Array.isArray(window.__shimErrors) ? window.__shimErrors : [];
    });
    for (const e of shimErrors) consoleErrors.push(e);

    // Single page.evaluate that walks the post-settle DOM and returns
    // everything we need. One round-trip is much cheaper than per-locator
    // queries; running in the page context lets us use real DOM APIs
    // (computedStyle, IntersectionObserver-equivalent checks, etc.).
    const snapshot = await tab.evaluate((caps) => {
      const isVisible = (el: Element): boolean => {
        const cs = window.getComputedStyle(el);
        if (cs.display === "none" || cs.visibility === "hidden" || cs.opacity === "0") return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };
      const txt = (s: string | null | undefined, n: number): string => (s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
      const body = document.body;
      const text = txt(body?.innerText ?? "", caps.TEXT_CAP);
      const dims = {
        viewportW: window.innerWidth,
        viewportH: window.innerHeight,
        bodyScrollH: body?.scrollHeight ?? 0,
      };
      // Buttons: <button> + role="button". Cap per caps.INV_CAP.
      const btnNodes = Array.from(document.querySelectorAll("button, [role='button']")).slice(0, caps.INV_CAP);
      const buttons = btnNodes.map((el) => ({
        text: txt(el.textContent, 80),
        ariaLabel: el.getAttribute("aria-label") ?? undefined,
        disabled: (el as HTMLButtonElement).disabled === true || el.getAttribute("aria-disabled") === "true",
      }));
      // Inputs: form controls.
      const inpNodes = Array.from(document.querySelectorAll("input, textarea, select")).slice(0, caps.INV_CAP);
      const inputs = inpNodes.map((el) => {
        const tag = el.tagName.toLowerCase();
        const type = tag === "input" ? ((el as HTMLInputElement).type || "text") : tag;
        return {
          type,
          placeholder: (el as HTMLInputElement).placeholder || undefined,
          value: (el as HTMLInputElement).value ? txt((el as HTMLInputElement).value, 80) : undefined,
          ariaLabel: el.getAttribute("aria-label") ?? undefined,
        };
      });
      // Canvases: dimensions + WebGL detection.
      const canvNodes = Array.from(document.querySelectorAll("canvas")).slice(0, caps.INV_CAP);
      const canvases = canvNodes.map((el) => {
        const c = el as HTMLCanvasElement;
        let webgl = false;
        try {
          // Probe via getContext: a previously-created context is returned;
          // we don't reinitialize, just check.
          webgl = !!(c.getContext("webgl2") ?? c.getContext("webgl") ?? c.getContext("experimental-webgl"));
        } catch { webgl = false; }
        return { width: c.width, height: c.height, webgl };
      });
      // Images: src + alt + visibility.
      const imgNodes = Array.from(document.querySelectorAll("img")).slice(0, caps.INV_CAP);
      const images = imgNodes.map((el) => {
        const img = el as HTMLImageElement;
        return { src: txt(img.getAttribute("src"), 200), alt: img.alt || undefined, visible: isVisible(img) };
      });
      // Headings.
      const hNodes = Array.from(document.querySelectorAll("h1, h2, h3, h4, h5, h6")).slice(0, caps.INV_CAP);
      const headings = hNodes.map((el) => ({
        level: parseInt(el.tagName.slice(1), 10) as 1 | 2 | 3 | 4 | 5 | 6,
        text: txt(el.textContent, 120),
      }));
      // Overlays: any element whose class or id matches the overlay-name
      // regex AND is currently visible. These are the static-fallback text
      // overlays that mislead the agent (canvas-back.md warns about them).
      const allVis = Array.from(document.querySelectorAll<HTMLElement>("[class],[id]"))
        .filter((el) => caps.OVERLAY_RX.test((el.className || "") + " " + (el.id || "")) && isVisible(el))
        .slice(0, caps.INV_CAP);
      const overlays = allVis.map((el) => ({
        selector: el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + (el.className ? "." + String(el.className).split(/\s+/).slice(0, 2).join(".") : ""),
        text: txt(el.textContent, 200),
      }));
      return { text, dims, buttons, inputs, canvases, images, headings, overlays };
    }, { TEXT_CAP, INV_CAP, OVERLAY_RX: OVERLAY_RX.source });

    pageText = snapshot.text;
    dimensions = snapshot.dims;
    domInventory = {
      buttons: snapshot.buttons,
      inputs: snapshot.inputs,
      canvases: snapshot.canvases,
      images: snapshot.images,
      headings: snapshot.headings,
      overlays: snapshot.overlays,
    };

    // Accessibility tree — separate API. Compact-render to indented lines.
    try {
      const a11y = await tab.accessibility.snapshot({ interestingOnly: true });
      a11ySummary = renderA11ySnapshot(a11y).slice(0, A11Y_CAP);
    } catch {
      a11ySummary = "(accessibility snapshot unavailable)";
    }
  } catch (err) {
    pageErrors.push(`introspect harness failed: ${(err as Error).message}`);
  } finally {
    await ctx.close().catch(() => { /* already closed */ });
  }

  const elapsed = Date.now() - t0;
  console.log(`[introspect:${shortDir}] done (${elapsed}ms, ${consoleErrors.length}E ${consoleWarnings.length}W ${pageErrors.length}P ${failedRequests.length}NF)`);

  return {
    skipped: false,
    observationMs,
    elapsedMs: elapsed,
    pageErrors,
    consoleErrors,
    consoleWarnings,
    consoleLog,
    failedRequests,
    network: { total: totalRequests, failed: failedRequests.length, bytesTransferred },
    pageText,
    dimensions,
    domInventory,
    a11ySummary,
  };
}

function makeSkipped(observationMs: number, t0: number, reason: string): IntrospectResult {
  return {
    skipped: true,
    skipReason: reason,
    observationMs,
    elapsedMs: Date.now() - t0,
    pageErrors: [], consoleErrors: [], consoleWarnings: [], consoleLog: [],
    failedRequests: [],
    network: { total: 0, failed: 0, bytesTransferred: 0 },
    pageText: "",
    dimensions: { viewportW: 0, viewportH: 0, bodyScrollH: 0 },
    domInventory: { buttons: [], inputs: [], canvases: [], images: [], headings: [], overlays: [] },
    a11ySummary: "",
  };
}

/** Render Playwright's recursive accessibility-snapshot tree as indented
 *  `role: name` lines. Skips nodes with no role AND no name (the snapshot
 *  is already filtered with interestingOnly=true so most decorative
 *  nesting is dropped, but children-only wrappers still come through). */
type A11yNode = { role?: string; name?: string; value?: string; children?: A11yNode[] };
function renderA11ySnapshot(root: A11yNode | null, depth = 0): string {
  if (!root) return "";
  const out: string[] = [];
  walk(root, depth, out);
  return out.join("\n");
  function walk(n: A11yNode, d: number, lines: string[]): void {
    const role = (n.role ?? "").trim();
    const name = (n.name ?? "").trim().replace(/\s+/g, " ").slice(0, 80);
    const value = (n.value ?? "").trim().replace(/\s+/g, " ").slice(0, 40);
    if (role || name) {
      const pad = "  ".repeat(d);
      const labelTail = name ? ` "${name}"` : "";
      const valueTail = value ? ` =${value}` : "";
      lines.push(`${pad}${role || "(none)"}${labelTail}${valueTail}`);
    }
    if (Array.isArray(n.children)) {
      for (const c of n.children) walk(c, d + 1, lines);
    }
  }
}
// Touched at module-eval time to keep tooling that flags unused imports
// happy when `join` is needed only in error paths.
void join;
