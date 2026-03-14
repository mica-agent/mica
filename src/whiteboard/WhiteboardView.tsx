import { useState, useEffect, useCallback, useImperativeHandle, forwardRef } from "react";
import { saveFile, deleteFile, convertDrawing, fetchContextStats } from "../api/layerFiles";
import type { LayerId, RenderedCard, ContextStats } from "../api/layerFiles";
import { useLayerSocket } from "./useLayerSocket";
import FileCard from "./FileCard";
import FileEditor from "./FileEditor";
import ExpandedCardView from "./ExpandedCardView";
import DrawingCanvas from "./DrawingCanvas";
import "./whiteboard.css";

interface Props {
  layerId: LayerId;
  layerColor: string;
}

export interface WhiteboardHandle {
  refetch: () => void;
}

// System files are identified by server metadata
const SYSTEM_FILENAMES = ["_goal.md", "_todo.md", "_brief.md", "_log.md", "_chat.md"];

const WhiteboardView = forwardRef<WhiteboardHandle, Props>(
  function WhiteboardView({ layerId, layerColor }, ref) {
    const { cards, loading, callExport, refetch } = useLayerSocket(layerId);
    const [contextStats, setContextStats] = useState<ContextStats | null>(null);
    const [editingFile, setEditingFile] = useState<{ name: string; content: string } | null>(null);
    const [expandedCard, setExpandedCard] = useState<RenderedCard | null>(null);
    const [creatingType, setCreatingType] = useState<"text" | "markdown" | "mermaid" | null>(null);
    const [drawingMode, setDrawingMode] = useState(false);
    const [converting, setConverting] = useState(false);

    useImperativeHandle(ref, () => ({ refetch }), [refetch]);

    // Fetch context stats when cards change
    useEffect(() => {
      fetchContextStats(layerId).then(setContextStats).catch(() => {});
    }, [layerId, cards.length]);

    const handleSave = useCallback(async (filename: string, content: string) => {
      await saveFile(layerId, filename, content);
      setEditingFile(null);
      setCreatingType(null);
      // WebSocket will push the update
    }, [layerId]);

    const handleDelete = useCallback(async (filename: string) => {
      await deleteFile(layerId, filename);
      // WebSocket will push the deletion
    }, [layerId]);

    const handleConvertDrawing = useCallback(async (imageBase64: string) => {
      setConverting(true);
      try {
        await convertDrawing(layerId, imageBase64);
        setDrawingMode(false);
      } catch (err) {
        console.error("Drawing conversion failed:", err);
      } finally {
        setConverting(false);
      }
    }, [layerId]);

    // For editing, we need to fetch the raw file content
    const handleEdit = useCallback(async (filename: string) => {
      try {
        const { fetchFile } = await import("../api/layerFiles");
        const file = await fetchFile(layerId, filename);
        setExpandedCard(null);
        setEditingFile({ name: file.name, content: file.content });
      } catch (err) {
        console.error("Failed to fetch file for editing:", err);
      }
    }, [layerId]);

    // Separate system cards from content cards
    const systemCards = cards.filter((c) => c.meta.isSystem);
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
          style={{ "--layer-color": layerColor } as React.CSSProperties}
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
                  layerId={layerId}
                  layerColor={layerColor}
                  onEdit={() => handleEdit(card.filename)}
                  onDelete={() => handleDelete(card.filename)}
                  onExpand={() => setExpandedCard(card)}
                  callExport={callExport}
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
                  layerId={layerId}
                  layerColor={layerColor}
                  onEdit={() => handleEdit(card.filename)}
                  onDelete={() => handleDelete(card.filename)}
                  onExpand={() => setExpandedCard(card)}
                  callExport={callExport}
                />
              ))}
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
            layerId={layerId}
            layerColor={layerColor}
            onClose={() => setExpandedCard(null)}
            onEdit={() => { handleEdit(expandedCard.filename); setExpandedCard(null); }}
            callExport={callExport}
          />
        )}

        {/* Editor modal */}
        {(editingFile || creatingType) && (
          <FileEditor
            file={editingFile ? { name: editingFile.name, type: "markdown" as const, content: editingFile.content, modifiedAt: "" } : null}
            defaultType={creatingType ?? undefined}
            layerColor={layerColor}
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
            layerColor={layerColor}
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
