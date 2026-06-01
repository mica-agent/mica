// Live-mount verifier — mount the card class in headless Chromium, observe
// for runtime errors over a ~2s window, return a structured report.
//
// This is the Layer 2 check the static verifiers can't reach: it catches
// failures that only surface when the card actually executes in a browser.
// Concrete failure shapes it covers:
//
//   - Bare-specifier import trap (orbit100, orbit200): `import('foo.js')`
//     where foo.js does `import 'three'` — browser can't resolve, init
//     throws, card stays blank.
//   - CDN 404 / DNS failure / CORS block on a fetched resource.
//   - Defensive try/catch swallowing the real failure (orbit200: init()'s
//     try/catch logs `[moon-orbit] init failed` to console.error and never
//     rethrows — pageerror doesn't fire, but Playwright's console listener
//     catches it and we flag the swallowed error).
//   - Null-deref / TypeError in init / wiring bugs that fire at mount time
//     but were missed by static analysis.
//
// What this does NOT catch:
//   - Interaction bugs (click handler broken — needs an interaction script)
//   - Visual correctness ("moon is wrong color" — render_capture's job)
//   - Lifecycle bugs that surface on re-mount or destroy
//   - Channel round-trip (mica stub records calls but doesn't respond;
//     a card that needs a channel response to render won't get it here)
//
// Invocation: NOT a write-time gate (too slow for the iterate loop).
// Called from renderCapture.ts before the screenshot pipeline runs, so it
// piggybacks on a step the agent already takes before declaring done. If
// live mount fails, render_capture returns the failure and the agent
// iterates without ever paying for the screenshot + caption.

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { getBrowser } from "./playwrightContext.js";
import { getCardShim } from "./cardShim.js";
import type { VerifyResult, VerifyProblem } from "./registry.js";

export interface LiveMountOptions {
  /** How long to observe after the page loads, in ms. Default 2000.
   *  Long enough for typical post-mount async (texture loads, ESM imports)
   *  to settle; short enough not to dominate the agent's iterate loop. */
  observationMs?: number;
}

/** Run the live-mount check against a card class directory. Returns
 *  { ok: true } if no runtime errors surfaced during the observation
 *  window; otherwise a VerifyResult with each problem listed. */
