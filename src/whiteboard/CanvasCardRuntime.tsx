// CanvasCardRuntime — thin portal host for the canvas card class.
//
// Responsibilities (host only):
//   1. Fetch & mount the canvas card via CardRuntime
//   2. Fetch child files and portal them into #canvas-freeform (owned by card class)
//   3. Listen for file-created/file-deleted/file-changed to update children
//   4. Provide modals (edit, create) triggered by child card actions
//
// Layout, positioning, drag, resize, and toolbar are all owned by the
// canvas card class (card-classes/canvas/render.js). React does NOT
// manage layout state — the canvas card class handles everything via
// event delegation on #canvas-freeform.

import { useState, useEffect, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import { fetchCanvasCard, fetchFiles, fetchFile, saveFile, deleteFile } from "../api/canvasFiles";
import type { RenderedCanvasCard, CanvasFile } from "../api/canvasFiles";
import { on } from "../api/micaSocket";
import CardRuntime from "./CardRuntime";
import CardFrame from "./CardFrame";
import FileEditor from "./FileEditor";
import "./whiteboard.css";

export default function CanvasCardRuntime() {
  // Canvas card (the layout surface itself)
  const [canvasCard, setCanvasCard] = useState<RenderedCanvasCard | null>(null);
  // Child files displayed as cards on the canvas
  const [children, setChildren] = useState<CanvasFile[]>([]);
  const [loading, setLoading] = useState(true);

  // Modal state
  const [editingFile, setEditingFile] = useState<CanvasFile | null>(null);
  const [creatingFile, setCreatingFile] = useState(false);

  // Portal target: the #canvas-freeform element rendered by the canvas card class
  const [freeformEl, setFreeformEl] = useState<HTMLElement | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // ── Data loading ────────────────────────────────────────

  const loadData = useCallback(async (signal?: AbortSignal) => {
    try {
      const [cardResult, childrenResult] = await Promise.allSettled([
        fetchCanvasCard(signal),
        fetchFiles(),
      ]);
      if (signal?.aborted) return;

      if (cardResult.status === "fulfilled") {
        setCanvasCard((prev) =>
          prev?.html === cardResult.value.html ? prev : cardResult.value
        );
      }

      if (childrenResult.status === "fulfilled") {
        setChildren((prev) => {
          const next = childrenResult.value;
          if (
            prev.length === next.length &&
            prev.every((c, i) => c.name === next[i].name && c.content === next[i].content)
          ) {
            return prev;
          }
          return next;
        });
      }
    } catch (err) {
      if (signal?.aborted) return;
      console.error("[CanvasCardRuntime] Failed to load:", err);
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    loadData(controller.signal);
    return () => controller.abort();
  }, [loadData]);

  // ── Find freeform container after card class renders ────

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !canvasCard) return;

    // Reset freeformEl — clear any stale reference from a previous render.
    setFreeformEl(null);

    // CardRuntime (child) runs its effect before this (parent) effect.
    // For canvas (no declared deps), innerHTML is injected synchronously
    // in CardRuntime's effect, so #canvas-freeform is already in the DOM.
    // Always check isConnected to reject stale elements from previous renders.
    const poll = setInterval(() => {
      const el = container.querySelector("#canvas-freeform");
      if (el && (el as HTMLElement).isConnected) {
        setFreeformEl(el as HTMLElement);
        clearInterval(poll);
      }
    }, 50);
    return () => clearInterval(poll);
  }, [canvasCard]);

  // ── Real-time updates via WebSocket ─────────────────────

  useEffect(() => {
    const unsub1 = on("file-created", async (msg: unknown) => {
      const m = msg as { filename?: string };
      if (!m.filename || m.filename.startsWith(".")) return;
      try {
        const file = await fetchFile(m.filename);
        setChildren((prev) => [
          ...prev.filter((f) => f.name !== m.filename),
          file,
        ]);
      } catch { /* ignore */ }
    });

    const unsub2 = on("file-changed", async (msg: unknown) => {
      const m = msg as { filename?: string };
      if (!m.filename || m.filename.startsWith(".")) return;
      try {
        const file = await fetchFile(m.filename);
        setChildren((prev) =>
          prev.map((f) => (f.name === m.filename ? file : f))
        );
      } catch { /* ignore */ }
    });

    const unsub3 = on("file-deleted", (msg: unknown) => {
      const m = msg as { filename?: string };
      if (!m.filename) return;
      setChildren((prev) => prev.filter((f) => f.name !== m.filename));
    });

    return () => { unsub1(); unsub2(); unsub3(); };
  }, []);

  // ── File operations (for modals) ────────────────────────

  const handleSave = useCallback(async (content: string, filename?: string) => {
    const name = filename || editingFile?.name;
    if (!name) return;
    await saveFile(name, content);
    setEditingFile(null);
    setCreatingFile(false);
  }, [editingFile]);

  const handleDelete = useCallback(async (filename: string) => {
    await deleteFile(filename);
  }, []);

  const handleEdit = useCallback(async (filename: string) => {
    try {
      const file = await fetchFile(filename);
      setEditingFile(file);
    } catch (err) {
      console.error("Failed to fetch file for editing:", err);
    }
  }, []);

  // ── Render ──────────────────────────────────────────────

  if (loading && !canvasCard) {
    return (
      <div className="wb-container">
        <div className="wb-empty">Loading project...</div>
      </div>
    );
  }

  return (
    <div className="wb-container">
      {/* Canvas card class renders toolbar, freeform container, and owns all layout */}
      {canvasCard && (
        <div ref={containerRef} className="canvas-card-host">
          <CardRuntime
            html={canvasCard.html}
            exports={canvasCard.exports}
            dependencies={canvasCard.dependencies}
            project="_"
            canvas="_"
            filename="__canvas__"
          />
        </div>
      )}

      {/* Portal child cards into the card class's #canvas-freeform container */}
      {freeformEl &&
        children.map((file) =>
          createPortal(
            <CardFrame
              key={file.name}
              file={file}
              onEdit={() => handleEdit(file.name)}
              onDelete={() => handleDelete(file.name)}
            />,
            freeformEl,
          )
        )}

      {/* Empty state — only if canvas loaded but no children */}
      {!loading && children.length === 0 && !canvasCard && (
        <div className="wb-empty">
          <div className="wb-empty-icon">&#9744;</div>
          <p>No files yet. Create a note, document, or diagram to get started.</p>
        </div>
      )}

      {/* Editor modal */}
      {(editingFile || creatingFile) && (
        <FileEditor
          file={editingFile || undefined}
          isNew={creatingFile}
          onSave={handleSave}
          onClose={() => { setEditingFile(null); setCreatingFile(false); }}
        />
      )}
    </div>
  );
}
