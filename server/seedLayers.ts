// Seed starter files for new projects and handle migration from legacy layout

import { existsSync } from "fs";
import { readdir, rename, mkdir } from "fs/promises";
import { join } from "path";
import {
  listFiles,
  writeLayerFile,
  ensureLayerDir,
  createProject,
  readProjectRegistry,
  listProjects,
  type ProjectConfig,
} from "./layerFiles.js";

const LAYERS_ROOT = join(process.cwd(), "layers");

// Legacy layer names from the pre-project era
const LEGACY_LAYERS = ["mission", "experience", "architecture", "implementation"];

// ── Seed content for a new project ──────────────────────────

const NEW_PROJECT_SEEDS: Record<string, string> = {
  "_goal.md": `# Project Goal

Define what this project aims to achieve.

## Checklist

- [ ] Problem statement is clear and specific
- [ ] Target users are identified
- [ ] Success criteria are measurable
- [ ] Scope is bounded — what's in v1 and what's deferred
`,

  "_brief.md": `# Agent Brief

## Who You Are
You are an AI collaborator for this project workspace. You help the human think through problems, create artifacts, and make progress toward the project goal.

## How to Work
- When the human shares ideas or notes, **refine them** into structured documents on the whiteboard. Don't just discuss — write files.
- When information is scattered across chat, **synthesize it** into a whiteboard file so nothing gets lost.
- When you spot gaps, **create a draft** and ask the human to review it.
- When a relationship or flow would be clearer as a diagram, **create a .mmd mermaid file**.
- Always prefer creating/updating whiteboard files over long chat responses. The whiteboard is the artifact — chat is ephemeral.

## Dependencies
<!-- Uncomment to add packages for Docker sandbox mode (PROD) -->
<!-- - apt: ffmpeg, curl -->
<!-- - pip: pandas, requests -->
`,

  "_todo.md": `# To Do

## Active

## Blocked

## Done (recent)
`,

  "_log.md": `# Activity Log
`,

  "_chat.md": ``,
};

// ── Seed a new project ──────────────────────────────────────

export async function seedNewProject(projectId: string, projectName: string): Promise<ProjectConfig> {
  const config = await createProject(projectId, projectName, ["workspace"]);

  // Seed the workspace layer with starter files
  const existing = await listFiles(projectId, "workspace");
  if (existing.length === 0) {
    console.log(`[seed] Seeding project "${projectId}" with starter files...`);
    for (const [filename, content] of Object.entries(NEW_PROJECT_SEEDS)) {
      await writeLayerFile(projectId, "workspace", filename, content);
    }
    console.log(
      `[seed] Created ${Object.keys(NEW_PROJECT_SEEDS).length} files in layers/${projectId}/workspace/`
    );
  }

  return config;
}

// ── Migration from legacy flat layout ───────────────────────

async function migrateLegacyLayers(): Promise<boolean> {
  // Check if any legacy layer dirs exist at the top level of layers/
  const legacyDirs: string[] = [];
  for (const layer of LEGACY_LAYERS) {
    const dir = join(LAYERS_ROOT, layer);
    if (existsSync(dir)) {
      legacyDirs.push(layer);
    }
  }

  if (legacyDirs.length === 0) return false;

  console.log(`[seed] Found legacy layer directories: ${legacyDirs.join(", ")}`);
  console.log(`[seed] Migrating to project structure: layers/default-project/...`);

  const projectId = "default-project";
  const projectDir = join(LAYERS_ROOT, projectId);
  await mkdir(projectDir, { recursive: true });

  // Move each legacy layer dir into the project dir
  for (const layer of legacyDirs) {
    const src = join(LAYERS_ROOT, layer);
    const dest = join(projectDir, layer);
    try {
      await rename(src, dest);
      console.log(`[seed] Moved layers/${layer}/ → layers/${projectId}/${layer}/`);
    } catch (err) {
      console.error(`[seed] Failed to move ${layer}:`, (err as Error).message);
    }
  }

  // Create the project in the registry
  const config = await createProject(projectId, "Default Project", legacyDirs);
  console.log(`[seed] Created project "${projectId}" with layers: ${legacyDirs.join(", ")}`);

  return true;
}

// ── Startup initialization ──────────────────────────────────

export async function initializeProjects(): Promise<void> {
  await mkdir(LAYERS_ROOT, { recursive: true });

  const registry = await readProjectRegistry();

  // If we already have projects, nothing to do
  if (registry.projects.length > 0) {
    console.log(`[seed] Found ${registry.projects.length} project(s) in registry.`);
    return;
  }

  // Try migration first
  const migrated = await migrateLegacyLayers();
  if (migrated) return;

  // No projects and no legacy dirs — create a starter project
  console.log("[seed] No projects found. Creating starter project...");
  await seedNewProject("my-project", "My Project");
}
