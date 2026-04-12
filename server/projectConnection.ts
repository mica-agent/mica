// Project Connection — manages workspace registry and .mica/ lifecycle.
// Projects are sovereign git repos; Mica connects to them via a .mica/ directory.

import { readFile, writeFile, mkdir, readdir, stat, unlink } from "fs/promises";
import { join } from "path";
import os from "os";
import { existsSync } from "fs";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

// ── Types ──────────────────────────────────────────────────

export interface ConnectedProject {
  id: string;
  name: string;
  path: string; // absolute path to the project repo
  canvases: string[];
  connectedAt: string;
  sandbox?: "local" | "docker";
}

export interface WorkspaceRegistry {
  projects: ConnectedProject[];
}

export interface MicaConfig {
  name: string;
  canvases: string[];
  canvasCard?: string; // filename of the canvas card (e.g. "project.project")
  agentProvider?: "claude" | "local"; // default: "claude"
  model?: string; // default model for all agents in this project
  agents?: Record<string, { // per-canvas/agent overrides
    model?: string;
  }>;
  runtime?: {
    entrypoint?: string;
    ports?: number[];
    env?: Record<string, string>;
  };
  reactive?: {
    enabled?: boolean;       // default: true
    cooldownMs?: number;     // default: 60000
  };
}

// ── Constants ──────────────────────────────────────────────

const MICA_DIR = ".mica";
const CONFIG_FILE = ".config.json";

// Projects directory — scanned for projects (any dir with .mica/.config.json)
export const PROJECTS_DIR = process.env.MICA_PROJECTS_DIR || join(os.homedir(), "mica-projects");

// ── Project Discovery (scan-based, no registry file) ──────

// ── Path Resolution ────────────────────────────────────────

/** Get the absolute filesystem path for a project */
export async function getProjectPath(projectId: string): Promise<string> {
  const projectPath = join(PROJECTS_DIR, projectId);
  if (!existsSync(join(projectPath, MICA_DIR, CONFIG_FILE))) {
    throw new Error(`Project not connected: ${projectId}`);
  }
  return projectPath;
}

/** Get the .mica directory path for a project */
export async function getMicaDir(projectId: string): Promise<string> {
  const projectPath = await getProjectPath(projectId);
  return join(projectPath, MICA_DIR);
}

/** Get the infrastructure directory for a canvas (inside .mica/).
 *  Used for dot-prefixed files: .chat-history.json, .layout.json, .config.json.
 *  Special case: canvas "_root" returns .mica/ itself. */
export async function getInfraDir(projectId: string, canvas: string): Promise<string> {
  const micaDir = await getMicaDir(projectId);
  if (canvas === "_root") return micaDir;
  return join(micaDir, canvas);
}

/** Get the card file directory for a canvas.
 *  For "_root", resolves to the canvas card's directory (e.g. project.project/).
 *  The canvas card filename is stored in .config.json as `canvasCard`. */
export async function getCanvasDir(projectId: string, canvas: string): Promise<string> {
  const projectPath = await getProjectPath(projectId);
  if (canvas === "_root") {
    // Read canvasCard from config — cards live inside the canvas card directory
    const configPath = join(projectPath, MICA_DIR, CONFIG_FILE);
    try {
      const raw = await readFile(configPath, "utf-8");
      const config = JSON.parse(raw) as MicaConfig;
      if (config.canvasCard) {
        return join(projectPath, config.canvasCard);
      }
    } catch { /* config not yet written during initial seed */ }
    // Fallback for legacy or during initial seeding
    return projectPath;
  }
  return join(projectPath, canvas);
}

// ── Dot-prefix Migration ──────────────────────────────────

// Data file renames (dot-prefix convention)
const DATA_RENAME_MAP: [string, string][] = [
  ["config.json", ".config.json"],
  ["_chat-history.json", ".chat-history.json"],
  ["_layout.json", ".layout.json"],
];

