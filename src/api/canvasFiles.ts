// Frontend API client for Mica Lite — single project, simple file operations.

export type CanvasId = string;

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

// ── Canvas Card (server-rendered) ────────────────────────

export interface RenderedCanvasCard {
  html: string;
  exports: string[];
  dependencies: { scripts?: string[]; styles?: string[] };
  meta: Record<string, string>;
}

export async function fetchCanvasCard(signal?: AbortSignal): Promise<RenderedCanvasCard> {
  const res = await fetch(`${API_BASE}/api/canvas-card`, { signal });
  if (!res.ok) throw new Error(`Failed to fetch canvas card: ${res.statusText}`);
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

// ── Rendered Card (for card classes with render.js) ──────

export interface RenderedCard {
  filename: string;
  html: string;
  exports: string[];
  dependencies?: { scripts?: string[]; styles?: string[] };
  meta: Record<string, string>;
}

export async function fetchRenderedCard(project: string, canvas: string, filename: string): Promise<RenderedCard> {
  // In single-project mode, project/canvas are ignored — use the rendered-card endpoint
  const res = await fetch(`${API_BASE}/api/rendered-card/${encodeURIComponent(filename)}`);
  if (!res.ok) throw new Error(`Failed to fetch rendered card: ${res.statusText}`);
  return res.json();
}

// ── Device class ─────────────────────────────────────────

export function getDeviceClass(): string {
  const w = window.innerWidth;
  if (w < 768) return "phone";
  if (w < 1200) return "tablet";
  if (w < 2560) return "desktop";
  return "display";
}

// ── Layout (per device class) ────────────────────────────

export async function fetchLayout(): Promise<Record<string, unknown>> {
  const device = getDeviceClass();
  const res = await fetch(`${API_BASE}/api/layout?device=${device}`);
  if (!res.ok) return {};
  return res.json();
}

export async function saveLayout(data: Record<string, unknown>): Promise<void> {
  const device = getDeviceClass();
  await fetch(`${API_BASE}/api/layout?device=${device}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

// ── Focus sync ───────────────────────────────────────────

export function broadcastFocus(filename: string): void {
  // Use the WebSocket broadcast mechanism
  import("./micaSocket").then(({ broadcast }) => {
    broadcast("card-focus", { filename });
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
