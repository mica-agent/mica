// CardRuntime — renders server-produced HTML inside a card.
// Provides the `mica` bridge (call, send, on, openChannel) for interactive cards.
// Card classes handle their own rendering (e.g., mermaid.js) via inline <script> blocks.

import { useEffect, useRef, useState } from "react";
// morphdom removed — innerHTML replacement is safer with React's lifecycle.
// TODO: Re-evaluate morphdom for preserving mounted library instances once
// we add proper lifecycle coordination between React and widget scripts.
import { getOrCreateBridge, windowId, on as onSocketEvent, type CanvasId } from "../api/micaSocket";
import { canonicalizeCardPath, canvasRelative, getCanvasRoot } from "../api/canvasPaths";
import { listenViaMediaRecorder, speakViaSynthesize } from "../api/voice";

interface CardDependencies {
  scripts?: string[];
  styles?: string[];
}

/**
 * Card runtime shim — injected before each card's inline script.
 *
 * Makes standard web patterns work inside cards:
 * - document.querySelector/getElementById → scoped to card container
 * - window.addEventListener('resize') → redirected to ResizeObserver on container
 * - setInterval/setTimeout/requestAnimationFrame → auto-cleaned on card destroy
 * - window.addEventListener (non-resize) → auto-cleaned on card destroy
 *
 * All overrides are IIFE-scoped (shadow globals via const/function declarations).
 * No global state is modified. Existing cards using container.querySelector still work.
 */
const CARD_SHIM = `
var container=_c;
var _cleanups=[];
// Auto-enable preserveDrawingBuffer on any WebGL context created in card
// scope. render_capture's html2canvas fallback calls canvas.toDataURL(),
// which returns blank for WebGL contexts unless the back buffer is
// preserved. Patching the prototype once (idempotent across re-mounts and
// cards on the same page) means WebGL cards capture out of the box —
// authors don't need to learn about onCapture or preserveDrawingBuffer
// for the common case. mica.onCapture remains the escape valve for cases
// this patch misses (OffscreenCanvas, WebGPU, pre-created contexts passed
// in via library config).
if(!HTMLCanvasElement.prototype._micaPreserveBufferPatched){
  var _origGetContext=HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext=function(type,options){
    if(type==='webgl'||type==='webgl2'||type==='experimental-webgl'){
      options=Object.assign({},options||{},{preserveDrawingBuffer:true});
    }
    return _origGetContext.call(this,type,options);
  };
  Object.defineProperty(HTMLCanvasElement.prototype,'_micaPreserveBufferPatched',{value:true,writable:false,enumerable:false,configurable:false});
}
var _origFetch=window.fetch.bind(window);
var fetch=function(input,init){
  init=init||{};
  var url=typeof input==='string'?input:(input&&input.url)||'';
  if(url.indexOf('/api/')===0||url.indexOf('api/')===0){
    var h=new Headers(init.headers||(typeof input!=='string'?input.headers:undefined));
    if(!h.has('X-Mica-Project'))h.set('X-Mica-Project',mica.project);
    init.headers=h;
  }
  return _origFetch(input,init);
};
var _rd=window.document;
var _origDAEL=_rd.addEventListener.bind(_rd);
var _origDREL=_rd.removeEventListener.bind(_rd);
// _docListenerMap tracks (originalFn -> wrappedFn) so the proxy's
// removeEventListener can find the wrapped function we actually
// registered. Without it, a card that does removeEventListener with
// the original fn would silently fail (we registered the wrapped form,
// not the bare fn). Cards rarely remove explicitly because cleanup
// auto-fires from mica.onDestroy, but the path needs to work for the
// ones that DO.
var _docListenerMap=new Map();
var document=new Proxy(_rd,{get:function(t,p){
  if(p==='querySelector')return function(s){return _c.querySelector(s)};
  if(p==='querySelectorAll')return function(s){return _c.querySelectorAll(s)};
  if(p==='getElementById')return function(id){return _c.querySelector('#'+CSS.escape(id))};
  if(p==='addEventListener')return function(evt,fn,o){
    // Wrap + register + push a cleanup so document-level listeners
    // auto-detach on card unmount. Without this, cards that did
    // document.addEventListener directly leaked across re-renders /
    // unmounts; pressing a key fired stale handlers from cards that
    // no longer existed on the canvas. Parallel to the window
    // .addEventListener wrap below.
    var w=_runCb(fn);
    _docListenerMap.set(fn,w);
    _origDAEL(evt,w,o);
    _cleanups.push(function(){_origDREL(evt,w,o);_docListenerMap.delete(fn);});
  };
  if(p==='removeEventListener')return function(evt,fn,o){
    var w=_docListenerMap.get(fn);
    if(w){_origDREL(evt,w,o);_docListenerMap.delete(fn);}
    else{_origDREL(evt,fn,o);}
  };
  var v=t[p];return typeof v==='function'?v.bind(t):v;
}});
// _em: build an error-report string with both message AND stack. Chrome's
// stack starts with the message; Firefox's doesn't. Detect and avoid
// duplicating. Note: all escape sequences below use double-backslash so
// they survive interpolation into this template literal (single backslash
// would be processed at template-eval time, breaking the generated JS).
function _em(e){var m=(e&&e.message)||String(e);var s=e&&e.stack?String(e.stack):'';return s&&s.indexOf(m)>=0?s:(s?m+'\\n'+s:m)}
function _reportError(e){
  // Route through mica.reportError so the bridge handles the URL with the
  // proper project-relative filename. mica.filename is now canvas-relative
  // (no canvasRoot prefix) and would 404 the card-error endpoint.
  try{mica.reportError(_em(e));}catch(_){}
}
// _runCb: run a callback, reporting BOTH synchronous throws AND async
// rejections (when the callback is async and returns a Promise). Card
// authors routinely write async arrow fns as setTimeout / addEventListener
// callbacks; a sync try/catch would only see the pre-await part of those.
// This wrapper also chains a .catch on the returned Promise so post-await
// errors are reported too. Scoped to this card's shim (no window-level
// unhandledrejection listener needed, no cross-card fanout).
function _runCb(fn){return function(){try{var r=fn.apply(this,arguments);if(r&&typeof r.catch==='function')r.catch(_reportError);return r;}catch(e){_reportError(e)}}}
var _si=window.setInterval.bind(window),_st=window.setTimeout.bind(window);
var _ci=window.clearInterval.bind(window),_ct=window.clearTimeout.bind(window);
function setInterval(fn,ms){var id=_si(_runCb(fn),ms);_cleanups.push(function(){_ci(id)});return id}
function setTimeout(fn,ms){var id=_st(_runCb(fn),ms);_cleanups.push(function(){_ct(id)});return id}
function clearInterval(id){_ci(id)}
function clearTimeout(id){_ct(id)}
var _raf=window.requestAnimationFrame.bind(window),_caf=window.cancelAnimationFrame.bind(window);
var _lastRaf=0;
function requestAnimationFrame(fn){_lastRaf=_raf(_runCb(fn));return _lastRaf}
function cancelAnimationFrame(id){_caf(id)}
_cleanups.push(function(){_caf(_lastRaf)});
var _resizeCbs=[];
var _origAEL=window.addEventListener.bind(window);
var _origREL=window.removeEventListener.bind(window);
window.addEventListener=function(t,fn,o){
  var w=_runCb(fn);
  if(t==='resize'){_resizeCbs.push(w);return}
  _origAEL(t,w,o);_cleanups.push(function(){_origREL(t,w,o)});
};
var _ro=new ResizeObserver(function(){for(var i=0;i<_resizeCbs.length;i++){try{_resizeCbs[i]()}catch(e){}}});
_ro.observe(_c);
_cleanups.push(function(){_ro.disconnect()});
mica.onDestroy(function(){for(var i=0;i<_cleanups.length;i++){try{_cleanups[i]()}catch(e){}}});
`;