// System card renames (extension-as-class convention)
const CARD_RENAME_MAP: [string, string][] = [
  ["_project.md", "_project.project"],
  ["_goal.md", "_goal.goal"],
  ["_todo.md", "_todo.todo"],
  ["_brief.md", "_brief.brief"],
  ["_log.md", "_log.log"],
  ["_agent.md", "_agent.agent"],
];

const ALL_RENAME_MAP = [...DATA_RENAME_MAP, ...CARD_RENAME_MAP];

/** Migrate old-named files to current conventions.
 *  Runs in .mica/ root and all canvas subdirectories.
 *  Also renames _card-classes/ → .card-classes/ if present. */
export async function migrateDataFileNames(projectPath: string): Promise<void> {
  const micaDir = join(projectPath, MICA_DIR);
  if (!existsSync(micaDir)) return;

  // Rename _card-classes/ → .card-classes/ at project level
  const oldClassesDir = join(micaDir, "_card-classes");
  const newClassesDir = join(micaDir, ".card-classes");
  if (existsSync(oldClassesDir) && !existsSync(newClassesDir)) {
    try {
      const { rename } = await import("fs/promises");
      await rename(oldClassesDir, newClassesDir);
      console.log(`[migrate] Renamed _card-classes/ → .card-classes/ in ${micaDir}`);
    } catch (err) {
      console.warn(`[migrate] Failed to rename _card-classes/: ${(err as Error).message}`);
    }
  }

  // Collect directories to scan: .mica/ itself + all canvas subdirs
  const dirs = [micaDir];
  try {
    const entries = await readdir(micaDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith(".")) {
        dirs.push(join(micaDir, entry.name));
      }
    }
  } catch { /* empty */ }

  for (const dir of dirs) {
    for (const [oldName, newName] of ALL_RENAME_MAP) {
      const oldPath = join(dir, oldName);
      const newPath = join(dir, newName);
      if (existsSync(oldPath) && !existsSync(newPath)) {
        try {
          const content = await readFile(oldPath, "utf-8");
          await writeFile(newPath, content, "utf-8");
          await unlink(oldPath);
          console.log(`[migrate] Renamed ${oldName} → ${newName} in ${dir}`);
        } catch (err) {
          console.warn(`[migrate] Failed to rename ${oldName} in ${dir}: ${(err as Error).message}`);
        }
      }
    }
  }
}

// ── Project Connection ─────────────────────────────────────

/** Connect an existing directory/repo to Mica */
export async function connectProject(
  absPath: string,
  name?: string
): Promise<ConnectedProject> {
  // Validate path exists
  if (!existsSync(absPath)) {
    throw new Error(`Path does not exist: ${absPath}`);
  }

  const pathStat = await stat(absPath);
  if (!pathStat.isDirectory()) {
    throw new Error(`Path is not a directory: ${absPath}`);
  }

  // Generate ID from directory name
  const dirName = absPath.split("/").pop() || "project";
  const id = dirName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

  // Check if .mica/ already exists (reconnecting)
  const micaDir = join(absPath, MICA_DIR);
  let config: MicaConfig;

  if (existsSync(join(micaDir, CONFIG_FILE))) {
    // Reconnecting — read existing config
    const raw = await readFile(join(micaDir, CONFIG_FILE), "utf-8");
    config = JSON.parse(raw);
  } else {
    // First connection — initialize .mica/
    config = {
      name: name || dirName,
      canvases: ["workspace"],
    };
    await initMicaDir(absPath, config);
  }

  // Check if it's a git repo; init if not
  const isGitRepo = existsSync(join(absPath, ".git"));
  if (!isGitRepo) {
    await execFileAsync("git", ["init"], { cwd: absPath });
    console.log(`[connect] Initialized git repo at ${absPath}`);
  }

  const project: ConnectedProject = {
    id,
    name: config.name,
    path: absPath,
    canvases: config.canvases,
    connectedAt: new Date().toISOString(),
  };

  console.log(`[connect] Connected project "${config.name}" at ${absPath}`);
  return project;
}

