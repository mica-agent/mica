// Seed starter files for new projects and handle initialization.
// Card files are created at the project root. Infrastructure stays in .mica/.

import { existsSync } from "fs";
import { readFile, writeFile as writeFileFs, mkdir } from "fs/promises";
import { join } from "path";
import {
  listFiles,
  writeCanvasFile,
  ensureCanvasDir,
  listProjects,
  migrateToCardDirectories,
} from "./canvasFiles.js";
import {
  connectProject,
  initMicaDir,
  readWorkspaceRegistry,
  migrateLegacyProjects,
  migrateDataFileNames,
  type ConnectedProject,
  type MicaConfig,
} from "./projectConnection.js";

import os from "os";

// Projects live outside the Mica repo to avoid tsx/bundler scanning issues.
// Default: ~/mica-projects/ (overridable via MICA_PROJECTS_DIR)
const PROJECTS_DIR = process.env.MICA_PROJECTS_DIR || join(os.homedir(), "mica-projects");

// ── Seed content for a new project ──────────────────────────
// Card files are written to the project root (canvas = "_root").

const NEW_PROJECT_SEEDS: Record<string, string> = {
  "_project.project": "", // Content will be generated with project name

  "_goal.goal": `# Project Goal

Define what this project aims to achieve.

## Checklist

- [ ] Problem statement is clear and specific
- [ ] Target users are identified
- [ ] Success criteria are measurable
- [ ] Scope is bounded — what's in v1 and what's deferred
`,

  "_brief.brief": `# Agent Brief

## Who You Are
You are an AI collaborator for this project. You help the human think through problems, create artifacts, and make progress toward the project goal.

## How to Work
- When the human shares ideas or notes, **refine them** into structured documents. Don't just discuss — write files.
- When information is scattered across chat, **synthesize it** into a file so nothing gets lost.
- When you spot gaps, **create a draft** and ask the human to review it.
- When a relationship or flow would be clearer as a diagram, **create a .mmd mermaid file**.
- Always prefer creating/updating files over long chat responses. The whiteboard is the artifact — chat is ephemeral.

## Dependencies
<!-- Uncomment to add packages for Docker sandbox mode (PROD) -->
<!-- - apt: ffmpeg, curl -->
<!-- - pip: pandas, requests -->
`,

  "_todo.todo": `# To Do

## Active

## Blocked

## Done (recent)
`,

  "_log.log": `# Activity Log
`,

  // Sample content cards to demonstrate different card types
  "welcome.md": `# Welcome to Mica

This is a **markdown** card. You can use it for documentation, notes, or any rich text content.

## Features
- Full markdown support with tables, code blocks, and more
- Rendered as a card on your project whiteboard
- Editable by you and the agent

## Getting Started
1. Edit the **Goal** card to define what you're building
2. Chat with the agent to brainstorm and create artifacts
3. Use the toolbar to add notes, docs, and diagrams
`,

  "architecture.mmd": `graph TD
    A[User Interface] --> B[Project Card]
    B --> C[System Cards]
    B --> D[Content Cards]
    C --> E[Goal]
    C --> F[Todo]
    C --> G[Brief]
    D --> H[Documents]
    D --> I[Diagrams]
    D --> J[Notes]
    B --> K[Agent Chat]
`,
};

// ── Seed a new project ──────────────────────────────────────

/** Create a new project directory, connect it to Mica, and seed starter files */
export async function seedNewProject(
  projectId: string,
  projectName: string,
  agentProvider?: "claude" | "local",
): Promise<ConnectedProject> {
  // Create project directory
  const projectDir = join(PROJECTS_DIR, projectId);
  await mkdir(projectDir, { recursive: true });

  // Connect the project (this creates .mica/ and git init)
  const config = await connectProject(projectDir, projectName);

  // Write agentProvider to config if specified
  if (agentProvider && agentProvider !== "claude") {
    const configPath = join(projectDir, ".mica", ".config.json");
    try {
      const raw = await readFile(configPath, "utf-8");
      const micaConfig = JSON.parse(raw);
      micaConfig.agentProvider = agentProvider;
      await writeFileFs(configPath, JSON.stringify(micaConfig, null, 2), "utf-8");
      console.log(`[seed] Set agentProvider="${agentProvider}" for "${projectId}"`);
    } catch (err) {
      console.error(`[seed] Failed to set agentProvider:`, (err as Error).message);
    }
  }

  // Seed the _root canvas with starter files
  const existing = await listFiles(projectId, "_root");
  // Filter out config.json from the count — it's always present
  const userFiles = existing.filter((f) => f.name !== ".config.json");
  if (userFiles.length === 0) {
    console.log(`[seed] Seeding project "${projectId}" with starter files...`);
    for (const [filename, content] of Object.entries(NEW_PROJECT_SEEDS)) {
      const fileContent = filename === "_project.project" ? `# ${projectName}\n` : content;
      await writeCanvasFile(projectId, "_root", filename, fileContent);
    }
    console.log(
      `[seed] Created ${Object.keys(NEW_PROJECT_SEEDS).length} files in ${projectDir}/`
    );
  }

  return config;
}

// ── Startup initialization ──────────────────────────────────

export async function initializeProjects(): Promise<void> {
  await mkdir(PROJECTS_DIR, { recursive: true });

  const registry = await readWorkspaceRegistry();

  // If we already have connected projects, run migrations on each
  if (registry.projects.length > 0) {
    console.log(`[seed] Found ${registry.projects.length} connected project(s).`);
    for (const project of registry.projects) {
      await migrateDataFileNames(project.path);
      // Migrate flat card files → card directories
      const migrated = await migrateToCardDirectories(project.path, "_root");
      if (migrated > 0) {
        console.log(`[seed] Migrated ${migrated} card(s) to directories in "${project.id}".`);
      }
    }
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
