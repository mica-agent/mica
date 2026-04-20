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
import { on, destroyBridgeFor, windowId } from "../api/micaSocket";
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

  // Portal targets: #canvas-freeform (content cards) + #canvas-meta-list (meta
  // sidebar). The canvas card class declares both containers; we portal each
  // CardFrame into the right one based on `file.meta` so React's reconciler
  // never sees a portaled element move between parents (which throws
  // NotFoundError on the next layout commit).
  const [freeformEl, setFreeformEl] = useState<HTMLElement | null>(null);
  const [metaListEl, setMetaListEl] = useState<HTMLElement | null>(null);
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

    // Reset both portal targets — clear any stale references from a previous render.
    setFreeformEl(null);
    setMetaListEl(null);

    // CardRuntime (child) runs its effect before this (parent) effect.
    // For canvas (no declared deps), innerHTML is injected synchronously
    // in CardRuntime's effect, so the containers are already in the DOM.
    // Always check isConnected to reject stale elements from previous renders.
    let freeformFound = false;
    let metaFound = false;
    const poll = setInterval(() => {
      if (!freeformFound) {
        const el = container.querySelector("#canvas-freeform");
        if (el && (el as HTMLElement).isConnected) {
          setFreeformEl(el as HTMLElement);
          freeformFound = true;
        }
      }
      if (!metaFound) {
        const el = container.querySelector("#canvas-meta-list");
        if (el && (el as HTMLElement).isConnected) {
          setMetaListEl(el as HTMLElement);
          metaFound = true;
        }
      }
      // Keep polling until BOTH targets resolve. (metaListEl is optional —
      // if the canvas card class doesn't ship a sidebar, we never find it
      // and meta cards just won't render. Stop polling after a few seconds
      // to avoid an infinite poll on canvases without a sidebar.)
      if (freeformFound && metaFound) clearInterval(poll);
    }, 50);
    // Hard stop after 3s; freeform alone is sufficient for non-sidebar canvases.
    const stop = setTimeout(() => clearInterval(poll), 3000);
    return () => { clearInterval(poll); clearTimeout(stop); };
  }, [canvasCard]);

  // ── Real-time updates via WebSocket ─────────────────────

  // Apply a transient glow class to a card. For create events the card may not
  // be in the DOM yet (React hasn't rendered the new CardFrame), so we retry
  // up to 3 times over ~300ms. For change events it's already there and the
  // first attempt succeeds.
  const applyGlow = useCallback((filename: string, className: string) => {
    const root = containerRef.current;
    if (!root) return;
    const safe = filename.replace(/"/g, '\\"');
    const attempt = (left: number) => {
      const el = root.querySelector(`.wb-card[data-filename="${safe}"]`) as HTMLElement | null;
      if (el) {
        el.classList.remove(className);
        void el.offsetWidth;
        el.classList.add(className);
        window.setTimeout(() => el.classList.remove(className), 5000);
      } else if (left > 0) {
        window.setTimeout(() => attempt(left - 1), 100);
      }
    };
    attempt(3);
  }, []);

  // Pick which glow (if any) to apply for a broadcast's source field.
  // Skips echoes from this same tab so you don't glow on your own writes.
  const glowClassFor = (source: string | undefined): string | null => {
    if (source === windowId) return null;
    if (source === "agent") return "wb-card--agent-write";
    return "wb-card--external-write";
  };

  useEffect(() => {
    const unsub1 = on("file-created", (msg: unknown) => {
      const m = msg as { filename?: string; source?: string };
      // Re-fetch canvas files — server determines membership. Skip the
      // setChildren if the new file isn't canvas-visible (e.g. the agent
      // wrote to backend/data/foo.py — not on the canvas, so the membership
      // list is unchanged and we don't want to thrash the React tree).
      fetchFiles(project, true).then((files) => {
        setChildren((prev) => {
          if (prev.length !== files.length) return files;
          const prevNames = new Set(prev.map((f) => f.name));
          for (const f of files) if (!prevNames.has(f.name)) return files;
          return prev;
        });
      }).catch(() => {});
      if (m.filename && !m.filename.startsWith(".")) {
        const cls = glowClassFor(m.source);
        if (cls) applyGlow(m.filename, cls);
      }
    });

    const unsub2 = on("file-changed", (msg: unknown) => {
      const m = msg as { filename?: string; source?: string };
      if (!m.filename || m.filename.startsWith(".")) return;
      // Update modifiedAt to trigger CardFrame re-render — but only when the
      // changed file is actually on the canvas. Without this guard, every
      // agent file write (even to non-canvas paths like backend/data/) churns
      // the entire children array and re-renders all CardFrames.
      setChildren((prev) => {
        let mutated = false;
        const next = prev.map((f) => {
          if (f.name !== m.filename) return f;
          mutated = true;
          return { ...f, modifiedAt: new Date().toISOString() };
        });
        return mutated ? next : prev;
      });
      const cls = glowClassFor(m.source);
      if (cls) applyGlow(m.filename, cls);
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

      {/* Portal each child card into the right container based on file.meta:
          meta cards land in the canvas-meta-list (sidebar), content cards
          land in canvas-freeform. We portal directly into the correct
          container so React's reconciler never sees a node move parents. */}
      {children.map((file) => {
        const target = file.meta ? metaListEl : freeformEl;
        if (!target) return null;
        // IMPORTANT: key is the THIRD arg to createPortal, not on CardFrame.
        // The portal is what lives in `children.map`'s array slot; React
        // reconciles by the portal's key. Putting key on the inner CardFrame
        // leaves the portal itself key-less, so when the array changes (e.g.
        // a file is added) React falls back to positional reconciliation and
        // every CardFrame unmounts+remounts, blowing away card state.
        return createPortal(
          <CardFrame
            project={project}
            file={file}
            onEdit={() => handleEdit(file.name)}
            onDelete={() => handleDelete(file.name)}
            onUnpin={file.pinned ? () => handleUnpin(file.name) : undefined}
          />,
          target,
          file.name,
        );
      })}

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