/** Delete a project (removes the entire project directory) */
export async function disconnectProject(projectId: string): Promise<void> {
  const projectPath = join(PROJECTS_DIR, projectId);
  if (!existsSync(projectPath)) {
    throw new Error(`Project not found: ${projectId}`);
  }
  const { rm } = await import("fs/promises");
  await rm(projectPath, { recursive: true, force: true });
  console.log(`[connect] Deleted project "${projectId}"`);
}

/** Initialize .mica/ directory and canvas directories in a project */
export async function initMicaDir(
  projectPath: string,
  config: MicaConfig
): Promise<void> {
  const micaDir = join(projectPath, MICA_DIR);
  await mkdir(micaDir, { recursive: true });

  // Create canvas directories at project root (card files live here)
  // and corresponding infra directories inside .mica/ (for .chat-history.json etc.)
  for (const canvas of config.canvases) {
    await mkdir(join(projectPath, canvas), { recursive: true });
    await mkdir(join(micaDir, canvas), { recursive: true });
  }

  // Write config.json to .mica/
  await writeFile(
    join(micaDir, CONFIG_FILE),
    JSON.stringify(config, null, 2),
    "utf-8"
  );

  console.log(`[connect] Initialized .mica/ at ${projectPath}`);
}

/** Add a canvas to a connected project */
export async function addCanvasToProject(
  projectId: string,
  canvasName: string
): Promise<void> {
  const projectPath = join(PROJECTS_DIR, projectId);
  const configPath = join(projectPath, MICA_DIR, CONFIG_FILE);

  const raw = await readFile(configPath, "utf-8");
  const config: MicaConfig = JSON.parse(raw);
  if (config.canvases.includes(canvasName)) {
    throw new Error(`Canvas already exists: ${canvasName}`);
  }

  config.canvases.push(canvasName);
  await writeFile(configPath, JSON.stringify(config, null, 2), "utf-8");

  await mkdir(join(projectPath, canvasName), { recursive: true });
  await mkdir(join(projectPath, MICA_DIR, canvasName), { recursive: true });
}

// ── Query helpers (scan-based) ─────────────────────────────

/** Scan the projects directory for all connected projects. */
export async function listProjects(): Promise<ConnectedProject[]> {
  try {
    await mkdir(PROJECTS_DIR, { recursive: true });
    const entries = await readdir(PROJECTS_DIR, { withFileTypes: true });
    const projects: ConnectedProject[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".")) continue;
      const projectPath = join(PROJECTS_DIR, entry.name);
      const configPath = join(projectPath, MICA_DIR, CONFIG_FILE);
      try {
        const raw = await readFile(configPath, "utf-8");
        const config: MicaConfig = JSON.parse(raw);
        projects.push({
          id: entry.name,
          name: config.name || entry.name,
          path: projectPath,
          canvases: config.canvases || [],
          connectedAt: "",
        });
      } catch {
        // No .mica/.config.json — not a Mica project, skip
      }
    }
    return projects;
  } catch {
    return [];
  }
}

/** Get config for a specific project by scanning its directory. */
export async function getProjectConfig(
  projectId: string
): Promise<ConnectedProject | null> {
  const projectPath = join(PROJECTS_DIR, projectId);
  const configPath = join(projectPath, MICA_DIR, CONFIG_FILE);
  try {
    const raw = await readFile(configPath, "utf-8");
    const config: MicaConfig = JSON.parse(raw);
    return {
      id: projectId,
      name: config.name || projectId,
      path: projectPath,
      canvases: config.canvases || [],
      connectedAt: "",
    };
  } catch {
    return null;
  }
}