interface Props {
  html: string;
  exports?: string[];
  dependencies?: CardDependencies;
  /** Stable per-file UUID. Used to key the bridge cache and the channel
   *  session so two projects with the same template-seeded filename get
   *  distinct sessions. Caller must supply the file's `id` from /api/files. */
  sessionId: string;
  project: string;
  canvas: CanvasId;
  filename: string;
}

// Track globally loaded external scripts and stylesheets
const loadedExternalScripts = new Set<string>();
const loadedExternalStyles = new Set<string>();

// canvasPaths helpers (canvasRelative, canonicalizeCardPath, getCanvasRoot)
// live at src/api/canvasPaths.ts — shared with the React shell so card titles
// and other display surfaces use the same canvas-relative semantics. Cards
// see canvas-relative; the wire stays project-relative.

/** Load a script into <head> (deduplicated). Returns a promise that resolves when loaded. */
// Track in-flight script loads so concurrent callers wait on the same promise
const scriptLoadPromises = new Map<string, Promise<void>>();

function ensureScript(src: string, cardFilename?: string): Promise<void> {
  // Register this CDN URL against the card's filename so the global
  // window-error handler can route parse-time failures back to the right
  // card-error reporter. See ensureScriptErrorHandler for the why.
  if (cardFilename) registerScriptForCard(src, cardFilename);
  if (loadedExternalScripts.has(src)) return Promise.resolve();

  // If a load is already in-flight (e.g., StrictMode second run), wait for it
  const inflight = scriptLoadPromises.get(src);
  if (inflight) return inflight;

  const promise = new Promise<void>((resolve, reject) => {
    // Check if already in DOM and loaded
    const existing = document.querySelector(`script[src="${CSS.escape(src)}"]`) as HTMLScriptElement | null;
    if (existing) {
      // Script element exists — but is it loaded? Check if the global it provides is available.
      // Use a load event listener in case it's still loading.
      if (loadedExternalScripts.has(src)) {
        resolve();
        return;
      }
      existing.addEventListener("load", () => { loadedExternalScripts.add(src); resolve(); });
      existing.addEventListener("error", () => reject(new Error(`Failed to load ${src}`)));
      // If it already loaded (no event will fire), resolve after a tick
      if ((existing as HTMLScriptElement & { readyState?: string }).readyState === "complete" || existing.dataset.loaded) {
        loadedExternalScripts.add(src);
        resolve();
      }
      return;
    }

    const s = document.createElement("script");
    s.src = src;
    // Dynamically-created scripts default to async=true (executes whenever
    // its network completes, regardless of source order). Force false so
    // multi-script dependency ordering (e.g. THREE before OrbitControls)
    // is respected even if upstream code happens to insert them concurrently.
    s.async = false;
    s.onload = () => { loadedExternalScripts.add(src); s.dataset.loaded = "1"; resolve(); };
    s.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(s);
  });

  scriptLoadPromises.set(src, promise);
  promise.finally(() => scriptLoadPromises.delete(src));
  return promise;
}

/** Load a stylesheet into <head> (deduplicated). Returns a promise that resolves when CSS is applied. */
function ensureStyle(href: string): Promise<void> {
  if (loadedExternalStyles.has(href)) return Promise.resolve();
  const existing = document.querySelector(`link[href="${CSS.escape(href)}"]`) as HTMLLinkElement | null;
  if (existing) {
    if (existing.sheet) {
      loadedExternalStyles.add(href);
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      existing.addEventListener("load", () => { loadedExternalStyles.add(href); resolve(); });
      existing.addEventListener("error", () => { loadedExternalStyles.add(href); resolve(); });
    });
  }
  return new Promise<void>((resolve) => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    link.onload = () => { loadedExternalStyles.add(href); resolve(); };
    link.onerror = () => { loadedExternalStyles.add(href); resolve(); };
    document.head.appendChild(link);
  });
}

/**
 * Wait for CSS rules to be applied to the DOM. Stylesheet downloads complete
 * before the browser has parsed and applied the rules. This function waits
 * for rendering frames to ensure styles are active before scripts run.
 */
