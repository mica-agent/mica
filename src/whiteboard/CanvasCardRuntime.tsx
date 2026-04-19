// CanvasCardRuntime — thin portal host for the canvas card class.
//
// Responsibilities (host only):
//   1. Fetch & mount the canvas card via CardRuntime
//   2. Fetch child files and portal them into #canvas-freeform (owned by card class)
//   3. Listen for file-created/file-deleted/file-changed to update children
//   4. Provide modals (edit, create) triggered by child card actions
//
// Layout, positioning, drag, resize, and toolbar are all owned by the
// canvas card class (card-classes/canvas/card.js). React does NOT
// manage layout state — the canvas card class handles everything via
// event delegation on #canvas-freeform.

import { useState, useEffect, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import { fetchCanvasCard, fetchFiles, fetchFileContent, saveFile, deleteFile } from "../api/canvasFiles";
import type { RenderedCanvasCard, CanvasFile } from "../api/canvasFiles";
import { on, destroyBridgeFor } from "../api/micaSocket";
import CardRuntime from "./CardRuntime";
import CardFrame from "./CardFrame";
import FileEditor from "./FileEditor";
import "./whiteboard.css";

interface Props {
  /** Per-tab active project name. Threaded into every project-scoped API call. */
  project: string;
}

export default function CanvasCardRuntime({ project }: Props) {
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
        fetchCanvasCard(project, signal),
        fetchFiles(project, true),
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
            prev.every((c, i) => c.name === next[i].name && c.modifiedAt === next[i].modifiedAt)
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
  }, [project]);

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
    const unsub1 = on("file-created", (_msg: unknown) => {
      // Re-fetch canvas files — server determines membership
      fetchFiles(project, true).then((files) => setChildren(files)).catch(() => {});
    });

    const unsub2 = on("file-changed", (msg: unknown) => {
      const m = msg as { filename?: string };
      if (!m.filename || m.filename.startsWith(".")) return;
      // Update modifiedAt to trigger CardFrame re-render
      setChildren((prev) =>
        prev.map((f) => f.name === m.filename
          ? { ...f, modifiedAt: new Date().toISOString() }
          : f
        )
      );
    });

    const unsub3 = on("file-deleted", (msg: unknown) => {
      const m = msg as { filename?: string };
      if (!m.filename) return;
      // Tear down the bridge for this file (look up via the children list to
      // find the file's UUID). Card sessions belong to files; deleting the
      // file is the true end-of-life signal (not React unmount).
      setChildren((prev) => {
        const victim = prev.find((f) => f.name === m.filename);
        if (victim?.id) destroyBridgeFor(victim.id);
        return prev.filter((f) => f.name !== m.filename);
      });
    });

    return () => { unsub1(); unsub2(); unsub3(); };
  }, [project]);

  // ── File operations (for modals) ────────────────────────

  const handleSave = useCallback(async (content: string, filename?: string) => {
    const name = filename || editingFile?.name;
    if (!name) return;
    await saveFile(project, name, content);
    setEditingFile(null);
    setCreatingFile(false);
  }, [editingFile, project]);

  const handleDelete = useCallback(async (filename: string) => {
    await deleteFile(project, filename);
  }, [project]);

  const handleEdit = useCallback(async (filename: string) => {
    try {
      const content = await fetchFileContent(project, filename);
      setEditingFile({ name: filename, size: content.length, content });
    } catch (err) {
      console.error("Failed to fetch file for editing:", err);
    }
  }, [project]);

  const handleUnpin = useCallback(async (filename: string) => {
    try {
      const API_BASE = import.meta.env.VITE_MICA_API || "";
      await fetch(`${API_BASE}/api/canvas/pin`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json", "X-Mica-Project": project },
        body: JSON.stringify({ filename }),
      });
      setChildren((prev) => prev.filter((f) => f.name !== filename));
    } catch (err) {
      console.error("Failed to unpin:", err);
    }
  }, [project]);

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
            sessionId={`canvas-${project}`}
            project={project}
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
              project={project}
              file={file}
              onEdit={() => handleEdit(file.name)}
              onDelete={() => handleDelete(file.name)}
              onUnpin={file.pinned ? () => handleUnpin(file.name) : undefined}
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