export async function runLiveMount(
  classDir: string,
  opts: LiveMountOptions = {},
): Promise<VerifyResult> {
  const t0 = Date.now();
  const observationMs = opts.observationMs ?? 2000;
  const shortDir = classDir.replace(/^.*\//, "");
  console.log(`[live-mount:${shortDir}] start`);

  // Read card sources via the shared loader (used by cardIntrospect too).
  // Any missing required file → can't mount; treat as a skip so we don't
  // refuse render_capture on a half-built class.
  const sources = await loadCardMountSources(classDir);
  if (!sources) {
    console.log(`[live-mount:${shortDir}] skip (missing card.js or card.html)`);
    return { ok: true };
  }
  const cardJsPath = join(classDir, "card.js");  // used below for problem.file
  const pageHtml = buildMountPage(sources);

  // Browser + context. If Chromium isn't installed, swallow and return
  // a skip — the agent shouldn't be blocked because dev-tooling isn't set
  // up. Log once so the operator knows the check isn't running.
  let browser;
  try {
    browser = await getBrowser();
  } catch (err) {
    if (!loggedMissingBrowser) {
      console.warn(`[live-mount:${shortDir}] Chromium unavailable, live-mount check is a no-op: ${(err as Error).message}`);
      loggedMissingBrowser = true;
    }
    return { ok: true };
  }
  console.log(`[live-mount:${shortDir}] browser ready (+${Date.now() - t0}ms), mounting`);

  const ctx = await browser.newContext();
  const tab = await ctx.newPage();

  const pageErrors:    string[] = [];
  const consoleErrors: string[] = [];
  const failedReqs:    { url: string; reason: string }[] = [];

  tab.on("pageerror", (err) => {
    pageErrors.push(err.message);
  });
  tab.on("console", (msg) => {
    if (msg.type() === "error") {
      // Filter out the noisy "Failed to load resource" lines that Chromium
      // emits for every requestfailed — we capture those separately and
      // double-reporting clutters the agent's tool result. Real swallowed
      // errors (the orbit200 case) come through with rich text.
      const text = msg.text();
      if (/Failed to load resource/i.test(text)) return;
      consoleErrors.push(text);
    }
  });
  tab.on("requestfailed", (req) => {
    failedReqs.push({
      url: req.url(),
      reason: req.failure()?.errorText ?? "unknown",
    });
  });

  try {
    // setContent with `waitUntil: "load"` waits for the load event, then we
    // sit for observationMs more. Most card runtime errors fire during init
    // or shortly after — texture loads, ESM resolution, etc.
    await tab.setContent(pageHtml, { waitUntil: "load", timeout: 10_000 });
    await tab.waitForTimeout(observationMs);

    // Also drain any errors the in-page catch recorded (e.g. wrap throws
    // synchronously before any error handler is attached).
    const shimErrors: string[] = await tab.evaluate(() => {
      // @ts-expect-error — injected by buildMountPage
      return Array.isArray(window.__shimErrors) ? window.__shimErrors : [];
    });
    for (const e of shimErrors) consoleErrors.push(e);
  } catch (err) {
    // setContent or evaluate threw — treat as a hard failure of the mount.
    pageErrors.push(`mount harness failed: ${(err as Error).message}`);
  } finally {
    await ctx.close().catch(() => { /* already closed */ });
  }

  const problems: VerifyProblem[] = [];
  for (const msg of pageErrors) {
    problems.push({
      file: cardJsPath,
      problem: `Uncaught error during mount: ${msg}`,
      fix_hint:
        "The card threw at mount time. Common causes: bare-specifier import (use `/+esm` on jsdelivr CDN URLs), " +
        "a library API used wrong (e.g. `new THREE.OrbitControls(...)` when OrbitControls must be imported from " +
        "the addons path), null-deref on a DOM query that returns null. Read the stack, fix the line, retry.",
    });
  }
  for (const msg of consoleErrors) {
    problems.push({
      file: cardJsPath,
      problem: `Console error during mount: ${msg}`,
      fix_hint:
        "Something in init failed and was logged but not rethrown — likely a defensive try/catch swallowed it. " +
        "Look at the message: if it's an import / fetch / library-init failure, fix the root cause rather than " +
        "letting the catch hide it. A card that needs to silently log on init should still throw if init can't proceed.",
    });
  }
  for (const r of failedReqs) {
    problems.push({
      file: cardJsPath,
      problem: `Network request failed: ${r.url} (${r.reason})`,
      fix_hint:
        "The URL did not load. Common: 404 (path / version wrong), CORS blocked (use a CDN that serves `*`), " +
        "or the URL is a source-style ESM (`import 'three'` inside) that the browser can't resolve. For jsdelivr " +
        "ESM addon paths (Three.js examples/jsm/...), append `/+esm` so jsdelivr pre-bundles bare specifiers.",
    });
  }

  const elapsed = Date.now() - t0;
  if (problems.length === 0) {
    console.log(`[live-mount:${shortDir}] PASS (${elapsed}ms)`);
    return { ok: true };
  }
  console.log(`[live-mount:${shortDir}] FAIL (${elapsed}ms, ${problems.length} problem${problems.length === 1 ? "" : "s"}): ${problems[0].problem.slice(0, 120)}`);
  return { ok: false, verifier: "card-live-mount", problems };
}

let loggedMissingBrowser = false;

/** Source bundle for a card class — what `buildMountPage` needs as input.
 *  Shared between the live-mount verifier (cardLiveMount.ts) and the
 *  introspection-for-text-LLM path (cardIntrospect.ts) so both mount the
 *  card exactly the same way. */
export interface CardMountSources {
  cardHtml: string;
  cardJs: string;
  cardCss: string;
  shim: string;
  depScripts: string[];
  depStyles: string[];
}

/** Load every file the headless mount needs from a card-class directory:
 *  card.html / card.js / card.css plus dependencies.scripts + .styles from
 *  metadata.json (the same shape CardRuntime injects). Returns null when
 *  card.html or card.js is missing — the caller treats that as a skip. */
export async function loadCardMountSources(classDir: string): Promise<CardMountSources | null> {
  const cardJsPath = join(classDir, "card.js");
  const cardHtmlPath = join(classDir, "card.html");
  const cardCssPath = join(classDir, "card.css");
  if (!existsSync(cardJsPath) || !existsSync(cardHtmlPath)) return null;
  const cardJs = await readFile(cardJsPath, "utf-8");
  const cardHtml = await readFile(cardHtmlPath, "utf-8");
  const cardCss = existsSync(cardCssPath) ? await readFile(cardCssPath, "utf-8") : "";
  const shim = await getCardShim();
  let depScripts: string[] = [];
  let depStyles: string[] = [];
  const metaPath = join(classDir, "metadata.json");
  if (existsSync(metaPath)) {
    try {
      const meta = JSON.parse(await readFile(metaPath, "utf-8")) as {
        dependencies?: { scripts?: unknown; styles?: unknown };
      };
      const s = meta.dependencies?.scripts;
      const t = meta.dependencies?.styles;
      if (Array.isArray(s)) depScripts = s.filter((x): x is string => typeof x === "string");
      if (Array.isArray(t)) depStyles  = t.filter((x): x is string => typeof x === "string");
    } catch { /* malformed metadata.json — skip deps */ }
  }
  return { cardHtml, cardJs, cardCss, shim, depScripts, depStyles };
}

/** Build the self-contained page that mounts the card under a stub `mica`.
 *  Mirrors what CardRuntime.tsx injects when a card renders in the real
 *  host: same async-IIFE wrap, same `container` binding, plus a minimal
 *  shim that records `mica.*` calls without actually opening channels.
 *  Exported so cardIntrospect can mount the card with the exact same
 *  semantics as the live-mount verifier — same shim, same error-collection
 *  globals, same async-IIFE wrap. */
export function buildMountPage(p: CardMountSources): string {
  // The wrapped form is identical to CardRuntime.tsx's: async IIFE with
  // (mica, _c) parameters, CARD_SHIM prepended, trailing \n before the
  // closing }) — same shape the wrapper-parse verifier checks.
  //
  // The outer try/catch records any synchronous wrap failure into the
  // global __shimErrors array; the in-page Playwright listener reads it
  // back after the observation window. Async failures inside the IIFE
  // surface as pageerror via the unhandled-promise-rejection path.
  const wrappedCardJs =
    `(async function(mica,_c){${p.shim}${p.cardJs}\n})(window.mica, document.getElementById('container'))`;

  // Dependency tags. Styles can go anywhere; scripts must be sync (no
  // defer / async) and ordered BEFORE our card.js block so globals like
  // window.L are defined when card.js runs.
  const styleTags  = p.depStyles.map((href) => `<link rel="stylesheet" href="${escapeAttr(href)}">`).join("\n");
  const scriptTags = p.depScripts.map((src) => `<script src="${escapeAttr(src)}"></script>`).join("\n");

  return `<!doctype html>
<html><head>
<meta charset="utf-8">
<style>${p.cardCss}</style>
${styleTags}
</head><body>
<div id="container">${p.cardHtml}</div>
${scriptTags}
<script>
  window.__shimCalls = [];
  window.__shimErrors = [];
  // Channel stub: a Proxy that returns a no-op function for every
  // property access, so any channel method (onData, send, close, etc.)
  // doesn't throw at mount. The card's data flow won't actually work
  // (no responses come back), but init code that registers listeners
  // and then waits won't surface false-fail errors.
  function makeChannelStub() {
    return new Proxy({}, {
      get: function() { return function(){}; },
    });
  }
  window.mica = {
    openChannel: function(handler, args) {
      window.__shimCalls.push({ kind: "openChannel", handler: handler, args: args });
      return makeChannelStub();
    },
    onCapture: function() { window.__shimCalls.push({ kind: "onCapture" }); },
    onDestroy: function() { window.__shimCalls.push({ kind: "onDestroy" }); },
    on:        function(ev) { window.__shimCalls.push({ kind: "on", ev: ev }); },
    isSelfEcho: function() { return false; },
    getContent: function() { return ""; },
    setContent: function() {},
    log:       function() {},
  };
  // Any property of mica we forgot to define is a no-op function instead
  // of throwing — keeps verifier fidelity ahead of real-mica surface drift.
  window.mica = new Proxy(window.mica, {
    get: function(target, prop) {
      if (prop in target) return target[prop];
      return function(){};
    },
  });
  // Catch synchronous wrap failures (e.g. SyntaxError thrown by the
  // IIFE before any async work). Async rejections inside the IIFE
  // surface via window.onunhandledrejection → Playwright pageerror.
  window.addEventListener("unhandledrejection", function(ev) {
    window.__shimErrors.push("Unhandled rejection: " + (ev.reason && ev.reason.stack ? ev.reason.stack : String(ev.reason)));
  });
  try {
    ${wrappedCardJs};
  } catch (err) {
    window.__shimErrors.push("Wrap threw: " + (err && err.stack ? err.stack : String(err)));
  }
</script>
</body></html>`;
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}
