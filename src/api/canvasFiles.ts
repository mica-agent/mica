// Frontend API client for Mica Lite — single project, simple file operations.

const API_BASE = import.meta.env.VITE_MICA_API || "";

export interface ProjectInfo {
  name: string;
  path: string;
}

export interface CanvasFile {
  name: string;
  content: string;
  modifiedAt?: string;
}

// ── Project ──────────────────────────────────────────────

export async function fetchProject(): Promise<ProjectInfo> {
  const res = await fetch(`${API_BASE}/api/project`);
  if (!res.ok) throw new Error(`Failed to fetch project: ${res.statusText}`);
  return res.json();
}

// ── Files ────────────────────────────────────────────────

export async function fetchFiles(): Promise<CanvasFile[]> {
  const res = await fetch(`${API_BASE}/api/files`);
  if (!res.ok) throw new Error(`Failed to fetch files: ${res.statusText}`);
  return res.json();
}

export async function fetchFile(filename: string): Promise<CanvasFile> {
  const res = await fetch(`${API_BASE}/api/files/${encodeURIComponent(filename)}`);
  if (!res.ok) throw new Error(`Failed to fetch file: ${res.statusText}`);
  return res.json();
}

export async function saveFile(filename: string, content: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/files/${encodeURIComponent(filename)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
  if (!res.ok) throw new Error(`Failed to save file: ${res.statusText}`);
}

export async function deleteFile(filename: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/files/${encodeURIComponent(filename)}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error(`Failed to delete file: ${res.statusText}`);
}

// ── Layout ───────────────────────────────────────────────

export async function fetchLayout(): Promise<Record<string, unknown>> {
  const res = await fetch(`${API_BASE}/api/layout`);
  if (!res.ok) return {};
  return res.json();
}

export async function saveLayout(data: Record<string, unknown>): Promise<void> {
  await fetch(`${API_BASE}/api/layout`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

// ── Canvas Back (project-level AI context) ───────────────

export async function fetchCanvasBack(): Promise<string> {
  const res = await fetch(`${API_BASE}/api/canvas-back`);
  if (!res.ok) return "";
  const data = await res.json();
  return data.content || "";
}

export async function saveCanvasBack(content: string): Promise<void> {
  await fetch(`${API_BASE}/api/canvas-back`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
}

// ── Card Backs (per-card AI context) ─────────────────────

export async function fetchCardBack(filename: string): Promise<string> {
  const res = await fetch(`${API_BASE}/api/card-back/${encodeURIComponent(filename)}`);
  if (!res.ok) return "";
  const data = await res.json();
  return data.content || "";
}

export async function saveCardBack(filename: string, content: string): Promise<void> {
  await fetch(`${API_BASE}/api/card-back/${encodeURIComponent(filename)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
}