export async function readMicaConfig(
  projectId: string
): Promise<MicaConfig | null> {
  const project = await getProjectConfig(projectId);
  if (!project) return null;
  const configPath = join(project.path, MICA_DIR, CONFIG_FILE);
  try {
    const raw = await readFile(configPath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function validateProjectCanvas(
  project: string,
  canvas: string
): Promise<void> {
  const config = await getProjectConfig(project);
  if (!config) throw new Error(`Invalid project: ${project}`);
  // "_root" is always valid — it refers to .mica/ itself (project-level cards)
  if (canvas === "_root") return;
  if (!config.canvases.includes(canvas)) {
    throw new Error(`Invalid canvas "${canvas}" in project "${project}"`);
  }
}

// ── Migration from legacy layers/ (deprecated) ──────────────

const LEGACY_PROJECTS_FILE = join(os.homedir(), ".mica", "projects.json");
const LEGACY_CANVASES_ROOT = join(os.homedir(), ".mica", "layers");

interface LegacyProjectConfig {
  id: string;
  name: string;
  canvases: string[];
  createdAt: string;
  sandbox?: "local" | "docker";
}

/** Migrate projects from old layers/{project}/ layout to .mica/ in new locations */
export async function migrateLegacyProjects(
  targetDir?: string
): Promise<ConnectedProject[]> {
  // Read old registry
  let legacyProjects: LegacyProjectConfig[] = [];
  try {
    const raw = await readFile(LEGACY_PROJECTS_FILE, "utf-8");
    const registry = JSON.parse(raw);
    legacyProjects = registry.projects || [];
  } catch {
    return []; // No legacy registry
  }

  if (legacyProjects.length === 0) return [];

  const migrated: ConnectedProject[] = [];
  const baseDir = targetDir || process.env.MICA_PROJECTS_DIR || join(os.homedir(), "mica-projects");

  for (const legacy of legacyProjects) {
    const legacyDir = join(LEGACY_CANVASES_ROOT, legacy.id);
    if (!existsSync(legacyDir)) continue;

    // Create project directory
    const projectDir = join(baseDir, legacy.id);
    await mkdir(projectDir, { recursive: true });

    // Move canvas files to .mica/ in the new location
    const micaDir = join(projectDir, MICA_DIR);
    for (const canvas of legacy.canvases) {
      const srcCanvas = join(legacyDir, canvas);
      const dstCanvas = join(micaDir, canvas);
      await mkdir(dstCanvas, { recursive: true });

      if (existsSync(srcCanvas)) {
        // Copy files (not move, to be safe during migration)
        const files = await readdir(srcCanvas);
        for (const file of files) {
          const srcFile = join(srcCanvas, file);
          const fileStat = await stat(srcFile);
          if (fileStat.isFile()) {
            const content = await readFile(srcFile, "utf-8");
            await writeFile(join(dstCanvas, file), content, "utf-8");
          }
        }
      }
    }

    // Also copy .card-classes if they exist
    const legacyClasses = join(legacyDir, ".card-classes");
    if (existsSync(legacyClasses)) {
      const classNames = await readdir(legacyClasses);
      for (const cls of classNames) {
        const srcClass = join(legacyClasses, cls);
        const dstClass = join(micaDir, ".card-classes", cls);
        await mkdir(dstClass, { recursive: true });
        const classFiles = await readdir(srcClass);
        for (const file of classFiles) {
          const content = await readFile(join(srcClass, file), "utf-8");
          await writeFile(join(dstClass, file), content, "utf-8");
        }
      }
    }

    // Write .mica/config.json
    const config: MicaConfig = {
      name: legacy.name,
      canvases: legacy.canvases,
    };
    await writeFile(
      join(micaDir, CONFIG_FILE),
      JSON.stringify(config, null, 2),
      "utf-8"
    );

    // Init git repo
    if (!existsSync(join(projectDir, ".git"))) {
      await execFileAsync("git", ["init"], { cwd: projectDir });
    }

    // Connect to workspace
    const connected = await connectProject(projectDir, legacy.name);
    migrated.push(connected);

    console.log(`[migrate] Migrated "${legacy.name}" from layers/${legacy.id}/ → ${projectDir}/`);
  }

  return migrated;
}
