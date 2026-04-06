// Seed starter files for new projects and handle initialization.
// The canvas card class defines the project structure via its _ prefixed seed files.
// Infrastructure stays in .mica/.

import { existsSync } from "fs";
import { readFile, writeFile as writeFileFs, mkdir } from "fs/promises";
import { join } from "path";
import {
  listFiles,
  createCard,
  writeCanvasFile,
  listProjects,
  getCardClassExtension,
  getPrimaryFile,
} from "./cardFiles.js";
import {
  connectProject,
  listProjects as listConnectedProjects,
  migrateLegacyProjects,
  migrateDataFileNames,
  type ConnectedProject,
  type MicaConfig,
} from "./projectConnection.js";

import { PROJECTS_DIR } from "./projectConnection.js";

// ── Seed a new project ──────────────────────────────────────

/** Create a new project directory, connect it to Mica, and seed starter files.
 *  The canvas card class (default: "simple-project") defines what child cards
 *  get created via its _ prefixed seed files. */
export async function seedNewProject(
  projectId: string,
  projectName: string,
  agentProvider?: "claude" | "local",
  canvasClass: string = "simple-project",
): Promise<ConnectedProject> {
  const projectDir = join(PROJECTS_DIR, projectId);
  await mkdir(projectDir, { recursive: true });

  // Connect the project (creates .mica/ and git init)
  const config = await connectProject(projectDir, projectName);

  // Canvas card filename = projectId + card class extension
  const ext = getCardClassExtension(canvasClass) || ".project";
  const canvasCardFilename = `${projectId}${ext}`;

  // Write canvasCard + agentProvider to config
  const configPath = join(projectDir, ".mica", ".config.json");
  try {
    const raw = await readFile(configPath, "utf-8");
    const micaConfig: MicaConfig = JSON.parse(raw);
    micaConfig.canvasCard = canvasCardFilename;
    if (agentProvider && agentProvider !== "claude") {
      micaConfig.agentProvider = agentProvider;
    }
    await writeFileFs(configPath, JSON.stringify(micaConfig, null, 2), "utf-8");
  } catch (err) {
    console.error(`[seed] Failed to write config:`, (err as Error).message);
  }

  // Create the canvas card — this triggers copySeedFiles which:
  //   - Copies internal files (_.layout.json → .layout.json)
  //   - Creates child card subdirectories (_goal.goal → goal.goal/)
  // Note: getCanvasDir reads canvasCard from config, but at this point the
  // canvas card directory doesn't exist yet. createCard calls getCanvasDir
  // with "_root" which will resolve to project.project/ directory.
  // But we need the directory to exist first. Create it manually.
  const canvasCardDir = join(projectDir, canvasCardFilename);
  await mkdir(canvasCardDir, { recursive: true });

  // Now createCard will work — it creates the card inside the canvas dir,
  // but we actually want to seed the canvas card itself at the project root.
  // The canvas card IS the root, so we create it directly.
  // Use createCard with a temporary approach: create the card at project root level.
  // Actually, the canvas card directory IS the canvas, so we just need to:
  // 1. Copy seed files from the card class into the canvas card directory
  // 2. Write the primary file

  // Import copySeedFiles helper — it's not exported, so we'll use createCard
  // which calls copySeedFiles internally. But createCard creates inside getCanvasDir,
  // which now points to project.project/ — creating project.project/project.project/.
  // That's wrong. We need to seed the canvas card at the project root level.

  // Copy seed files from the canvas card class into the canvas card directory.
  // This creates child cards (_goal.goal → goal.goal/) and internal files (_.layout.json).
  // Each child card also gets its own class's seed files (e.g. todo gets _brief.md).
  const { resolveCardClassDir, copySeedFiles } = await import("./cardFiles.js");
  const classDir = resolveCardClassDir(canvasClass);
  if (classDir) {
    await copySeedFiles(classDir, canvasCardDir);
  }

  // Write the canvas card's primary file
  const primaryFile = getPrimaryFile(canvasClass);
  const primaryPath = join(canvasCardDir, primaryFile);
  if (!existsSync(primaryPath)) {
    await writeFileFs(primaryPath, `# ${projectName}\n`, "utf-8");
  }

  console.log(`[seed] Seeded project "${projectId}" with canvas class "${canvasClass}" → ${canvasCardFilename}/`);

  return config;
}

// ── Startup initialization ──────────────────────────────────

export async function initializeProjects(): Promise<void> {
  await mkdir(PROJECTS_DIR, { recursive: true });

  const projects = await listConnectedProjects();

  if (projects.length > 0) {
    console.log(`[seed] Found ${projects.length} connected project(s).`);
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
