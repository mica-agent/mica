// Frontend API client for Mica — multi-project workspace.

const API_BASE = import.meta.env.VITE_MICA_API || "";

export interface WorkspaceInfo {
  name: string;
  path: string;
}

export interface ProjectInfo {
  name: string;
  path: string;
  project?: string;
  hasGit?: boolean;
  hasMica?: boolean;
  docsDir?: string;
}

/** File metadata from GET /api/files (no content). */
export interface CanvasFile {
  name: string;      // Relative path from project root (e.g., "docs/spec.md")
  type?: "file" | "directory";
  size: number;
  modifiedAt?: string;
  content?: string;  // Loaded lazily by CardFrame when needed
  pinned?: boolean;  // true if pinned to canvas (not a canvasRoot child)
}

// ── Workspace ───────────────────────────────────────────

export async function fetchWorkspace(): Promise<WorkspaceInfo> {
  const res = await fetch(`${API_BASE}/api/workspace`);
  if (!res.ok) throw new Error(`Failed to fetch workspace: ${res.statusText}`);
  return res.json();
}

// ── Projects ────────────────────────────────────────────

export async function fetchProjects(): Promise<ProjectInfo[]> {
  const res = await fetch(`${API_BASE}/api/projects`);
  if (!res.ok) throw new Error(`Failed to fetch projects: ${res.statusText}`);
  return res.json();
}

export async function createProjectApi(name: string, docsDir?: string, template?: string): Promise<{ success: boolean; name: string; template: string | null }> {
  const body: Record<string, string> = { name };
  if (template) body.template = template;
  else body.docsDir = docsDir || "docs";
  const res = await fetch(`${API_BASE}/api/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error || "Failed to create project");
  }
  return res.json();
}

export interface TemplateInfo {
  name: string;
  description: string;
}

export async function fetchTemplates(): Promise<TemplateInfo[]> {
  const res = await fetch(`${API_BASE}/api/templates`);
  if (!res.ok) throw new Error(`Failed to fetch templates: ${res.statusText}`);
  return res.json();
}

export async function cloneProjectApi(url: string, name?: string, docsDir?: string): Promise<{ success: boolean; name: string }> {
  const res = await fetch(`${API_BASE}/api/projects/clone`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, name, docsDir: docsDir || "docs" }),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error || "Failed to clone project");
  }
  return res.json();
}

export async function openProjectApi(project: string, docsDir?: string): Promise<ProjectInfo> {
  const res = await fetch(`${API_BASE}/api/projects/${encodeURIComponent(project)}/open`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ docsDir }),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error || "Failed to open project");
  }
  return res.json();
}

export async function renameProjectApi(project: string, newName: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/projects/${encodeURIComponent(project)}/rename`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ newName }),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error || "Failed to rename project");
  }
}

export async function deleteProjectApi(project: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/projects/${encodeURIComponent(project)}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error || "Failed to delete project");
  }
}

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

/** Fetch file list (metadata only — name, size, modifiedAt). */
export async function fetchFiles(canvas?: boolean): Promise<CanvasFile[]> {
  const q = canvas ? "?canvas=true" : "";
  const res = await fetch(`${API_BASE}/api/files${q}`);
  if (!res.ok) throw new Error(`Failed to fetch files: ${res.statusText}`);
  return res.json();
}

/** Fetch raw file content as text. */
export async function fetchFileContent(filename: string): Promise<string> {
  const res = await fetch(`${API_BASE}/api/files/${encodeURIComponent(filename)}`);
  if (!res.ok) throw new Error(`Failed to fetch file: ${res.statusText}`);
  return res.text();
}

/** Fetch file metadata + content (convenience wrapper). */
export async function fetchFile(filename: string): Promise<CanvasFile> {
  const content = await fetchFileContent(filename);
  return { name: filename, size: content.length, content };
}

/** Get the raw file URL (for binary files — images, PDFs, etc.). */
export function getFileUrl(filename: string): string {
  return `${API_BASE}/api/files/${encodeURIComponent(filename)}`;
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

// ── Rendered Card ───────────────────────────────────────

export interface RenderedCard {
  filename: string;
  html: string;
  exports: string[];
  dependencies?: { scripts?: string[]; styles?: string[] };
  meta: Record<string, string>;
}

export async function fetchRenderedCard(project: string, canvas: string, filename: string): Promise<RenderedCard> {
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
