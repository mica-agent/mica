// CardFrame — wraps a file as a .wb-card element on the canvas.
//
// Renders the wb-card chrome (header, body, footer, resize handle).
// The canvas card class owns positioning, drag, and resize via event
// delegation on #canvas-freeform.
//
// Content is loaded lazily from the API — the file list only provides metadata.
// Card classes get content via mica.getContent() (async, fetches from API).
// Fallback renderer loads content for text files on mount.

import { useState, useRef, useEffect, useCallback } from "react";
import type { CanvasFile } from "../api/canvasFiles";
import { fetchCardBack, saveCardBack, getFileUrl } from "../api/canvasFiles";
import CardRuntime from "./CardRuntime";

interface RenderedCardData {
  html: string | null;
  cardClass: string | null;
  exports?: string[];
  dependencies?: { scripts?: string[]; styles?: string[] };
  meta?: Record<string, string>;
}

interface Props {
  /** Per-tab active project name. Threaded into every project-scoped API call. */
  project: string;
  file: CanvasFile;
  onEdit: () => void;
  onDelete: () => void;
  onUnpin?: () => void;
}

function getFileType(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() || "";
  if (["png", "jpg", "jpeg", "gif", "svg", "webp"].includes(ext)) return "image";
  if (["pdf"].includes(ext)) return "binary";
  // Everything else is resolved via the card-class registry. Files with no
  // class render as the "???" unknown-type placeholder (see body render
  // below), not as a text fallback. Text files have their own card class
  // (card-classes/text/); other formats need a class to render.
  return "unknown";
}

function getFileBadge(type: string): string {
  switch (type) {
    case "image": return "IMG";
    case "binary": return "BIN";
    default: return "???";
  }
}

