// CardFrame — wraps a file as a .wb-card element on the canvas.
//
// Renders the wb-card chrome (header, body, footer, resize handle).
// The canvas card class owns positioning, drag, and resize via event
// delegation on #canvas-freeform.
//
// Content rendering: for now, renders file content client-side
// (markdown, mermaid, text, json). Future: delegate to card class render.js.

import { useState, useRef, useEffect, useCallback } from "react";
import type { CanvasFile } from "../api/canvasFiles";
import { fetchCardBack, saveCardBack } from "../api/canvasFiles";
import CardRuntime from "./CardRuntime";

interface RenderedCardData {
  html: string | null;
  cardClass: string | null;
  exports?: string[];
  dependencies?: { scripts?: string[]; styles?: string[] };
  meta?: Record<string, string>;
}

interface Props {
  file: CanvasFile;
  onEdit: () => void;
  onDelete: () => void;
}

function getFileType(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() || "";
  if (ext === "md" || ext === "markdown") return "markdown";
  if (ext === "mmd" || ext === "mermaid") return "mermaid";
  if (ext === "json") return "json";
  if (ext === "html" || ext === "htm") return "html";
  if (["png", "jpg", "jpeg", "gif", "svg", "webp"].includes(ext)) return "image";
  return "text";
}

function getFileBadge(type: string): string {
  switch (type) {
    case "markdown": return "MD";
    case "mermaid": return "MMD";
    case "json": return "JSON";
    case "html": return "HTML";
    case "image": return "IMG";
    default: return "TXT";
  }
}