function waitForStyleApplication(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

// ── Card-scoped unhandled-promise-rejection handling ──────────────
//
// The card-shim's `_runCb` catches sync throws + async rejections inside the
// callbacks Mica wraps (setTimeout, setInterval, RAF, window/document
// addEventListener). It does NOT cover:
//   - DOM event handlers on elements inside the card (`btn.addEventListener`)
//   - Top-level promises (`let p = render()` at module scope)
//   - any other path where a rejected Promise escapes without a .catch
//
// Each card's script tag gets a unique sourceURL containing the card's
// filename. The module-level handler below listens once for unhandled
// rejections at the window level, parses the stack to find a card-class
// filename, and routes the error to that card's reportError.
//
// The Map's values are weak references (well, just regular references; cards
// remove themselves on unmount). If a rejection's stack matches no registered
// card (e.g. the card was destroyed before its promise settled, or the error
// originated in framework code), the rejection is logged to console with a
// Mica prefix and otherwise allowed to bubble — exact prior behavior.
type Reporter = (msg: string) => void;
const cardErrorReporters = new Map<string, Reporter>();

// Fallback attribution for unhandled rejections whose stack doesn't match
// any registered `mica-card://<filename>/` sourceURL. Common case: an
// `await import(cdnUrl)` whose imported module throws at module-load time
// (e.g. bare-specifier failures like `import * as THREE from 'three'`).
// The rejection's stack frames point at the CDN URL, not at card.js — so
// stack-match attribution fails and the error never reaches the card's
// error reporter (→ never broadcasts → render_capture's error buffer
// stays empty → verdict bypasses ERRORS → agent misdiagnoses).
//
// We track the most recently registered card; if a rejection lands within
// FALLBACK_WINDOW_MS of that registration and no stack match found, we
// attribute to it. False positives are possible (rare: card A and B both
// just loaded, A throws, gets attributed to whichever was registered last),
// but every miss currently goes to console.warn — better to attribute to
// one card than to drop entirely.
let lastInjectedCard: { filename: string; ts: number } | null = null;
const FALLBACK_WINDOW_MS = 60_000;

function sourceUrlForCard(filename: string): string {
  // URL-safe slug that includes the filename for stack-trace attribution.
  // Browsers display `//# sourceURL=` text verbatim in stack frames.
  return `mica-card://${encodeURIComponent(filename)}/card.js`;
}

// ── Script-load parse-error attribution ───────────────────────────
//
// A <script> element's onerror fires for NETWORK failures only (404,
// blocked, DNS). When the script downloads with 200 OK but then fails
// to PARSE (e.g. SyntaxError because the bundle is ESM-only and we
// loaded it as a classic script), the load resolves as success and the
// parse error fires on `window` as an `error` event — not on the
// script tag. Without a global error listener, Mica's card-error
// pipeline never sees these failures; the user has to manually paste
// the browser console into chat. The map + handler below catch them.
//
// Attribution: when a card declares `dependencies.scripts`, each URL is
// registered against the card's filename in `scriptUrlToCards`. When
// the window error event fires, its `filename` field is the URL of the
// failing script; we look it up in the map and route to every card
// that depends on it (typically just one). Cleanup happens at unmount
// via `unregisterCardFromScripts`.
const scriptUrlToCards = new Map<string, Set<string>>();

function registerScriptForCard(src: string, filename: string): void {
  let set = scriptUrlToCards.get(src);
  if (!set) {
    set = new Set();
    scriptUrlToCards.set(src, set);
  }
  set.add(filename);
}

function unregisterCardFromScripts(filename: string): void {
  for (const [src, set] of scriptUrlToCards) {
    set.delete(filename);
    if (set.size === 0) scriptUrlToCards.delete(src);
  }
}

let scriptErrorHandlerInstalled = false;
function ensureScriptErrorHandler(): void {
  if (scriptErrorHandlerInstalled) return;
  scriptErrorHandlerInstalled = true;
  // capture=true is REQUIRED. Script-load errors (parse failures, runtime
  // throws inside a CDN script's top-level code) fire on the target element,
  // not on window — they don't bubble. The capture phase reaches them on the
  // way DOWN to the target, which is the only way to observe them at window
  // level. Without capture=true the handler never fires for CDN parse errors.
  window.addEventListener("error", (event) => {
    const errFilename = event.filename || "";
    if (!errFilename) return; // "Script error." (CORS-redacted); no info to route
    const cards = scriptUrlToCards.get(errFilename);
    if (!cards || cards.size === 0) return; // not one of our CDN scripts
    const where = event.lineno
      ? ` (line ${event.lineno}${event.colno ? ":" + event.colno : ""})`
      : "";
    const msg = `Script error in ${errFilename}${where}: ${event.message || "<no message>"}`;
    for (const cardFilename of cards) {
      const reporter = cardErrorReporters.get(cardFilename);
      if (reporter) {
        try { reporter(msg); } catch { /* swallow */ }
      }
    }
  }, true);
}

// Install the global handler exactly once.
let unhandledRejectionInstalled = false;
function ensureUnhandledRejectionHandler(): void {
  if (unhandledRejectionInstalled) return;
  unhandledRejectionInstalled = true;
  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason as { message?: string; stack?: string } | string | undefined;
    const message = typeof reason === "string"
      ? reason
      : (reason && reason.message) || String(reason);
    const stack = typeof reason === "object" && reason && reason.stack ? reason.stack : "";
    const full = stack && stack.indexOf(message) >= 0 ? stack : (stack ? `${message}\n${stack}` : message);

    // Attribute by matching the sourceURL prefix in the stack.
    let matched = false;
    for (const [filename, reporter] of cardErrorReporters) {
      if (stack.includes(`mica-card://${encodeURIComponent(filename)}/`)) {
        try { reporter(`Uncaught (in promise): ${full}`); } catch { /* swallow */ }
        matched = true;
        break;  // attribute to one card; an error genuinely in shared code
                // would match the FIRST registered card, which is acceptable
                // (rare) noise vs missing the error entirely.
      }
    }
    // Fallback: if stack-match found nothing AND a card was registered recently,
    // attribute to it. Catches the common case of `await import(cdnUrl)` whose
    // imported module throws at load time — the rejection's stack frames are
    // all inside the CDN module file and never mention the card's sourceURL,
    // so stack-match misses. The most recently injected card is the likely
    // owner since these rejections fire during init.
    if (!matched && lastInjectedCard && Date.now() - lastInjectedCard.ts < FALLBACK_WINDOW_MS) {
      const reporter = cardErrorReporters.get(lastInjectedCard.filename);
      if (reporter) {
        try { reporter(`Uncaught (in promise, attributed by recency): ${full}`); } catch { /* swallow */ }
        matched = true;
      }
    }
    if (!matched) {
      console.warn("[mica-card] uncaught promise rejection with no card attribution:", full);
    }
  });
}

