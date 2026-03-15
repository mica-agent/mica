import { useEffect, useRef, useState } from "react";
import type { LayerId, CardMeta } from "../api/layerFiles";
import WidgetRuntime from "./WidgetRuntime";

interface Props {
  filename: string;
  html: string;
  exports: string[];
  meta: CardMeta;
  projectId: string;
  layerId: LayerId;
  layerColor: string;
  onEdit: () => void;
  onDelete: () => void;
  onExpand: () => void;
}

export default function FileCard({ filename, html, exports: exportFns, meta, projectId, layerId, layerColor, onEdit, onDelete, onExpand }: Props) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const [overflows, setOverflows] = useState(false);

  const cardClass = meta.isSystem ? `wb-card--${meta.cardClass}` : "";
  const isInteractive = exportFns.length > 0;

  // Detect overflow after render
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const timer = setTimeout(() => {
      setOverflows(el.scrollHeight > el.clientHeight + 10);
    }, 100);
    return () => clearTimeout(timer);
  }, [html]);

  // For interactive cards, don't expand when clicking the body — only via header/footer
  const handleCardClick = isInteractive ? undefined : onExpand;

  return (
    <div
      className={`wb-card ${cardClass}`}
      style={{ "--layer-color": layerColor } as React.CSSProperties}
      onClick={handleCardClick}
    >
      <div className="wb-card-header">
        <span className="wb-card-type">{meta.badge}</span>
        <span className="wb-card-title">{meta.title}</span>
        {meta.isSystem && meta.cardClass !== "todo" && meta.cardClass !== "chat" && (
          <span className="wb-card-system-hint">editable by you &amp; the agent</span>
        )}
        <div className="wb-card-actions">
          {isInteractive && (
            <button onClick={(e) => { e.stopPropagation(); onExpand(); }} title="Expand" className="wb-card-btn">
              &#x26F6;
            </button>
          )}
          <button onClick={(e) => { e.stopPropagation(); onEdit(); }} title="Edit" className="wb-card-btn">
            &#9998;
          </button>
          {!meta.isSystem && (
            <button onClick={(e) => { e.stopPropagation(); onDelete(); }} title="Delete" className="wb-card-btn wb-card-btn--danger">
              &times;
            </button>
          )}
        </div>
      </div>
      <div
        ref={bodyRef}
        className={`wb-card-body ${overflows ? "wb-card-body--overflows" : ""}`}
      >
        <WidgetRuntime
          html={html}
          exports={exportFns}
          project={projectId}
          layer={layerId}
          filename={filename}
        />
      </div>
      <div className="wb-card-footer">
        <span className="wb-card-filename">{filename}</span>
        {overflows && <span className="wb-card-expand-hint">Click to read</span>}
      </div>
    </div>
  );
}