export default function CardFrame({ file, onEdit, onDelete }: Props) {
  const [flipped, setFlipped] = useState(false);
  const [backContent, setBackContent] = useState("");
  const [backLoaded, setBackLoaded] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [overflows, setOverflows] = useState(false);

  const [renderedCard, setRenderedCard] = useState<RenderedCardData | null>(null);
  const [renderChecked, setRenderChecked] = useState(false);

  const fileType = getFileType(file.name);
  const badge = renderedCard?.meta?.badge || getFileBadge(fileType);

  // Check if this file has a card class, render CLIENT-SIDE
  useEffect(() => {
    const API_BASE = import.meta.env.VITE_MICA_API || "";
    const ext = file.name.split(".").pop()?.toLowerCase() || "";

    // First check if a card class exists for this extension
    fetch(`${API_BASE}/api/card-classes/${ext}/render.js`)
      .then(r => {
        if (!r.ok) throw new Error("No card class");
        return r.text();
      })
      .then(async (jsSource) => {
        // Import the render.js as an ES module via blob URL
        const blob = new Blob([jsSource], { type: "application/javascript" });
        const url = URL.createObjectURL(blob);
        try {
          const mod = await import(/* @vite-ignore */ url);
          const html = mod.default(file.content, { filename: file.name });
          setRenderedCard({
            html,
            cardClass: ext,
            exports: Object.keys(mod).filter(k => k !== "default" && k !== "metadata" && k !== "dependencies"),
            dependencies: mod.dependencies || {},
            meta: mod.metadata || {},
          });
        } finally {
          URL.revokeObjectURL(url);
        }
        setRenderChecked(true);
      })
      .catch(() => {
        setRenderedCard(null);
        setRenderChecked(true);
      });
  }, [file.name, file.content]);

  // Check overflow
  useEffect(() => {
    const el = bodyRef.current;
    if (!el || flipped) return;
    setOverflows(el.scrollHeight > el.clientHeight + 4);
  }, [file.content, flipped]);

  // Load card back on flip
  useEffect(() => {
    if (flipped && !backLoaded) {
      fetchCardBack(file.name).then((c) => {
        setBackContent(c);
        setBackLoaded(true);
      });
    }
  }, [flipped, backLoaded, file.name]);

  const handleSaveBack = useCallback(() => {
    saveCardBack(file.name, backContent);
  }, [file.name, backContent]);

  return (
    <div
      ref={(el) => {
        if (!el) return;
        // After React re-render (e.g. flip), restore classes the canvas script added.
        // wb-card--positioned controls opacity — without it the card disappears.
        // We add it here only if the card already has a position (style.left is set).
        if (el.style.left) el.classList.add("wb-card--positioned");
        el.classList.add("wb-card--resized");
      }}
      className={`wb-card wb-card--resized ${flipped ? "wb-card--flipped" : ""}`}
      data-filename={file.name}
    >
      {/* Header — drag handle (canvas card class makes this draggable) */}
      <div className="wb-card-header">
        <span className="wb-card-type">{badge}</span>
        <span className="wb-card-title">{file.name}</span>
        <div className="wb-card-actions">
          <button
            onClick={(e) => { e.stopPropagation(); setFlipped(!flipped); setBackLoaded(false); }}
            title={flipped ? "Show content" : "Card info"}
            className={`wb-card-btn ${flipped ? "wb-card-btn--active" : ""}`}
          >
            &#8645;
          </button>
          {fileType === "html" && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                const w = window.open("", "_blank");
                if (w) { w.document.write(file.content); w.document.close(); }
              }}
              title="Preview in new tab"
              className="wb-card-btn"
            >
              &#8599;
            </button>
          )}
          <button onClick={(e) => { e.stopPropagation(); onEdit(); }} title="Edit" className="wb-card-btn">
            &#9998;
          </button>
          <button onClick={(e) => { e.stopPropagation(); onDelete(); }} title="Delete" className="wb-card-btn wb-card-btn--danger">
            &times;
          </button>
        </div>
      </div>

      {/* Body */}
      {flipped ? (
        <div className="wb-card-body" style={{ padding: 12, display: "flex", flexDirection: "column" }}>
          <div style={{ color: "#888", fontSize: 11, marginBottom: 8 }}>
            Card info — how this card was generated, AI guidance
          </div>
          <textarea
            value={backContent}
            onChange={(e) => setBackContent(e.target.value)}
            onBlur={handleSaveBack}
            placeholder="Add info about this card..."
            style={{
              flex: 1, background: "rgba(255,255,255,0.03)", color: "#ccc",
              border: "1px solid rgba(255,255,255,0.1)", borderRadius: 4,
              padding: 8, fontSize: 13, fontFamily: "monospace",
              resize: "none", outline: "none", minHeight: 100,
            }}
          />
        </div>
      ) : renderedCard?.html ? (
        <div className="wb-card-body" style={{ overflow: "hidden", display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
          <CardRuntime
            html={renderedCard.html}
            exports={renderedCard.exports}
            dependencies={renderedCard.dependencies}
            project="_"
            canvas="_"
            filename={file.name}
          />
        </div>
      ) : (
        <div
          ref={bodyRef}
          className={`wb-card-body ${overflows ? "wb-card-body--overflows" : ""}`}
        >
          <FileContent content={file.content} type={fileType} />
        </div>
      )}

      {/* Footer */}
      <div className="wb-card-footer">
        <span className="wb-card-filename">{file.name}</span>
      </div>

      {/* Resize handle (canvas card class handles resize via event delegation) */}
      <div className="wb-card-resize-handle" />
    </div>
  );
}

// ── File Content Renderer ────────────────────────────────────

function FileContent({ content, type }: { content: string; type: string }) {
  switch (type) {
    case "markdown":
      return (
        <div
          style={{ color: "#ddd", fontSize: 14, lineHeight: 1.6, padding: 16 }}
          dangerouslySetInnerHTML={{ __html: simpleMarkdown(content) }}
        />
      );
    case "mermaid":
      return (
        <div
          ref={(el) => {
            if (!el) return;
            // Only prevent page scroll when Alt/Option is held (zoom/pan mode)
            el.onwheel = (e) => { if (e.altKey) e.preventDefault(); };
          }}
          style={{ flex: 1, minHeight: 0, overflow: "hidden" }}
        >
          <MermaidRenderer content={content} />
        </div>
      );
    case "json":
      return <pre style={{ color: "#b8d4e3", fontSize: 12, margin: 0, whiteSpace: "pre-wrap", padding: 16 }}>{content}</pre>;
    default:
      return <pre style={{ color: "#ccc", fontSize: 13, margin: 0, whiteSpace: "pre-wrap", padding: 16 }}>{content}</pre>;
  }
}

