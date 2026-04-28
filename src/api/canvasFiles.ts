// Frontend API client for Mica — multi-project workspace.
//
// Per-tab project scoping: every request that operates on a specific project
// passes `project` as the first argument. The wrapper `projFetch` injects an
// `X-Mica-Project: <project>` header so the server routes to the right project,
// regardless of what other tabs in the same browser are doing.
//
// Endpoints that are NOT project-scoped (workspace, project listing/create/etc.)
// use the bare `fetch` and don't need the header.

const API_BASE = import.meta.env.VITE_MICA_API || "";

/** Wrap fetch with the X-Mica-Project header for project-scoped endpoints.
 *  Also forces cache:'no-store' so two projects hitting the same URL never
 *  get cross-contaminated responses from the browser's disk cache. */
function projFetch(project: string, url: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  headers.set("X-Mica-Project", project);
  return fetch(url, { ...init, headers, cache: "no-store" });
}

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
  /** Number of agent turns currently in flight for this project. >0 means
   *  an agent is actively processing. Updated live via the
   *  project-activity-changed WebSocket event. */
  activeTurns?: number;
  /** Wall-clock timestamp (ms) of the last turn-start or turn-end for this
   *  project. Used to render "active … ago" hints if needed. */
  lastActivityAt?: number;
}

/** File metadata from GET /api/files (no content). */
export interface CanvasFile {
  name: string;      // Relative path from project root (e.g., "docs/spec.md")
  type?: "file" | "directory";
  size: number;
  modifiedAt?: string;
  content?: string;  // Loaded lazily by CardFrame when needed
  pinned?: boolean;  // true if pinned to canvas (not a canvasRoot child)
  badge?: string;    // Card class badge resolved server-side from metadata.json
  meta?: boolean;    // Card class is "meta" (configures how the canvas works) — canvas
                     // card class renders these in a docked sidebar instead of freeform.
  id?: string;       // Stable per-file UUID — used as channel-session key
}

// ── Workspace (not project-scoped) ──────────────────────

export async function fetchWorkspace(): Promise<WorkspaceInfo> {
  const res = await fetch(`${API_BASE}/api/workspace`);
  if (!res.ok) throw new Error(`Failed to fetch workspace: ${res.statusText}`);
  return res.json();
}

// ── Projects (not project-scoped — operate on the project list) ─────────

export async function fetchProjects(): Promise<ProjectInfo[]> {
  const res = await fetch(`${API_BASE}/api/projects`);
  if (!res.ok) throw new Error(`Failed to fetch projects: ${res.statusText}`);
  return res.json();
}

export async function createProjectApi(name: string, docsDir?: string, template?: string): Promise<{ success: boolean; name: string; template: string | null }> {
  const body: Record<string, string> = { name };
  if (template) body.template = template;
  // Omit docsDir when empty; server falls back to its DEFAULT_CANVAS_ROOT
  // (see server/files.ts). Avoids duplicating the canonical default here.
  else if (docsDir && docsDir.trim()) body.docsDir = docsDir.trim();
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

export async function cloneProjectApi(
  url: string,
  name?: string,
  docsDir?: string,
  template?: string,
): Promise<{ success: boolean; name: string; template: string | null }> {
  // Omit docsDir when empty; server falls back to DEFAULT_CANVAS_ROOT.
  const body: Record<string, string> = { url };
  if (name) body.name = name;
  if (docsDir && docsDir.trim()) body.docsDir = docsDir.trim();
  if (template) body.template = template;
  const res = await fetch(`${API_BASE}/api/projects/clone`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
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

/** Get info about a specific project (returns workspace info if project is empty/null). */
export async function fetchProject(project: string): Promise<ProjectInfo> {
  const res = await projFetch(project, `${API_BASE}/api/project`);
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

export async function fetchCanvasCard(project: string, signal?: AbortSignal): Promise<RenderedCanvasCard> {
  const res = await projFetch(project, `${API_BASE}/api/canvas-card`, { signal });
  if (!res.ok) throw new Error(`Failed to fetch canvas card: ${res.statusText}`);
  return res.json();
}

// ── Files ────────────────────────────────────────────────

/** Fetch file list (metadata only — name, size, modifiedAt). */
export async function fetchFiles(project: string, canvas?: boolean): Promise<CanvasFile[]> {
  const q = canvas ? "?canvas=true" : "";
  const res = await projFetch(project, `${API_BASE}/api/files${q}`);
  if (!res.ok) throw new Error(`Failed to fetch files: ${res.statusText}`);
  return res.json();
}

/** Fetch raw file content as text. */
export async function fetchFileContent(project: string, filename: string): Promise<string> {
  const res = await projFetch(project, `${API_BASE}/api/files/${encodeURIComponent(filename)}`);
  if (!res.ok) throw new Error(`Failed to fetch file: ${res.statusText}`);
  return res.text();
}

/** Fetch file metadata + content (convenience wrapper). */
export async function fetchFile(project: string, filename: string): Promise<CanvasFile> {
  const content = await fetchFileContent(project, filename);
  return { name: filename, size: content.length, content };
}

/** Get the raw file URL (for binary files — images, PDFs, etc.).
 *  `<img>` / `window.open()` can't send the `X-Mica-Project` header, so the
 *  project is carried as a query string instead — the server's
 *  getRequestProject() accepts either header or `?project=` (see
 *  server/index.ts:150). Without the project qualifier, multi-project
 *  workspaces would 404 or serve from the wrong project. */
export function getFileUrl(filename: string, project: string): string {
  return `${API_BASE}/api/files/${encodeURIComponent(filename)}?project=${encodeURIComponent(project)}`;
}

export async function saveFile(project: string, filename: string, content: string): Promise<void> {
  const res = await projFetch(project, `${API_BASE}/api/files/${encodeURIComponent(filename)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
  if (!res.ok) throw new Error(`Failed to save file: ${res.statusText}`);
}

export async function deleteFile(project: string, filename: string): Promise<void> {
  const res = await projFetch(project, `${API_BASE}/api/files/${encodeURIComponent(filename)}`, {
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

export async function fetchRenderedCard(project: string, _canvas: string, filename: string): Promise<RenderedCard> {
  const res = await projFetch(project, `${API_BASE}/api/rendered-card/${encodeURIComponent(filename)}`);
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

export async function fetchLayout(project: string): Promise<Record<string, unknown>> {
  const device = getDeviceClass();
  const res = await projFetch(project, `${API_BASE}/api/layout?device=${device}`);
  if (!res.ok) return {};
  return res.json();
}

export async function saveLayout(project: string, data: Record<string, unknown>): Promise<void> {
  const device = getDeviceClass();
  await projFetch(project, `${API_BASE}/api/layout?device=${device}`, {
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

export async function fetchCanvasBack(project: string): Promise<string> {
  const res = await projFetch(project, `${API_BASE}/api/canvas-back`);
  if (!res.ok) return "";
  const data = await res.json();
  return data.content || "";
}

export async function saveCanvasBack(project: string, content: string): Promise<void> {
  await projFetch(project, `${API_BASE}/api/canvas-back`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
}

// ── Card Backs (per-card AI context) ─────────────────────

export async function fetchCardBack(project: string, filename: string): Promise<string> {
  const res = await projFetch(project, `${API_BASE}/api/card-back/${encodeURIComponent(filename)}`);
  if (!res.ok) return "";
  const data = await res.json();
  return data.content || "";
}

export async function saveCardBack(project: string, filename: string, content: string): Promise<void> {
  await projFetch(project, `${API_BASE}/api/card-back/${encodeURIComponent(filename)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
}
