import { useState, useEffect, useCallback, useImperativeHandle, forwardRef } from "react";
import mermaid from "mermaid";
import { fetchFiles, saveFile, deleteFile, convertDrawing } from "../api/layerFiles";
import type { LayerFile, LayerId } from "../api/layerFiles";
import FileCard from "./FileCard";
import FileEditor from "./FileEditor";
import DrawingCanvas from "./DrawingCanvas";
import "./whiteboard.css";

// Initialize mermaid
mermaid.initialize({ startOnLoad: false, theme: "dark" });

interface Props {
  layerId: LayerId;
  layerColor: string;
}

export interface WhiteboardHandle {
  refetch: () => void;
}

const WhiteboardView = forwardRef<WhiteboardHandle, Props>(
  function WhiteboardView({ layerId, layerColor }, ref) {
    const [files, setFiles] = useState<LayerFile[]>([]);
    const [loading, setLoading] = useState(true);
    const [editingFile, setEditingFile] = useState<LayerFile | null>(null);
    const [creatingType, setCreatingType] = useState<
      "text" | "markdown" | "mermaid" | null
    >(null);
    const [drawingMode, setDrawingMode] = useState(false);
    const [converting, setConverting] = useState(false);

    const loadFiles = useCallback(async () => {
      try {
        const loaded = await fetchFiles(layerId);
        setFiles(loaded);
      } catch (err) {
        console.error("Failed to load files:", err);
      } finally {
        setLoading(false);
      }
    }, [layerId]);

    // Expose refetch to parent
    useImperativeHandle(ref, () => ({ refetch: loadFiles }), [loadFiles]);

    // Fetch on mount and layer change
    useEffect(() => {
      setLoading(true);
      loadFiles();
    }, [loadFiles]);

    // Poll every 5 seconds for external changes
    useEffect(() => {
      const interval = setInterval(loadFiles, 5000);
      return () => clearInterval(interval);
    }, [loadFiles]);

    async function handleSave(filename: string, content: string) {
      await saveFile(layerId, filename, content);
      setEditingFile(null);
      setCreatingType(null);
      loadFiles();
    }

    async function handleDelete(filename: string) {
      await deleteFile(layerId, filename);
      loadFiles();
    }

    async function handleConvertDrawing(imageBase64: string) {
      setConverting(true);
      try {
        await convertDrawing(layerId, imageBase64);
        setDrawingMode(false);
        loadFiles();
      } catch (err) {
        console.error("Drawing conversion failed:", err);
      } finally {
        setConverting(false);
      }
    }

    return (
      <div className="wb-container">
        {/* Toolbar */}
        <div
          className="wb-toolbar"
          style={{ "--layer-color": layerColor } as React.CSSProperties}
        >
          <div className="wb-toolbar-left">
            <button
              className="wb-btn wb-btn--tool"
              onClick={() => setCreatingType("text")}
            >
              + Note
            </button>
            <button
              className="wb-btn wb-btn--tool"
              onClick={() => setCreatingType("markdown")}
            >
              + Doc
            </button>
            <button
              className="wb-btn wb-btn--tool"
              onClick={() => setCreatingType("mermaid")}
            >
              + Diagram
            </button>
            <button
              className="wb-btn wb-btn--tool"
              onClick={() => setDrawingMode(true)}
            >
              Draw
            </button>
          </div>
          <div className="wb-toolbar-right">
            <span className="wb-file-count">
              {files.length} file{files.length !== 1 ? "s" : ""}
            </span>
            <button className="wb-btn wb-btn--tool" onClick={loadFiles}>
              Refresh
            </button>
          </div>
        </div>

        {/* File grid */}
        <div className="wb-grid">
          {loading && files.length === 0 && (
            <div className="wb-empty">Loading files...</div>
          )}
          {!loading && files.length === 0 && (
            <div className="wb-empty">
              <div className="wb-empty-icon">&#9744;</div>
              <p>
                No files yet. Create a note, document, or diagram to get
                started.
              </p>
            </div>
          )}
          {/* System files first (_goal, _brief), then regular files */}
          {files
            .filter((f) => f.name === "_goal.md")
            .map((file) => (
              <FileCard
                key={file.name}
                file={file}
                layerColor={layerColor}
                onEdit={() => setEditingFile(file)}
                onDelete={() => handleDelete(file.name)}
                isGoal
              />
            ))}
          {files
            .filter((f) => f.name === "_brief.md")
            .map((file) => (
              <FileCard
                key={file.name}
                file={file}
                layerColor={layerColor}
                onEdit={() => setEditingFile(file)}
                onDelete={() => handleDelete(file.name)}
                isBrief
              />
            ))}
          {files
            .filter((f) => f.name !== "_goal.md" && f.name !== "_brief.md")
            .map((file) => (
              <FileCard
                key={file.name}
                file={file}
                layerColor={layerColor}
                onEdit={() => setEditingFile(file)}
                onDelete={() => handleDelete(file.name)}
              />
            ))}
        </div>

        {/* Editor modal */}
        {(editingFile || creatingType) && (
          <FileEditor
            file={editingFile}
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
