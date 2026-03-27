// Seed starter files for new projects and handle initialization.
// In the project-first model, seeding creates .mica/ inside a project directory.

import { existsSync } from "fs";
import { readFile, mkdir } from "fs/promises";
import { join } from "path";
import {
  listFiles,
  writeCanvasFile,
  ensureCanvasDir,
  listProjects,
} from "./canvasFiles.js";
import {
  connectProject,
  initMicaDir,
  readWorkspaceRegistry,
  migrateLegacyProjects,
  type ConnectedProject,
  type MicaConfig,
} from "./projectConnection.js";

import os from "os";

// Projects live outside the Mica repo to avoid tsx/bundler scanning issues.
// Default: ~/mica-projects/ (overridable via MICA_PROJECTS_DIR)
const PROJECTS_DIR = process.env.MICA_PROJECTS_DIR || join(os.homedir(), "mica-projects");

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

/** Create a new project directory, connect it to Mica, and seed starter files */
export async function seedNewProject(
  projectId: string,
  projectName: string
): Promise<ConnectedProject> {
  // Create project directory
  const projectDir = join(PROJECTS_DIR, projectId);
  await mkdir(projectDir, { recursive: true });

  // Connect the project (this creates .mica/ and git init)
  const config = await connectProject(projectDir, projectName);

  // Seed the workspace canvas with starter files
  const existing = await listFiles(projectId, "workspace");
  if (existing.length === 0) {
    console.log(`[seed] Seeding project "${projectId}" with starter files...`);
    for (const [filename, content] of Object.entries(NEW_PROJECT_SEEDS)) {
      await writeCanvasFile(projectId, "workspace", filename, content);
    }
    console.log(
      `[seed] Created ${Object.keys(NEW_PROJECT_SEEDS).length} files in ${projectDir}/.mica/workspace/`
    );
  }

  return config;
}

// ── Startup initialization ──────────────────────────────────

export async function initializeProjects(): Promise<void> {
  await mkdir(PROJECTS_DIR, { recursive: true });

  const registry = await readWorkspaceRegistry();

  // If we already have connected projects, nothing to do
  if (registry.projects.length > 0) {
    console.log(`[seed] Found ${registry.projects.length} connected project(s).`);
    return;
  }

  // Try migrating legacy layers/ projects
  const legacyFile = join(process.cwd(), "layers", "_projects.json");
  if (existsSync(legacyFile)) {
    console.log("[seed] Found legacy layers/ structure. Migrating...");
    const migrated = await migrateLegacyProjects(PROJECTS_DIR);
    if (migrated.length > 0) {
      console.log(`[seed] Migrated ${migrated.length} project(s) to projects/.`);
      return;
    }
  }

  // No projects — create a starter project
  console.log("[seed] No projects found. Creating starter project...");
  await seedNewProject("my-project", "My Project");
}
