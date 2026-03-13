import { useState, useEffect, useCallback, useImperativeHandle, forwardRef } from "react";
import mermaid from "mermaid";
import { fetchFiles, saveFile, deleteFile, convertDrawing } from "../api/layerFiles";
import type { LayerFile, LayerId } from "../api/layerFiles";
import FileCard from "./FileCard";
import FileEditor from "./FileEditor";
import ExpandedCardView from "./ExpandedCardView";
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

// System file helpers
const SYSTEM_FILES = ["_goal.md", "_todo.md", "_brief.md", "_log.md"];
function isSystemFile(name: string) { return SYSTEM_FILES.includes(name); }

function fileTitle(name: string): string {
  if (name === "_goal.md") return "Layer Goal";
  if (name === "_todo.md") return "To Do";
  if (name === "_brief.md") return "Agent Brief";
  if (name === "_log.md") return "Activity Log";
  return name.replace(/\.(txt|md|mmd)$/, "").replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function fileBadge(file: LayerFile): string {
  if (file.name === "_goal.md") return "GOAL";
  if (file.name === "_todo.md") return "TODO";
  if (file.name === "_brief.md") return "BRIEF";
  if (file.name === "_log.md") return "LOG";
  if (file.type === "markdown") return "MD";
  if (file.type === "mermaid") return "MMD";
  return "TXT";
}

// Parse _todo.md to extract counts
function parseTodoCounts(content: string): { active: number; blocked: number; done: number } {
  let active = 0, blocked = 0, done = 0;
  let section = "active";
  for (const line of content.split("\n")) {
    const lower = line.toLowerCase().trim();
    if (lower.startsWith("## active")) section = "active";
    else if (lower.startsWith("## blocked")) section = "blocked";
    else if (lower.startsWith("## done")) section = "done";
    else if (/^- \[x\]/i.test(line.trim())) done++;
    else if (/^- \[ \]/.test(line.trim())) {
      if (section === "blocked") blocked++;
      else active++;
    }
  }
  return { active, blocked, done };
}

const WhiteboardView = forwardRef<WhiteboardHandle, Props>(
  function WhiteboardView({ layerId, layerColor }, ref) {
    const [files, setFiles] = useState<LayerFile[]>([]);
    const [loading, setLoading] = useState(true);
    const [editingFile, setEditingFile] = useState<LayerFile | null>(null);
    const [expandedFile, setExpandedFile] = useState<LayerFile | null>(null);
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

    useImperativeHandle(ref, () => ({ refetch: loadFiles }), [loadFiles]);

    useEffect(() => {
      setLoading(true);
      loadFiles();
    }, [loadFiles]);

    // Poll every 5 seconds
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

    // Separate system files from content files
    const systemFiles = files.filter((f) => isSystemFile(f.name));
    const contentFiles = files.filter((f) => !isSystemFile(f.name));

    const goalFile = systemFiles.find((f) => f.name === "_goal.md");
    const todoFile = systemFiles.find((f) => f.name === "_todo.md");
    const briefFile = systemFiles.find((f) => f.name === "_brief.md");
    const logFile = systemFiles.find((f) => f.name === "_log.md");

    const todoCounts = todoFile ? parseTodoCounts(todoFile.content) : null;

    function renderCard(file: LayerFile, opts: { isGoal?: boolean; isTodo?: boolean; isBrief?: boolean; isLog?: boolean; todoCounts?: { active: number; blocked: number; done: number } | null } = {}) {
      return (
        <FileCard
          key={file.name}
          file={file}
          layerColor={layerColor}
          onEdit={() => { setExpandedFile(null); setEditingFile(file); }}
          onDelete={() => handleDelete(file.name)}
          onExpand={() => setExpandedFile(file)}
          {...opts}
        />
      );
    }

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
            <span className="wb-file-count">
              {files.length} file{files.length !== 1 ? "s" : ""}
            </span>
            <button className="wb-btn wb-btn--tool" onClick={loadFiles}>
              Refresh
            </button>
          </div>
        </div>

        {/* Content area */}
        <div className="wb-grid">
          {loading && files.length === 0 && (
            <div className="wb-empty">Loading files...</div>
          )}
          {!loading && files.length === 0 && (
            <div className="wb-empty">
              <div className="wb-empty-icon">&#9744;</div>
              <p>No files yet. Create a note, document, or diagram to get started.</p>
            </div>
          )}

          {/* System cards — full-width section above masonry */}
          {(goalFile || todoFile || briefFile || logFile) && (
            <div className="wb-system-cards">
              {goalFile && renderCard(goalFile, { isGoal: true })}
              {todoFile && renderCard(todoFile, { isTodo: true, todoCounts })}
              {briefFile && renderCard(briefFile, { isBrief: true })}
              {logFile && renderCard(logFile, { isLog: true })}
            </div>
          )}

          {/* Content cards — masonry layout */}
          {contentFiles.length > 0 && (
            <div className="wb-masonry">
              {contentFiles.map((file) => renderCard(file))}
            </div>
          )}
        </div>

        {/* Expanded card reader */}
        {expandedFile && (
          <ExpandedCardView
            file={expandedFile}
            layerColor={layerColor}
            onClose={() => setExpandedFile(null)}
            onEdit={() => { setEditingFile(expandedFile); setExpandedFile(null); }}
            title={fileTitle(expandedFile.name)}
            badge={fileBadge(expandedFile)}
          />
        )}

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
