// DraggableCard — generic draggable + resizable card wrapper.
// Used by both file cards and chat cards.

import { useState, useRef, useCallback } from "react";

export interface CardLayout {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Props {
  layout: CardLayout;
  onLayoutChange: (layout: CardLayout) => void;
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}

export default function DraggableCard({ layout, onLayoutChange, title, subtitle, actions, children }: Props) {
  const [isDragging, setIsDragging] = useState(false);
  const [isResizing, setIsResizing] = useState(false);
  const dragRef = useRef({ startX: 0, startY: 0, origX: 0, origY: 0, w: 0, h: 0 });
  const resizeRef = useRef({ startX: 0, startY: 0, origW: 0, origH: 0, x: 0, y: 0 });

  const handleDragStart = useCallback((e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest(".card-actions")) return;
    e.preventDefault();
    setIsDragging(true);
    // Capture everything at drag start — no stale closure issues
    dragRef.current = { startX: e.clientX, startY: e.clientY, origX: layout.x, origY: layout.y, w: layout.w, h: layout.h };

    const handleMove = (e: MouseEvent) => {
      const d = dragRef.current;
      onLayoutChange({
        x: d.origX + (e.clientX - d.startX),
        y: d.origY + (e.clientY - d.startY),
        w: d.w,
        h: d.h,
      });
    };
    const handleUp = () => {
      setIsDragging(false);
      document.removeEventListener("mousemove", handleMove);
      document.removeEventListener("mouseup", handleUp);
    };
    document.addEventListener("mousemove", handleMove);
    document.addEventListener("mouseup", handleUp);
  }, [layout, onLayoutChange]);

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsResizing(true);
    resizeRef.current = { startX: e.clientX, startY: e.clientY, origW: layout.w, origH: layout.h, x: layout.x, y: layout.y };

    const handleMove = (e: MouseEvent) => {
      const d = resizeRef.current;
      onLayoutChange({
        x: d.x,
        y: d.y,
        w: Math.max(200, d.origW + (e.clientX - d.startX)),
        h: Math.max(150, d.origH + (e.clientY - d.startY)),
      });
    };
    const handleUp = () => {
      setIsResizing(false);
      document.removeEventListener("mousemove", handleMove);
      document.removeEventListener("mouseup", handleUp);
    };
    document.addEventListener("mousemove", handleMove);
    document.addEventListener("mouseup", handleUp);
  }, [layout, onLayoutChange]);

  return (
    <div
      style={{
        position: "absolute",
        left: layout.x,
        top: layout.y,
        width: layout.w,
        height: layout.h,
        background: "#252540",
        border: "1px solid #333",
        borderRadius: 8,
        overflow: "hidden",
        boxShadow: isDragging ? "0 8px 32px rgba(0,0,0,0.4)" : "0 2px 8px rgba(0,0,0,0.2)",
        cursor: isDragging ? "grabbing" : "default",
        zIndex: isDragging || isResizing ? 1000 : 1,
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* Header — drag handle */}
      <div
        onMouseDown={handleDragStart}
        style={{
          padding: "6px 12px",
          background: "#1e1e38",
          borderBottom: "1px solid #333",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          cursor: "grab",
          userSelect: "none",
          flexShrink: 0,
        }}
      >
        <span style={{ color: "#aaa", fontSize: 13, fontWeight: 500 }}>
          {title}
          {subtitle && <span style={{ color: "#666", marginLeft: 8, fontSize: 11 }}>{subtitle}</span>}
        </span>
        <div className="card-actions" style={{ display: "flex", gap: 4 }}>
          {actions}
        </div>
      </div>

      {/* Body */}
      <div style={{ flex: 1, minHeight: 0, overflow: "hidden", display: "flex", flexDirection: "column" }}>
        {children}
      </div>

      {/* Resize handle */}
      <div
        onMouseDown={handleResizeStart}
        style={{
          position: "absolute",
          bottom: 0,
          right: 0,
          width: 16,
          height: 16,
          cursor: "se-resize",
          opacity: 0.3,
        }}
      >
        <svg width="16" height="16" viewBox="0 0 16 16">
          <path d="M14 14L14 8M14 14L8 14" stroke="#888" strokeWidth="2" fill="none" />
        </svg>
      </div>
    </div>
  );
}