function simpleMarkdown(md: string): string {
  // Strip ```markdown fences — just render the content as markdown
  md = md.replace(/^```markdown\n([\s\S]*?)```$/gm, (_m, inner) => inner);

  // Extract fenced code blocks before other processing
  const fenced: string[] = [];
  md = md.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, _lang, code) => {
    fenced.push(`<pre style="background:rgba(0,0,0,0.3);padding:8px 10px;border-radius:6px;overflow-x:auto;margin:6px 0"><code style="font-size:12px;font-family:monospace">${code.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</code></pre>`);
    return `__FENCED__${fenced.length - 1}__`;
  });

  // Extract tables (consecutive lines starting with |)
  const tables: string[] = [];
  md = md.replace(/(^\|.+\|\n?)+/gm, (block) => {
    const rows = block.trim().split("\n");
    let html = '<table style="border-collapse:collapse;margin:6px 0;font-size:12px;width:100%">';
    rows.forEach((row, ri) => {
      if (/^\|[\s-:|]+\|$/.test(row.trim())) return; // skip separator row
      const cells = row.split("|").filter((_c, i, a) => i > 0 && i < a.length - 1);
      const tag = ri === 0 ? "th" : "td";
      html += "<tr>";
      cells.forEach((cell) => {
        const style = tag === "th" ? "background:rgba(255,255,255,0.05);font-weight:600;" : "";
        html += `<${tag} style="border:1px solid #333;padding:4px 8px;${style}">${cell.trim()}</${tag}>`;
      });
      html += "</tr>";
    });
    html += "</table>";
    tables.push(html);
    return `__TABLE__${tables.length - 1}__`;
  });

  let result = md
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/^### (.+)$/gm, "<h3>$1</h3>")
    .replace(/^## (.+)$/gm, "<h2>$1</h2>")
    .replace(/^# (.+)$/gm, "<h1>$1</h1>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/`(.+?)`/g, "<code style='background:rgba(255,255,255,0.06);padding:1px 4px;border-radius:3px'>$1</code>")
    .replace(/^- \[x\] (.+)$/gm, '<div style="opacity:0.6"><input type="checkbox" checked disabled /> <s>$1</s></div>')
    .replace(/^- \[ \] (.+)$/gm, '<div><input type="checkbox" disabled /> $1</div>')
    .replace(/^- (.+)$/gm, "<li>$1</li>")
    .replace(/\n\n/g, "<br/><br/>")
    .replace(/\n/g, "<br/>");

  // Restore fenced code blocks and tables
  for (let i = 0; i < fenced.length; i++) {
    result = result.replace(`__FENCED__${i}__`, fenced[i]);
  }
  for (let i = 0; i < tables.length; i++) {
    result = result.replace(`__TABLE__${i}__`, tables[i]);
  }
  return result;
}

function MermaidRenderer({ content }: { content: string }) {
  const [svg, setSvg] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [transform, setTransform] = useState({ x: 0, y: 0, scale: 1 });
  const containerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef({ dragging: false, startX: 0, startY: 0, origX: 0, origY: 0 });

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      import("mermaid"),
      import("@mermaid-js/layout-elk"),
    ]).then(async ([m, elk]) => {
      m.default.registerLayoutLoaders(elk.default);
      m.default.initialize({ startOnLoad: false, theme: "dark", securityLevel: "strict", layout: "elk" });
      try {
        const { svg } = await m.default.render(`mermaid-${Date.now()}`, content);
        if (!cancelled) {
          setSvg(svg);
          // Auto-fit: scale to container width after render
          requestAnimationFrame(() => {
            const el = containerRef.current;
            if (!el) return;
            const svgEl = el.querySelector("svg");
            if (!svgEl) return;
            const svgW = svgEl.viewBox?.baseVal?.width || svgEl.getBoundingClientRect().width;
            const containerW = el.clientWidth;
            if (svgW > 0 && containerW > 0) {
              const fitScale = Math.min(1, containerW / svgW);
              setTransform({ x: 0, y: 0, scale: fitScale });
            } else {
              setTransform({ x: 0, y: 0, scale: 1 });
            }
          });
        }
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      }
    });
    return () => { cancelled = true; };
  }, [content]);


  // Wheel zoom (only with Alt/Option key)
  const handleWheel = useCallback((e: React.WheelEvent) => {
    if (!e.altKey) return;
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    // Mouse position relative to container
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const factor = e.deltaY > 0 ? 1.04 : 0.96;

    setTransform(prev => {
      const newScale = Math.max(0.1, Math.min(20, prev.scale * factor));
      const ratio = newScale / prev.scale;
      // Adjust translation so the point under cursor stays fixed
      return {
        x: mx - ratio * (mx - prev.x),
        y: my - ratio * (my - prev.y),
        scale: newScale,
      };
    });
  }, []);

  // Pan via drag (only with Alt/Option key, skip buttons)
  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return;
    if (!e.altKey) return; // require Option/Alt key for pan
    if ((e.target as HTMLElement).closest("button")) return;
    e.stopPropagation();
    e.preventDefault();
    dragRef.current = { dragging: true, startX: e.clientX, startY: e.clientY, origX: transform.x, origY: transform.y };
    const el = containerRef.current;
    if (el) el.setPointerCapture(e.pointerId);
  }, [transform.x, transform.y]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragRef.current.dragging) return;
    e.stopPropagation();
    setTransform(prev => ({
      ...prev,
      x: dragRef.current.origX + (e.clientX - dragRef.current.startX),
      y: dragRef.current.origY + (e.clientY - dragRef.current.startY),
    }));
  }, []);

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    if (!dragRef.current.dragging) return;
    e.stopPropagation();
    dragRef.current.dragging = false;
  }, []);

  const [altHeld, setAltHeld] = useState(false);

  useEffect(() => {
    const down = (e: KeyboardEvent) => { if (e.altKey) setAltHeld(true); };
    const up = (e: KeyboardEvent) => { if (!e.altKey) setAltHeld(false); };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => { window.removeEventListener("keydown", down); window.removeEventListener("keyup", up); };
  }, []);

  if (error) return <pre style={{ color: "#f66", fontSize: 12 }}>{error}</pre>;
  if (!svg) return <div style={{ color: "#666" }}>Rendering diagram...</div>;

  return (
    <div
      ref={containerRef}
      style={{ position: "relative", width: "100%", height: "100%", overflow: "hidden", cursor: altHeld ? "grab" : "default" }}
      onWheel={handleWheel}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
    >
      <div
        style={{
          transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`,
          transformOrigin: "0 0",
          transition: "none",
        }}
        dangerouslySetInnerHTML={{ __html: svg }}
      />
      {/* Zoom controls */}
      <div style={{
        position: "absolute", bottom: 6, right: 6,
        display: "flex", gap: 2, opacity: 0.6,
      }}>
        <button
          onClick={(e) => { e.stopPropagation(); setTransform(prev => ({ ...prev, scale: Math.min(20, prev.scale * 1.3) })); }}
          style={zoomBtnStyle}
          title="Zoom in"
        >+</button>
        <button
          onClick={(e) => { e.stopPropagation(); setTransform(prev => ({ ...prev, scale: Math.max(0.1, prev.scale * 0.7) })); }}
          style={zoomBtnStyle}
          title="Zoom out"
        >-</button>
        <button
          onClick={(e) => { e.stopPropagation(); setTransform({ x: 0, y: 0, scale: 1 }); }}
          style={zoomBtnStyle}
          title="Reset"
        >R</button>
      </div>
    </div>
  );
}

const zoomBtnStyle: React.CSSProperties = {
  background: "rgba(255,255,255,0.1)",
  border: "1px solid rgba(255,255,255,0.15)",
  color: "#ccc",
  borderRadius: 4,
  width: 24,
  height: 24,
  cursor: "pointer",
  fontSize: 13,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 0,
};
