// WidgetRuntime — renders server-produced HTML inside a card.
// Provides the `mica.call()` bridge for interactive widgets (@export functions).
// Initializes mermaid.js for any <pre class="mermaid"> elements in the output.

import { useEffect, useRef } from "react";
import mermaid from "mermaid";
import type { LayerId } from "../api/layerFiles";

interface Props {
  html: string;
  exports?: string[];
  layer: LayerId;
  filename: string;
  callExport: (layer: LayerId, filename: string, fn: string, args?: Record<string, unknown>) => Promise<unknown>;
}

// Initialize mermaid once
mermaid.initialize({ startOnLoad: false, theme: "dark" });

export default function WidgetRuntime({ html, exports: exportFns, layer, filename, callExport }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const prevHtmlRef = useRef<string>("");

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    // Only update DOM if html actually changed
    if (html !== prevHtmlRef.current) {
      el.innerHTML = html;
      prevHtmlRef.current = html;
    }

    // Inject mica.call() into the widget's scope
    const micaBridge = {
      call: (fn: string, args: Record<string, unknown> = {}) => {
        return callExport(layer, filename, fn, args);
      },
      exports: exportFns || [],
    };
    (el as unknown as Record<string, unknown>).__mica = micaBridge;

    // Also set on window for inline scripts
    const w = el.ownerDocument.defaultView;
    if (w) {
      (w as unknown as Record<string, unknown>).mica = micaBridge;
    }

    // Execute any <script> tags in the HTML
    const scripts = el.querySelectorAll("script");
    scripts.forEach((oldScript) => {
      const newScript = document.createElement("script");
      // Copy attributes
      Array.from(oldScript.attributes).forEach((attr) => {
        newScript.setAttribute(attr.name, attr.value);
      });
      newScript.textContent = oldScript.textContent;
      oldScript.parentNode?.replaceChild(newScript, oldScript);
    });

    // Initialize mermaid diagrams
    const mermaidEls = el.querySelectorAll("pre.mermaid");
    if (mermaidEls.length > 0) {
      mermaidEls.forEach((pre, i) => {
        const id = `mermaid-widget-${filename.replace(/[^a-zA-Z0-9]/g, "_")}-${i}-${Date.now()}`;
        const content = pre.textContent || "";

        // Create off-screen temp div for mermaid rendering
        const tempDiv = document.createElement("div");
        tempDiv.id = id;
        tempDiv.style.position = "absolute";
        tempDiv.style.left = "-9999px";
        document.body.appendChild(tempDiv);

        mermaid.render(id, content).then(({ svg }) => {
          pre.innerHTML = svg;
          pre.classList.add("mermaid-rendered");
        }).catch(() => {
          pre.classList.add("mermaid-error");
        }).finally(() => {
          try { document.body.removeChild(tempDiv); } catch {}
        });
      });
    }

    // Cleanup: remove mica from window on unmount
    return () => {
      const w2 = el?.ownerDocument?.defaultView;
      if (w2 && (w2 as unknown as Record<string, unknown>).mica === micaBridge) {
        delete (w2 as unknown as Record<string, unknown>).mica;
      }
    };
  }, [html, layer, filename, callExport, exportFns]);

  return <div ref={containerRef} className="widget-runtime" />;
}
