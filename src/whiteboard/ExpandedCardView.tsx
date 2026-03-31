import { useEffect, useState, useRef, useCallback } from "react";
import type { CanvasId, CardMeta } from "../api/canvasFiles";
import WidgetRuntime from "./WidgetRuntime";

interface Props {
  filename: string;
  html: string;
  exports: string[];
  meta: CardMeta;
  projectId: string;
  canvasId: CanvasId;
  canvasColor: string;
  onClose: () => void;
  onEdit: () => void;
}

export default function ExpandedCardView({ filename, html, exports: exportFns, meta, projectId, canvasId, canvasColor, onClose, onEdit }: Props) {
  const isMermaid = meta.cardClass === "mermaid";

  // Pan/zoom state for diagrams
  const [scale, setScale] = useState(1);
  const [translate, setTranslate] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const dragStart = useRef({ x: 0, y: 0 });
  const translateStart = useRef({ x: 0, y: 0 });
  const containerRef = useRef<HTMLDivElement>(null);
  const svgCloneRef = useRef<HTMLDivElement>(null);

  // Close on Escape
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // For mermaid cards: clone the already-rendered SVG from the inline card
  // instead of re-rendering via WidgetRuntime (which causes mermaid state conflicts).
  useEffect(() => {
    if (!isMermaid || !svgCloneRef.current) return;
    // Find the inline card's rendered SVG by filename
    const inlineCard = document.querySelector(`[data-filename="${CSS.escape(filename)}"] .wb-card-body svg`);
    if (inlineCard) {
      const clone = inlineCard.cloneNode(true) as SVGElement;
      clone.setAttribute("width", "100%");
      clone.removeAttribute("height");
      clone.style.maxWidth = "none";
      svgCloneRef.current.innerHTML = "";
      svgCloneRef.current.appendChild(clone);
    } else {
      // Fallback: if we can't find the SVG, show a message
      svgCloneRef.current.innerHTML = '<div style="color:#8b949e;padding:20px;text-align:center;">Diagram preview not available</div>';
    }
  }, [isMermaid, filename]);

  // Zoom via mouse wheel
  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    setScale((s) => Math.min(Math.max(s * delta, 0.1), 5));
  }, []);

  // Drag to pan
  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    setDragging(true);
    dragStart.current = { x: e.clientX, y: e.clientY };
    translateStart.current = { ...translate };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, [translate]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragging) return;
    setTranslate({
      x: translateStart.current.x + (e.clientX - dragStart.current.x),
      y: translateStart.current.y + (e.clientY - dragStart.current.y),
    });
  }, [dragging]);

  const handlePointerUp = useCallback(() => {
    setDragging(false);
  }, []);

  const resetView = useCallback(() => {
    setScale(1);
    setTranslate({ x: 0, y: 0 });
  }, []);

  const zoomIn = useCallback(() => setScale((s) => Math.min(s * 1.25, 5)), []);
  const zoomOut = useCallback(() => setScale((s) => Math.max(s * 0.8, 0.1)), []);

  return (
    <div className="wb-expanded-overlay" onClick={onClose}>
      <div
        className={`wb-expanded-card ${isMermaid ? "wb-expanded-card--full" : ""}`}
        style={{ "--canvas-color": canvasColor } as React.CSSProperties}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="wb-expanded-header">
          <span className="wb-card-type">{meta.badge}</span>
          <span className="wb-expanded-title">{meta.title}</span>
          <div className="wb-expanded-actions">
            {isMermaid && (
              <div className="wb-zoom-controls">
                <button className="wb-zoom-btn" onClick={zoomOut} title="Zoom out">&minus;</button>
                <span className="wb-zoom-label">{Math.round(scale * 100)}%</span>
                <button className="wb-zoom-btn" onClick={zoomIn} title="Zoom in">+</button>
                <button className="wb-zoom-btn" onClick={resetView} title="Reset zoom">Reset</button>
              </div>
            )}
            <button className="wb-btn wb-btn--tool" onClick={onEdit}>
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

        {isMermaid ? (
          <div
            ref={containerRef}
            className="wb-panzoom-container"
            onWheel={handleWheel}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
          >
            <div
              className="wb-panzoom-inner"
              style={{ transform: `translate(${translate.x}px, ${translate.y}px) scale(${scale})` }}
            >
              <div ref={svgCloneRef} style={{ width: "100%" }} />
            </div>
          </div>
        ) : (
          <div className="wb-expanded-body">
            <WidgetRuntime
              html={html}
              exports={exportFns}
              project={projectId}
              canvas={canvasId}
              filename={filename}
            />
          </div>
        )}

        <div className="wb-expanded-footer">
          <span className="wb-expanded-filename">{filename}</span>
          {isMermaid && (
            <span className="wb-expanded-filename">Scroll to zoom · Drag to pan</span>
          )}
        </div>
      </div>
    </div>
  );
}
