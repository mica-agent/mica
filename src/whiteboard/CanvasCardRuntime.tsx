// CanvasCardRuntime — renders a canvas card (parent) with isolated child cards in slots.
//
// The parent card's HTML contains data-slot elements ("system-cards", "content-cards").
// This component fills those slots with individually isolated WidgetRuntime instances,
// one per child card. Each child gets its own container, bridge, and script scope.

import React, { useState, useEffect, useCallback, useRef, type MutableRefObject } from "react";
import { fetchProjectCard, fetchProjectChildren, saveFile, deleteFile, fetchFile, convertDrawing, fetchLayout, saveLayout, createCardApi } from "../api/canvasFiles";
import type { RenderedCard } from "../api/canvasFiles";
import { on } from "../api/micaSocket";
import WidgetRuntime from "./WidgetRuntime";
import FileCard from "./FileCard";
import FileEditor from "./FileEditor";
import ExpandedCardView from "./ExpandedCardView";
import DrawingCanvas from "./DrawingCanvas";
import "./whiteboard.css";

interface Props {
  projectId: string;
  onReloadRef?: MutableRefObject<(() => void) | null>;
}

type LayoutMode = "masonry" | "freeform";

interface CardLayout {
  x: number;
  y: number;
  w: number;
  h: number;
}

const DEFAULT_CARD_W = 320;
const DEFAULT_CARD_H = 280;
const GRID_GAP = 16;
const FREEFORM_COLS = 3;

// System files ordering
const SEED_CARD_ORDER = ["goal.goal", "todo.todo", "brief.md", "log.md"];

// ── Debounced layout save ───────────────────────────────
let layoutSaveTimer: ReturnType<typeof setTimeout> | null = null;
const LAYOUT_SAVE_DELAY = 500;

function debouncedSaveLayout(projectId: string, mode: LayoutMode, layouts: Map<string, CardLayout>) {
  if (layoutSaveTimer) clearTimeout(layoutSaveTimer);
  layoutSaveTimer = setTimeout(() => {
    saveLayout(projectId, "_root", {
      mode,
      cards: Object.fromEntries(layouts),
    }).catch(() => {});
  }, LAYOUT_SAVE_DELAY);
}

