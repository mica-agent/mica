import { useEffect, useState, useRef, useCallback } from "react";
import type { CanvasId, CardMeta } from "../api/canvasFiles";

interface Props {
  filename: string;
  meta: CardMeta;
  canvasColor: string;
  onClose: () => void;
  onEdit: () => void;
}

/**
 * Expanded card view — reparents the actual card body DOM into a full-screen overlay.
 *
 * Instead of creating a second WidgetRuntime (which causes issues with stateful
 * widgets like mermaid, Three.js, xterm), we move the existing card's DOM into
 * the overlay. The widget stays live — terminals keep their PTY connection,
 * animations continue, etc. On close, the DOM is moved back.
 *
 * This is the same pattern as "detaching" a panel in an IDE.
 */
export default function ExpandedCardView({ filename, meta, canvasColor, onClose, onEdit }: Props) {
  const isMermaid = meta.cardClass === "mermaid";
  const overlayBodyRef = useRef<HTMLDivElement>(null);
  const sourceCardBodyRef = useRef<HTMLElement | null>(null);
  const placeholderRef = useRef<HTMLElement | null>(null);

  // Pan/zoom state (for mermaid and similar static diagrams)
  const [scale, setScale] = useState(1);
  const [translate, setTranslate] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const dragStart = useRef({ x: 0, y: 0 });
  const translateStart = useRef({ x: 0, y: 0 });

  // Close on Escape
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Reparent: move the card body DOM into the overlay on mount, move it back on unmount
  useEffect(() => {
    const overlayBody = overlayBodyRef.current;
    if (!overlayBody) return;

    // Find the inline card's body element
    const inlineCard = document.querySelector(`[data-filename="${CSS.escape(filename)}"]`);
    const cardBody = inlineCard?.querySelector(".wb-card-body") as HTMLElement | null;
    if (!cardBody) return;

    sourceCardBodyRef.current = cardBody;

    // Leave a placeholder in the original position so the card doesn't collapse
    const placeholder = document.createElement("div");
    placeholder.style.cssText = `width:100%;height:${cardBody.offsetHeight}px;`;
    placeholder.className = "wb-card-body";
    cardBody.parentElement?.insertBefore(placeholder, cardBody);
    placeholderRef.current = placeholder;

    // Move the real card body into the overlay
    overlayBody.appendChild(cardBody);

    // Notify the widget that it was resized (xterm fitAddon, etc.)
    window.dispatchEvent(new Event("resize"));

    // Cleanup: move it back on unmount
    return () => {
      if (sourceCardBodyRef.current && placeholderRef.current?.parentElement) {
        placeholderRef.current.parentElement.insertBefore(sourceCardBodyRef.current, placeholderRef.current);
        placeholderRef.current.remove();
        // Re-notify resize so inline card refits
        window.dispatchEvent(new Event("resize"));
      }
    };
  }, [filename]);

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

  // Pan/zoom is only for mermaid-like cards (static diagrams).
  // Interactive cards (terminal, chat, flight-sim) just get a bigger container.
  const showPanZoom = isMermaid;

  return (
    <div className="wb-expanded-overlay" onClick={onClose}>
      <div
        className={`wb-expanded-card ${showPanZoom ? "wb-expanded-card--full" : ""}`}
        style={{ "--canvas-color": canvasColor } as React.CSSProperties}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="wb-expanded-header">
          <span className="wb-card-type">{meta.badge}</span>
          <span className="wb-expanded-title">{meta.title}</span>
          <div className="wb-expanded-actions">
            {showPanZoom && (
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

        {showPanZoom ? (
          <div
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
              <div ref={overlayBodyRef} style={{ width: "100%" }} />
            </div>
          </div>
        ) : (
          <div ref={overlayBodyRef} className="wb-expanded-body" />
        )}

        <div className="wb-expanded-footer">
          <span className="wb-expanded-filename">{filename}</span>
          {showPanZoom && (
            <span className="wb-expanded-filename">Scroll to zoom · Drag to pan</span>
          )}
        </div>
      </div>
    </div>
  );
}
