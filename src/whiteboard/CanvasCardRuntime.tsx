// CanvasCardRuntime — Mica Lite canvas component.
// Renders project files as cards on a spatial canvas.
// Files are files — content is rendered client-side based on extension.

import { useState, useEffect, useCallback } from "react";
import { fetchFiles, fetchLayout, saveLayout, saveFile, deleteFile, fetchFile } from "../api/canvasFiles";
import type { CanvasFile } from "../api/canvasFiles";
import { on } from "../api/micaSocket";
import CardFrame from "./CardFrame";
import FileEditor from "./FileEditor";

interface Props {
  projectId: string;
}

interface CardLayout {
  x: number;
  y: number;
  w: number;
  h: number;
}

export default function CanvasCardRuntime({ projectId }: Props) {
  const [files, setFiles] = useState<CanvasFile[]>([]);
  const [layouts, setLayouts] = useState<Record<string, CardLayout>>({});
  const [loading, setLoading] = useState(true);
  const [editingFile, setEditingFile] = useState<CanvasFile | null>(null);
  const [creatingFile, setCreatingFile] = useState(false);

  const canvas = "_root";

  // Load files and layout
  useEffect(() => {
    const controller = new AbortController();

    async function load() {
      try {
        const [fileList, layoutData] = await Promise.allSettled([
          fetchFiles(projectId, canvas),
          fetchLayout(projectId, canvas),
        ]);

        if (controller.signal.aborted) return;

        if (fileList.status === "fulfilled") {
          setFiles(fileList.value);
        }
        if (layoutData.status === "fulfilled") {
          setLayouts((layoutData.value as Record<string, CardLayout>) || {});
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }

    load();
    return () => controller.abort();
  }, [projectId]);

  // Listen for file changes via WebSocket
  useEffect(() => {
    const unsubs = [
      on("file-created", async (data: { project: string; canvas: string; filename: string }) => {
        if (data.project !== projectId) return;
        try {
          const file = await fetchFile(projectId, canvas, data.filename);
          setFiles((prev) => [...prev.filter((f) => f.name !== data.filename), file]);
        } catch { /* ignore */ }
      }),
      on("file-changed", async (data: { project: string; canvas: string; filename: string }) => {
        if (data.project !== projectId) return;
        try {
          const file = await fetchFile(projectId, canvas, data.filename);
          setFiles((prev) => prev.map((f) => (f.name === data.filename ? file : f)));
        } catch { /* ignore */ }
      }),
      on("file-deleted", (data: { project: string; canvas: string; filename: string }) => {
        if (data.project !== projectId) return;
        setFiles((prev) => prev.filter((f) => f.name !== data.filename));
        setLayouts((prev) => {
          const next = { ...prev };
          delete next[data.filename];
          return next;
        });
      }),
      on("layout-changed", (data: { project: string; source?: string }) => {
        if (data.project !== projectId) return;
        fetchLayout(projectId, canvas).then((l) => setLayouts(l as Record<string, CardLayout>));
      }),
    ];

    return () => unsubs.forEach((u) => u());
  }, [projectId]);

  // Save layout when cards are moved/resized
  const handleLayoutChange = useCallback(
    (filename: string, layout: CardLayout) => {
      setLayouts((prev) => {
        const next = { ...prev, [filename]: layout };
        saveLayout(projectId, canvas, { ...next, source: "self" });
        return next;
      });
    },
    [projectId]
  );

  const handleDeleteFile = useCallback(
    async (filename: string) => {
      await deleteFile(projectId, canvas, filename);
      setFiles((prev) => prev.filter((f) => f.name !== filename));
    },
    [projectId]
  );

  const handleSaveFile = useCallback(
    async (filename: string, content: string) => {
      await saveFile(projectId, canvas, filename, content);
      setFiles((prev) => prev.map((f) => (f.name === filename ? { ...f, content } : f)));
    },
    [projectId]
  );

  const handleCreateFile = useCallback(
    async (filename: string, content: string) => {
      await saveFile(projectId, canvas, filename, content);
      const file = await fetchFile(projectId, canvas, filename);
      setFiles((prev) => [...prev, file]);
      setCreatingFile(false);
    },
    [projectId]
  );

  if (loading) {
    return <div style={{ padding: 40, color: "#888" }}>Loading project...</div>;
  }

  return (
    <div style={{ position: "relative", width: "100%", height: "100%", overflow: "auto", background: "#1a1a2e" }}>
      {/* Toolbar */}
      <div style={{
        position: "sticky", top: 0, left: 0, zIndex: 100,
        padding: "8px 16px", background: "#1a1a2e", borderBottom: "1px solid #333",
        display: "flex", gap: 8, alignItems: "center",
      }}>
        <button onClick={() => setCreatingFile(true)} style={btnStyle}>
          + New File
        </button>
        <span style={{ color: "#666", fontSize: 12 }}>
          {files.length} file{files.length !== 1 ? "s" : ""} on canvas
        </span>
      </div>

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
              projectId={projectId}
              canvas={canvas}
            />
          );
        })}
      </div>

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
