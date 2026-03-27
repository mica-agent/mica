import { useRef, useState, useEffect, useCallback } from "react";

interface Stroke {
  points: { x: number; y: number; pressure: number }[];
}

interface Props {
  canvasColor: string;
  onConvert: (imageBase64: string) => void;
  onCancel: () => void;
  converting?: boolean;
}

export default function DrawingCanvas({
  canvasColor,
  onConvert,
  onCancel,
  converting,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [currentStroke, setCurrentStroke] = useState<Stroke | null>(null);
  const isDrawing = useRef(false);

  // Set up canvas dimensions
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * window.devicePixelRatio;
    canvas.height = rect.height * window.devicePixelRatio;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
    }
    redraw(canvas, strokes);
  }, []);

  const redraw = useCallback(
    (canvas: HTMLCanvasElement, strokesToDraw: Stroke[]) => {
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const rect = canvas.getBoundingClientRect();
      ctx.clearRect(0, 0, rect.width, rect.height);

      // White background
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, rect.width, rect.height);

      // Draw strokes
      ctx.strokeStyle = "#000000";
      ctx.lineCap = "round";
      ctx.lineJoin = "round";

      for (const stroke of strokesToDraw) {
        if (stroke.points.length < 2) continue;
        ctx.beginPath();
        ctx.moveTo(stroke.points[0].x, stroke.points[0].y);
        for (let i = 1; i < stroke.points.length; i++) {
          const p = stroke.points[i];
          ctx.lineWidth = Math.max(1, p.pressure * 4);
          ctx.lineTo(p.x, p.y);
        }
        ctx.stroke();
      }
    },
    []
  );

  // Redraw when strokes change
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas) redraw(canvas, strokes);
  }, [strokes, redraw]);

  function getPoint(e: React.PointerEvent) {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
      pressure: e.pressure || 0.5,
    };
  }

  function onPointerDown(e: React.PointerEvent) {
    isDrawing.current = true;
    const point = getPoint(e);
    setCurrentStroke({ points: [point] });
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }

  function onPointerMove(e: React.PointerEvent) {
    if (!isDrawing.current || !currentStroke) return;
    const point = getPoint(e);
    const updated = {
      points: [...currentStroke.points, point],
    };
    setCurrentStroke(updated);

    // Live draw current stroke
    const canvas = canvasRef.current;
    if (canvas) {
      redraw(canvas, [...strokes, updated]);
    }
  }

  function onPointerUp() {
    if (!isDrawing.current || !currentStroke) return;
    isDrawing.current = false;
    if (currentStroke.points.length > 1) {
      setStrokes((prev) => [...prev, currentStroke]);
    }
    setCurrentStroke(null);
  }

  function handleUndo() {
    setStrokes((prev) => prev.slice(0, -1));
  }

  function handleClear() {
    setStrokes([]);
  }

  function handleConvert() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    // Ensure final redraw
    redraw(canvas, strokes);
    const dataUrl = canvas.toDataURL("image/png");
    const base64 = dataUrl.replace(/^data:image\/png;base64,/, "");
    onConvert(base64);
  }

  return (
    <div className="wb-drawing-overlay">
      <div className="wb-drawing-container" style={{ "--canvas-color": canvasColor } as React.CSSProperties}>
        <div className="wb-drawing-toolbar">
          <span className="wb-drawing-title">Draw a diagram</span>
          <div className="wb-drawing-actions">
            <button onClick={handleUndo} disabled={strokes.length === 0 || converting} className="wb-btn wb-btn--secondary">
              Undo
            </button>
            <button onClick={handleClear} disabled={strokes.length === 0 || converting} className="wb-btn wb-btn--secondary">
              Clear
            </button>
            <button
              onClick={handleConvert}
              disabled={strokes.length === 0 || converting}
              className="wb-btn wb-btn--primary"
            >
              {converting ? "Converting..." : "Convert to Mermaid"}
            </button>
            <button onClick={onCancel} disabled={converting} className="wb-btn wb-btn--secondary">
              Cancel
            </button>
          </div>
        </div>
        <canvas
          ref={canvasRef}
          className="wb-drawing-canvas"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          style={{ touchAction: "none" }}
        />
      </div>
    </div>
  );
}
