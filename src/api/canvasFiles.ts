// Frontend API client for canvas file operations

export type CanvasId = string;

export interface ProjectConfig {
  id: string;
  name: string;
  path: string;
  canvases: string[];
  connectedAt: string;
}

export interface CanvasFile {
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

export async function createProject(id: string, name: string, agentProvider?: string): Promise<ProjectConfig> {
  const res = await fetch(`${API_BASE}/api/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, name, agentProvider }),
  });
  if (!res.ok) throw new Error(`Failed to create project: ${res.statusText}`);
  return res.json();
}

export async function connectProjectApi(path: string, name?: string): Promise<ProjectConfig> {
  const res = await fetch(`${API_BASE}/api/projects/connect`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path, name }),
  });
  if (!res.ok) throw new Error(`Failed to connect project: ${res.statusText}`);
  return res.json();
}

export async function disconnectProjectApi(projectId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/projects/${encodeURIComponent(projectId)}/disconnect`, {
    method: "POST",
  });
  if (!res.ok) throw new Error(`Failed to disconnect project: ${res.statusText}`);
}

export async function deleteProjectApi(projectId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/projects/${encodeURIComponent(projectId)}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error(`Failed to delete project: ${res.statusText}`);
}

// ── File API (project-scoped) ────────────────────────────

function projectCanvasUrl(project: string, canvas: string): string {
  return `${API_BASE}/api/projects/${encodeURIComponent(project)}/canvases/${encodeURIComponent(canvas)}`;
}

export async function fetchFiles(project: string, canvas: CanvasId): Promise<CanvasFile[]> {
  const res = await fetch(`${projectCanvasUrl(project, canvas)}/files`);
  if (!res.ok) throw new Error(`Failed to fetch files: ${res.statusText}`);
  return res.json();
}

export async function fetchFile(
  project: string,
  canvas: CanvasId,
  filename: string
): Promise<CanvasFile> {
  const res = await fetch(
    `${projectCanvasUrl(project, canvas)}/files/${encodeURIComponent(filename)}`
  );
  if (!res.ok) throw new Error(`Failed to fetch file: ${res.statusText}`);
  return res.json();
}

export async function saveFile(
  project: string,
  canvas: CanvasId,
  filename: string,
  content: string
): Promise<void> {
  const res = await fetch(
    `${projectCanvasUrl(project, canvas)}/files/${encodeURIComponent(filename)}`,
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
  canvas: CanvasId,
  filename: string
): Promise<void> {
  const res = await fetch(
    `${projectCanvasUrl(project, canvas)}/files/${encodeURIComponent(filename)}`,
    { method: "DELETE" }
  );
  if (!res.ok) throw new Error(`Failed to delete file: ${res.statusText}`);
}

export async function convertDrawing(
  project: string,
  canvas: CanvasId,
  imageBase64: string
): Promise<{ mermaid: string; filename: string }> {
  const res = await fetch(
    `${projectCanvasUrl(project, canvas)}/convert-drawing`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ imageBase64 }),
    }
  );
  if (!res.ok) throw new Error(`Failed to convert drawing: ${res.statusText}`);
  return res.json();
}

export async function fetchCards(project: string, canvas: CanvasId): Promise<RenderedCard[]> {
  const res = await fetch(`${projectCanvasUrl(project, canvas)}/cards`);
  if (!res.ok) throw new Error(`Failed to fetch cards: ${res.statusText}`);
  return res.json();
}

// ── Project Card API ──────────────────────────────────────

/** Fetch the rendered project card (layout shell with child metadata) */
export async function fetchProjectCard(project: string): Promise<RenderedCard> {
  const res = await fetch(`${API_BASE}/api/projects/${encodeURIComponent(project)}/card`);
  if (!res.ok) throw new Error(`Failed to fetch project card: ${res.statusText}`);
  return res.json();
}

/** Fetch all rendered child cards for a project's _root canvas */
export async function fetchProjectChildren(project: string): Promise<RenderedCard[]> {
  const res = await fetch(`${API_BASE}/api/projects/${encodeURIComponent(project)}/children`);
  if (!res.ok) throw new Error(`Failed to fetch project children: ${res.statusText}`);
  return res.json();
}

export interface ContextStats {
  project: string;
  canvas: string;
  files: number;
  fileContentChars: number;
  systemPromptChars: number;
  chatHistoryChars: number;
  totalContextChars: number;
  estimatedTokens: number;
}

export async function fetchContextStats(project: string, canvas: CanvasId): Promise<ContextStats> {
  const res = await fetch(`${projectCanvasUrl(project, canvas)}/context-stats`);
  if (!res.ok) throw new Error(`Failed to fetch context stats: ${res.statusText}`);
  return res.json();
}

export async function callCardExport(
  project: string,
  canvas: CanvasId,
  filename: string,
  fn: string,
  args: Record<string, unknown> = {}
): Promise<unknown> {
  const res = await fetch(
    `${projectCanvasUrl(project, canvas)}/cards/${encodeURIComponent(filename)}/call/${encodeURIComponent(fn)}`,
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
