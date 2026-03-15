// Layer file management — filesystem CRUD scoped to layers/<project>/<layer>/

import { readdir, readFile, writeFile, unlink, mkdir, stat, rm } from "fs/promises";
import { join, basename, extname } from "path";
import { existsSync } from "fs";

export type LayerId = string;

export interface ProjectConfig {
  id: string;
  name: string;
  layers: string[];
  createdAt: string;
  sandbox?: "local" | "docker";
}

export interface ProjectRegistry {
  projects: ProjectConfig[];
}

const VALID_EXTENSIONS = [".txt", ".md", ".mmd", ".py", ".json", ".html"];

const LAYERS_ROOT = join(process.cwd(), "layers");
const PROJECTS_FILE = join(LAYERS_ROOT, "_projects.json");

export interface LayerFile {
  name: string;
  type: "text" | "markdown" | "mermaid";
  content: string;
  modifiedAt: string;
}

function extToType(ext: string): "text" | "markdown" | "mermaid" {
  if (ext === ".md") return "markdown";
  if (ext === ".mmd") return "mermaid";
  return "text";
}

// ── Project management ──────────────────────────────────────

export async function readProjectRegistry(): Promise<ProjectRegistry> {
  try {
    const raw = await readFile(PROJECTS_FILE, "utf-8");
    return JSON.parse(raw);
  } catch {
    return { projects: [] };
  }
}

async function writeProjectRegistry(registry: ProjectRegistry): Promise<void> {
  await mkdir(LAYERS_ROOT, { recursive: true });
  await writeFile(PROJECTS_FILE, JSON.stringify(registry, null, 2), "utf-8");
}

export async function listProjects(): Promise<ProjectConfig[]> {
  const registry = await readProjectRegistry();
  return registry.projects;
}

export async function getProjectConfig(projectId: string): Promise<ProjectConfig | null> {
  const registry = await readProjectRegistry();
  return registry.projects.find((p) => p.id === projectId) || null;
}

export async function createProject(id: string, name: string, layers: string[] = ["workspace"]): Promise<ProjectConfig> {
  const registry = await readProjectRegistry();
  if (registry.projects.some((p) => p.id === id)) {
    throw new Error(`Project already exists: ${id}`);
  }
  const config: ProjectConfig = {
    id,
    name,
    layers,
    createdAt: new Date().toISOString(),
  };
  registry.projects.push(config);
  await writeProjectRegistry(registry);

  // Create layer directories
  for (const layer of layers) {
    await mkdir(join(LAYERS_ROOT, id, layer), { recursive: true });
  }

  return config;
}

export async function deleteProject(id: string): Promise<void> {
  const registry = await readProjectRegistry();
  registry.projects = registry.projects.filter((p) => p.id !== id);
  await writeProjectRegistry(registry);

  // Remove project directory
  const dir = join(LAYERS_ROOT, id);
  if (existsSync(dir)) {
    await rm(dir, { recursive: true });
  }
}

export async function addLayerToProject(projectId: string, layerName: string): Promise<void> {
  const registry = await readProjectRegistry();
  const project = registry.projects.find((p) => p.id === projectId);
  if (!project) throw new Error(`Project not found: ${projectId}`);
  if (project.layers.includes(layerName)) throw new Error(`Layer already exists: ${layerName}`);
  project.layers.push(layerName);
  await writeProjectRegistry(registry);
  await mkdir(join(LAYERS_ROOT, projectId, layerName), { recursive: true });
}

// ── Validation ──────────────────────────────────────────────

export async function validateProjectLayer(project: string, layer: string): Promise<void> {
  const config = await getProjectConfig(project);
  if (!config) throw new Error(`Invalid project: ${project}`);
  if (!config.layers.includes(layer)) throw new Error(`Invalid layer "${layer}" in project "${project}"`);
}

function validateFilename(filename: string): void {
  const base = basename(filename);
  if (base !== filename || filename.includes("..") || filename.includes("/")) {
    throw new Error(`Invalid filename: ${filename}`);
  }
  const ext = extname(filename);
  if (!VALID_EXTENSIONS.includes(ext)) {
    throw new Error(
      `Invalid extension: ${ext}. Must be one of: ${VALID_EXTENSIONS.join(", ")}`
    );
  }
}

// ── File operations (project-scoped) ────────────────────────

export async function ensureLayerDir(project: string, layer: string): Promise<string> {
  const dir = join(LAYERS_ROOT, project, layer);
  await mkdir(dir, { recursive: true });
  return dir;
}

export async function listFiles(project: string, layer: string): Promise<LayerFile[]> {
  const dir = await ensureLayerDir(project, layer);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  const files: LayerFile[] = [];
  for (const name of entries) {
    const ext = extname(name);
    if (!VALID_EXTENSIONS.includes(ext)) continue;

    const filepath = join(dir, name);
    const content = await readFile(filepath, "utf-8");
    const stats = await stat(filepath);
    files.push({
      name,
      type: extToType(ext),
      content,
      modifiedAt: stats.mtime.toISOString(),
    });
  }

  return files.sort(
    (a, b) =>
      new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime()
  );
}

export async function readLayerFile(
  project: string,
  layer: string,
  filename: string
): Promise<LayerFile> {
  validateFilename(filename);
  const dir = join(LAYERS_ROOT, project, layer);
  const filepath = join(dir, filename);
  const content = await readFile(filepath, "utf-8");
  const stats = await stat(filepath);
  return {
    name: filename,
    type: extToType(extname(filename)),
    content,
    modifiedAt: stats.mtime.toISOString(),
  };
}

export async function writeLayerFile(
  project: string,
  layer: string,
  filename: string,
  content: string
): Promise<void> {
  validateFilename(filename);
  const dir = await ensureLayerDir(project, layer);
  await writeFile(join(dir, filename), content, "utf-8");
}

export async function deleteLayerFile(
  project: string,
  layer: string,
  filename: string
): Promise<void> {
  validateFilename(filename);
  const dir = join(LAYERS_ROOT, project, layer);
  await unlink(join(dir, filename));
}

export async function getAllFilesAsContext(project: string, layer: string): Promise<string> {
  const files = await listFiles(project, layer);
  if (files.length === 0) {
    return "(No files yet in this layer.)";
  }

  return files
    .map(
      (f) =>
        `--- ${f.name} (${f.type}) ---\n${f.content}\n--- end ${f.name} ---`
    )
    .join("\n\n");
}
