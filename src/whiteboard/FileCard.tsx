import { useEffect, useRef, useState } from "react";
import type { LayerId, CardMeta } from "../api/layerFiles";
import WidgetRuntime from "./WidgetRuntime";

interface Props {
  filename: string;
  html: string;
  exports: string[];
  meta: CardMeta;
  layerId: LayerId;
  layerColor: string;
  onEdit: () => void;
  onDelete: () => void;
  onExpand: () => void;
  callExport: (layer: LayerId, filename: string, fn: string, args?: Record<string, unknown>) => Promise<unknown>;
}

export default function FileCard({ filename, html, exports: exportFns, meta, layerId, layerColor, onEdit, onDelete, onExpand, callExport }: Props) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const [overflows, setOverflows] = useState(false);

  const cardClass = meta.isSystem ? `wb-card--${meta.cardClass}` : "";

  // Detect overflow after render
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const timer = setTimeout(() => {
      setOverflows(el.scrollHeight > el.clientHeight + 10);
    }, 100);
    return () => clearTimeout(timer);
  }, [html]);

  return (
    <div
      className={`wb-card ${cardClass}`}
      style={{ "--layer-color": layerColor } as React.CSSProperties}
      onClick={onExpand}
    >
      <div className="wb-card-header">
        <span className="wb-card-type">{meta.badge}</span>
        <span className="wb-card-title">{meta.title}</span>
        {meta.isSystem && meta.cardClass !== "todo" && meta.cardClass !== "chat" && (
          <span className="wb-card-system-hint">editable by you &amp; the agent</span>
        )}
        <div className="wb-card-actions">
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
          layer={layerId}
          filename={filename}
          callExport={callExport}
        />
      </div>
      <div className="wb-card-footer">
        <span className="wb-card-filename">{filename}</span>
        {overflows && <span className="wb-card-expand-hint">Click to read</span>}
      </div>
    </div>
  );
}
