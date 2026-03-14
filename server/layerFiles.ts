// Layer file management — filesystem CRUD scoped to layers/<layerId>/

import { readdir, readFile, writeFile, unlink, mkdir, stat } from "fs/promises";
import { join, basename, extname } from "path";

export type LayerId =
  | "mission"
  | "experience"
  | "architecture"
  | "implementation";

const VALID_LAYERS: LayerId[] = [
  "mission",
  "experience",
  "architecture",
  "implementation",
];

const VALID_EXTENSIONS = [".txt", ".md", ".mmd", ".py", ".json"];

const LAYERS_ROOT = join(process.cwd(), "layers");

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

function validateLayer(layer: string): asserts layer is LayerId {
  if (!VALID_LAYERS.includes(layer as LayerId)) {
    throw new Error(`Invalid layer: ${layer}`);
  }
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

export async function ensureLayerDir(layer: string): Promise<string> {
  validateLayer(layer);
  const dir = join(LAYERS_ROOT, layer);
  await mkdir(dir, { recursive: true });
  return dir;
}

export async function listFiles(layer: string): Promise<LayerFile[]> {
  const dir = await ensureLayerDir(layer);
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
  layer: string,
  filename: string
): Promise<LayerFile> {
  validateLayer(layer);
  validateFilename(filename);
  const dir = join(LAYERS_ROOT, layer);
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
  layer: string,
  filename: string,
  content: string
): Promise<void> {
  validateLayer(layer);
  validateFilename(filename);
  const dir = await ensureLayerDir(layer);
  await writeFile(join(dir, filename), content, "utf-8");
}

export async function deleteLayerFile(
  layer: string,
  filename: string
): Promise<void> {
  validateLayer(layer);
  validateFilename(filename);
  const dir = join(LAYERS_ROOT, layer);
  await unlink(join(dir, filename));
}

export async function getAllFilesAsContext(layer: string): Promise<string> {
  const files = await listFiles(layer);
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
