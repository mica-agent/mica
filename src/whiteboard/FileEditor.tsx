import { useState, useEffect, useRef } from "react";
import mermaid from "mermaid";
import type { LayerFile } from "../api/layerFiles";

interface Props {
  file: LayerFile | null; // null = new file
  defaultType?: "text" | "markdown" | "mermaid";
  layerColor: string;
  onSave: (filename: string, content: string) => void;
  onCancel: () => void;
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

  if (error) return <pre className="wb-editor-preview-error">{error}</pre>;
  if (!hasContent) return <div className="wb-editor-preview-empty">Mermaid preview</div>;
  return <div ref={containerRef} />;
}

export default function FileEditor({
  file,
  defaultType,
  layerColor,
  onSave,
  onCancel,
}: Props) {
  const isNew = !file;
  const [filename, setFilename] = useState(file?.name ?? "");
  const [content, setContent] = useState(file?.content ?? "");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const ext = filename.match(/\.(txt|md|mmd)$/)?.[0] ?? "";
  const isMermaid =
    ext === ".mmd" || (!ext && defaultType === "mermaid");

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  function handleSave() {
    let finalName = filename.trim();
    if (!finalName) return;
    // Auto-add extension if missing
    if (!/\.(txt|mmd|md)$/.test(finalName)) {
      if (defaultType === "mermaid") finalName += ".mmd";
      else if (defaultType === "markdown") finalName += ".md";
      else finalName += ".txt";
    }
    // Fix wrong extension: user typed .md but this is a mermaid file
    if (defaultType === "mermaid" && finalName.endsWith(".md") && !finalName.endsWith(".mmd")) {
      finalName = finalName.slice(0, -3) + ".mmd";
    }
    onSave(finalName, content);
  }

  return (
    <div className="wb-editor-overlay" onClick={onCancel}>
      <div
        className="wb-editor"
        style={{ "--layer-color": layerColor } as React.CSSProperties}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="wb-editor-header">
          <span>{isNew ? "New File" : "Edit File"}</span>
          <button onClick={onCancel} className="wb-editor-close">
            &times;
          </button>
        </div>

        {isNew && (
          <input
            className="wb-editor-filename"
            type="text"
            placeholder={defaultType === "mermaid" ? "diagram.mmd" : defaultType === "text" ? "note.txt" : "filename.md"}
            value={filename}
            onChange={(e) => setFilename(e.target.value)}
          />
        )}

        <div className={`wb-editor-body ${isMermaid ? "wb-editor-body--split" : ""}`}>
          <textarea
            ref={textareaRef}
            className="wb-editor-textarea"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder={
              isMermaid
                ? "graph TD\n    A[Start] --> B[End]"
                : "Start typing..."
            }
          />
          {isMermaid && (
            <div className="wb-editor-preview">
              <MermaidPreview content={content} />
            </div>
          )}
        </div>

        <div className="wb-editor-footer">
          <button onClick={onCancel} className="wb-btn wb-btn--secondary">
            Cancel
          </button>
          <button
            onClick={handleSave}
            className="wb-btn wb-btn--primary"
            disabled={!filename.trim()}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
