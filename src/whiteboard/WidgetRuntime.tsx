// WidgetRuntime — renders server-produced HTML inside a card.
// Provides the `mica` bridge (call, send, on, openChannel) for interactive widgets.
// Initializes mermaid.js for any <pre class="mermaid"> elements in the output.

import { useEffect, useRef, useState } from "react";
import mermaid from "mermaid";
import type { CanvasId } from "../api/canvasFiles";
import { createBridge } from "../api/micaSocket";

interface Props {
  html: string;
  exports?: string[];
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

export default function WidgetRuntime({ html, exports: exportFns, project, canvas, filename }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const prevHtmlRef = useRef<string>("");
  const [activeCalls, setActiveCalls] = useState(0);

  // Only re-run when html changes
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    if (html === prevHtmlRef.current) return;

    el.innerHTML = html;
    prevHtmlRef.current = html;

    // Hoist <link rel="stylesheet"> to <head> and track load promises
    const cssLoads: Promise<void>[] = [];
    el.querySelectorAll('link[rel="stylesheet"]').forEach((link) => {
      const href = link.getAttribute("href");
      if (href) {
        if (loadedExternalStyles.has(href)) {
          // Already loaded — nothing to wait for
        } else {
          const existing = document.querySelector(`link[href="${href}"]`) as HTMLLinkElement | null;
          if (existing) {
            // Link exists in head — wait for it if not yet loaded
            if (existing.sheet) {
              loadedExternalStyles.add(href);
            } else {
              cssLoads.push(new Promise<void>((resolve) => {
                existing.addEventListener("load", () => { loadedExternalStyles.add(href); resolve(); });
                existing.addEventListener("error", () => { loadedExternalStyles.add(href); resolve(); });
              }));
            }
          } else {
            // New link — add to head and wait for load
            const headLink = document.createElement("link");
            headLink.rel = "stylesheet";
            headLink.href = href;
            cssLoads.push(new Promise<void>((resolve) => {
              headLink.onload = () => { loadedExternalStyles.add(href); resolve(); };
              headLink.onerror = () => { loadedExternalStyles.add(href); resolve(); };
            }));
            document.head.appendChild(headLink);
          }
        }
      }
      link.remove();
    });

    // Build mica bridge — WebSocket-based with all 4 patterns
    // Wrap call() to track in-flight exports for the activity indicator
    const baseBridge = createBridge(project, canvas, filename);
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

    // Separate external (src) and inline scripts
    const scripts = Array.from(el.querySelectorAll("script"));
    const externalSrcs: string[] = [];
    const inlineScripts: HTMLScriptElement[] = [];

    scripts.forEach((s) => {
      const src = s.getAttribute("src");
      if (src) {
        externalSrcs.push(src);
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

    // Wait for ALL external resources (scripts + CSS) before running inline scripts
    const scriptLoads = externalSrcs.map((src) => {
      if (loadedExternalScripts.has(src)) return Promise.resolve();
      if (document.querySelector(`script[src="${src}"]`)) {
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
    });

    const allLoads = [...scriptLoads, ...cssLoads];
    if (allLoads.length > 0) {
      Promise.all(allLoads).then(() => {
        // CSS onload fires when downloaded, but styles may not be applied
        // until the browser completes a rendering cycle. Wait two frames
        // to ensure CSS rules are fully active before widget scripts run.
        requestAnimationFrame(() => requestAnimationFrame(executeInlineScripts));
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
      // HMR / re-mount: fix already-rendered SVGs
      fixMermaidSvgs(el);
    }
  }, [html, project, canvas, filename]);

  return (
    <div ref={containerRef} className={`widget-runtime ${activeCalls > 0 ? "widget-runtime--busy" : ""}`}>
      {activeCalls > 0 && <div className="widget-activity-indicator" />}
    </div>
  );
}
