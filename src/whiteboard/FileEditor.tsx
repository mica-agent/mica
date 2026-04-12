import { useState, useEffect, useRef } from "react";
import mermaid from "mermaid";
import type { CanvasFile } from "../api/canvasFiles";

interface Props {
  file?: CanvasFile;
  isNew?: boolean;
  onSave: (content: string, filename?: string) => void;
  onClose: () => void;
}

let mermaidCounter = 0;

function MermaidPreview({ content }: { content: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState("");
  const [hasContent, setHasContent] = useState(false);

  useEffect(() => {
    if (!content.trim()) {
      setHasContent(false);
      setError("");
      if (containerRef.current) containerRef.current.innerHTML = "";
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      mermaidCounter += 1;
      const uniqueId = `mermaid-preview-${mermaidCounter}-${Date.now()}`;
      const tempDiv = document.createElement("div");
      tempDiv.id = uniqueId;
      tempDiv.style.position = "absolute";
      tempDiv.style.left = "-9999px";
      document.body.appendChild(tempDiv);
      try {
        const { svg } = await mermaid.render(uniqueId, content);
        if (!cancelled && containerRef.current) {
          containerRef.current.innerHTML = svg;
          setHasContent(true);
          setError("");
        }
      } catch (err) {
        if (!cancelled) {
          setError((err as Error).message);
          setHasContent(false);
        }
      } finally {
        try { document.body.removeChild(tempDiv); } catch {}
      }
    }, 500);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [content]);

  if (error) return <pre style={{ color: "#f66", fontSize: 12 }}>{error}</pre>;
  if (!hasContent) return <div style={{ color: "#666" }}>Mermaid preview</div>;
  return <div ref={containerRef} />;
}

export default function FileEditor({ file, isNew, onSave, onClose }: Props) {
  const [filename, setFilename] = useState(file?.name ?? "");
  const [content, setContent] = useState(file?.content ?? "");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const ext = filename.split(".").pop()?.toLowerCase() || "";
  const isMermaid = ext === "mmd" || ext === "mermaid";

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  function handleSave() {
    if (isNew) {
      let finalName = filename.trim();
      if (!finalName) return;
      if (!/\.\w+$/.test(finalName)) finalName += ".md";
      onSave(content, finalName);
    } else {
      onSave(content);
    }
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)",
        display: "flex", alignItems: "center", justifyContent: "center", zIndex: 2000,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "#1e1e38", borderRadius: 12, width: isMermaid ? "80vw" : "60vw",
          maxWidth: 900, maxHeight: "80vh", display: "flex", flexDirection: "column",
          border: "1px solid #333",
        }}
      >
        {/* Header */}
        <div style={{
          padding: "12px 16px", borderBottom: "1px solid #333",
          display: "flex", justifyContent: "space-between", alignItems: "center",
        }}>
          <span style={{ color: "#ccc", fontWeight: 600 }}>
            {isNew ? "New File" : `Edit: ${file?.name}`}
          </span>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "#888", fontSize: 20, cursor: "pointer" }}>
            &times;
          </button>
        </div>

        {/* Filename input for new files */}
        {isNew && (
          <input
            type="text"
            placeholder="filename.md"
            value={filename}
            onChange={(e) => setFilename(e.target.value)}
            style={{
              margin: "12px 16px 0", padding: "8px 12px",
              background: "#252540", color: "#ccc", border: "1px solid #444",
              borderRadius: 6, fontSize: 14, outline: "none",
            }}
          />
        )}

        {/* Editor body */}
        <div style={{ flex: 1, display: "flex", overflow: "hidden", padding: 16, gap: 16 }}>
          <textarea
            ref={textareaRef}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder={isMermaid ? "graph TD\n    A[Start] --> B[End]" : "Start typing..."}
            style={{
              flex: 1, background: "#252540", color: "#ddd", border: "1px solid #444",
              borderRadius: 6, padding: 12, fontSize: 14, fontFamily: "monospace",
              resize: "none", outline: "none", minHeight: 300,
            }}
          />
          {isMermaid && (
            <div style={{
              flex: 1, background: "#252540", border: "1px solid #444",
              borderRadius: 6, padding: 12, overflow: "auto",
            }}>
              <MermaidPreview content={content} />
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{
          padding: "12px 16px", borderTop: "1px solid #333",
          display: "flex", justifyContent: "flex-end", gap: 8,
        }}>
          <button onClick={onClose} style={{ ...footerBtnStyle, background: "#333" }}>Cancel</button>
          <button
            onClick={handleSave}
            disabled={isNew && !filename.trim()}
            style={{ ...footerBtnStyle, background: "#4a4a8a", opacity: (isNew && !filename.trim()) ? 0.5 : 1 }}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

const footerBtnStyle: React.CSSProperties = {
  color: "#ccc",
  border: "none",
  borderRadius: 6,
  padding: "8px 20px",
  cursor: "pointer",
  fontSize: 14,
};
