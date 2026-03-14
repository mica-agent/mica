// Frontend API client for layer file operations

export type LayerId = string;

export interface ProjectConfig {
  id: string;
  name: string;
  layers: string[];
  createdAt: string;
}

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

// ── Project API ──────────────────────────────────────────

export async function fetchProjects(): Promise<ProjectConfig[]> {
  const res = await fetch(`${API_BASE}/api/projects`);
  if (!res.ok) throw new Error(`Failed to fetch projects: ${res.statusText}`);
  return res.json();
}

export async function fetchProject(projectId: string): Promise<ProjectConfig> {
  const res = await fetch(`${API_BASE}/api/projects/${encodeURIComponent(projectId)}`);
  if (!res.ok) throw new Error(`Failed to fetch project: ${res.statusText}`);
  return res.json();
}

export async function createProject(id: string, name: string): Promise<ProjectConfig> {
  const res = await fetch(`${API_BASE}/api/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, name }),
  });
  if (!res.ok) throw new Error(`Failed to create project: ${res.statusText}`);
  return res.json();
}

export async function deleteProjectApi(projectId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/projects/${encodeURIComponent(projectId)}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error(`Failed to delete project: ${res.statusText}`);
}

// ── File API (project-scoped) ────────────────────────────

function projectLayerUrl(project: string, layer: string): string {
  return `${API_BASE}/api/projects/${encodeURIComponent(project)}/layers/${encodeURIComponent(layer)}`;
}

export async function fetchFiles(project: string, layer: LayerId): Promise<LayerFile[]> {
  const res = await fetch(`${projectLayerUrl(project, layer)}/files`);
  if (!res.ok) throw new Error(`Failed to fetch files: ${res.statusText}`);
  return res.json();
}

export async function fetchFile(
  project: string,
  layer: LayerId,
  filename: string
): Promise<LayerFile> {
  const res = await fetch(
    `${projectLayerUrl(project, layer)}/files/${encodeURIComponent(filename)}`
  );
  if (!res.ok) throw new Error(`Failed to fetch file: ${res.statusText}`);
  return res.json();
}

export async function saveFile(
  project: string,
  layer: LayerId,
  filename: string,
  content: string
): Promise<void> {
  const res = await fetch(
    `${projectLayerUrl(project, layer)}/files/${encodeURIComponent(filename)}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    }
  );
  if (!res.ok) throw new Error(`Failed to save file: ${res.statusText}`);
}

export async function deleteFile(
  project: string,
  layer: LayerId,
  filename: string
): Promise<void> {
  const res = await fetch(
    `${projectLayerUrl(project, layer)}/files/${encodeURIComponent(filename)}`,
    { method: "DELETE" }
  );
  if (!res.ok) throw new Error(`Failed to delete file: ${res.statusText}`);
}

export async function convertDrawing(
  project: string,
  layer: LayerId,
  imageBase64: string
): Promise<{ mermaid: string; filename: string }> {
  const res = await fetch(
    `${projectLayerUrl(project, layer)}/convert-drawing`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ imageBase64 }),
    }
  );
  if (!res.ok) throw new Error(`Failed to convert drawing: ${res.statusText}`);
  return res.json();
}

export async function fetchCards(project: string, layer: LayerId): Promise<RenderedCard[]> {
  const res = await fetch(`${projectLayerUrl(project, layer)}/cards`);
  if (!res.ok) throw new Error(`Failed to fetch cards: ${res.statusText}`);
  return res.json();
}

export interface ContextStats {
  project: string;
  layer: string;
  files: number;
  fileContentChars: number;
  systemPromptChars: number;
  chatHistoryChars: number;
  totalContextChars: number;
  estimatedTokens: number;
}

export async function fetchContextStats(project: string, layer: LayerId): Promise<ContextStats> {
  const res = await fetch(`${projectLayerUrl(project, layer)}/context-stats`);
  if (!res.ok) throw new Error(`Failed to fetch context stats: ${res.statusText}`);
  return res.json();
}

export async function callCardExport(
  project: string,
  layer: LayerId,
  filename: string,
  fn: string,
  args: Record<string, unknown> = {}
): Promise<unknown> {
  const res = await fetch(
    `${projectLayerUrl(project, layer)}/cards/${encodeURIComponent(filename)}/call/${encodeURIComponent(fn)}`,
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
