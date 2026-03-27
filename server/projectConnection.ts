// Project Connection — manages workspace registry and .mica/ lifecycle.
// Projects are sovereign git repos; Mica connects to them via a .mica/ directory.

import { readFile, writeFile, mkdir, readdir, stat } from "fs/promises";
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
  model?: string; // default model for all agents in this project
  agents?: Record<string, { // per-canvas/agent overrides
    model?: string;
  }>;
  runtime?: {
    entrypoint?: string;
    ports?: number[];
    env?: Record<string, string>;
  };
}

// ── Constants ──────────────────────────────────────────────

const MICA_DIR = ".mica";
const CONFIG_FILE = "config.json";

// Workspace registry lives in Mica's own directory
const WORKSPACE_FILE = join(process.cwd(), "workspaces.json");

// Legacy path for backward compatibility during migration
const LEGACY_CANVASES_ROOT = join(process.cwd(), "layers");
const LEGACY_PROJECTS_FILE = join(LEGACY_CANVASES_ROOT, "_projects.json");

// ── Workspace Registry ─────────────────────────────────────

export async function readWorkspaceRegistry(): Promise<WorkspaceRegistry> {
  try {
    const raw = await readFile(WORKSPACE_FILE, "utf-8");
    return JSON.parse(raw);
  } catch {
    return { projects: [] };
  }
}

async function writeWorkspaceRegistry(registry: WorkspaceRegistry): Promise<void> {
  await writeFile(WORKSPACE_FILE, JSON.stringify(registry, null, 2), "utf-8");
}

// ── Path Resolution ────────────────────────────────────────

/** Get the absolute filesystem path for a connected project */
export async function getProjectPath(projectId: string): Promise<string> {
  const registry = await readWorkspaceRegistry();
  const project = registry.projects.find((p) => p.id === projectId);
  if (!project) {
    throw new Error(`Project not connected: ${projectId}`);
  }
  return project.path;
}

/** Get the .mica directory path for a project */
export async function getMicaDir(projectId: string): Promise<string> {
  const projectPath = await getProjectPath(projectId);
  return join(projectPath, MICA_DIR);
}

/** Get the canvas directory inside .mica/ */
export async function getCanvasDir(projectId: string, canvas: string): Promise<string> {
  const micaDir = await getMicaDir(projectId);
  return join(micaDir, canvas);
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

  // Check not already connected
  const registry = await readWorkspaceRegistry();
  if (registry.projects.some((p) => p.id === id)) {
    throw new Error(`Project already connected: ${id}`);
  }

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

  // Check if it's a git repo; offer to init if not
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

  registry.projects.push(project);
  await writeWorkspaceRegistry(registry);

  console.log(`[connect] Connected project "${config.name}" at ${absPath}`);
  return project;
}

/** Disconnect a project from the workspace (leaves .mica/ intact) */
export async function disconnectProject(projectId: string): Promise<void> {
  const registry = await readWorkspaceRegistry();
  const before = registry.projects.length;
  registry.projects = registry.projects.filter((p) => p.id !== projectId);
  if (registry.projects.length === before) {
    throw new Error(`Project not found: ${projectId}`);
  }
  await writeWorkspaceRegistry(registry);
  console.log(`[connect] Disconnected project "${projectId}" (files preserved)`);
}

/** Initialize .mica/ directory in a project */
export async function initMicaDir(
  projectPath: string,
  config: MicaConfig
): Promise<void> {
  const micaDir = join(projectPath, MICA_DIR);

  // Create .mica/ and canvas subdirectories
  for (const canvas of config.canvases) {
    await mkdir(join(micaDir, canvas), { recursive: true });
  }

  // Write config.json
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
  const registry = await readWorkspaceRegistry();
  const project = registry.projects.find((p) => p.id === projectId);
  if (!project) throw new Error(`Project not found: ${projectId}`);
  if (project.canvases.includes(canvasName)) {
    throw new Error(`Canvas already exists: ${canvasName}`);
  }

  project.canvases.push(canvasName);
  await writeWorkspaceRegistry(registry);

  // Create the canvas directory in .mica/
  const canvasDir = join(project.path, MICA_DIR, canvasName);
  await mkdir(canvasDir, { recursive: true });

  // Update .mica/config.json
  const configPath = join(project.path, MICA_DIR, CONFIG_FILE);
  try {
    const raw = await readFile(configPath, "utf-8");
    const config: MicaConfig = JSON.parse(raw);
    config.canvases.push(canvasName);
    await writeFile(configPath, JSON.stringify(config, null, 2), "utf-8");
  } catch {
    // Config file missing — create it
    const config: MicaConfig = { name: project.name, canvases: project.canvases };
    await writeFile(configPath, JSON.stringify(config, null, 2), "utf-8");
  }
}

// ── Query helpers ──────────────────────────────────────────

export async function listProjects(): Promise<ConnectedProject[]> {
  const registry = await readWorkspaceRegistry();
  return registry.projects;
}

export async function getProjectConfig(
  projectId: string
): Promise<ConnectedProject | null> {
  const registry = await readWorkspaceRegistry();
  return registry.projects.find((p) => p.id === projectId) || null;
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
  if (!config.canvases.includes(canvas)) {
    throw new Error(`Invalid canvas "${canvas}" in project "${project}"`);
  }
}

// ── Migration from legacy layers/ ──────────────────────────

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

    // Also copy _card-classes if they exist
    const legacyClasses = join(legacyDir, "_card-classes");
    if (existsSync(legacyClasses)) {
      const classNames = await readdir(legacyClasses);
      for (const cls of classNames) {
        const srcClass = join(legacyClasses, cls);
        const dstClass = join(micaDir, "_card-classes", cls);
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
