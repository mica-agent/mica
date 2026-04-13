// CanvasCardRuntime — Mica Lite canvas component.
// Renders project files as cards on a spatial canvas.
// Single project model — no project ID needed.

import { useState, useEffect, useCallback } from "react";
import { fetchFiles, fetchLayout, saveLayout, saveFile, deleteFile, fetchFile, fetchCanvasBack, saveCanvasBack } from "../api/canvasFiles";
import type { CanvasFile } from "../api/canvasFiles";
import { on } from "../api/micaSocket";
import CardFrame from "./CardFrame";
import FileEditor from "./FileEditor";
import ChatCard from "./ChatCard";
import DraggableCard from "./DraggableCard";

interface CardLayout {
  x: number;
  y: number;
  w: number;
  h: number;
}

export default function CanvasCardRuntime() {
  const [files, setFiles] = useState<CanvasFile[]>([]);
  const [layouts, setLayouts] = useState<Record<string, CardLayout>>({});
  const [loading, setLoading] = useState(true);
  const [editingFile, setEditingFile] = useState<CanvasFile | null>(null);
  const [creatingFile, setCreatingFile] = useState(false);
  const [showCanvasBack, setShowCanvasBack] = useState(false);
  const [canvasBackContent, setCanvasBackContent] = useState("");
  const [chatCards, setChatCards] = useState<string[]>([]);

  // Load files and layout
  useEffect(() => {
    const controller = new AbortController();

    async function load() {
      try {
        const [fileList, layoutData] = await Promise.allSettled([
          fetchFiles(),
          fetchLayout(),
        ]);

        if (controller.signal.aborted) return;

        if (fileList.status === "fulfilled") setFiles(fileList.value);
        if (layoutData.status === "fulfilled") setLayouts((layoutData.value as Record<string, CardLayout>) || {});
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }

    load();
    return () => controller.abort();
  }, []);

  // Listen for file changes via WebSocket
  useEffect(() => {
    const unsubs = [
      on("file-created", async (data: { filename: string }) => {
        try {
          const file = await fetchFile(data.filename);
          setFiles((prev) => [...prev.filter((f) => f.name !== data.filename), file]);
        } catch { /* ignore */ }
      }),
      on("file-changed", async (data: { filename: string }) => {
        try {
          const file = await fetchFile(data.filename);
          setFiles((prev) => prev.map((f) => (f.name === data.filename ? file : f)));
        } catch { /* ignore */ }
      }),
      on("file-deleted", (data: { filename: string }) => {
        setFiles((prev) => prev.filter((f) => f.name !== data.filename));
        setLayouts((prev) => {
          const next = { ...prev };
          delete next[data.filename];
          return next;
        });
      }),
      on("layout-changed", (data: { source?: string }) => {
        if (data.source === "self") return;
        fetchLayout().then((l) => setLayouts(l as Record<string, CardLayout>));
      }),
    ];

    return () => unsubs.forEach((u) => u());
  }, []);

  const handleLayoutChange = useCallback(
    (filename: string, layout: CardLayout) => {
      setLayouts((prev) => {
        const next = { ...prev, [filename]: layout };
        saveLayout({ ...next, source: "self" });
        return next;
      });
    },
    []
  );

  const handleDeleteFile = useCallback(async (filename: string) => {
    await deleteFile(filename);
    setFiles((prev) => prev.filter((f) => f.name !== filename));
  }, []);

  const handleSaveFile = useCallback(async (filename: string, content: string) => {
    await saveFile(filename, content);
    setFiles((prev) => prev.map((f) => (f.name === filename ? { ...f, content } : f)));
  }, []);

  const handleCreateFile = useCallback(async (filename: string, content: string) => {
    await saveFile(filename, content);
    const file = await fetchFile(filename);
    setFiles((prev) => [...prev, file]);
    setCreatingFile(false);
  }, []);

  if (loading) {
    return <div style={{ padding: 40, color: "#888" }}>Loading project...</div>;
  }

  return (
    <div style={{ position: "relative", width: "100%", height: "100%", overflow: "auto", background: "#1a1a2e" }}>
      {/* Toolbar */}
      <div style={{
        padding: "8px 16px", background: "#1a1a2e", borderBottom: "1px solid #333",
        display: "flex", gap: 8, alignItems: "center",
      }}>
        <button onClick={() => setCreatingFile(true)} style={btnStyle}>
          + New File
        </button>
        <button
          onClick={() => setChatCards((prev) => [...prev, `chat-${Date.now()}`])}
          style={btnStyle}
        >
          + AI Chat
        </button>
        <button
          onClick={() => {
            if (!showCanvasBack) fetchCanvasBack().then(setCanvasBackContent);
            setShowCanvasBack(!showCanvasBack);
          }}
          style={{ ...btnStyle, background: showCanvasBack ? "#4a4a8a" : "#2a2a4a" }}
        >
          {showCanvasBack ? "Hide AI Context" : "Project AI Context"}
        </button>
        <span style={{ color: "#666", fontSize: 12 }}>
          {files.length} file{files.length !== 1 ? "s" : ""} on canvas
        </span>
      </div>

      {/* Canvas back — project-level AI context */}
      {showCanvasBack && (
        <div style={{
          padding: "12px 16px", background: "#1e1e38", borderBottom: "1px solid #333",
        }}>
          <div style={{ color: "#888", fontSize: 11, marginBottom: 6 }}>
            Project AI Context — instructions that shape how the AI participates on this canvas
          </div>
          <textarea
            value={canvasBackContent}
            onChange={(e) => setCanvasBackContent(e.target.value)}
            onBlur={() => saveCanvasBack(canvasBackContent)}
            placeholder="e.g. 'This is a GCP automation project. Prefer Terraform. Always consider IAM implications.'"
            style={{
              width: "100%", minHeight: 80, background: "#252540", color: "#ccc",
              border: "1px solid #444", borderRadius: 6, padding: 8, fontSize: 13,
              fontFamily: "monospace", resize: "vertical", outline: "none", boxSizing: "border-box",
            }}
          />
        </div>
      )}

      {/* Canvas area */}
      <div style={{ position: "relative", minHeight: "calc(100vh - 50px)", padding: 20 }}>
        {files.length === 0 && (
          <div style={{ color: "#666", textAlign: "center", marginTop: 100 }}>
            No files yet. Click "+ New File" to get started.
          </div>
        )}
        {files.map((file) => {
          const layout = layouts[file.name] || {
            x: 20 + (files.indexOf(file) % 3) * 420,
            y: 20 + Math.floor(files.indexOf(file) / 3) * 320,
            w: 400,
            h: 300,
          };
          return (
            <CardFrame
              key={file.name}
              file={file}
              layout={layout}
              onLayoutChange={(l) => handleLayoutChange(file.name, l)}
              onEdit={() => setEditingFile(file)}
              onDelete={() => handleDeleteFile(file.name)}
              onSave={(content) => handleSaveFile(file.name, content)}
            />
          );
        })}
      </div>

      {/* Chat cards */}
      {chatCards.map((chatId) => {
        const layoutKey = `__chat__${chatId}`;
        const chatLayout = layouts[layoutKey] || {
          x: 20 + chatCards.indexOf(chatId) * 30,
          y: 20 + chatCards.indexOf(chatId) * 30,
          w: 420,
          h: 500,
        };
        return (
          <DraggableCard
            key={chatId}
            layout={chatLayout}
            onLayoutChange={(l) => handleLayoutChange(layoutKey, l)}
            title="AI Chat"
            subtitle="Qwen3"
            actions={
              <button
                onClick={() => setChatCards((prev) => prev.filter((id) => id !== chatId))}
                style={{ background: "transparent", color: "#888", border: "none", cursor: "pointer", fontSize: 16, padding: "0 4px" }}
                title="Close"
              >
                &times;
              </button>
            }
          >
            <ChatCard chatId={chatId} onClose={() => setChatCards((prev) => prev.filter((id) => id !== chatId))} />
          </DraggableCard>
        );
      })}

      {/* File editor modal */}
      {(editingFile || creatingFile) && (
        <FileEditor
          file={editingFile || undefined}
          onSave={editingFile
            ? (content) => { handleSaveFile(editingFile.name, content); setEditingFile(null); }
            : (content, filename) => { if (filename) handleCreateFile(filename, content); }
          }
          onClose={() => { setEditingFile(null); setCreatingFile(false); }}
          isNew={creatingFile}
        />
      )}
    </div>
  );
}

const btnStyle: React.CSSProperties = {
  background: "#2a2a4a",
  color: "#ccc",
  border: "1px solid #444",
  borderRadius: 4,
  padding: "4px 12px",
  cursor: "pointer",
  fontSize: 13,
};
