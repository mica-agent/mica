import { useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import mermaid from "mermaid";
import type { LayerFile } from "../api/layerFiles";

interface Props {
  file: LayerFile;
  layerColor: string;
  onEdit: () => void;
  onDelete: () => void;
  isGoal?: boolean;
  isBrief?: boolean;
}

function MermaidRenderer({ content, id }: { content: string; id: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState("");
  const renderCountRef = useRef(0);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let cancelled = false;
    renderCountRef.current += 1;
    const uniqueId = `mermaid-${id.replace(/[^a-zA-Z0-9-]/g, "_")}-${renderCountRef.current}-${Date.now()}`;

    // Create a temporary off-screen element for mermaid to render into
    const tempDiv = document.createElement("div");
    tempDiv.id = uniqueId;
    tempDiv.style.position = "absolute";
    tempDiv.style.left = "-9999px";
    document.body.appendChild(tempDiv);

    (async () => {
      try {
        const { svg } = await mermaid.render(uniqueId, content);
        if (!cancelled) {
          container.innerHTML = svg;
          setError("");
        }
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      } finally {
        // Clean up temp element
        try { document.body.removeChild(tempDiv); } catch {}
      }
    })();

    return () => { cancelled = true; };
  }, [content, id]);

  if (error) {
    return <pre className="wb-mermaid-error">{error}</pre>;
  }
  return <div ref={containerRef} className="wb-mermaid-svg" />;
}

function fileTitle(name: string): string {
  return name
    .replace(/\.(txt|md|mmd)$/, "")
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function typeLabel(type: LayerFile["type"]): string {
  if (type === "markdown") return "MD";
  if (type === "mermaid") return "MMD";
  return "TXT";
}

export default function FileCard({ file, layerColor, onEdit, onDelete, isGoal, isBrief }: Props) {
  const isSystem = isGoal || isBrief;
  const cardClass = isGoal ? "wb-card--goal" : isBrief ? "wb-card--brief" : "";
  const badge = isGoal ? "GOAL" : isBrief ? "BRIEF" : typeLabel(file.type);
  const title = isGoal ? "Layer Goal" : isBrief ? "Agent Brief" : fileTitle(file.name);

  return (
    <div
      className={`wb-card ${cardClass}`}
      style={{ "--layer-color": layerColor } as React.CSSProperties}
    >
      <div className="wb-card-header">
        <span className="wb-card-type">{badge}</span>
        <span className="wb-card-title">{title}</span>
        {isSystem && (
          <span className="wb-card-system-hint">editable by you & the agent</span>
        )}
        <div className="wb-card-actions">
          <button onClick={onEdit} title="Edit" className="wb-card-btn">
            &#9998;
          </button>
          <button onClick={onDelete} title="Delete" className="wb-card-btn wb-card-btn--danger">
            &times;
          </button>
        </div>
      </div>
      <div className="wb-card-body" onClick={onEdit}>
        {file.type === "text" && (
          <pre className="wb-card-text">{file.content}</pre>
        )}
        {file.type === "markdown" && (
          <div className="wb-card-markdown">
            <Markdown>{file.content}</Markdown>
          </div>
        )}
        {file.type === "mermaid" && (
          <MermaidRenderer content={file.content} id={file.name} />
        )}
      </div>
      <div className="wb-card-footer">
        <span className="wb-card-filename">{file.name}</span>
      </div>
    </div>
  );
}
