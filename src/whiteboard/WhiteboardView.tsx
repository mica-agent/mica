import { useState, useEffect, useCallback, useImperativeHandle, forwardRef, useRef } from "react";
import { saveFile, deleteFile, convertDrawing, fetchContextStats } from "../api/canvasFiles";
import type { CanvasId, RenderedCard, ContextStats } from "../api/canvasFiles";
import { useCanvasSocket } from "./useCanvasSocket";
import FileCard from "./FileCard";
import FileEditor from "./FileEditor";
import ExpandedCardView from "./ExpandedCardView";
import DrawingCanvas from "./DrawingCanvas";
import "./whiteboard.css";

interface Props {
  projectId: string;
  canvasId: CanvasId;
  canvasColor: string;
}

export interface WhiteboardHandle {
  refetch: () => void;
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
const COLS = 3;

/** Compute initial grid positions for all cards */
function autoLayout(cards: RenderedCard[]): Map<string, CardLayout> {
  const layouts = new Map<string, CardLayout>();
  cards.forEach((card, i) => {
    const col = i % COLS;
    const row = Math.floor(i / COLS);
    layouts.set(card.filename, {
      x: col * (DEFAULT_CARD_W + GRID_GAP),
      y: row * (DEFAULT_CARD_H + GRID_GAP),
      w: DEFAULT_CARD_W,
      h: DEFAULT_CARD_H,
    });
  });
  return layouts;
}

// System files are identified by server metadata
const SYSTEM_FILENAMES = ["_goal.md", "_todo.md", "_brief.md", "_log.md", "_chat.md"];

const WhiteboardView = forwardRef<WhiteboardHandle, Props>(
  function WhiteboardView({ projectId, canvasId, canvasColor }, ref) {
    const { cards, loading, refetch } = useCanvasSocket(projectId, canvasId);
    const [contextStats, setContextStats] = useState<ContextStats | null>(null);
    const [editingFile, setEditingFile] = useState<{ name: string; content: string } | null>(null);
    const [expandedCard, setExpandedCard] = useState<RenderedCard | null>(null);
    const [creatingType, setCreatingType] = useState<"text" | "markdown" | "mermaid" | null>(null);
    const [drawingMode, setDrawingMode] = useState(false);
    const [converting, setConverting] = useState(false);
    const [layoutMode, setLayoutMode] = useState<LayoutMode>("masonry");
    const [cardLayouts, setCardLayouts] = useState<Map<string, CardLayout>>(new Map());
    const layoutInitialized = useRef(false);

    useImperativeHandle(ref, () => ({ refetch }), [refetch]);

    // Fetch context stats when cards change
    useEffect(() => {
      fetchContextStats(projectId, canvasId).then(setContextStats).catch(() => {});
    }, [projectId, canvasId, cards.length]);

    const handleSave = useCallback(async (filename: string, content: string) => {
      await saveFile(projectId, canvasId, filename, content);
      setEditingFile(null);
      setCreatingType(null);
      // WebSocket will push the update
    }, [projectId, canvasId]);

    const handleDelete = useCallback(async (filename: string) => {
      await deleteFile(projectId, canvasId, filename);
      // WebSocket will push the deletion
    }, [projectId, canvasId]);

    const handleConvertDrawing = useCallback(async (imageBase64: string) => {
      setConverting(true);
      try {
        await convertDrawing(projectId, canvasId, imageBase64);
        setDrawingMode(false);
      } catch (err) {
        console.error("Drawing conversion failed:", err);
      } finally {
        setConverting(false);
      }
    }, [projectId, canvasId]);

    // Initialize card layouts when switching to freeform or when cards change
    useEffect(() => {
      if (layoutMode !== "freeform") {
        layoutInitialized.current = false;
        return;
      }
      if (!layoutInitialized.current || cards.length !== cardLayouts.size) {
        const allCards = cards.filter((c) => c.filename !== "_chat.md");
        const existing = new Map(cardLayouts);
        // Keep existing positions, add new cards
        let nextIndex = existing.size;
        for (const card of allCards) {
          if (!existing.has(card.filename)) {
            const col = nextIndex % COLS;
            const row = Math.floor(nextIndex / COLS);
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
    }, [layoutMode, cards]);

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

    // For editing, we need to fetch the raw file content
    const handleEdit = useCallback(async (filename: string) => {
      try {
        const { fetchFile } = await import("../api/canvasFiles");
        const file = await fetchFile(projectId, canvasId, filename);
        setExpandedCard(null);
        setEditingFile({ name: file.name, content: file.content });
      } catch (err) {
        console.error("Failed to fetch file for editing:", err);
      }
    }, [projectId, canvasId]);

    // Separate system cards from content cards (_chat.md is in sidebar, not here)
    const systemCards = cards.filter((c) => c.meta.isSystem && c.filename !== "_chat.md");
    const contentCards = cards.filter((c) => !c.meta.isSystem && !c.filename.startsWith("_"));

    // Order system cards: goal, todo, brief, log, chat
    const orderedSystem = SYSTEM_FILENAMES
      .map((name) => systemCards.find((c) => c.filename === name))
      .filter((c): c is RenderedCard => c != null);
    // Add any system cards not in the predefined list
    const extraSystem = systemCards.filter((c) => !SYSTEM_FILENAMES.includes(c.filename));
    const allSystem = [...orderedSystem, ...extraSystem];

    return (
      <div className="wb-container">
        {/* Toolbar */}
        <div
          className="wb-toolbar"
          style={{ "--canvas-color": canvasColor } as React.CSSProperties}
        >
          <div className="wb-toolbar-left">
            <button className="wb-btn wb-btn--tool" onClick={() => setCreatingType("text")}>
              + Note
            </button>
            <button className="wb-btn wb-btn--tool" onClick={() => setCreatingType("markdown")}>
              + Doc
            </button>
            <button className="wb-btn wb-btn--tool" onClick={() => setCreatingType("mermaid")}>
              + Diagram
            </button>
            <button className="wb-btn wb-btn--tool" onClick={() => setDrawingMode(true)}>
              Draw
            </button>
          </div>
          <div className="wb-toolbar-right">
            {contextStats && (
              <span className="wb-context-stats" title={`${contextStats.files} files, ${contextStats.fileContentChars.toLocaleString()} chars content + ${contextStats.systemPromptChars.toLocaleString()} chars prompt`}>
                ~{contextStats.estimatedTokens < 1000
                  ? contextStats.estimatedTokens
                  : `${(contextStats.estimatedTokens / 1000).toFixed(1)}k`} tokens
              </span>
            )}
            <span className="wb-file-count">
              {cards.length} card{cards.length !== 1 ? "s" : ""}
            </span>
            <button
              className={`wb-btn wb-btn--tool ${layoutMode === "masonry" ? "wb-btn--active" : ""}`}
              onClick={() => setLayoutMode("masonry")}
              title="Grid layout"
            >
              Grid
            </button>
            <button
              className={`wb-btn wb-btn--tool ${layoutMode === "freeform" ? "wb-btn--active" : ""}`}
              onClick={() => setLayoutMode("freeform")}
              title="Freeform layout"
            >
              Free
            </button>
            <button className="wb-btn wb-btn--tool" onClick={refetch}>
              Refresh
            </button>
          </div>
        </div>

        {/* Content area */}
        <div className="wb-grid">
          {loading && cards.length === 0 && (
            <div className="wb-empty">Loading cards...</div>
          )}
          {!loading && cards.length === 0 && (
            <div className="wb-empty">
              <div className="wb-empty-icon">&#9744;</div>
              <p>No files yet. Create a note, document, or diagram to get started.</p>
            </div>
          )}

          {layoutMode === "masonry" ? (
            <>
              {/* System cards — full-width section above masonry */}
              {allSystem.length > 0 && (
                <div className="wb-system-cards">
                  {allSystem.map((card) => (
                    <FileCard
                      key={card.filename}
                      filename={card.filename}
                      html={card.html}
                      exports={card.exports}
                      meta={card.meta}
                      projectId={projectId}
                      canvasId={canvasId}
                      canvasColor={canvasColor}
                      onEdit={() => handleEdit(card.filename)}
                      onDelete={() => handleDelete(card.filename)}
                      onExpand={() => setExpandedCard(card)}
                    />
                  ))}
                </div>
              )}

              {/* Content cards — masonry layout */}
              {contentCards.length > 0 && (
                <div className="wb-masonry">
                  {contentCards.map((card) => (
                    <FileCard
                      key={card.filename}
                      filename={card.filename}
                      html={card.html}
                      exports={card.exports}
                      meta={card.meta}
                      projectId={projectId}
                      canvasId={canvasId}
                      canvasColor={canvasColor}
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
              {cards.filter((c) => c.filename !== "_chat.md").map((card) => {
                const layout = cardLayouts.get(card.filename);
                if (!layout) return null;
                return (
                  <FileCard
                    key={card.filename}
                    filename={card.filename}
                    html={card.html}
                    exports={card.exports}
                    meta={card.meta}
                    projectId={projectId}
                    canvasId={canvasId}
                    canvasColor={canvasColor}
                    resizable
                    cardStyle={{
                      left: layout.x,
                      top: layout.y,
                      width: layout.w,
                      height: layout.h,
                    }}
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
        </div>

        {/* Expanded card reader */}
        {expandedCard && (
          <ExpandedCardView
            filename={expandedCard.filename}
            html={expandedCard.html}
            exports={expandedCard.exports}
            meta={expandedCard.meta}
            projectId={projectId}
            canvasId={canvasId}
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
);

export default WhiteboardView;
