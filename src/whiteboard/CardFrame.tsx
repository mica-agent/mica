// CardFrame — File card that renders content client-side.
// Uses DraggableCard for drag/resize. Adds file-specific features (flip, edit, render).

import { useState, useCallback, useEffect } from "react";
import type { CanvasFile } from "../api/canvasFiles";
import { fetchCardBack, saveCardBack } from "../api/canvasFiles";
import DraggableCard from "./DraggableCard";
import type { CardLayout } from "./DraggableCard";

interface Props {
  file: CanvasFile;
  layout: CardLayout;
  onLayoutChange: (layout: CardLayout) => void;
  onEdit: () => void;
  onDelete: () => void;
  onSave: (content: string) => void;
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
  const [flipped, setFlipped] = useState(false);
  const [backContent, setBackContent] = useState("");
  const [backLoaded, setBackLoaded] = useState(false);

  const fileType = getFileType(file.name);

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

  const actions = (
    <>
      <button onClick={() => { setFlipped(!flipped); setBackLoaded(false); }} style={actionBtnStyle} title={flipped ? "Show content" : "Card info"}>
        &#8645;
      </button>
      <button onClick={onEdit} style={actionBtnStyle} title="Edit">
        &#9998;
      </button>
      <button onClick={onDelete} style={actionBtnStyle} title="Delete">
        &times;
      </button>
    </>
  );

  return (
    <DraggableCard
      layout={layout}
      onLayoutChange={onLayoutChange}
      title={file.name}
      subtitle={fileType}
      actions={actions}
    >
      {flipped ? (
        <div style={{ padding: 12, display: "flex", flexDirection: "column", height: "100%" }}>
          <div style={{ color: "#888", fontSize: 11, marginBottom: 8 }}>Card info — how this card was generated, AI guidance</div>
          <textarea
            value={backContent}
            onChange={(e) => setBackContent(e.target.value)}
            onBlur={handleSaveBack}
            placeholder="Add info about this card..."
            style={{
              flex: 1, background: "#1a1a2e", color: "#ccc", border: "1px solid #444",
              borderRadius: 4, padding: 8, fontSize: 13, fontFamily: "monospace",
              resize: "none", outline: "none",
            }}
          />
        </div>
      ) : (
        <div style={{ flex: 1, overflow: "auto", padding: 12 }}>
          <FileContent content={file.content} type={fileType} />
        </div>
      )}
    </DraggableCard>
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
