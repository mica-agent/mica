import React, { useEffect, useRef, useState, useCallback } from "react";
import type { CanvasId, CardMeta } from "../api/canvasFiles";
import { readCardInternalFile, writeCardInternalFile } from "../api/canvasFiles";
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
  const [flipped, setFlipped] = useState(false);
  const [briefContent, setBriefContent] = useState<string | null>(null);
  const [briefDirty, setBriefDirty] = useState(false);
  const [saving, setSaving] = useState(false);

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

  const [hasBrief, setHasBrief] = useState<boolean | null>(null);

  // Check if brief exists on mount
  useEffect(() => {
    readCardInternalFile(projectId, canvasId, filename, "brief.md")
      .then(() => setHasBrief(true))
      .catch(() => setHasBrief(false));
  }, [projectId, canvasId, filename]);

  // Load brief content when flipped
  useEffect(() => {
    if (!flipped) return;
    readCardInternalFile(projectId, canvasId, filename, "brief.md")
      .then(setBriefContent)
      .catch(() => setBriefContent(null));
  }, [flipped, projectId, canvasId, filename]);

  const handleFlip = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setFlipped(!flipped);
    setBriefDirty(false);
  }, [flipped]);

  const handleSaveBrief = useCallback(async () => {
    if (briefContent === null) return;
    setSaving(true);
    try {
      await writeCardInternalFile(projectId, canvasId, filename, "brief.md", briefContent);
      setBriefDirty(false);
    } catch (err) {
      console.error("Failed to save brief:", err);
    } finally {
      setSaving(false);
    }
  }, [projectId, canvasId, filename, briefContent]);

  const handleExpandClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onExpand();
  }, [onExpand]);

  return (
    <div
      ref={cardRef}
      data-filename={filename}
      className={`wb-card ${cardClass} ${flipped ? "wb-card--flipped" : ""}`}
      style={{ "--canvas-color": canvasColor } as React.CSSProperties}
    >
      <div
        className="wb-card-header"
        onClick={!isInteractive && !flipped ? handleExpandClick : undefined}
      >
        <span className="wb-card-type">{meta.badge}</span>
        <span className="wb-card-title">{flipped ? `${meta.title} — Brief` : meta.title}</span>
        <div className="wb-card-actions">
          {hasBrief && (
            <button onClick={handleFlip} title={flipped ? "Show front" : "Show brief"} className={`wb-card-btn ${flipped ? "wb-card-btn--active" : ""}`}>
              &#x21BB;
            </button>
          )}
          {!flipped && isInteractive && (
            <button onClick={(e) => { e.stopPropagation(); onExpand(); }} title="Expand" className="wb-card-btn">
              &#x26F6;
            </button>
          )}
          {!flipped && (
            <button onClick={(e) => { e.stopPropagation(); onEdit(); }} title="Edit" className="wb-card-btn">
              &#9998;
            </button>
          )}
          <button onClick={(e) => { e.stopPropagation(); onDelete(); }} title="Delete" className="wb-card-btn wb-card-btn--danger">
            &times;
          </button>
        </div>
      </div>

      {flipped ? (
        <div className="wb-card-body wb-card-brief">
          {briefContent !== null ? (
            <>
              <textarea
                className="wb-card-brief-editor"
                value={briefContent}
                onChange={(e) => { setBriefContent(e.target.value); setBriefDirty(true); }}
                placeholder="No brief — write agent instructions here..."
                spellCheck={false}
              />
              {briefDirty && (
                <button
                  className="wb-card-brief-save"
                  onClick={handleSaveBrief}
                  disabled={saving}
                >
                  {saving ? "Saving..." : "Save Brief"}
                </button>
              )}
            </>
          ) : (
            <div className="wb-card-brief-empty">
              No brief file for this card.
            </div>
          )}
        </div>
      ) : (
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
      )}

      <div className="wb-card-footer" onClick={!isInteractive && !flipped ? handleExpandClick : undefined}>
        <span className="wb-card-filename">{filename}</span>
        {!flipped && (overflows || meta.cardClass === "mermaid") && (
          <span className="wb-card-expand-hint">
            {meta.cardClass === "mermaid" ? "Click to expand" : "Click to read"}
          </span>
        )}
      </div>
      <div className="wb-card-resize-handle" />
    </div>
  );
}
