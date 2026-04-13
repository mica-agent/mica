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
  const dragStartRef = useRef({ x: 0, y: 0, lx: 0, ly: 0 });
  const resizeStartRef = useRef({ x: 0, y: 0, w: 0, h: 0 });

  const handleDragStart = useCallback((e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest(".card-actions")) return;
    e.preventDefault();
    setIsDragging(true);
    dragStartRef.current = { x: e.clientX, y: e.clientY, lx: layout.x, ly: layout.y };

    const handleMove = (e: MouseEvent) => {
      const dx = e.clientX - dragStartRef.current.x;
      const dy = e.clientY - dragStartRef.current.y;
      onLayoutChange({ ...layout, x: dragStartRef.current.lx + dx, y: dragStartRef.current.ly + dy });
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
    resizeStartRef.current = { x: e.clientX, y: e.clientY, w: layout.w, h: layout.h };

    const handleMove = (e: MouseEvent) => {
      const dx = e.clientX - resizeStartRef.current.x;
      const dy = e.clientY - resizeStartRef.current.y;
      onLayoutChange({
        ...layout,
        w: Math.max(200, resizeStartRef.current.w + dx),
        h: Math.max(150, resizeStartRef.current.h + dy),
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