export default function CardRuntime({ html, exports: exportFns, dependencies, sessionId, project, canvas, filename }: Props) {
  const outerRef = useRef<HTMLDivElement>(null);
  const widgetRef = useRef<HTMLDivElement>(null);
  // Bridge is keyed on (project, canvas, filename) and lives in a module-level
  // cache. Survives React remounts (StrictMode double-mount, parent re-render
  // forcing unmount/remount, key changes). Destroy is driven by file lifecycle
  // (file-deleted event in CanvasCardRuntime calls `destroyBridgeFor`), not by
  // React unmount — sessions belong to files, not to component instances.
  const bridge = getOrCreateBridge(sessionId, project, canvas, filename);
  const activeCallsRef = useRef(0);
  const [loadingDeps, setLoadingDeps] = useState(false);

  // Visible error overlay — surfaces card-error broadcasts as a red banner
  // ON the card itself. Two purposes:
  //   1. User sees the failure spatially co-located with what's broken
  //      (no need to look at separate chat-card bubbles).
  //   2. render_capture's html2canvas pass picks up the banner; the agent's
  //      caption then describes "card has a red error banner reading X" —
  //      which means the error reaches the agent through the same visual
  //      feedback channel as everything else, no separate prompt-injection
  //      mechanism needed.
  // Cleared automatically when the card class is rewritten (mtime change →
  // CardRuntime re-renders → effect below resets) or when the user dismisses.
  const [currentError, setCurrentError] = useState<string | null>(null);

  // Subscribe to card-error events for THIS card's filename. The server
  // broadcasts a card-error every time `mica.reportError` fires (or a card.js
  // throw is caught) — we filter by filename so each card only shows its own
  // errors. Note the filename match is project-relative (server uses the
  // path POSTed by reportError, which is the React closure's `filename`,
  // already project-relative).
  useEffect(() => {
    const unsub = onSocketEvent("card-error", (data) => {
      const evt = data as { filename?: string; error?: string };
      if (evt && evt.filename === filename && typeof evt.error === "string") {
        setCurrentError(evt.error);
      }
    });
    return unsub;
  }, [filename]);

  // Clear the error banner when the server confirms this card now renders
  // cleanly. Server fires `card-error-cleared` after the card POSTs /ok
  // (successful mount with no throw). The banner persists across the
  // agent's edit-and-retry cycle until that signal lands — important
  // because render_capture's screenshot must capture the banner while the
  // card is still erroring. An optimistic clear on `[html]` changes would
  // race the screenshot: agent edits → html prop changes → banner clears
  // → screenshot captures cleared state → vision caption misses the error
  // → agent flies blind. Wait for the explicit success milestone instead.
  useEffect(() => {
    const unsub = onSocketEvent("card-error-cleared", (data) => {
      const evt = data as { filename?: string };
      if (evt && evt.filename === filename) {
        setCurrentError(null);
      }
    });
    return unsub;
  }, [filename]);

  // Render on mount or when html changes. Re-injects HTML and re-executes scripts.
  // Does NOT destroy sessions — channels survive via bridge dedup.
  useEffect(() => {
    const el = widgetRef.current;
    if (!el) return;

    // ── Phase 0: Resolve canvasRoot for path canonicalization ──
    // Cards address files canvas-relative; CardRuntime translates to
    // project-relative before HTTP. canvasRoot is fetched once per project
    // and cached for subsequent cards. Awaited before continueRender() so
    // mica.filename and the files API are correct from script-start.
    const canvasRootPromise = getCanvasRoot(project);

    // ── Phase 1: Preload declared dependencies ──────────────────
    // If the card class declared `export const dependencies`, load them
    // BEFORE injecting the HTML. This guarantees scripts and styles are
    // available and applied when inline <script> blocks execute.
    const declaredScripts = dependencies?.scripts || [];
    const declaredStyles = dependencies?.styles || [];

    const preloadDeps = async () => {
      // Load all declared styles in parallel (CSS load order doesn't matter —
      // CSSOM merges rules regardless of arrival order).
      await Promise.all(declaredStyles.map(ensureStyle));
      // Load declared scripts SEQUENTIALLY — order matters when scripts have
      // dependencies (e.g., OrbitControls.js requires `window.THREE` to be
      // defined first). Promise.all would race them, leading to
      // "Can't find variable: THREE" when the dependent script's network
      // completes before its dependency's. Sequential = source-order = the
      // contract card-class authors expect.
      for (const src of declaredScripts) {
        await ensureScript(src, filename);
      }
      // Wait for CSS rules to be fully applied
      if (declaredStyles.length > 0) {
        await waitForStyleApplication();
      }
    };

    // POST CDN/dependency load failures to /api/cards/:filename/error so the
    // chat card can surface them with a "Ask agent to fix" button. Same endpoint
    // the CARD_SHIM uses for script throws — gives the agent a uniform signal.
    const reportLoadError = (err: unknown) => {
      const msg = (err as Error)?.message || String(err);
      fetch(`/api/cards/${encodeURIComponent(filename)}/error`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Mica-Project": project },
        body: JSON.stringify({ error: `Failed to load dependency: ${msg}` }),
      }).catch(() => { /* best-effort; chat-card surfacing isn't critical-path */ });
    };

    const continueRender = (canvasRoot: string) => {
      // ── Phase 2: Inject HTML ──────────────────────────────────
      el.innerHTML = html;

      // Keyboard isolation: stop key events from bubbling out of this card.
      // Prevents one card's keyboard handler from interfering with others.
      // Uses bubble phase so card-internal document.addEventListener still works.
      el.addEventListener("keydown", (e: Event) => e.stopPropagation());
      el.addEventListener("keyup", (e: Event) => e.stopPropagation());
      el.addEventListener("keypress", (e: Event) => e.stopPropagation());

      // ── Phase 3: Process inline dependencies from HTML ────────
      // Handle <link> and <script src> tags that weren't declared
      // via the dependencies export (legacy / inline approach).
      const cssLoads: Promise<void>[] = [];
      el.querySelectorAll('link[rel="stylesheet"]').forEach((link) => {
        const href = link.getAttribute("href");
        if (href) cssLoads.push(ensureStyle(href));
        link.remove();
      });

      // Use the stable bridge from the ref (created once per component instance)
      const baseBridge = bridge;

      // Provide the refresh implementation — re-fetches content and re-executes scripts
      baseBridge._setRefreshFn(async () => {
        // Re-fetch file content
        if (filename && filename !== "__canvas__") {
          try {
            const res = await fetch(`/api/files/${encodeURIComponent(filename)}`, { headers: { "X-Mica-Project": project } });
            _cachedContent = res.ok ? await res.text() : "";
          } catch { _cachedContent = ""; }
        }

        // Re-inject original HTML and re-execute scripts with updated content
        if (el) {
          el.innerHTML = html;
          const scripts = Array.from(el.querySelectorAll("script"));
          scripts.forEach((oldScript) => {
            if (oldScript.getAttribute("src")) { oldScript.remove(); return; }
            const newScript = document.createElement("script");
            // Refresh path (mica.refresh() re-runs). Same error contract
            // as the initial script: chain reporting off the async
            // IIFE's promise so post-await rejections reach the server.
            // Outer .catch grabs both message AND stack — without the stack,
            // the agent has no file:line and has to grep the whole card.
            newScript.textContent =
              `(function(){` +
              `const _m=document.currentScript.__mica;` +
              `(async function(mica,_c){${CARD_SHIM}${oldScript.textContent}})(` +
              `_m,document.currentScript.parentElement)` +
              `.catch(function(e){` +
              `console.error("[card-runtime] Script error in ${filename}:",e);` +
              // Route through the bridge so the proper project-relative filename
              // is used for the URL (mica.filename is canvas-relative now).
              `try{` +
              `var _m1=(e&&e.message)||String(e);` +
              `var _s1=e&&e.stack?String(e.stack):'';` +
              `_m.reportError(_s1&&_s1.indexOf(_m1)>=0?_s1:(_s1?_m1+'\\n'+_s1:_m1));` +
              `}catch(_){}` +
              `});` +
              `})()` +
              `\n//# sourceURL=${sourceUrlForCard(filename)}`;
            oldScript.remove();
            (newScript as unknown as Record<string, unknown>).__mica = micaBridge;
            // Wrap appendChild in try/catch: if card.js has a syntax error,
            // Chrome throws SyntaxError from appendChild ("Failed to execute
            // 'appendChild' on 'Node': Invalid or unexpected token"). Without
            // this guard the error propagates up to the React render loop
            // and breaks the page. POST it to /error so the agent sees it
            // the same way it sees runtime errors. Mirrors the safety net
            // in executeInlineScripts (the initial-mount path).
            try {
              el.appendChild(newScript);
            } catch (parseErr) {
              const msg = (parseErr as Error)?.message || String(parseErr);
              console.error(`[card-runtime] Refresh-path parse failed in ${filename}:`, parseErr);
              fetch(`/api/cards/${encodeURIComponent(filename)}/error`, {
                method: "POST",
                headers: { "Content-Type": "application/json", "X-Mica-Project": project },
                body: JSON.stringify({
                  error: `card.js fails to parse at mount: ${msg}. The script wrapper rejected it before any code ran. Common causes: top-level \`export\`/\`import\`, unbalanced braces, accidentally pasted non-JS content. Mica wraps card.js in \`(async function(mica,_c){…})()\` — the file must be valid as a function body.`,
                }),
              }).catch(() => {});
            }
          });
        }
      });

      // Content fetch — starts immediately, cards access via mica.getContent()
      let _cachedContent: string | null = null;
      const _contentPromise: Promise<string> = (filename && filename !== "__canvas__")
        ? fetch(`/api/files/${encodeURIComponent(filename)}`, { headers: { "X-Mica-Project": project } })
            .then(r => r.ok ? r.text() : "")
            .then(c => { _cachedContent = c; return c; })
            .catch(() => { _cachedContent = ""; return ""; })
        : Promise.resolve("");

      // High-level helpers for card authors. Covers the common Mica endpoints
      // so cards don't need to construct URLs, remember field names, or handle
      // the `source` field for writes. Prefer these over raw `fetch()` in cards.
      const projectHeaders = (extra?: HeadersInit): HeadersInit => {
        const h = new Headers(extra);
        if (!h.has("X-Mica-Project")) h.set("X-Mica-Project", project);
        return h;
      };

      // Fire-and-forget error report to the server. Chat cards listen for the
      // resulting `card-error` broadcast and render a "Ask agent to fix" bubble.
      // Runs OUTSIDE CARD_SHIM's fetch wrapper — uses window.fetch directly
      // with an explicit X-Mica-Project header. Never throws; errors during
      // reporting are swallowed.
      const reportError = (message: string): void => {
        try {
          fetch(`/api/cards/${encodeURIComponent(filename)}/error`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Mica-Project": project },
            body: JSON.stringify({ error: message }),
          }).catch(() => {});
        } catch {
          /* best-effort */
        }
      };

      // Register this card with the module-level error-reporter registry +
      // ensure the window-level unhandledrejection handler is installed.
      // The handler at the top of this file matches uncaught rejections to
      // a card via stack-trace sourceURL inspection.
      ensureUnhandledRejectionHandler();
      ensureScriptErrorHandler();
      cardErrorReporters.set(filename, reportError);
      // Update lastInjectedCard so the unhandledrejection handler can fall
      // back to this card if a rejection's stack doesn't match any registered
      // mica-card:// sourceURL (e.g. await import(cdnUrl) failures whose
      // stack frames are all inside the imported module).
      lastInjectedCard = { filename, ts: Date.now() };

      // Wrap a namespace object so unknown method access returns a helpful
      // shadow function that (when called) reports the hallucination to the
      // server AND throws a descriptive error listing the real methods.
      //
      // Why this exists: agents regularly invent methods like
      // `mica.files.append(...)` that don't exist. Without a guard, the call
      // throws `TypeError: ... is not a function` — opaque, and if the card's
      // own try/catch displays a local toast, the chat never sees the error
      // so the user has to manually describe it to the agent. The Proxy turns
      // every hallucinated call into (1) a detailed TypeError with a
      // "known methods" list and (2) a chat-surfacing card-error report.
      //
      // Property READ returns a shadow function — not a throw — so existence
      // checks like `if (mica.files.futureThing)` stay safe (function is
      // truthy). The throw only happens when the shadow is CALLED, matching
      // native JS behaviour: `obj.missing` returns undefined; `obj.missing()`
      // throws.
      const guardNamespace = <T extends object>(target: T, name: string): T => {
        const known = Object.keys(target).join(", ");
        return new Proxy(target, {
          get(t, prop, receiver) {
            if (prop in t || typeof prop === "symbol") return Reflect.get(t, prop, receiver);
            const propName = String(prop);
            return function hallucinatedMethod(): never {
              const msg = `mica.${name} has no method '${propName}'. Known: ${known}.`;
              reportError(msg);
              throw new TypeError(msg);
            };
          },
          has(t, prop) {
            return prop in t;
          },
        });
      };

      // Canonicalize a card-supplied path (canvas-relative, with `..` and `/`
      // escapes) to the project-relative path the server expects on the wire.
      // See canonicalizeCardPath at module level for the rules. Throws if the
      // resolved path escapes projectDir — caller's mica.files.* call rejects.
      const canon = (p: string): string => canonicalizeCardPath(p, canvasRoot);

      const files = {
        /** List CANVAS files only — direct children of canvasRoot plus any
         *  pinned files. Returned `path` values are canvas-relative (bare names
         *  for files inside canvas, `../foo` for pinned files outside). Pass
         *  the returned path back to `mica.files.read` directly without any
         *  prefix juggling.
         *
         *  For project-wide listing (rare — debug/audit cards), see `listAll`. */
        async list(): Promise<Array<{ path: string; isFile: boolean; isFolder: boolean; size: number; modifiedAt: string }>> {
          const r = await fetch("/api/files?canvas=true", { headers: projectHeaders() });
          if (!r.ok) throw new Error(`mica.files.list: HTTP ${r.status}`);
          const raw = (await r.json()) as Array<{ name: string; type: string; size: number; modifiedAt: string }>;
          return raw.map((f) => ({
            path: canvasRelative(f.name, canvasRoot),
            isFile: f.type === "file",
            isFolder: f.type === "directory",
            size: f.size,
            modifiedAt: f.modifiedAt,
          }));
        },
        /** Project-wide listing — includes files outside the canvas
         *  (`.mica/`, `.qwen/`, `.claude/`, project-root configs, etc.).
         *  Most cards want `list()`; reach for this only when you need
         *  visibility beyond the canvas (debug cards, repo browsers).
         *  Returned `path` values are canvas-relative (with `../` prefix
         *  for files outside canvas), so they round-trip through `read`.
         *
         *  `opts.showHidden`: when true, reveals dot-prefixed entries
         *  (`.mica/`, `.qwen/`, `.claude/`). Build-noise dirs like
         *  `.git/`, `.next/`, `node_modules/` stay filtered regardless.
         *  Default false (matches the historical filter shape). */
        async listAll(opts: { showHidden?: boolean } = {}): Promise<Array<{ path: string; isFile: boolean; isFolder: boolean; size: number; modifiedAt: string }>> {
          const url = opts.showHidden ? "/api/files?showHidden=true" : "/api/files";
          const r = await fetch(url, { headers: projectHeaders() });
          if (!r.ok) throw new Error(`mica.files.listAll: HTTP ${r.status}`);
          const raw = (await r.json()) as Array<{ name: string; type: string; size: number; modifiedAt: string }>;
          // Project-wide listing returns raw PROJECT-RELATIVE paths (canvas-
          // relative is meaningless when the listing spans canvas + outside).
          // Callers that want to read a file via mica.files.read() should prefix
          // the path with "/" — the project-root-absolute escape handled by canon.
          return raw.map((f) => ({
            path: f.name,
            isFile: f.type === "file",
            isFolder: f.type === "directory",
            size: f.size,
            modifiedAt: f.modifiedAt,
          }));
        },
        /** Read a text file. Path is canvas-relative — bare names resolve
         *  against canvasRoot; `../foo` escapes one level above canvas;
         *  `/foo` is a project-root absolute. */
        async read(path: string): Promise<string> {
          const p = canon(path);
          const r = await fetch(`/api/files/${encodeURIComponent(p)}`, { headers: projectHeaders() });
          if (!r.ok) throw new Error(`mica.files.read(${path}): HTTP ${r.status}`);
          return r.text();
        },
        /** Read a binary file as ArrayBuffer. Path is canvas-relative. */
        async readBinary(path: string): Promise<ArrayBuffer> {
          const p = canon(path);
          const r = await fetch(`/api/files/${encodeURIComponent(p)}`, { headers: projectHeaders() });
          if (!r.ok) throw new Error(`mica.files.readBinary(${path}): HTTP ${r.status}`);
          return r.arrayBuffer();
        },
        /** Write a file. Path is canvas-relative. Accepts text or binary.
         *  `source: mica.windowId` is auto-injected so file-changed events
         *  don't echo back to this card. Parents auto-created. Binary writes
         *  stream to disk (no size limit, constant memory). */
        async write(
          path: string,
          content: string | ArrayBuffer | ArrayBufferView | Blob,
        ): Promise<void> {
          const p = canon(path);
          if (typeof content === "string") {
            const r = await fetch(`/api/files/${encodeURIComponent(p)}`, {
              method: "PUT",
              headers: projectHeaders({ "Content-Type": "application/json" }),
              // Send both: `source` (windowId) for backward compat with existing
              // cards that filter on mica.windowId, and `cardSource` (per-card
              // UUID) for sibling-friendly self-echo via mica.isSelfEcho().
              body: JSON.stringify({ content, source: windowId, cardSource: sessionId }),
            });
            if (!r.ok) throw new Error(`mica.files.write(${path}): HTTP ${r.status}`);
          } else {
            const url = `/api/files/${encodeURIComponent(p)}/upload?source=${encodeURIComponent(windowId)}&cardSource=${encodeURIComponent(sessionId)}`;
            const body = content instanceof Blob
              ? content
              : (content instanceof ArrayBuffer ? content : content.buffer);
            const r = await fetch(url, { method: "POST", body: body as BodyInit, headers: projectHeaders() });
            if (!r.ok) throw new Error(`mica.files.write(${path}): HTTP ${r.status}`);
          }
        },
        /** Delete a file. Path is canvas-relative. */
        async delete(path: string): Promise<void> {
          const p = canon(path);
          const r = await fetch(`/api/files/${encodeURIComponent(p)}`, { method: "DELETE", headers: projectHeaders() });
          if (!r.ok && r.status !== 404) throw new Error(`mica.files.delete(${path}): HTTP ${r.status}`);
        },
        /** Build a URL for inline use (e.g. `<img src={mica.files.url("pic.png")}/>`).
         *  Path is canvas-relative. Includes `?project=` so the URL works in
         *  contexts that can't send the `X-Mica-Project` header (window.open
         *  new tabs, <img src>, etc.). */
        url(path: string): string {
          const p = canon(path);
          return `/api/files/${encodeURIComponent(p)}?project=${encodeURIComponent(project)}`;
        },
      };

      const cardClasses = {
        /** List available card classes. */
        async list(): Promise<Array<{ name: string; builtIn: boolean; format: string }>> {
          const r = await fetch("/api/card-classes", { headers: projectHeaders() });
          if (!r.ok) throw new Error(`mica.cardClasses.list: HTTP ${r.status}`);
          const obj = (await r.json()) as Record<string, { builtIn: boolean; format: string }>;
          return Object.entries(obj).map(([name, meta]) => ({ name, builtIn: meta.builtIn, format: meta.format }));
        },
        /** Get the parsed metadata.json for a single card class. Returns the
         *  metadata object (extension, badge, defaultTitle, dependencies, etc.).
         *  Throws if the class doesn't exist or has no metadata.json. */
        async get(name: string): Promise<Record<string, unknown>> {
          const r = await fetch(`/api/card-classes/${encodeURIComponent(name)}/metadata.json`, { headers: projectHeaders() });
          if (!r.ok) throw new Error(`mica.cardClasses.get(${name}): HTTP ${r.status}`);
          return (await r.json()) as Record<string, unknown>;
        },
      };

      /** Canvas-state introspection. Pairs with `mica.on('layout-changed')`:
       *  the event tells you the layout moved; this function tells you what
       *  it moved TO. Returns the layout JSON for the current device class,
       *  shape: { cards: { [canvasRelPath]: { x, y, w, h } }, bounds?: { w, h } }.
       *  Cards reflecting on the canvas (overview, minimap, navigation,
       *  layout linters) use this. */
      async function readLayout(): Promise<{ cards: Record<string, { x: number; y: number; w: number; h: number }>; bounds?: { w: number; h: number } }> {
        const r = await fetch("/api/layout", { headers: projectHeaders() });
        if (!r.ok) throw new Error(`mica.layout: HTTP ${r.status}`);
        return (await r.json()) as { cards: Record<string, { x: number; y: number; w: number; h: number }>; bounds?: { w: number; h: number } };
      }

      // Card-facing filename is canvas-relative — no canvasRoot prefix.
      // Pinned files outside canvas surface with `../` escape (so the value
      // round-trips through mica.files.read). Self-reference becomes:
      //   await mica.files.read(mica.filename)
      // — no prefix juggling regardless of project's canvasRoot config.
      // The internal `filename` variable stays project-relative for
      // wire-format calls (reportError, content fetch).
      const cardFacingFilename = canvasRelative(filename, canvasRoot);

      // Wrap baseBridge.on so cards see canvas-relative `filename` fields in
      // event payloads — matches mica.filename. Without this, comparisons
      // like `event.filename === mica.filename` (used by every reactive card
      // class to filter its own file's events) silently break: event.filename
      // arrives project-relative from the server, mica.filename is now
      // canvas-relative. Translate at the bridge boundary so every card sees
      // a consistent canvas-relative world.
      //
      // ALSO routes sync throws AND async rejections from the card's callback
      // to reportError. mica.on callbacks were previously a gap in Mica's
      // error coverage: the script-shim's `_runCb` wraps setTimeout / setInterval
      // / addEventListener but not bridge subscriptions. Cards that do
      // `mica.on('file-changed', async (e) => render())` would silently drop
      // any render error to "Uncaught (in promise)" in DevTools — the chat
      // saw nothing. Now every mica.on cb gets the same treatment.
      const wrapCbForErrors = (cb: (data: unknown) => void) => (data: unknown) => {
        try {
          const r = cb(data) as unknown;
          if (r && typeof (r as { catch?: (h: (e: unknown) => void) => unknown }).catch === "function") {
            (r as { catch: (h: (e: unknown) => void) => unknown }).catch((e: unknown) => {
              const msg = e instanceof Error ? (e.stack || e.message) : String(e);
              reportError(`Uncaught in mica.on('${cb.name || "<anonymous>"}'): ${msg}`);
            });
          }
        } catch (e) {
          const msg = e instanceof Error ? (e.stack || e.message) : String(e);
          reportError(`Threw in mica.on callback: ${msg}`);
        }
      };
      const wrappedOn = (eventName: string, cb: (data: unknown) => void): (() => void) => {
        return baseBridge.on(eventName, wrapCbForErrors((data: unknown) => {
          if (data && typeof data === "object" && "filename" in data) {
            const obj = data as Record<string, unknown>;
            const fn = obj.filename;
            if (typeof fn === "string") {
              cb({ ...obj, filename: canvasRelative(fn, canvasRoot) });
              return;
            }
          }
          cb(data);
        }));
      };

      const micaBridge = {
        ...baseBridge,
        project,
        canvas,
        filename: cardFacingFilename,
        windowId,
        on: wrappedOn,
        /** Per-card-instance UUID. Stable across reloads (sidecar in
         *  `.mica/cards/<sanitized>.id.json`); same UUID used as the channel
         *  session key. Use `mica.isSelfEcho(event)` to skip your own writes
         *  without suppressing sibling cards in the same browser tab. */
        cardId: sessionId,
        /** Returns true if `event` was caused by THIS card instance writing
         *  through `mica.files.write()`. Prefer this over comparing `event.source`
         *  to `mica.windowId` — windowId is per-tab, so the windowId comparison
         *  also suppresses writes from sibling cards in the same tab. */
        isSelfEcho(event: { cardSource?: string } | null | undefined): boolean {
          return Boolean(event && event.cardSource && event.cardSource === sessionId);
        },
        call: async (fn: string, args: Record<string, unknown> = {}) => {
          activeCallsRef.current++;
          try {
            return await baseBridge.call(fn, args);
          } finally {
            activeCallsRef.current--;
          }
        },
        refresh: baseBridge.refresh,
        exports: exportFns || [],
        /** Get the instance file content. Returns cached string or Promise. Use with await. */
        getContent: () => _cachedContent !== null ? _cachedContent : _contentPromise,
        files: guardNamespace(files, "files"),
        cardClasses: guardNamespace(cardClasses, "cardClasses"),
        /** Read the canvas's current layout for the current device class.
         *  Pairs with `mica.on('layout-changed')` — event signals change,
         *  this returns current state. See readLayout above for shape. */
        layout: readLayout,
        /** Speak `text` through the local Kokoro TTS sidecar. Resolves
         *  when playback ends; rejects with AbortError if `opts.signal`
         *  fires. Voice servers must be running (`/api/voice/status`).
         *  Cards typically wire this to a 🔊 toggle that auto-speaks
         *  agent replies. */
        speak: (text: string, opts: { voice?: string; signal?: AbortSignal } = {}): Promise<void> =>
          speakViaSynthesize(text, opts),
        /** Capture mic audio until `opts.releaseSignal` aborts, then
         *  POST to /api/voice/transcribe and return the transcript.
         *  Caller manages the AbortController (e.g. press-and-hold:
         *  `pointerdown` creates the controller, `pointerup` aborts it).
         *  Resolves with `transcript: ""` for sub-200ms recordings
         *  (accidental taps). */
        listen: (opts: { mode: "press-hold"; releaseSignal: AbortSignal; minDurationMs?: number }) =>
          listenViaMediaRecorder({
            releaseSignal: opts.releaseSignal,
            minDurationMs: opts.minDurationMs,
          }),
        /** Surface an error to chat. Chat cards listen for `card-error` and
         *  render a "Ask agent to fix" bubble with this message. Use inside
         *  try/catch when your card handles its own UI (e.g. a toast) but
         *  you also want the agent to know. Fire-and-forget; never throws. */
        reportError,
        /** Proxy HTTP request through the Mica server. The server enforces
         *  SSRF protection (resolves DNS, blocks private/loopback IPs), a
         *  per-project rate limit, a response-size cap, and redacts common
         *  secret patterns from its audit log. Returns a result object;
         *  NEVER rejects on upstream or our-side failure — upstream HTTP
         *  errors come back as `status`, and our-side failures come back
         *  with `status: 0` plus a structured `errorCode`/`error`. Always
         *  check `errorCode` first, then `status`, before reading `body`.
         *  Body is a string; call JSON.parse() yourself. */
        fetch: async (url: string, opts: {
          method?: "GET" | "POST" | "PUT" | "DELETE" | "HEAD" | "PATCH";
          headers?: Record<string, string>;
          body?: string;
          timeout?: number;
        } = {}): Promise<{
          status: number;
          headers: Record<string, string>;
          body: string;
          truncated?: boolean;
          durationMs: number;
          error?: string;
          errorCode?: string;
          retryAfterMs?: number;
        }> => {
          const payload: Record<string, unknown> = { url };
          if (opts.method) payload.method = opts.method;
          if (opts.headers) payload.headers = opts.headers;
          if (opts.body !== undefined) payload.body = opts.body;
          if (typeof opts.timeout === "number") payload.timeout = opts.timeout;
          // For card-class-private sidecar calls (`mica-internal://card-server/...`)
          // inject the calling card's class so the server can spawn / route to
          // the right sidecar. Class is the extension on the canvas-relative
          // filename (e.g. "canvas/foo.vector-search" → "vector-search").
          if (typeof url === "string" && url.startsWith("mica-internal://card-server/")) {
            const dot = filename.lastIndexOf(".");
            if (dot >= 0) payload._cardClass = filename.slice(dot + 1);
          }
          try {
            const r = await fetch("/api/mica/fetch/request", {
              method: "POST",
              headers: projectHeaders({ "Content-Type": "application/json" }),
              body: JSON.stringify(payload),
            });
            if (!r.ok) {
              // Should never happen — the handler always resolves with a
              // structured result. If it does (e.g. network between card and
              // Mica server), surface as internal_error so callers see it.
              const txt = await r.text().catch(() => "");
              return {
                status: 0, headers: {}, body: "", durationMs: 0,
                error: `mica.fetch transport failed: HTTP ${r.status} ${txt.slice(0, 200)}`,
                errorCode: "internal_error",
              };
            }
            return await r.json();
          } catch (e) {
            return {
              status: 0, headers: {}, body: "", durationMs: 0,
              error: `mica.fetch transport failed: ${(e as Error).message}`,
              errorCode: "internal_error",
            };
          }
        },
      };

      // Separate external (src) and inline scripts from HTML
      const scripts = Array.from(el.querySelectorAll("script"));
      const inlineExternalSrcs: string[] = [];
      const inlineScripts: HTMLScriptElement[] = [];

      scripts.forEach((s) => {
        const src = s.getAttribute("src");
        if (src) {
          inlineExternalSrcs.push(src);
          s.remove();
        } else {
          inlineScripts.push(s);
        }
      });

      const executeInlineScripts = () => {
        inlineScripts.forEach((oldScript) => {
          // Skip module scripts — they use import/export which can't work in IIFE wrappers.
          // Report as error so agents know to use dependencies.scripts instead.
          if (oldScript.type === "module") {
            console.error(`[card-runtime] Module scripts not supported in ${filename} — use dependencies.scripts for CDN libraries`);
            fetch(`/api/cards/${encodeURIComponent(filename)}/error`, {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ error: "Module scripts (<script type=\"module\">) are not supported in cards. Use the dependencies.scripts export for CDN libraries instead of import statements." }),
            }).catch(() => {});
            oldScript.remove();
            return;
          }

          const newScript = document.createElement("script");
          Array.from(oldScript.attributes).forEach((attr) => {
            newScript.setAttribute(attr.name, attr.value);
          });
          // Run the async IIFE and chain /ok or /error off its RESULT
          // promise. Previously a sync try/catch guarded the invocation
          // and fired /ok immediately after — which meant post-await
          // errors in the card script became unreported dangling
          // rejections, and /ok could fire even when the script would
          // ultimately fail. .then/.catch on the returned promise
          // reports sync errors, initial-chain async errors, and gates
          // the /ok fetch on actual success.
          //
          // The /ok and /error fetches run OUTSIDE CARD_SHIM's closure,
          // so they use window.fetch directly (the shim's fetch-override
          // is scoped to the async IIFE). We explicitly pass
          // X-Mica-Project so the server broadcasts card-error events
          // to the right project.
          // Hardcode the URLs with the project-relative filename from React
          // closure (mica.filename is now canvas-relative — would 404 these
          // endpoints). JSON.stringify on the URL string so any unusual
          // characters in the filename get safely escaped into the JS literal.
          const okUrlLit = JSON.stringify(`/api/cards/${encodeURIComponent(filename)}/ok`);
          const errUrlLit = JSON.stringify(`/api/cards/${encodeURIComponent(filename)}/error`);
          newScript.textContent =
            `(function(){` +
            `const _m=document.currentScript.__mica;` +
            `const _ph={'X-Mica-Project':_m.project||''};` +
            `(async function(mica,_c){${CARD_SHIM}${oldScript.textContent}})(` +
            `_m,document.currentScript.parentElement)` +
            `.then(function(){` +
            `fetch(${okUrlLit},{method:'POST',headers:_ph}).catch(function(){});` +
            `})` +
            `.catch(function(e){` +
            `console.error("[card-runtime] Script error in ${filename}:",e);` +
            // Capture both message AND stack. Chrome's stack starts with the
            // message line ("TypeError: …\n  at …"); Firefox's doesn't. Detect
            // and avoid duplicating. The stack is what gives the agent file
            // path + line + column — without it, the agent has to grep the
            // whole card looking for the symbol that threw.
            `var _m1=(e&&e.message)||String(e);` +
            `var _s1=e&&e.stack?String(e.stack):'';` +
            `var _err=_s1&&_s1.indexOf(_m1)>=0?_s1:(_s1?_m1+'\\n'+_s1:_m1);` +
            `fetch(${errUrlLit},` +
            `{method:'POST',headers:Object.assign({'Content-Type':'application/json'},_ph),` +
            `body:JSON.stringify({error:_err})}).catch(()=>{});` +
            `});` +
            `})()` +
            `\n//# sourceURL=${sourceUrlForCard(filename)}`;
          oldScript.remove();
          (newScript as unknown as Record<string, unknown>).__mica = micaBridge;
          // Wrap in try/catch: appending a <script> with invalid syntax
          // (e.g. top-level `export`, malformed braces) makes the browser
          // throw SyntaxError synchronously during parse. The IIFE never
          // runs, so its `.catch` never attaches, and the error dies in
          // the browser's console with no `card-error` broadcast — the
          // chat agent never sees it. Catch here and POST manually so the
          // agent gets the same surface it would for any other card error.
          // (Layer-1 prevention is `enforceCardJsLint` in cardValidators;
          // this is the mount-time safety net for whatever slips through.)
          try {
            el.appendChild(newScript);
          } catch (parseErr) {
            const msg = (parseErr as Error)?.message || String(parseErr);
            console.error(`[card-runtime] Script parse failed in ${filename}:`, parseErr);
            fetch(`/api/cards/${encodeURIComponent(filename)}/error`, {
              method: "POST",
              headers: { "Content-Type": "application/json", "X-Mica-Project": project },
              body: JSON.stringify({
                error: `card.js fails to parse at mount: ${msg}. The script wrapper rejected it before any code ran. Common causes: top-level \`export\`/\`import\`, unbalanced braces, accidentally pasted non-JS content. Mica wraps card.js in \`(async function(mica,_c){…})()\` — the file must be valid as a function body.`,
              }),
            }).catch(() => {});
          }
        });

      };

      // Load any inline-declared scripts not already loaded via dependencies
      const inlineScriptLoads = inlineExternalSrcs.map((src) => ensureScript(src, filename));
      const allInlineLoads = [...inlineScriptLoads, ...cssLoads];

      if (allInlineLoads.length > 0) {
        Promise.all(allInlineLoads).then(async () => {
          if (cssLoads.length > 0) await waitForStyleApplication();
          executeInlineScripts();
        }).catch((err) => {
          console.error("[card-runtime] External resource load failed:", err);
          reportLoadError(err);
        });
      } else {
        executeInlineScripts();
      }

      // Mermaid rendering is handled by the mermaid card class itself (via inline <script>),
      // not by CardRuntime. Card classes own their own rendering lifecycle.
    };

    // If there are declared dependencies, show loading skeleton, preload, then render.
    // Otherwise, render immediately (backward compatible). Either way, await
    // canvasRoot first so mica.filename and the files API are correct from
    // script-start; the fetch is per-project-cached and almost always free.
    if (declaredScripts.length > 0 || declaredStyles.length > 0) {
      setLoadingDeps(true);
      Promise.all([preloadDeps(), canvasRootPromise]).then(([, canvasRoot]) => {
        setLoadingDeps(false);
        continueRender(canvasRoot);
      }).catch((err) => {
        console.error("[card-runtime] Dependency preload failed:", err);
        reportLoadError(err);
        setLoadingDeps(false);
        canvasRootPromise.then((canvasRoot) => continueRender(canvasRoot));
      });
    } else {
      canvasRootPromise.then((canvasRoot) => continueRender(canvasRoot));
    }

    // Unregister the card-error reporter on unmount. The Map entry was set
    // inside continueRender (closure-scoped to this effect run). If the
    // effect re-fires (deps change), the cleanup runs first, removing the
    // OLD reporter; the new run installs a fresh one for the new closure.
    return () => {
      cardErrorReporters.delete(filename);
      unregisterCardFromScripts(filename);
    };

  }, [html, project, canvas, filename]);

  return (
    <div ref={outerRef} className="card-runtime" style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0, position: "relative" }}>
      {loadingDeps && (
        <div className="card-deps-loading">
          <div className="card-deps-skeleton" />
          <div className="card-deps-skeleton card-deps-skeleton--short" />
          <div className="card-deps-skeleton card-deps-skeleton--med" />
        </div>
      )}
      {currentError && (
        // Inset error box overlaid near the top of the card. Visible to the
        // user AND to render_capture's html2canvas — the agent's caption
        // picks up "card has a red error box reading X," which is its
        // evidence the error fired. Click × to dismiss; auto-clears on next
        // card re-render. Flex layout so the box grows vertically with
        // wrapped text instead of clipping to one line.
        <div
          style={{
            position: "absolute",
            top: 8,
            left: 8,
            right: 8,
            zIndex: 100,
            display: "flex",
            alignItems: "flex-start",
            gap: 8,
            background: "rgba(220, 38, 38, 0.95)",
            color: "#fff",
            // Generous vertical padding so text has visible breathing room
            // above and below; otherwise the box looks like it "just barely
            // fits" the text. min-height gives a single-line error the same
            // visual weight as a multi-line one. Long errors that still
            // don't fit get max-height + scroll inside the box instead of
            // silently clipping past the card boundary.
            padding: "24px 18px 24px 20px",
            fontFamily: "-apple-system, BlinkMacSystemFont, sans-serif",
            fontSize: 13,
            lineHeight: 1.55,
            borderRadius: 6,
            boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
            minHeight: 72,
            maxHeight: "calc(100% - 16px)",
            overflowY: "auto",
            boxSizing: "border-box",
          }}
        >
          <div style={{ flex: 1, minWidth: 0, overflowWrap: "anywhere" }}>
            <strong style={{ marginRight: 6 }}>⚠ Card error:</strong>
            <span>{currentError.slice(0, 400)}</span>
          </div>
          <button
            onClick={() => setCurrentError(null)}
            aria-label="Dismiss error"
            style={{
              flexShrink: 0,
              background: "transparent",
              border: "none",
              color: "rgba(255,255,255,0.85)",
              fontSize: 16,
              lineHeight: 1,
              cursor: "pointer",
              padding: "2px 6px",
              marginTop: -2,
            }}
          >
            ×
          </button>
        </div>
      )}
      {/* Widget HTML is injected into this div via innerHTML — kept separate
          from React-managed children to avoid NotFoundError when React tries
          to reconcile nodes that innerHTML has destroyed.
          `position: relative` makes this the positioning context for any
          card-side absolute-positioned children (so `position: absolute`
          inside card.js anchors here, not at the page root).
          `overflow: hidden` clips children that exceed the card's bounds —
          a structural guarantee that cards cannot escape their frame
          regardless of card.js's layout choices. Cards that genuinely need
          to extend past their bounds (rare, e.g. dropdown menus) can
          override `overflow: visible` from card.css. */}
      <div ref={widgetRef} style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0, position: "relative", overflow: "hidden" }} />
    </div>
  );
}
