// WidgetRuntime — renders server-produced HTML inside a card.
// Provides the `mica` bridge (call, send, on, openChannel) for interactive widgets.
// Initializes mermaid.js for any <pre class="mermaid"> elements in the output.

import { useEffect, useRef, useState } from "react";
import mermaid from "mermaid";
import morphdom from "morphdom";
import type { CanvasId } from "../api/canvasFiles";
import { createBridge } from "../api/micaSocket";

interface CardDependencies {
  scripts?: string[];
  styles?: string[];
}

interface Props {
  html: string;
  exports?: string[];
  dependencies?: CardDependencies;
  project: string;
  canvas: CanvasId;
  filename: string;
}

// Initialize mermaid once
mermaid.initialize({ startOnLoad: false, theme: "dark", maxTextSize: 100000, flowchart: { useMaxWidth: true }, sequence: { useMaxWidth: true } });

/** Force mermaid SVGs to fill their container width */
function fixMermaidSvgs(el: HTMLElement) {
  el.querySelectorAll("pre.mermaid svg").forEach((svg) => {
    const s = svg as SVGElement;
    s.setAttribute("width", "100%");
    s.removeAttribute("height");
    s.style.maxWidth = "none";
    s.style.width = "100%";
  });
}

// Track globally loaded external scripts and stylesheets
const loadedExternalScripts = new Set<string>();
const loadedExternalStyles = new Set<string>();

/** Load a script into <head> (deduplicated). Returns a promise that resolves when loaded. */
function ensureScript(src: string): Promise<void> {
  if (loadedExternalScripts.has(src)) return Promise.resolve();
  if (document.querySelector(`script[src="${CSS.escape(src)}"]`)) {
    loadedExternalScripts.add(src);
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = () => { loadedExternalScripts.add(src); resolve(); };
    s.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(s);
  });
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

export default function WidgetRuntime({ html, exports: exportFns, dependencies, project, canvas, filename }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const prevHtmlRef = useRef<string>("");
  const bridgeRef = useRef<ReturnType<typeof createBridge> | null>(null);
  const [activeCalls, setActiveCalls] = useState(0);
  const [loadingDeps, setLoadingDeps] = useState(false);

  // Only re-run when html changes
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    if (html === prevHtmlRef.current) return;

    // Run destroy callbacks from previous render before updating DOM
    if (bridgeRef.current) {
      bridgeRef.current._runDestroy();
    }

    const isFirstRender = prevHtmlRef.current === "";
    prevHtmlRef.current = html;

    // ── Phase 1: Preload declared dependencies ──────────────────
    // If the card class declared `export const dependencies`, load them
    // BEFORE injecting the HTML. This guarantees scripts and styles are
    // available and applied when inline <script> blocks execute.
    const declaredScripts = dependencies?.scripts || [];
    const declaredStyles = dependencies?.styles || [];

    const preloadDeps = async () => {
      // Load all declared styles first (so CSS is applied before scripts run)
      await Promise.all(declaredStyles.map(ensureStyle));
      // Then load all declared scripts
      await Promise.all(declaredScripts.map(ensureScript));
      // Wait for CSS rules to be fully applied
      if (declaredStyles.length > 0) {
        await waitForStyleApplication();
      }
    };

    const continueRender = () => {
      // ── Phase 2: Inject HTML ──────────────────────────────────
      if (isFirstRender) {
        el.innerHTML = html;
      } else {
        const wrapper = document.createElement("div");
        wrapper.innerHTML = html;
        morphdom(el, wrapper, {
          childrenOnly: true,
          onBeforeElUpdated(fromEl) {
            if (fromEl.tagName === "SCRIPT") return false;
            if (fromEl.hasAttribute("data-morphdom-skip")) return false;
            return true;
          },
        });
      }

      // ── Phase 3: Process inline dependencies from HTML ────────
      // Handle <link> and <script src> tags that weren't declared
      // via the dependencies export (legacy / inline approach).
      const cssLoads: Promise<void>[] = [];
      el.querySelectorAll('link[rel="stylesheet"]').forEach((link) => {
        const href = link.getAttribute("href");
        if (href) cssLoads.push(ensureStyle(href));
        link.remove();
      });

      // Build mica bridge
      const baseBridge = createBridge(project, canvas, filename);
      bridgeRef.current = baseBridge;
      const micaBridge = {
        ...baseBridge,
        call: async (fn: string, args: Record<string, unknown> = {}) => {
          setActiveCalls((n) => n + 1);
          try {
            return await baseBridge.call(fn, args);
          } finally {
            setActiveCalls((n) => n - 1);
          }
        },
        exports: exportFns || [],
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
          const newScript = document.createElement("script");
          Array.from(oldScript.attributes).forEach((attr) => {
            newScript.setAttribute(attr.name, attr.value);
          });
          newScript.textContent =
            `(function(mica, container) {${oldScript.textContent}})(` +
            `document.currentScript.__mica, document.currentScript.parentElement);`;
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
          console.error("[widget-runtime] External resource load failed:", err);
        });
      } else {
        executeInlineScripts();
      }

      // Initialize mermaid diagrams
      const mermaidEls = el.querySelectorAll("pre.mermaid:not(.mermaid-rendered)");
      if (mermaidEls.length > 0) {
        mermaid.run({ nodes: mermaidEls as unknown as ArrayLike<HTMLElement> })
          .then(() => {
            mermaidEls.forEach((pre) => pre.classList.add("mermaid-rendered"));
            fixMermaidSvgs(el);
          })
          .catch((err) => {
            console.error("[mermaid] render failed:", err);
          });
      } else {
        fixMermaidSvgs(el);
      }
    };

    // If there are declared dependencies, show loading skeleton, preload, then render.
    // Otherwise, render immediately (backward compatible).
    if (declaredScripts.length > 0 || declaredStyles.length > 0) {
      setLoadingDeps(true);
      preloadDeps().then(() => {
        setLoadingDeps(false);
        continueRender();
      }).catch((err) => {
        console.error("[widget-runtime] Dependency preload failed:", err);
        setLoadingDeps(false);
        continueRender();
      });
    } else {
      continueRender();
    }

    // Cleanup on unmount
    return () => {
      if (bridgeRef.current) {
        bridgeRef.current._runDestroy();
      }
    };
  }, [html, project, canvas, filename, dependencies]);

  return (
    <div ref={containerRef} className={`widget-runtime ${activeCalls > 0 ? "widget-runtime--busy" : ""}`}>
      {activeCalls > 0 && <div className="widget-activity-indicator" />}
      {loadingDeps && (
        <div className="widget-deps-loading">
          <div className="widget-deps-skeleton" />
          <div className="widget-deps-skeleton widget-deps-skeleton--short" />
          <div className="widget-deps-skeleton widget-deps-skeleton--med" />
        </div>
      )}
    </div>
  );
}
