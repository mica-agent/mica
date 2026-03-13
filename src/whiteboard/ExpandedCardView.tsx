import { useEffect, useRef } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import mermaid from "mermaid";
import type { LayerFile } from "../api/layerFiles";

interface Props {
  file: LayerFile;
  layerColor: string;
  onClose: () => void;
  onEdit: () => void;
  title: string;
  badge: string;
}

function MermaidRenderer({ content, id }: { content: string; id: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const renderCountRef = useRef(0);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let cancelled = false;
    renderCountRef.current += 1;
    const uniqueId = `mermaid-expanded-${id.replace(/[^a-zA-Z0-9-]/g, "_")}-${renderCountRef.current}-${Date.now()}`;
    const tempDiv = document.createElement("div");
    tempDiv.id = uniqueId;
    tempDiv.style.position = "absolute";
    tempDiv.style.left = "-9999px";
    document.body.appendChild(tempDiv);
    (async () => {
      try {
        const { svg } = await mermaid.render(uniqueId, content);
        if (!cancelled) container.innerHTML = svg;
      } catch {}
      finally { try { document.body.removeChild(tempDiv); } catch {} }
    })();
    return () => { cancelled = true; };
  }, [content, id]);

  return <div ref={containerRef} className="wb-mermaid-svg" />;
}

export default function ExpandedCardView({ file, layerColor, onClose, onEdit, title, badge }: Props) {
  // Close on Escape
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="wb-expanded-overlay" onClick={onClose}>
      <div
        className="wb-expanded-card"
        style={{ "--layer-color": layerColor } as React.CSSProperties}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="wb-expanded-header">
          <span className="wb-card-type">{badge}</span>
          <span className="wb-expanded-title">{title}</span>
          <div className="wb-expanded-actions">
            <button
              className="wb-btn wb-btn--tool"
              onClick={onEdit}
            >
              Edit
            </button>
            <button
              className="wb-card-btn"
              onClick={onClose}
              style={{ fontSize: "1.2rem" }}
            >
              &times;
            </button>
          </div>
        </div>

        <div className="wb-expanded-body">
          {file.type === "text" && (
            <pre className="wb-card-text">{file.content}</pre>
          )}
          {file.type === "markdown" && (
            <div className="wb-card-markdown">
              <Markdown remarkPlugins={[remarkGfm]}>{file.content}</Markdown>
            </div>
          )}
          {file.type === "mermaid" && (
            <MermaidRenderer content={file.content} id={`expanded-${file.name}`} />
          )}
        </div>

        <div className="wb-expanded-footer">
          <span className="wb-expanded-filename">{file.name}</span>
        </div>
      </div>
    </div>
  );
}
