// WidgetRuntime — renders server-produced HTML inside a card.
// Provides the `mica` bridge (call, send, on, openChannel) for interactive widgets.
// Initializes mermaid.js for any <pre class="mermaid"> elements in the output.

import { useEffect, useRef } from "react";
import mermaid from "mermaid";
import type { LayerId } from "../api/layerFiles";
import { createBridge } from "../api/micaSocket";

interface Props {
  html: string;
  exports?: string[];
  project: string;
  layer: LayerId;
  filename: string;
}

// Initialize mermaid once
mermaid.initialize({ startOnLoad: false, theme: "dark" });

// Track globally loaded external scripts and stylesheets
const loadedExternalScripts = new Set<string>();
const loadedExternalStyles = new Set<string>();

export default function WidgetRuntime({ html, exports: exportFns, project, layer, filename }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const prevHtmlRef = useRef<string>("");

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
    const micaBridge = {
      ...createBridge(project, layer, filename),
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

    // Scroll chat messages to bottom
    requestAnimationFrame(() => {
      const chatMessages = el.querySelector(".chat-messages");
      if (chatMessages) {
        chatMessages.scrollTop = chatMessages.scrollHeight;
      }
    });

    // Initialize mermaid diagrams
    const mermaidEls = el.querySelectorAll("pre.mermaid:not(.mermaid-rendered)");
    if (mermaidEls.length > 0) {
      mermaid.run({ nodes: mermaidEls as unknown as ArrayLike<HTMLElement> })
        .then(() => {
          mermaidEls.forEach((pre) => pre.classList.add("mermaid-rendered"));
        })
        .catch((err) => {
          console.error("[mermaid] render failed:", err);
        });
    }
  }, [html, project, layer, filename]);

  return <div ref={containerRef} className="widget-runtime" />;
}
