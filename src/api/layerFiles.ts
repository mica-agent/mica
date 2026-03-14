// Frontend API client for layer file operations

export type LayerId = "mission" | "experience" | "architecture" | "implementation";

export interface LayerFile {
  name: string;
  type: "text" | "markdown" | "mermaid";
  content: string;
  modifiedAt: string;
}

export interface CardMeta {
  cardClass: string;
  title: string;
  badge: string;
  isSystem: boolean;
  config: Record<string, string>;
}

export interface RenderedCard {
  filename: string;
  html: string;
  exports: string[];
  meta: CardMeta;
}

const API_BASE = import.meta.env.VITE_MICA_API || "";

export async function fetchFiles(layer: LayerId): Promise<LayerFile[]> {
  const res = await fetch(`${API_BASE}/api/layers/${layer}/files`);
  if (!res.ok) throw new Error(`Failed to fetch files: ${res.statusText}`);
  return res.json();
}

export async function fetchFile(
  layer: LayerId,
  filename: string
): Promise<LayerFile> {
  const res = await fetch(
    `${API_BASE}/api/layers/${layer}/files/${encodeURIComponent(filename)}`
  );
  if (!res.ok) throw new Error(`Failed to fetch file: ${res.statusText}`);
  return res.json();
}

export async function saveFile(
  layer: LayerId,
  filename: string,
  content: string
): Promise<void> {
  const res = await fetch(
    `${API_BASE}/api/layers/${layer}/files/${encodeURIComponent(filename)}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    }
  );
  if (!res.ok) throw new Error(`Failed to save file: ${res.statusText}`);
}

export async function deleteFile(
  layer: LayerId,
  filename: string
): Promise<void> {
  const res = await fetch(
    `${API_BASE}/api/layers/${layer}/files/${encodeURIComponent(filename)}`,
    { method: "DELETE" }
  );
  if (!res.ok) throw new Error(`Failed to delete file: ${res.statusText}`);
}

export async function convertDrawing(
  layer: LayerId,
  imageBase64: string
): Promise<{ mermaid: string; filename: string }> {
  const res = await fetch(
    `${API_BASE}/api/layers/${layer}/convert-drawing`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ imageBase64 }),
    }
  );
  if (!res.ok) throw new Error(`Failed to convert drawing: ${res.statusText}`);
  return res.json();
}

export async function fetchCards(layer: LayerId): Promise<RenderedCard[]> {
  const res = await fetch(`${API_BASE}/api/layers/${layer}/cards`);
  if (!res.ok) throw new Error(`Failed to fetch cards: ${res.statusText}`);
  return res.json();
}

export interface ContextStats {
  layer: string;
  files: number;
  fileContentChars: number;
  systemPromptChars: number;
  chatHistoryChars: number;
  totalContextChars: number;
  estimatedTokens: number;
}

export async function fetchContextStats(layer: LayerId): Promise<ContextStats> {
  const res = await fetch(`${API_BASE}/api/layers/${layer}/context-stats`);
  if (!res.ok) throw new Error(`Failed to fetch context stats: ${res.statusText}`);
  return res.json();
}

export async function callCardExport(
  layer: LayerId,
  filename: string,
  fn: string,
  args: Record<string, unknown> = {}
): Promise<unknown> {
  const res = await fetch(
    `${API_BASE}/api/layers/${layer}/cards/${encodeURIComponent(filename)}/call/${encodeURIComponent(fn)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(args),
    }
  );
  if (!res.ok) throw new Error(`Export call failed: ${res.statusText}`);
  const data = await res.json();
  return data.result;
}
