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
var _si=window.setInterval.bind(window),_st=window.setTimeout.bind(window);
var _ci=window.clearInterval.bind(window),_ct=window.clearTimeout.bind(window);
function setInterval(fn,ms){var w=function(){try{fn()}catch(e){_reportError(e)}};var id=_si(w,ms);_cleanups.push(function(){_ci(id)});return id}
function setTimeout(fn,ms){var w=function(){try{fn()}catch(e){_reportError(e)}};var id=_st(w,ms);_cleanups.push(function(){_ct(id)});return id}
function clearInterval(id){_ci(id)}
function clearTimeout(id){_ct(id)}
var _raf=window.requestAnimationFrame.bind(window),_caf=window.cancelAnimationFrame.bind(window);
var _lastRaf=0;
function requestAnimationFrame(fn){_lastRaf=_raf(function(){try{fn()}catch(e){_reportError(e)}});return _lastRaf}
function cancelAnimationFrame(id){_caf(id)}
_cleanups.push(function(){_caf(_lastRaf)});
var _resizeCbs=[];
var _origAEL=window.addEventListener.bind(window);
var _origREL=window.removeEventListener.bind(window);
window.addEventListener=function(t,fn,o){
  var w=function(ev){try{fn(ev)}catch(e){_reportError(e)}};
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
            newScript.textContent =
              `(function(){` +
              `const _m=document.currentScript.__mica;` +
              `try{(async function(mica,_c){${CARD_SHIM}${oldScript.textContent}})(` +
              `_m,document.currentScript.parentElement);` +
              `}catch(e){console.error("[card-runtime] Script error in ${filename}:",e);}` +
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
              body: JSON.stringify({ content, source: windowId }),
            });
            if (!r.ok) throw new Error(`mica.files.write(${path}): HTTP ${r.status}`);
          } else {
            const url = `/api/files/${encodeURIComponent(path)}/upload?source=${encodeURIComponent(windowId)}`;
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
        /** Build a URL for inline use (e.g. `<img src={mica.files.url("docs/pic.png")}/>`). */
        url(path: string): string {
          return `/api/files/${encodeURIComponent(path)}`;
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
        files,
        cardClasses,
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
          // Wrap in try-catch so a single card's script failure doesn't crash the page.
          // On error (sync or async), report back to server so agents can auto-fix.
          newScript.textContent =
            `(function(){` +
            `const _m=document.currentScript.__mica;` +
            `try{(async function(mica,_c){${CARD_SHIM}${oldScript.textContent}})(` +
            `_m,document.currentScript.parentElement);` +
            `fetch('/api/cards/'+encodeURIComponent(_m.filename)+'/ok',{method:'POST'}).catch(function(){});` +
            `}catch(e){` +
            `console.error("[card-runtime] Script error in ${filename}:",e);` +
            `fetch('/api/cards/'+encodeURIComponent(_m.filename)+'/error',` +
            `{method:'POST',headers:{'Content-Type':'application/json'},` +
            `body:JSON.stringify({error:e.message||String(e)})}).catch(()=>{});` +
            `}})()`;
          oldScript.remove();
          (newScript as unknown as Record<string, unknown>).__mica = micaBridge;
          el.appendChild(newScript);
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
