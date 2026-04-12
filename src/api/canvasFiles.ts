// Frontend API client for Mica Lite — file operations and project management

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
  content: string;
  modifiedAt?: string;
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

export async function connectProjectApi(path: string, name?: string): Promise<ProjectConfig> {
  const res = await fetch(`${API_BASE}/api/projects/connect`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path, name }),
  });
  if (!res.ok) throw new Error(`Failed to connect project: ${res.statusText}`);
  return res.json();
}

export async function deleteProjectApi(projectId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/projects/${encodeURIComponent(projectId)}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error(`Failed to delete project: ${res.statusText}`);
}

// ── File API ─────────────────────────────────────────────

function projectCanvasUrl(project: string, canvas: string): string {
  return `${API_BASE}/api/projects/${encodeURIComponent(project)}/canvases/${encodeURIComponent(canvas)}`;
}

export async function fetchFiles(project: string, canvas: CanvasId): Promise<CanvasFile[]> {
  const res = await fetch(`${projectCanvasUrl(project, canvas)}/files`);
  if (!res.ok) throw new Error(`Failed to fetch files: ${res.statusText}`);
  return res.json();
}

export async function fetchFile(project: string, canvas: CanvasId, filename: string): Promise<CanvasFile> {
  const res = await fetch(`${projectCanvasUrl(project, canvas)}/files/${encodeURIComponent(filename)}`);
  if (!res.ok) throw new Error(`Failed to fetch file: ${res.statusText}`);
  return res.json();
}

export async function saveFile(project: string, canvas: CanvasId, filename: string, content: string): Promise<void> {
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

export async function deleteFile(project: string, canvas: CanvasId, filename: string): Promise<void> {
  const res = await fetch(
    `${projectCanvasUrl(project, canvas)}/files/${encodeURIComponent(filename)}`,
    { method: "DELETE" }
  );
  if (!res.ok) throw new Error(`Failed to delete file: ${res.statusText}`);
}

// ── Layout persistence ───────────────────────────────────

export async function fetchLayout(project: string, canvas: CanvasId): Promise<Record<string, unknown>> {
  const res = await fetch(`${projectCanvasUrl(project, canvas)}/layout`);
  if (!res.ok) return {};
  return res.json();
}

export async function saveLayout(project: string, canvas: CanvasId, data: Record<string, unknown>): Promise<void> {
  await fetch(`${projectCanvasUrl(project, canvas)}/layout`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}
