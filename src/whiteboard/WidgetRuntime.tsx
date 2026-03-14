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

    // Build per-widget mica bridge
    const micaBridge = {
      call: (fn: string, args: Record<string, unknown> = {}) => {
        return callExport(layer, filename, fn, args);
      },
      exports: exportFns || [],
    };

    // Execute <script> tags with the correct mica bridge injected.
    // Each widget gets its own bridge scoped to its layer/filename,
    // avoiding the global window.mica collision between multiple cards.
    const scripts = el.querySelectorAll("script");
    scripts.forEach((oldScript) => {
      const newScript = document.createElement("script");
      Array.from(oldScript.attributes).forEach((attr) => {
        newScript.setAttribute(attr.name, attr.value);
      });
      // Inject `mica` and `container` as locals so widget scripts
      // don't need to rely on globals or document.currentScript
      newScript.textContent =
        `(function(mica, container) {${oldScript.textContent}})(` +
        `document.currentScript.__mica, document.currentScript.parentElement);`;
      oldScript.remove();
      // Attach bridge to script element before it executes
      (newScript as unknown as Record<string, unknown>).__mica = micaBridge;
      el.appendChild(newScript);
    });

    // Initialize mermaid diagrams using mermaid.run() (v10+ API)
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
  }, [html, layer, filename, callExport, exportFns]);

  return <div ref={containerRef} className="widget-runtime" />;
}
