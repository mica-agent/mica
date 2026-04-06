import React, { useEffect, useRef, useState, useCallback } from "react";
import type { CanvasId, CardMeta } from "../api/canvasFiles";
import CardRuntime from "./CardRuntime";

interface CardDependencies {
  scripts?: string[];
  styles?: string[];
}

interface Props {
  filename: string;
  html: string;
  exports: string[];
  dependencies?: CardDependencies;
  meta: CardMeta;
  projectId: string;
  canvasId: CanvasId;
  canvasColor: string;
  onEdit: () => void;
  onDelete: () => void;
  onExpand: () => void;
}

export default function CardFrame({ filename, html, exports: exportFns, dependencies, meta, projectId, canvasId, canvasColor, onEdit, onDelete, onExpand }: Props) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const [overflows, setOverflows] = useState(false);

  const cardClass = meta.cardClass === "mermaid" ? `wb-card--${meta.cardClass}` : "";
  const isInteractive = exportFns.length > 0;
  const isResized = cardRef.current?.style.height != null && cardRef.current?.style.height !== "";

  // Detect overflow after render
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const timer = setTimeout(() => {
      setOverflows(el.scrollHeight > el.clientHeight + 10);
    }, 100);
    return () => clearTimeout(timer);
  }, [html]);

  const handleExpandClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onExpand();
  }, [onExpand]);

  return (
    <div
      ref={cardRef}
      data-filename={filename}
      className={`wb-card ${cardClass}`}
      style={{ "--canvas-color": canvasColor } as React.CSSProperties}
    >
      <div
        className="wb-card-header"
        onClick={!isInteractive ? handleExpandClick : undefined}
      >
        <span className="wb-card-type">{meta.badge}</span>
        <span className="wb-card-title">{meta.title}</span>
        <div className="wb-card-actions">
          {isInteractive && (
            <button onClick={(e) => { e.stopPropagation(); onExpand(); }} title="Expand" className="wb-card-btn">
              &#x26F6;
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
      <div
        ref={bodyRef}
        className={`wb-card-body ${overflows && !isResized ? "wb-card-body--overflows" : ""}`}
      >
        <CardRuntime
          html={html}
          exports={exportFns}
          dependencies={dependencies}
          project={projectId}
          canvas={canvasId}
          filename={filename}
        />
      </div>
      <div className="wb-card-footer" onClick={!isInteractive ? handleExpandClick : undefined}>
        <span className="wb-card-filename">{filename}</span>
        {(overflows || meta.cardClass === "mermaid") && (
          <span className="wb-card-expand-hint">
            {meta.cardClass === "mermaid" ? "Click to expand" : "Click to read"}
          </span>
        )}
      </div>
      <div className="wb-card-resize-handle" />
    </div>
  );
}