export default function CanvasCardRuntime({ projectId, onReloadRef }: Props) {
  const [parentCard, setParentCard] = useState<RenderedCard | null>(null);
  const [children, setChildren] = useState<RenderedCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [cardClasses, setCardClasses] = useState<Record<string, { extension: string; badge: string; defaultTitle?: string; seed?: boolean }>>({});

  // Editor/expanded state
  const [editingFile, setEditingFile] = useState<{ name: string; content: string } | null>(null);
  const [expandedCard, setExpandedCard] = useState<RenderedCard | null>(null);
  const [creatingType, setCreatingType] = useState<"text" | "markdown" | "mermaid" | null>(null);
  const [drawingMode, setDrawingMode] = useState(false);
  const [converting, setConverting] = useState(false);
  const [renderingFiles, setRenderingFiles] = useState<Set<string>>(new Set());
  const [flashFiles, setFlashFiles] = useState<Set<string>>(new Set());
  const [layoutMode, setLayoutMode] = useState<LayoutMode>("masonry");
  const [cardLayouts, setCardLayouts] = useState<Map<string, CardLayout>>(new Map());
  const layoutInitialized = useRef(false);
  const layoutLoaded = useRef(false);

  const parentRef = useRef<HTMLDivElement>(null);

  // ── Fetch available card classes for toolbar ──────────────
  useEffect(() => {
    fetch(`${import.meta.env.VITE_API_BASE || "http://localhost:3002"}/api/card-classes`)
      .then((r) => r.json())
      .then(setCardClasses)
      .catch((err) => console.error("[toolbar] Failed to fetch card classes:", err));
  }, []);

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

  // Expose reload function so parent can trigger refresh (e.g. after agent writes files)
  useEffect(() => {
    if (onReloadRef) onReloadRef.current = loadProjectCard;
    return () => { if (onReloadRef) onReloadRef.current = null; };
  }, [onReloadRef, loadProjectCard]);

  // ── Load persisted layout from server ───────────────────
  useEffect(() => {
    fetchLayout(projectId, "_root").then((data) => {
      const d = data as { mode?: string; cards?: Record<string, CardLayout> };
      if (d.mode === "freeform") setLayoutMode("freeform");
      if (d.cards) {
        const entries = Object.entries(d.cards) as [string, CardLayout][];
        if (entries.length > 0) {
          setCardLayouts(new Map(entries));
          layoutInitialized.current = true;
        }
      }
      layoutLoaded.current = true;
    }).catch(() => { layoutLoaded.current = true; });
  }, [projectId]);

  // ── Real-time updates via WebSocket ─────────────────────

  useEffect(() => {
    function handleRendering(msg: unknown) {
      const m = msg as { project?: string; canvas?: string; filename?: string };
      if (m.project !== projectId || m.canvas !== "_root" || !m.filename) return;
      setRenderingFiles((prev) => new Set(prev).add(m.filename!));
    }

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

      // Skip files that aren't child cards
      if (m.filename === "_project.project" || m.filename === ".chat-history.json" || m.filename === ".config.json") {
        if (m.filename === "_project.project") {
          fetchProjectCard(projectId).then(setParentCard).catch(() => {});
        }
        return;
      }

      // Clear rendering state
      if (m.filename) {
        setRenderingFiles((prev) => { const next = new Set(prev); next.delete(m.filename!); return next; });
      }

      // file-created: add new card to canvas (server sends full render)
      if (m.type === "file-created" && m.html && m.filename && m.meta) {
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
        setFlashFiles((prev) => new Set(prev).add(m.filename!));
        setTimeout(() => {
          setFlashFiles((prev) => { const next = new Set(prev); next.delete(m.filename!); return next; });
        }, 1200);
      }
      // file-changed: event only — card classes handle their own updates via mica.on()
      // No HTML replacement, no React state update for existing cards.
      else if (m.type === "file-deleted" && m.filename) {
        setChildren((prev) => prev.filter((c) => c.filename !== m.filename));
      }
      // file-changed events are passed through to card scripts via mica.on('file-changed')
      // (handled by the WebSocket event listener system — no action needed here)
    }

    const unsub0 = on("file-rendering", handleRendering);
    const unsub1 = on("file-changed", handleFileEvent);
    const unsub2 = on("file-created", handleFileEvent);
    const unsub3 = on("file-deleted", handleFileEvent);
    return () => { unsub0(); unsub1(); unsub2(); unsub3(); };
  }, [projectId, loadProjectCard]);

  // ── Listen for toolbar-action broadcasts from the parent card's scripts ──

  useEffect(() => {
    const unsub = on("toolbar-action", (msg) => {
      const m = msg as Record<string, unknown>;
      // Server flattens broadcast data — action is a top-level key
      const action = m.action as string | undefined;
      if (action === "new-note") setCreatingType("text");
      else if (action === "new-doc") setCreatingType("markdown");
      else if (action === "new-diagram") setCreatingType("mermaid");
    });
    return unsub;
  }, []);

  // ── File operations ─────────────────────────────────────

  const createCardInstance = useCallback(async (className: string, extension: string) => {
    const prefix = className.split("-")[0].slice(0, 6);
    const name = `${prefix}-${Date.now().toString(36)}${extension}`;
    await createCardApi(projectId, "_root", name);
  }, [projectId]);

  const handleSave = useCallback(async (filename: string, content: string) => {
    await saveFile(projectId, "_root", filename, content);
    setEditingFile(null);
    setCreatingType(null);
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

  const handleConvertDrawing = useCallback(async (imageBase64: string) => {
    setConverting(true);
    try {
      await convertDrawing(projectId, "_root", imageBase64);
      setDrawingMode(false);
    } catch (err) {
      console.error("Drawing conversion failed:", err);
    } finally {
      setConverting(false);
    }
  }, [projectId]);

  // ── Freeform layout management ─────────────────────────

  const allNonChat = children;

  useEffect(() => {
    if (layoutMode !== "freeform") {
      layoutInitialized.current = false;
      return;
    }
    if (!layoutInitialized.current || allNonChat.length !== cardLayouts.size) {
      const existing = new Map(cardLayouts);
      let nextIndex = existing.size;
      for (const card of allNonChat) {
        if (!existing.has(card.filename)) {
          const col = nextIndex % FREEFORM_COLS;
          const row = Math.floor(nextIndex / FREEFORM_COLS);
          existing.set(card.filename, {
            x: col * (DEFAULT_CARD_W + GRID_GAP),
            y: row * (DEFAULT_CARD_H + GRID_GAP),
            w: DEFAULT_CARD_W,
            h: DEFAULT_CARD_H,
          });
          nextIndex++;
        }
      }
      setCardLayouts(existing);
      layoutInitialized.current = true;
    }
  }, [layoutMode, allNonChat.length]);

  const handleCardDragEnd = useCallback((filename: string, x: number, y: number) => {
    setCardLayouts((prev) => {
      const next = new Map(prev);
      const layout = next.get(filename) ?? { x: 0, y: 0, w: DEFAULT_CARD_W, h: DEFAULT_CARD_H };
      next.set(filename, { ...layout, x, y });
      return next;
    });
  }, []);

  const handleCardResize = useCallback((filename: string, w: number, h: number) => {
    setCardLayouts((prev) => {
      const next = new Map(prev);
      const layout = next.get(filename) ?? { x: 0, y: 0, w: DEFAULT_CARD_W, h: DEFAULT_CARD_H };
      next.set(filename, { ...layout, w, h });
      return next;
    });
  }, []);

  // Persist layout state to server (debounced)
  useEffect(() => {
    if (!layoutLoaded.current) return; // Don't save until initial load completes
    debouncedSaveLayout(projectId, layoutMode, cardLayouts);
  }, [projectId, layoutMode, cardLayouts]);

  // ── Partition children into system vs content ───────────

  const systemCards = children.filter((c) => c.meta.isSystem);
  const allContent = children.filter((c) => !c.meta.isSystem);
  const diagramCards = allContent.filter((c) => c.meta.cardClass === "mermaid");
  const contentCards = allContent.filter((c) => c.meta.cardClass !== "mermaid");

  // Order system cards
  const orderedSystem = SEED_CARD_ORDER
    .map((name) => systemCards.find((c) => c.filename === name))
    .filter((c): c is RenderedCard => c != null);
  const extraSystem = systemCards.filter((c) => !SEED_CARD_ORDER.includes(c.filename));
  const allSystem = [...orderedSystem, ...extraSystem];

  // ── Render ──────────────────────────────────────────────

  if (loading && !parentCard) {
    return <div className="wb-container"><div className="wb-empty">Loading project...</div></div>;
  }

  const canvasColor = "#4a8aff";

  return (
    <div className="wb-container">
      {/* Scrollable content area */}
      <div className="wb-grid">
        {/* Parent card chrome — rendered by simple-project render.py */}
        {parentCard && (
          <div ref={parentRef} className="canvas-card-parent">
            <WidgetRuntime
              html={parentCard.html}
              exports={parentCard.exports}
              dependencies={parentCard.dependencies}
              project={projectId}
              canvas="_root"
              filename="_project.project"
            />
          </div>
        )}

        {/* Toolbar */}
        <div className="wb-toolbar" style={{ "--canvas-color": canvasColor } as React.CSSProperties}>
          <div className="wb-toolbar-left">
            {Object.entries(cardClasses)
              .filter(([name, meta]) => !meta.seed && name !== "simple-project" && name !== "canvas")
              .map(([name, meta]) => (
                <button
                  key={name}
                  className="wb-btn wb-btn--tool"
                  onClick={() => {
                    if (name === "text" || name === "markdown" || name === "mermaid") {
                      setCreatingType(name as "text" | "markdown" | "mermaid");
                    } else {
                      createCardInstance(name, meta.extension);
                    }
                  }}
                >
                  + {meta.defaultTitle || name}
                </button>
              ))}
            <button className="wb-btn wb-btn--tool" onClick={() => setDrawingMode(true)}>Draw</button>
          </div>
          <div className="wb-toolbar-right">
            <button
              className={`wb-btn wb-btn--tool ${layoutMode === "masonry" ? "wb-btn--active" : ""}`}
              onClick={() => setLayoutMode("masonry")}
            >
              Grid
            </button>
            <button
              className={`wb-btn wb-btn--tool ${layoutMode === "freeform" ? "wb-btn--active" : ""}`}
              onClick={() => setLayoutMode("freeform")}
            >
              Free
            </button>
          </div>
        </div>

        {layoutMode === "masonry" ? (
          <>
            {/* System cards */}
            {allSystem.length > 0 && (
              <div className="wb-system-cards">
                {allSystem.map((card) => (
                  <FileCard
                    key={card.filename}
                    filename={card.filename}
                    html={card.html}
                    exports={card.exports}
                    dependencies={card.dependencies}
                    meta={card.meta}
                    projectId={projectId}
                    canvasId="_root"
                    canvasColor={canvasColor}
                    rendering={renderingFiles.has(card.filename)}
                    flash={flashFiles.has(card.filename)}
                    onEdit={() => handleEdit(card.filename)}
                    onDelete={() => handleDelete(card.filename)}
                    onExpand={() => setExpandedCard(card)}
                  />
                ))}
              </div>
            )}

            {/* Diagram cards — full width, outside masonry */}
            {diagramCards.map((card) => (
              <FileCard
                key={card.filename}
                filename={card.filename}
                html={card.html}
                exports={card.exports}
                dependencies={card.dependencies}
                meta={card.meta}
                projectId={projectId}
                canvasId="_root"
                canvasColor={canvasColor}
                rendering={renderingFiles.has(card.filename)}
                flash={flashFiles.has(card.filename)}
                onEdit={() => handleEdit(card.filename)}
                onDelete={() => handleDelete(card.filename)}
                onExpand={() => setExpandedCard(card)}
              />
            ))}

            {/* Content cards — masonry layout */}
            {contentCards.length > 0 && (
              <div className="wb-masonry">
                {contentCards.map((card) => (
                  <FileCard
                    key={card.filename}
                    filename={card.filename}
                    html={card.html}
                    exports={card.exports}
                    dependencies={card.dependencies}
                    meta={card.meta}
                    projectId={projectId}
                    canvasId="_root"
                    canvasColor={canvasColor}
                    rendering={renderingFiles.has(card.filename)}
                    flash={flashFiles.has(card.filename)}
                    onEdit={() => handleEdit(card.filename)}
                    onDelete={() => handleDelete(card.filename)}
                    onExpand={() => setExpandedCard(card)}
                  />
                ))}
              </div>
            )}
          </>
        ) : (
          /* Freeform layout — all cards absolutely positioned */
          <div className="wb-freeform">
            {allNonChat.map((card) => {
              const layout = cardLayouts.get(card.filename);
              if (!layout) return null;
              return (
                <FileCard
                  key={card.filename}
                  filename={card.filename}
                  html={card.html}
                  exports={card.exports}
                  dependencies={card.dependencies}
                  meta={card.meta}
                  projectId={projectId}
                  canvasId="_root"
                  canvasColor={canvasColor}
                  resizable
                  cardStyle={{
                    left: layout.x,
                    top: layout.y,
                    width: layout.w,
                    height: layout.h,
                  }}
                  rendering={renderingFiles.has(card.filename)}
                  flash={flashFiles.has(card.filename)}
                  onEdit={() => handleEdit(card.filename)}
                  onDelete={() => handleDelete(card.filename)}
                  onExpand={() => setExpandedCard(card)}
                  onDragEnd={(x, y) => handleCardDragEnd(card.filename, x, y)}
                  onResize={(w, h) => handleCardResize(card.filename, w, h)}
                />
              );
            })}
          </div>
        )}

        {!loading && children.length === 0 && !parentCard && (
          <div className="wb-empty">
            <div className="wb-empty-icon">&#9744;</div>
            <p>No files yet. Create a note, document, or diagram to get started.</p>
          </div>
        )}
      </div>

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
      {(editingFile || creatingType) && (
        <FileEditor
          file={editingFile ? { name: editingFile.name, type: "markdown" as const, content: editingFile.content, modifiedAt: "" } : null}
          defaultType={creatingType ?? undefined}
          canvasColor={canvasColor}
          onSave={handleSave}
          onCancel={() => {
            setEditingFile(null);
            setCreatingType(null);
          }}
        />
      )}

      {/* Drawing canvas */}
      {drawingMode && (
        <DrawingCanvas
          canvasColor={canvasColor}
          onConvert={handleConvertDrawing}
          onCancel={() => setDrawingMode(false)}
          converting={converting}
        />
      )}
    </div>
  );
}