export default function CardFrame({ project, file, onEdit, onDelete, onUnpin }: Props) {
  const [flipped, setFlipped] = useState(false);
  const [backContent, setBackContent] = useState("");
  const [backLoaded, setBackLoaded] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [overflows, setOverflows] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // Meta cards (canvas-back, skills) live in the sidebar and use an
  // expand/collapse toggle instead of the flip-card button — flipping doesn't
  // really apply to config cards, and collapsing saves vertical space when
  // multiple meta cards stack in the sidebar.
  const [collapsed, setCollapsed] = useState(false);

  const [renderedCard, setRenderedCard] = useState<RenderedCardData | null>(null);
  const [renderChecked, setRenderChecked] = useState(false);

  const fileType = getFileType(file.name);
  // Prefer the badge the server resolved from metadata.json (sent with the
  // file list — synchronous on mount, no flash). Fall back to renderedCard
  // metadata once loaded, then to the extension-based default ("???" for
  // anything without a registered card class).
  const badge = file.badge || renderedCard?.meta?.badge || getFileBadge(fileType);

  // Load card class (card.html format)
  useEffect(() => {
    const API_BASE = import.meta.env.VITE_MICA_API || "";
    const ext = file.name.split(".").pop()?.toLowerCase() || "";
    const headers = { "X-Mica-Project": project };

    async function loadCardClass() {
      const classesRes = await fetch(`${API_BASE}/api/card-classes`, { headers });
      const classes = await classesRes.json() as Record<string, { format?: string; hasCss?: boolean; hasJs?: boolean; hasMetadata?: boolean }>;
      const cls = classes[ext];
      if (!cls) return null;

      if (cls.format === "html") {
        const htmlRes = await fetch(`${API_BASE}/api/card-classes/${ext}/card.html`, { headers });
        if (!htmlRes.ok) return null;
        const cardHtml = await htmlRes.text();

        let cardCss = "";
        if (cls.hasCss) {
          const cssRes = await fetch(`${API_BASE}/api/card-classes/${ext}/card.css`, { headers });
          if (cssRes.ok) cardCss = await cssRes.text();
        }

        let cardJs = "";
        if (cls.hasJs) {
          const jsRes = await fetch(`${API_BASE}/api/card-classes/${ext}/card.js`, { headers });
          if (jsRes.ok) cardJs = await jsRes.text();
        }

        let meta: Record<string, unknown> = {};
        let deps: { scripts?: string[]; styles?: string[] } = {};
        if (cls.hasMetadata) {
          const metaRes = await fetch(`${API_BASE}/api/card-classes/${ext}/metadata.json`, { headers });
          if (metaRes.ok) {
            meta = await metaRes.json();
            deps = (meta.dependencies as { scripts?: string[]; styles?: string[] }) || {};
          }
        }

        // Assemble HTML — no data-mica-content attribute needed.
        // Card scripts use mica.getContent() which fetches from API.
        const assembled =
          `<div data-mica-filename="${file.name}" style="display:flex;flex-direction:column;flex:1;min-height:0;height:100%;">` +
          cardHtml +
          `</div>` +
          (cardCss ? `<style>${cardCss}</style>` : "") +
          (cardJs ? `<script>${cardJs}</script>` : "");

        return {
          html: assembled,
          cardClass: ext,
          exports: [],
          dependencies: deps,
          meta,
        };
      }

      return null;
    }

    loadCardClass()
      .then((result) => {
        setRenderedCard(result);
        setRenderChecked(true);
      })
      .catch(() => {
        setRenderedCard(null);
        setRenderChecked(true);
      });
  }, [file.name, file.modifiedAt, project]);

  // Check overflow
  useEffect(() => {
    const el = bodyRef.current;
    if (!el || flipped) return;
    setOverflows(el.scrollHeight > el.clientHeight + 4);
  }, [flipped]);

  // Load card back on flip
  useEffect(() => {
    if (flipped && !backLoaded) {
      fetchCardBack(project, file.name).then((c) => {
        setBackContent(c);
        setBackLoaded(true);
      });
    }
  }, [flipped, backLoaded, file.name, project]);

  const handleSaveBack = useCallback(() => {
    saveCardBack(project, file.name, backContent);
  }, [file.name, backContent, project]);

  return (
    <div
      ref={(el) => {
        if (!el) return;
        if (el.style.left) el.classList.add("wb-card--positioned");
        el.classList.add("wb-card--resized");
      }}
      className={`wb-card wb-card--resized ${flipped ? "wb-card--flipped" : ""} ${file.meta && collapsed ? "wb-card--collapsed" : ""}`}
      data-filename={file.name}
      data-meta={file.meta ? "true" : undefined}
    >
      {/* Header */}
      <div className="wb-card-header">
        <span className="wb-card-type">{badge}</span>
        <span className="wb-card-title">{file.name}</span>
        <div className="wb-card-actions">
          {file.meta ? (
            <button
              onClick={(e) => { e.stopPropagation(); setCollapsed(!collapsed); }}
              title={collapsed ? "Expand" : "Collapse"}
              className="wb-card-btn"
            >
              {collapsed ? "+" : "\u2212"}
            </button>
          ) : (
            <button
              onClick={(e) => { e.stopPropagation(); setFlipped(!flipped); setBackLoaded(false); }}
              title={flipped ? "Show content" : "Card info"}
              className={`wb-card-btn ${flipped ? "wb-card-btn--active" : ""}`}
            >
              &#8645;
            </button>
          )}
          {(() => { const e = file.name.split(".").pop()?.toLowerCase(); return e === "html" || e === "htm"; })() && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                window.open(getFileUrl(file.name), "_blank");
              }}
              title="Preview in new tab"
              className="wb-card-btn"
            >
              &#8599;
            </button>
          )}
          {/* Expand/contract button — canvas card.js handles the click via
              event delegation, toggles .wb-card--expanded on the outer card,
              and stashes the pre-expand layout in data-prev-layout. No onClick
              here so the click bubbles freely to canvas.js. Meta (sidebar)
              cards don't get the button — they're docked and can't resize. */}
          {!file.meta && (
            <button className="wb-card-btn wb-card-expand-btn" title="Expand to fill screen (click again to restore; Tidy commits the new size)">
              <span className="wb-card-expand-icon">&#10530;</span>
              <span className="wb-card-contract-icon">&#10529;</span>
            </button>
          )}
          <button onClick={(e) => { e.stopPropagation(); onEdit(); }} title="Edit" className="wb-card-btn">
            &#9998;
          </button>
          <button onClick={(e) => { e.stopPropagation(); setConfirmDelete(true); }} title="Remove" className="wb-card-btn wb-card-btn--danger">
            &times;
          </button>
        </div>
      </div>

      {/* Delete/remove confirmation dialog */}
      {confirmDelete && (
        <div
          style={{
            position: "absolute", inset: 0, zIndex: 100,
            background: "rgba(0,0,0,0.85)", borderRadius: 8,
            display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
            gap: 8, padding: 16,
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <div style={{ color: "#aaa", fontSize: 12, marginBottom: 4, textAlign: "center" }}>
            {file.name}
          </div>
          {file.pinned && onUnpin && (
            <button
              onClick={() => { setConfirmDelete(false); onUnpin(); }}
              style={{
                background: "rgba(255,255,255,0.1)", border: "1px solid rgba(255,255,255,0.15)",
                color: "#ccc", padding: "6px 16px", borderRadius: 4, cursor: "pointer", fontSize: 12, width: "100%",
              }}
            >
              Remove from canvas
            </button>
          )}
          <button
            onClick={() => { setConfirmDelete(false); onDelete(); }}
            style={{
              background: "rgba(239,68,68,0.2)", border: "1px solid rgba(239,68,68,0.4)",
              color: "#f87171", padding: "6px 16px", borderRadius: 4, cursor: "pointer", fontSize: 12, width: "100%",
            }}
          >
            Delete file
          </button>
          <button
            onClick={() => setConfirmDelete(false)}
            style={{
              background: "none", border: "1px solid rgba(255,255,255,0.1)",
              color: "#888", padding: "6px 16px", borderRadius: 4, cursor: "pointer", fontSize: 12, width: "100%",
            }}
          >
            Cancel
          </button>
        </div>
      )}

      {/* Body */}
      {flipped ? (
        <div className="wb-card-body" style={{ padding: 12, display: "flex", flexDirection: "column" }}>
          <div style={{ color: "#888", fontSize: 11, marginBottom: 8 }}>
            Card info — how this card was generated, AI guidance
          </div>
          <textarea
            value={backContent}
            onChange={(e) => setBackContent(e.target.value)}
            onBlur={handleSaveBack}
            placeholder="Add info about this card..."
            style={{
              flex: 1, background: "rgba(255,255,255,0.03)", color: "#ccc",
              border: "1px solid rgba(255,255,255,0.1)", borderRadius: 4,
              padding: 8, fontSize: 13, fontFamily: "monospace",
              resize: "none", outline: "none", minHeight: 100,
            }}
          />
        </div>
      ) : renderedCard?.html ? (
        <div className="wb-card-body" style={{ overflow: "hidden", display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
          <CardRuntime
            html={renderedCard.html}
            exports={renderedCard.exports}
            dependencies={renderedCard.dependencies}
            sessionId={file.id ?? `legacy-${file.name}`}
            project={project}
            canvas="_"
            filename={file.name}
          />
        </div>
      ) : fileType === "image" ? (
        <div className="wb-card-body" style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: 8 }}>
          <img src={getFileUrl(file.name)} alt={file.name} style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }} />
        </div>
      ) : fileType === "binary" ? (
        <div className="wb-card-body" style={{ padding: 16, color: "#888", fontSize: 13 }}>
          Binary file — open to view
        </div>
      ) : renderChecked ? (
        // Class check has run and no class resolved. This is the explicit
        // "unknown file type" state — a file at the canvas root whose
        // extension has no matching card class. Before the race fix, this
        // could also happen transiently while a class was still being
        // written; now card-class-changed forces a re-check, so if it's
        // visible here it's genuinely unknown. Loudly visible so the user
        // or agent notices.
        <div className="wb-card-body" style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 24, gap: 10, color: "#888" }}>
          <div style={{ fontSize: 40, fontWeight: 700, color: "#555", letterSpacing: 2 }}>???</div>
          <div style={{ fontSize: 12, textAlign: "center", lineHeight: 1.5 }}>
            No card class for <code style={{ color: "#c9a45d", background: "rgba(255,255,255,0.04)", padding: "1px 6px", borderRadius: 3 }}>.{file.name.split(".").pop()?.toLowerCase() || ""}</code>
          </div>
        </div>
      ) : (
        <div className="wb-card-body" style={{ padding: 16, color: "#666" }}>Loading...</div>
      )}

      {/* Footer */}
      <div className="wb-card-footer">
        <span className="wb-card-filename">{file.name}</span>
      </div>

      {/* Resize handle */}
      <div className="wb-card-resize-handle" />
    </div>
  );
}

