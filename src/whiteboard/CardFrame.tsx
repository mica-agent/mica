import React, { useEffect, useRef, useState, useCallback } from "react";
import type { CanvasId, CardMeta } from "../api/canvasFiles";
import { readCardInternalFile, writeCardInternalFile, readClassFile, writeClassFile } from "../api/canvasFiles";
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

const API_BASE = import.meta.env.VITE_MICA_API || "";

export default function CardFrame({ filename, html, exports: exportFns, dependencies, meta, projectId, canvasId, canvasColor, onEdit, onDelete, onExpand }: Props) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const [overflows, setOverflows] = useState(false);
  const [flipped, setFlipped] = useState(false);
  const [saving, setSaving] = useState(false);

  // Setup approval state
  const [setupRequired, setSetupRequired] = useState(false);
  const [setupScript, setSetupScript] = useState("");
  const [setupRunning, setSetupRunning] = useState(false);
  const [setupOutput, setSetupOutput] = useState("");

  // Class-level state (spec + default brief)
  const [specContent, setSpecContent] = useState("");
  const [specOriginal, setSpecOriginal] = useState("");
  const [defaultBrief, setDefaultBrief] = useState("");
  const [defaultBriefOriginal, setDefaultBriefOriginal] = useState("");

  // Instance-level state (brief)
  const [briefContent, setBriefContent] = useState("");
  const [briefOriginal, setBriefOriginal] = useState("");

  const cardClass = meta.cardClass === "mermaid" ? `wb-card--${meta.cardClass}` : "";
  const isInteractive = exportFns.length > 0;
  const isResized = cardRef.current?.style.height != null && cardRef.current?.style.height !== "";

  const isDirty = specContent !== specOriginal || defaultBrief !== defaultBriefOriginal || briefContent !== briefOriginal;

  // Check if card class needs setup
  useEffect(() => {
    fetch(`${API_BASE}/api/projects/${encodeURIComponent(projectId)}/card-classes/${encodeURIComponent(meta.cardClass)}/setup`)
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data?.required && !data.approved) {
          setSetupRequired(true);
          setSetupScript(data.script);
        } else {
          setSetupRequired(false);
        }
      })
      .catch(() => {});
  }, [projectId, meta.cardClass]);

  const handleApproveSetup = useCallback(async () => {
    setSetupRunning(true);
    setSetupOutput("");
    try {
      const res = await fetch(
        `${API_BASE}/api/projects/${encodeURIComponent(projectId)}/card-classes/${encodeURIComponent(meta.cardClass)}/setup/approve`,
        { method: "POST", headers: { "Content-Type": "application/json" } }
      );
      const data = await res.json();
      if (res.ok) {
        setSetupOutput(data.output || "Setup complete.");
        setSetupRequired(false);
      } else {
        setSetupOutput(`Error: ${data.error}`);
      }
    } catch (err) {
      setSetupOutput(`Error: ${(err as Error).message}`);
    } finally {
      setSetupRunning(false);
    }
  }, [projectId, meta.cardClass]);

  // Detect overflow after render.
  // Uses double-rAF so the browser (including Safari) has completed flex
  // layout before we read scrollHeight/clientHeight.
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    let cancelled = false;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (!cancelled) {
          setOverflows(el.scrollHeight > el.clientHeight + 10);
        }
      });
    });
    return () => { cancelled = true; };
  }, [html]);

  // Load all config files when flipped
  useEffect(() => {
    if (!flipped) return;
    // Class-level: spec.md
    readClassFile(meta.cardClass, "spec.md")
      .then((c) => { setSpecContent(c); setSpecOriginal(c); })
      .catch(() => { setSpecContent(""); setSpecOriginal(""); });
    // Class-level: ~brief.md (default brief)
    readClassFile(meta.cardClass, "~brief.md")
      .then((c) => { setDefaultBrief(c); setDefaultBriefOriginal(c); })
      .catch(() => { setDefaultBrief(""); setDefaultBriefOriginal(""); });
    // Instance-level: brief.md
    readCardInternalFile(projectId, canvasId, filename, "brief.md")
      .then((c) => { setBriefContent(c); setBriefOriginal(c); })
      .catch(() => { setBriefContent(""); setBriefOriginal(""); });
  }, [flipped, meta.cardClass, projectId, canvasId, filename]);

  const handleFlip = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (flipped && isDirty) {
      setSpecContent(specOriginal);
      setDefaultBrief(defaultBriefOriginal);
      setBriefContent(briefOriginal);
    }
    setFlipped(!flipped);
  }, [flipped, isDirty, specOriginal, defaultBriefOriginal, briefOriginal]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      const promises: Promise<void>[] = [];
      if (specContent !== specOriginal) {
        promises.push(writeClassFile(meta.cardClass, "spec.md", specContent));
      }
      if (defaultBrief !== defaultBriefOriginal) {
        promises.push(writeClassFile(meta.cardClass, "~brief.md", defaultBrief));
      }
      if (briefContent !== briefOriginal) {
        promises.push(writeCardInternalFile(projectId, canvasId, filename, "brief.md", briefContent));
      }
      await Promise.all(promises);
      setSpecOriginal(specContent);
      setDefaultBriefOriginal(defaultBrief);
      setBriefOriginal(briefContent);
      setFlipped(false);
    } catch (err) {
      console.error("Failed to save:", err);
    } finally {
      setSaving(false);
    }
  }, [meta.cardClass, projectId, canvasId, filename, specContent, specOriginal, defaultBrief, defaultBriefOriginal, briefContent, briefOriginal]);

  const handleCancel = useCallback(() => {
    setSpecContent(specOriginal);
    setDefaultBrief(defaultBriefOriginal);
    setBriefContent(briefOriginal);
    setFlipped(false);
  }, [specOriginal, defaultBriefOriginal, briefOriginal]);

  const handleExpandClick = useCallback((e: React.MouseEvent) => {
    // Suppress if card was just dragged — the drag handler adds/removes wb-card--dragging
    if (cardRef.current?.dataset.justDragged) return;
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
        <span className="wb-card-title">{flipped ? `${meta.title} — Config` : meta.title}</span>
        <div className="wb-card-actions">
          <button onClick={handleFlip} title={flipped ? "Show front" : "Configure"} className={`wb-card-btn ${flipped ? "wb-card-btn--active" : ""}`}>
            &#x2699;
          </button>
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
        <div className="wb-card-config">
          <div className="wb-card-config-section">
            <div className="wb-card-config-label">Spec <span className="wb-card-config-scope">all {meta.cardClass} cards</span></div>
            <textarea
              className="wb-card-config-editor"
              value={specContent}
              onChange={(e) => setSpecContent(e.target.value)}
              placeholder="What this card type does..."
              spellCheck={false}
            />
          </div>
          <div className="wb-card-config-section">
            <div className="wb-card-config-label">Default Brief <span className="wb-card-config-scope">new {meta.cardClass} cards</span></div>
            <textarea
              className="wb-card-config-editor wb-card-config-editor--small"
              value={defaultBrief}
              onChange={(e) => setDefaultBrief(e.target.value)}
              placeholder="Default brief for new instances..."
              spellCheck={false}
            />
          </div>
          <div className="wb-card-config-section">
            <div className="wb-card-config-label">Brief <span className="wb-card-config-scope">this card only</span></div>
            <textarea
              className="wb-card-config-editor"
              value={briefContent}
              onChange={(e) => setBriefContent(e.target.value)}
              placeholder="What this specific card is for..."
              spellCheck={false}
            />
          </div>
          <div className="wb-card-config-actions">
            <button className="wb-card-brief-cancel" onClick={handleCancel}>Cancel</button>
            <button className="wb-card-brief-save" onClick={handleSave} disabled={saving || !isDirty}>
              {saving ? "Saving..." : "Save"}
            </button>
          </div>
        </div>
      ) : setupRequired ? (
        <div className="wb-card-body" style={{ padding: "16px", color: "#e6edf3", fontSize: "13px" }}>
          <div style={{ marginBottom: "12px", fontWeight: 600 }}>
            Setup required for <em>{meta.cardClass}</em>
          </div>
          <div style={{ marginBottom: "8px", fontSize: "12px", color: "#8b949e" }}>
            This card class needs to install dependencies in the project container:
          </div>
          <pre style={{
            background: "#161b22", border: "1px solid #30363d", borderRadius: "6px",
            padding: "10px", fontSize: "11px", color: "#c9d1d9", overflow: "auto",
            maxHeight: "120px", whiteSpace: "pre-wrap", marginBottom: "12px",
          }}>{setupScript}</pre>
          {setupOutput && (
            <pre style={{
              background: "#0d1117", border: "1px solid #21262d", borderRadius: "4px",
              padding: "8px", fontSize: "10px", color: "#8b949e", maxHeight: "80px",
              overflow: "auto", whiteSpace: "pre-wrap", marginBottom: "12px",
            }}>{setupOutput}</pre>
          )}
          <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
            <button
              onClick={handleApproveSetup}
              disabled={setupRunning}
              style={{
                background: "#238636", color: "#fff", border: "none", borderRadius: "6px",
                padding: "6px 16px", fontSize: "12px", fontWeight: 600, cursor: "pointer",
              }}
            >{setupRunning ? "Installing..." : "Approve & Install"}</button>
          </div>
          <div style={{ marginTop: "8px", fontSize: "11px", color: "#6e7681" }}>
            Runs inside the project container (isolated from host). One-time only.
          </div>
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
