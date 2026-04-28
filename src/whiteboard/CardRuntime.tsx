// CardRuntime — renders server-produced HTML inside a card.
// Provides the `mica` bridge (call, send, on, openChannel) for interactive cards.
// Card classes handle their own rendering (e.g., mermaid.js) via inline <script> blocks.

import { useEffect, useRef, useState } from "react";
// morphdom removed — innerHTML replacement is safer with React's lifecycle.
// TODO: Re-evaluate morphdom for preserving mounted library instances once
// we add proper lifecycle coordination between React and widget scripts.
import { getOrCreateBridge, windowId, type CanvasId } from "../api/micaSocket";

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
var document=new Proxy(_rd,{get:function(t,p){
  if(p==='querySelector')return function(s){return _c.querySelector(s)};
  if(p==='querySelectorAll')return function(s){return _c.querySelectorAll(s)};
  if(p==='getElementById')return function(id){return _c.querySelector('#'+CSS.escape(id))};
  var v=t[p];return typeof v==='function'?v.bind(t):v;
}});
function _reportError(e){
  fetch('/api/cards/'+encodeURIComponent(mica.filename)+'/error',
    {method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({error:e.message||String(e)})}).catch(function(){});
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

/** Load a script into <head> (deduplicated). Returns a promise that resolves when loaded. */
// Track in-flight script loads so concurrent callers wait on the same promise
const scriptLoadPromises = new Map<string, Promise<void>>();

function ensureScript(src: string): Promise<void> {
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

  // Render on mount or when html changes. Re-injects HTML and re-executes scripts.
  // Does NOT destroy sessions — channels survive via bridge dedup.
  useEffect(() => {
    const el = widgetRef.current;
    if (!el) return;

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
        await ensureScript(src);
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

    const continueRender = () => {
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
            newScript.textContent =
              `(function(){` +
              `const _m=document.currentScript.__mica;` +
              `const _ph={'X-Mica-Project':_m.project||''};` +
              `(async function(mica,_c){${CARD_SHIM}${oldScript.textContent}})(` +
              `_m,document.currentScript.parentElement)` +
              `.catch(function(e){` +
              `console.error("[card-runtime] Script error in ${filename}:",e);` +
              `fetch('/api/cards/'+encodeURIComponent(_m.filename)+'/error',` +
              `{method:'POST',headers:Object.assign({'Content-Type':'application/json'},_ph),` +
              `body:JSON.stringify({error:(e&&e.message)||String(e)})}).catch(()=>{});` +
              `});` +
              `})()`;
            oldScript.remove();
            (newScript as unknown as Record<string, unknown>).__mica = micaBridge;
            el.appendChild(newScript);
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

      const files = {
        /** List all files and directories under the project.
         *  `isFile` and `isFolder` are always opposites — both provided so you can
         *  write whichever reads more naturally for your case. */
        async list(): Promise<Array<{ path: string; isFile: boolean; isFolder: boolean; size: number; modifiedAt: string }>> {
          const r = await fetch("/api/files", { headers: projectHeaders() });
          if (!r.ok) throw new Error(`mica.files.list: HTTP ${r.status}`);
          const raw = (await r.json()) as Array<{ name: string; type: string; size: number; modifiedAt: string }>;
          return raw.map((f) => ({
            path: f.name,
            isFile: f.type === "file",
            isFolder: f.type === "directory",
            size: f.size,
            modifiedAt: f.modifiedAt,
          }));
        },
        /** Read a text file. */
        async read(path: string): Promise<string> {
          const r = await fetch(`/api/files/${encodeURIComponent(path)}`, { headers: projectHeaders() });
          if (!r.ok) throw new Error(`mica.files.read(${path}): HTTP ${r.status}`);
          return r.text();
        },
        /** Read a binary file as ArrayBuffer. */
        async readBinary(path: string): Promise<ArrayBuffer> {
          const r = await fetch(`/api/files/${encodeURIComponent(path)}`, { headers: projectHeaders() });
          if (!r.ok) throw new Error(`mica.files.readBinary(${path}): HTTP ${r.status}`);
          return r.arrayBuffer();
        },
        /** Write a file. Accepts text (string) or binary (ArrayBuffer / TypedArray / Blob / File).
         *  `source: mica.windowId` is auto-injected so file-changed events don't echo back to this card.
         *  Parents are auto-created. Binary writes stream to disk (no size limit, constant memory). */
        async write(
          path: string,
          content: string | ArrayBuffer | ArrayBufferView | Blob,
        ): Promise<void> {
          if (typeof content === "string") {
            const r = await fetch(`/api/files/${encodeURIComponent(path)}`, {
              method: "PUT",
              headers: projectHeaders({ "Content-Type": "application/json" }),
              // Send both: `source` (windowId) for backward compat with existing
              // cards that filter on mica.windowId, and `cardSource` (per-card
              // UUID) for sibling-friendly self-echo via mica.isSelfEcho().
              body: JSON.stringify({ content, source: windowId, cardSource: sessionId }),
            });
            if (!r.ok) throw new Error(`mica.files.write(${path}): HTTP ${r.status}`);
          } else {
            const url = `/api/files/${encodeURIComponent(path)}/upload?source=${encodeURIComponent(windowId)}&cardSource=${encodeURIComponent(sessionId)}`;
            const body = content instanceof Blob
              ? content
              : (content instanceof ArrayBuffer ? content : content.buffer);
            const r = await fetch(url, { method: "POST", body: body as BodyInit, headers: projectHeaders() });
            if (!r.ok) throw new Error(`mica.files.write(${path}): HTTP ${r.status}`);
          }
        },
        /** Delete a file. */
        async delete(path: string): Promise<void> {
          const r = await fetch(`/api/files/${encodeURIComponent(path)}`, { method: "DELETE", headers: projectHeaders() });
          if (!r.ok && r.status !== 404) throw new Error(`mica.files.delete(${path}): HTTP ${r.status}`);
        },
        /** Build a URL for inline use (e.g. `<img src={mica.files.url("docs/pic.png")}/>`).
         *  Includes `?project=` so the URL works in contexts that can't send the
         *  `X-Mica-Project` header (window.open new tabs, <img src>, etc.). */
        url(path: string): string {
          return `/api/files/${encodeURIComponent(path)}?project=${encodeURIComponent(project)}`;
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
      };

      const micaBridge = {
        ...baseBridge,
        project,
        canvas,
        filename,
        windowId,
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
          newScript.textContent =
            `(function(){` +
            `const _m=document.currentScript.__mica;` +
            `const _ph={'X-Mica-Project':_m.project||''};` +
            `(async function(mica,_c){${CARD_SHIM}${oldScript.textContent}})(` +
            `_m,document.currentScript.parentElement)` +
            `.then(function(){` +
            `fetch('/api/cards/'+encodeURIComponent(_m.filename)+'/ok',{method:'POST',headers:_ph}).catch(function(){});` +
            `})` +
            `.catch(function(e){` +
            `console.error("[card-runtime] Script error in ${filename}:",e);` +
            `fetch('/api/cards/'+encodeURIComponent(_m.filename)+'/error',` +
            `{method:'POST',headers:Object.assign({'Content-Type':'application/json'},_ph),` +
            `body:JSON.stringify({error:(e&&e.message)||String(e)})}).catch(()=>{});` +
            `});` +
            `})()`;
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
      const inlineScriptLoads = inlineExternalSrcs.map(ensureScript);
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
    // Otherwise, render immediately (backward compatible).
    if (declaredScripts.length > 0 || declaredStyles.length > 0) {
      setLoadingDeps(true);
      preloadDeps().then(() => {
        setLoadingDeps(false);
        continueRender();
      }).catch((err) => {
        console.error("[card-runtime] Dependency preload failed:", err);
        reportLoadError(err);
        setLoadingDeps(false);
        continueRender();
      });
    } else {
      continueRender();
    }

  }, [html, project, canvas, filename]);

  return (
    <div ref={outerRef} className="card-runtime" style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      {loadingDeps && (
        <div className="card-deps-loading">
          <div className="card-deps-skeleton" />
          <div className="card-deps-skeleton card-deps-skeleton--short" />
          <div className="card-deps-skeleton card-deps-skeleton--med" />
        </div>
      )}
      {/* Widget HTML is injected into this div via innerHTML — kept separate
          from React-managed children to avoid NotFoundError when React tries
          to reconcile nodes that innerHTML has destroyed. */}
      <div ref={widgetRef} style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }} />
    </div>
  );
}
