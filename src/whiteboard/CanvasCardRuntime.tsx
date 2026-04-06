// CanvasCardRuntime — thin host for the canvas card class.
//
// Responsibilities (host only):
//   1. Fetch & mount the canvas card via CardRuntime
//   2. Fetch child cards and portal them into #canvas-freeform (owned by card class)
//   3. Listen for file-created/file-deleted to add/remove children
//   4. Provide modals (expand, edit) triggered by child card actions
//
// Layout, positioning, drag, resize, and toolbar are all owned by the
// canvas card class (e.g. simple-project/render.js).

import { useState, useEffect, useCallback, useRef, type MutableRefObject } from "react";
import { createPortal } from "react-dom";
import { fetchProjectCard, fetchProjectChildren, saveFile, deleteFile, fetchFile } from "../api/canvasFiles";
import type { RenderedCard, ProjectCardResponse } from "../api/canvasFiles";
import { on } from "../api/micaSocket";
import CardRuntime from "./CardRuntime";
import CardFrame from "./CardFrame";
import FileEditor from "./FileEditor";
import ExpandedCardView from "./ExpandedCardView";
import "./whiteboard.css";

interface Props {
  projectId: string;
  onReloadRef?: MutableRefObject<(() => void) | null>;
}

export default function CanvasCardRuntime({ projectId, onReloadRef }: Props) {
  const [parentCard, setParentCard] = useState<ProjectCardResponse | null>(null);
  const [children, setChildren] = useState<RenderedCard[]>([]);
  const [loading, setLoading] = useState(true);

  // Modal state
  const [editingFile, setEditingFile] = useState<{ name: string; content: string } | null>(null);
  const [expandedCard, setExpandedCard] = useState<RenderedCard | null>(null);

  // Portal target: the #canvas-freeform element rendered by the card class
  const [freeformEl, setFreeformEl] = useState<HTMLElement | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Canvas card filename — discovered from server, not hardcoded
  const canvasFilename = parentCard?.canvasFilename || "project.project";

  // ── Data loading ────────────────────────────────────────

  const loadProjectCard = useCallback(async () => {
    try {
      const [card, childCards] = await Promise.all([
        fetchProjectCard(projectId),
        fetchProjectChildren(projectId),
      ]);
      setParentCard(card);
      setChildren(childCards);
    } catch (err) {
      console.error("[CanvasCardRuntime] Failed to load project card:", err);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    setLoading(true);
    loadProjectCard();
  }, [loadProjectCard]);

  useEffect(() => {
    if (onReloadRef) onReloadRef.current = loadProjectCard;
    return () => { if (onReloadRef) onReloadRef.current = null; };
  }, [onReloadRef, loadProjectCard]);

  // ── Find freeform container after card class renders ────

  useEffect(() => {
    if (!parentCard || !containerRef.current) return;

    const check = () => {
      const el = containerRef.current?.querySelector("#canvas-freeform");
      if (el) {
        setFreeformEl(el as HTMLElement);
        return true;
      }
      return false;
    };

    if (check()) return;

    // Watch for card class HTML injection
    const obs = new MutationObserver(() => { if (check()) obs.disconnect(); });
    obs.observe(containerRef.current, { childList: true, subtree: true });

    // Fallback: poll briefly in case MutationObserver misses the injection
    let retries = 0;
    const poll = () => {
      if (check()) { obs.disconnect(); return; }
      if (++retries < 20) requestAnimationFrame(poll);
    };
    requestAnimationFrame(poll);

    return () => obs.disconnect();
  }, [parentCard]);

  // ── Real-time updates via WebSocket ─────────────────────

  useEffect(() => {
    function handleFileEvent(msg: unknown) {
      const m = msg as {
        type: string;
        project?: string;
        canvas?: string;
        filename?: string;
        html?: string;
        exports?: string[];
        dependencies?: RenderedCard["dependencies"];
        meta?: RenderedCard["meta"];
      };
      if (m.project !== projectId || m.canvas !== "_root") return;

      // Skip infrastructure files (dot-prefixed) and the canvas card itself
      if (!m.filename || m.filename.startsWith(".") || m.filename === canvasFilename) {
        if (m.filename === canvasFilename) {
          fetchProjectCard(projectId).then(setParentCard).catch(() => {});
        }
        return;
      }

      if (m.type === "file-created" && m.html && m.meta) {
        setChildren((prev) => {
          const card: RenderedCard = {
            filename: m.filename!,
            html: m.html!,
            exports: m.exports || [],
            dependencies: m.dependencies,
            meta: m.meta!,
          };
          const idx = prev.findIndex((c) => c.filename === m.filename);
          if (idx >= 0) {
            const next = [...prev];
            next[idx] = card;
            return next;
          }
          return [...prev, card];
        });
      } else if (m.type === "file-deleted") {
        setChildren((prev) => prev.filter((c) => c.filename !== m.filename));
      }
      // file-changed: card scripts handle via mica.on() — no action here
    }

    const unsub1 = on("file-changed", handleFileEvent);
    const unsub2 = on("file-created", handleFileEvent);
    const unsub3 = on("file-deleted", handleFileEvent);
    return () => { unsub1(); unsub2(); unsub3(); };
  }, [projectId, canvasFilename]);

  // ── File operations (for modals) ────────────────────────

  const handleSave = useCallback(async (filename: string, content: string) => {
    await saveFile(projectId, "_root", filename, content);
    setEditingFile(null);
  }, [projectId]);

  const handleDelete = useCallback(async (filename: string) => {
    await deleteFile(projectId, "_root", filename);
  }, [projectId]);

  const handleEdit = useCallback(async (filename: string) => {
    try {
      const file = await fetchFile(projectId, "_root", filename);
      setExpandedCard(null);
      setEditingFile({ name: file.name, content: file.content });
    } catch (err) {
      console.error("Failed to fetch file for editing:", err);
    }
  }, [projectId]);

  // ── Render ──────────────────────────────────────────────

  if (loading && !parentCard) {
    return <div className="wb-container"><div className="wb-empty">Loading project...</div></div>;
  }

  const canvasColor = "#4a8aff";

  return (
    <div className="wb-container">
      {/* Canvas card class renders toolbar, header, and freeform container */}
      {parentCard && (
        <div ref={containerRef} className="canvas-card-host">
          <CardRuntime
            html={parentCard.html}
            exports={parentCard.exports}
            dependencies={parentCard.dependencies}
            project={projectId}
            canvas="_root"
            filename={canvasFilename}
          />
        </div>
      )}

      {/* Portal child cards into the card class's freeform container */}
      {freeformEl && children.map((card) => createPortal(
        <CardFrame
          key={card.filename}
          filename={card.filename}
          html={card.html}
          exports={card.exports}
          dependencies={card.dependencies}
          meta={card.meta}
          projectId={projectId}
          canvasId="_root"
          canvasColor={canvasColor}
          onEdit={() => handleEdit(card.filename)}
          onDelete={() => handleDelete(card.filename)}
          onExpand={() => setExpandedCard(card)}
        />,
        freeformEl,
      ))}

      {!loading && children.length === 0 && !parentCard && (
        <div className="wb-empty">
          <div className="wb-empty-icon">&#9744;</div>
          <p>No files yet. Create a note, document, or diagram to get started.</p>
        </div>
      )}

      {/* Expanded card reader */}
      {expandedCard && (
        <ExpandedCardView
          filename={expandedCard.filename}
          meta={expandedCard.meta}
          canvasColor={canvasColor}
          onClose={() => setExpandedCard(null)}
          onEdit={() => { handleEdit(expandedCard.filename); setExpandedCard(null); }}
        />
      )}

      {/* Editor modal */}
      {editingFile && (
        <FileEditor
          file={{ name: editingFile.name, type: "markdown" as const, content: editingFile.content, modifiedAt: "" }}
          canvasColor={canvasColor}
          onSave={handleSave}
          onCancel={() => setEditingFile(null)}
        />
      )}
    </div>
  );
}
