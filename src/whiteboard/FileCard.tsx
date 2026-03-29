import { useEffect, useRef, useState, useCallback } from "react";
import type { CanvasId, CardMeta } from "../api/canvasFiles";
import WidgetRuntime from "./WidgetRuntime";

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
  rendering?: boolean;
  flash?: boolean;
  resizable?: boolean;
  cardStyle?: React.CSSProperties;
  onEdit: () => void;
  onDelete: () => void;
  onExpand: () => void;
  onResize?: (w: number, h: number) => void;
  onDragEnd?: (x: number, y: number) => void;
}

const MIN_WIDTH = 200;
const MIN_HEIGHT = 120;

export default function FileCard({ filename, html, exports: exportFns, dependencies, meta, projectId, canvasId, canvasColor, rendering, flash, resizable, cardStyle, onEdit, onDelete, onExpand, onResize, onDragEnd }: Props) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const [overflows, setOverflows] = useState(false);
  const [dragging, setDragging] = useState(false);
  const justDragged = useRef(false);

  const cardClass = (meta.isSystem || meta.cardClass === "mermaid") ? `wb-card--${meta.cardClass}` : "";
  const isInteractive = exportFns.length > 0;
  const isResized = cardStyle?.height != null;

  // Detect overflow after render
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const timer = setTimeout(() => {
      setOverflows(el.scrollHeight > el.clientHeight + 10);
    }, 100);
    return () => clearTimeout(timer);
  }, [html]);

  // ── Drag (header) ──────────────────────────────────
  const handleDragStart = useCallback((e: React.PointerEvent) => {
    if (!onDragEnd || !cardRef.current) return;
    e.preventDefault();
    e.stopPropagation();

    const startX = e.clientX;
    const startY = e.clientY;
    const origLeft = cardRef.current.offsetLeft;
    const origTop = cardRef.current.offsetTop;

    setDragging(true);
    let moved = false;

    const onMove = (ev: PointerEvent) => {
      if (!cardRef.current) return;
      moved = true;
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      cardRef.current.style.left = `${Math.max(0, origLeft + dx)}px`;
      cardRef.current.style.top = `${Math.max(0, origTop + dy)}px`;
    };

    const onUp = (ev: PointerEvent) => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      setDragging(false);
      if (moved) {
        justDragged.current = true;
        setTimeout(() => { justDragged.current = false; }, 0);
      }
      if (!cardRef.current) return;
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      onDragEnd(Math.max(0, origLeft + dx), Math.max(0, origTop + dy));
    };

    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  }, [onDragEnd]);

  // ── Resize (bottom-right handle) ───────────────────
  const handleResizeStart = useCallback((e: React.PointerEvent) => {
    if (!onResize || !cardRef.current) return;
    e.preventDefault();
    e.stopPropagation();

    const startX = e.clientX;
    const startY = e.clientY;
    const origW = cardRef.current.offsetWidth;
    const origH = cardRef.current.offsetHeight;

    const onMove = (ev: PointerEvent) => {
      if (!cardRef.current) return;
      const w = Math.max(MIN_WIDTH, origW + (ev.clientX - startX));
      const h = Math.max(MIN_HEIGHT, origH + (ev.clientY - startY));
      cardRef.current.style.width = `${w}px`;
      cardRef.current.style.height = `${h}px`;
    };

    const onUp = (ev: PointerEvent) => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      justDragged.current = true;
      setTimeout(() => { justDragged.current = false; }, 0);
      if (!cardRef.current) return;
      const w = Math.max(MIN_WIDTH, origW + (ev.clientX - startX));
      const h = Math.max(MIN_HEIGHT, origH + (ev.clientY - startY));
      onResize(w, h);
    };

    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  }, [onResize]);

  // Expand on header/footer click only — body is for text selection
  const handleExpandClick = useCallback((e: React.MouseEvent) => {
    if (justDragged.current) return;
    e.stopPropagation();
    onExpand();
  }, [onExpand]);

  const flashClass = flash ? "wb-card--flash" : "";
  const renderingClass = rendering ? "wb-card--rendering" : "";
  const resizedClass = isResized ? "wb-card--resized" : "";
  const draggingClass = dragging ? "wb-card--dragging" : "";

  return (
    <div
      ref={cardRef}
      className={`wb-card ${cardClass} ${flashClass} ${renderingClass} ${resizedClass} ${draggingClass}`}
      style={{ "--canvas-color": canvasColor, ...cardStyle } as React.CSSProperties}
    >
      {rendering && <div className="wb-card-rendering-bar" />}
      <div
        className="wb-card-header"
        onPointerDown={onDragEnd ? handleDragStart : undefined}
        onClick={!isInteractive ? handleExpandClick : undefined}
      >
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
        className={`wb-card-body ${overflows && !isResized ? "wb-card-body--overflows" : ""}`}
      >
        <WidgetRuntime
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
      {resizable && (
        <div
          className="wb-card-resize-handle"
          onPointerDown={handleResizeStart}
        />
      )}
    </div>
  );
}
