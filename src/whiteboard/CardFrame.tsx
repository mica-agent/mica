// CardFrame — Draggable, resizable card that renders file content client-side.
// Detects file type from extension and renders accordingly.

import { useState, useRef, useCallback } from "react";
import type { CanvasFile } from "../api/canvasFiles";

interface CardLayout {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Props {
  file: CanvasFile;
  layout: CardLayout;
  onLayoutChange: (layout: CardLayout) => void;
  onEdit: () => void;
  onDelete: () => void;
  onSave: (content: string) => void;
  projectId: string;
  canvas: string;
}

function getFileType(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() || "";
  if (ext === "md" || ext === "markdown") return "markdown";
  if (ext === "mmd" || ext === "mermaid") return "mermaid";
  if (ext === "json") return "json";
  if (["png", "jpg", "jpeg", "gif", "svg", "webp"].includes(ext)) return "image";
  return "text";
}

export default function CardFrame({ file, layout, onLayoutChange, onEdit, onDelete }: Props) {
  const [isDragging, setIsDragging] = useState(false);
  const [isResizing, setIsResizing] = useState(false);
  const dragStartRef = useRef({ x: 0, y: 0, lx: 0, ly: 0 });
  const resizeStartRef = useRef({ x: 0, y: 0, w: 0, h: 0 });

  const fileType = getFileType(file.name);

  // Drag handlers
  const handleDragStart = useCallback((e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest(".card-actions")) return;
    e.preventDefault();
    setIsDragging(true);
    dragStartRef.current = { x: e.clientX, y: e.clientY, lx: layout.x, ly: layout.y };

    const handleMove = (e: MouseEvent) => {
      const dx = e.clientX - dragStartRef.current.x;
      const dy = e.clientY - dragStartRef.current.y;
      onLayoutChange({ ...layout, x: dragStartRef.current.lx + dx, y: dragStartRef.current.ly + dy });
    };
    const handleUp = () => {
      setIsDragging(false);
      document.removeEventListener("mousemove", handleMove);
      document.removeEventListener("mouseup", handleUp);
    };
    document.addEventListener("mousemove", handleMove);
    document.addEventListener("mouseup", handleUp);
  }, [layout, onLayoutChange]);

  // Resize handlers
  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsResizing(true);
    resizeStartRef.current = { x: e.clientX, y: e.clientY, w: layout.w, h: layout.h };

    const handleMove = (e: MouseEvent) => {
      const dx = e.clientX - resizeStartRef.current.x;
      const dy = e.clientY - resizeStartRef.current.y;
      onLayoutChange({
        ...layout,
        w: Math.max(200, resizeStartRef.current.w + dx),
        h: Math.max(100, resizeStartRef.current.h + dy),
      });
    };
    const handleUp = () => {
      setIsResizing(false);
      document.removeEventListener("mousemove", handleMove);
      document.removeEventListener("mouseup", handleUp);
    };
    document.addEventListener("mousemove", handleMove);
    document.addEventListener("mouseup", handleUp);
  }, [layout, onLayoutChange]);

  return (
    <div
      style={{
        position: "absolute",
        left: layout.x,
        top: layout.y + 50,
        width: layout.w,
        height: layout.h,
        background: "#252540",
        border: "1px solid #333",
        borderRadius: 8,
        overflow: "hidden",
        boxShadow: isDragging ? "0 8px 32px rgba(0,0,0,0.4)" : "0 2px 8px rgba(0,0,0,0.2)",
        cursor: isDragging ? "grabbing" : "default",
        zIndex: isDragging || isResizing ? 1000 : 1,
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* Header */}
      <div
        onMouseDown={handleDragStart}
        style={{
          padding: "6px 12px",
          background: "#1e1e38",
          borderBottom: "1px solid #333",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          cursor: "grab",
          userSelect: "none",
          flexShrink: 0,
        }}
      >
        <span style={{ color: "#aaa", fontSize: 13, fontWeight: 500 }}>
          {file.name}
          <span style={{ color: "#666", marginLeft: 8, fontSize: 11 }}>{fileType}</span>
        </span>
        <div className="card-actions" style={{ display: "flex", gap: 4 }}>
          <button onClick={onEdit} style={actionBtnStyle} title="Edit">
            &#9998;
          </button>
          <button onClick={onDelete} style={actionBtnStyle} title="Delete">
            &times;
          </button>
        </div>
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflow: "auto", padding: 12 }}>
        <FileContent content={file.content} type={fileType} />
      </div>

      {/* Resize handle */}
      <div
        onMouseDown={handleResizeStart}
        style={{
          position: "absolute",
          bottom: 0,
          right: 0,
          width: 16,
          height: 16,
          cursor: "se-resize",
          opacity: 0.3,
        }}
      >
        <svg width="16" height="16" viewBox="0 0 16 16">
          <path d="M14 14L14 8M14 14L8 14" stroke="#888" strokeWidth="2" fill="none" />
        </svg>
      </div>
    </div>
  );
}

// ── File Content Renderer ────────────────────────────────────

function FileContent({ content, type }: { content: string; type: string }) {
  switch (type) {
    case "markdown":
      return (
        <div
          style={{ color: "#ddd", fontSize: 14, lineHeight: 1.6 }}
          dangerouslySetInnerHTML={{ __html: simpleMarkdown(content) }}
        />
      );
    case "mermaid":
      return <MermaidRenderer content={content} />;
    case "json":
      return <pre style={{ color: "#b8d4e3", fontSize: 12, margin: 0, whiteSpace: "pre-wrap" }}>{content}</pre>;
    default:
      return <pre style={{ color: "#ccc", fontSize: 13, margin: 0, whiteSpace: "pre-wrap" }}>{content}</pre>;
  }
}

// ── Simple Markdown Renderer ─────────────────────────────────

function simpleMarkdown(md: string): string {
  return md
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/^### (.+)$/gm, "<h3>$1</h3>")
    .replace(/^## (.+)$/gm, "<h2>$1</h2>")
    .replace(/^# (.+)$/gm, "<h1>$1</h1>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/`(.+?)`/g, "<code style='background:#1a1a2e;padding:1px 4px;border-radius:3px'>$1</code>")
    .replace(/^- \[x\] (.+)$/gm, '<div style="opacity:0.6"><input type="checkbox" checked disabled /> <s>$1</s></div>')
    .replace(/^- \[ \] (.+)$/gm, '<div><input type="checkbox" disabled /> $1</div>')
    .replace(/^- (.+)$/gm, "<li>$1</li>")
    .replace(/\n\n/g, "<br/><br/>")
    .replace(/\n/g, "<br/>");
}

// ── Mermaid Renderer ─────────────────────────────────────────

function MermaidRenderer({ content }: { content: string }) {
  const [svg, setSvg] = useState<string>("");
  const [error, setError] = useState<string>("");

  useState(() => {
    import("mermaid").then(async (m) => {
      m.default.initialize({ startOnLoad: false, theme: "dark", securityLevel: "strict" });
      try {
        const { svg } = await m.default.render(`mermaid-${Date.now()}`, content);
        setSvg(svg);
      } catch (err) {
        setError((err as Error).message);
      }
    });
  });

  if (error) return <pre style={{ color: "#f66", fontSize: 12 }}>{error}</pre>;
  if (!svg) return <div style={{ color: "#666" }}>Rendering diagram...</div>;
  return <div dangerouslySetInnerHTML={{ __html: svg }} />;
}

const actionBtnStyle: React.CSSProperties = {
  background: "transparent",
  color: "#888",
  border: "none",
  cursor: "pointer",
  fontSize: 16,
  padding: "0 4px",
  lineHeight: 1,
};
