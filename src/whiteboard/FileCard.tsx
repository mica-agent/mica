import { useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import mermaid from "mermaid";
import type { LayerFile } from "../api/layerFiles";

interface Props {
  file: LayerFile;
  layerColor: string;
  onEdit: () => void;
  onDelete: () => void;
  onExpand: () => void;
  isGoal?: boolean;
  isTodo?: boolean;
  isBrief?: boolean;
  isLog?: boolean;
  todoCounts?: { active: number; blocked: number; done: number } | null;
}

function MermaidRenderer({ content, id }: { content: string; id: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState("");
  const renderCountRef = useRef(0);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let cancelled = false;
    renderCountRef.current += 1;
    const uniqueId = `mermaid-${id.replace(/[^a-zA-Z0-9-]/g, "_")}-${renderCountRef.current}-${Date.now()}`;

    const tempDiv = document.createElement("div");
    tempDiv.id = uniqueId;
    tempDiv.style.position = "absolute";
    tempDiv.style.left = "-9999px";
    document.body.appendChild(tempDiv);

    (async () => {
      try {
        const { svg } = await mermaid.render(uniqueId, content);
        if (!cancelled) {
          container.innerHTML = svg;
          setError("");
        }
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      } finally {
        try { document.body.removeChild(tempDiv); } catch {}
      }
    })();

    return () => { cancelled = true; };
  }, [content, id]);

  if (error) return <pre className="wb-mermaid-error">{error}</pre>;
  return <div ref={containerRef} className="wb-mermaid-svg" />;
}

function fileTitle(name: string): string {
  return name
    .replace(/\.(txt|md|mmd)$/, "")
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function typeLabel(type: LayerFile["type"]): string {
  if (type === "markdown") return "MD";
  if (type === "mermaid") return "MMD";
  return "TXT";
}

export default function FileCard({ file, layerColor, onEdit, onDelete, onExpand, isGoal, isTodo, isBrief, isLog, todoCounts }: Props) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const [overflows, setOverflows] = useState(false);
  const isSystem = isGoal || isTodo || isBrief || isLog;
  const cardClass = isGoal ? "wb-card--goal" : isTodo ? "wb-card--todo" : isBrief ? "wb-card--brief" : isLog ? "wb-card--log" : "";
  const badge = isGoal ? "GOAL" : isTodo ? "TODO" : isBrief ? "BRIEF" : isLog ? "LOG" : typeLabel(file.type);
  const title = isGoal ? "Layer Goal" : isTodo ? "To Do" : isBrief ? "Agent Brief" : isLog ? "Activity Log" : fileTitle(file.name);

  // Detect overflow after render
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const timer = setTimeout(() => {
      setOverflows(el.scrollHeight > el.clientHeight + 10);
    }, 100);
    return () => clearTimeout(timer);
  }, [file.content]);

  // Todo status badge
  const todoStatusBadge = isTodo && todoCounts ? (
    <span className="wb-todo-status">
      {todoCounts.active > 0 && <span className="wb-todo-active">{todoCounts.active} active</span>}
      {todoCounts.blocked > 0 && <span className="wb-todo-blocked">{todoCounts.blocked} blocked</span>}
      {todoCounts.done > 0 && <span className="wb-todo-done">{todoCounts.done} done</span>}
    </span>
  ) : null;

  return (
    <div
      className={`wb-card ${cardClass}`}
      style={{ "--layer-color": layerColor } as React.CSSProperties}
      onClick={onExpand}
    >
      <div className="wb-card-header">
        <span className="wb-card-type">{badge}</span>
        <span className="wb-card-title">{title}</span>
        {todoStatusBadge}
        {isSystem && !isTodo && (
          <span className="wb-card-system-hint">editable by you & the agent</span>
        )}
        <div className="wb-card-actions">
          <button onClick={(e) => { e.stopPropagation(); onEdit(); }} title="Edit" className="wb-card-btn">
            &#9998;
          </button>
          {!isSystem && (
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
        {file.type === "text" && (
          <pre className="wb-card-text">{file.content}</pre>
        )}
        {file.type === "markdown" && (
          <div className="wb-card-markdown">
            <Markdown remarkPlugins={[remarkGfm]}>{file.content}</Markdown>
          </div>
        )}
        {file.type === "mermaid" && (
          <MermaidRenderer content={file.content} id={file.name} />
        )}
      </div>
      <div className="wb-card-footer">
        <span className="wb-card-filename">{file.name}</span>
        {overflows && <span className="wb-card-expand-hint">Click to read</span>}
      </div>
    </div>
  );
}
