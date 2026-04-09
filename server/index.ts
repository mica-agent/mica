// Mica AI Team Server
// Express + WebSocket server. Card classes own all behavior.
// The server provides pipes: file I/O, channels, container lifecycle.

import express from "express";
import cors from "cors";
import http from "http";
import { WebSocketServer, WebSocket } from "ws";
import {
  listFiles,
  readCanvasFile,
  writeCanvasFile,
  deleteCanvasFile,
  readCardFile,
  writeCardFile,
  createCard,
  listProjects,
  deleteProject,
  getProjectConfig,
  validateProjectCanvas,
} from "./cardFiles.js";
import { readFile, writeFile } from "fs/promises";
import { execFile } from "child_process";
import { promisify } from "util";
import { join } from "path";

const execFileAsync = promisify(execFile);
import { connectProject, addCanvasToProject, migrateLegacyProjects, readMicaConfig, getProjectPath, getCanvasDir } from "./projectConnection.js";
import { initializeProjects, seedNewProject } from "./seedCard.js";
import { CardManager } from "./cardManager.js";
import type { MicaBridge } from "./moduleLoader.js";
import { ContainerRuntime } from "./containerRuntime.js";
import { FileWatcher } from "./fileWatcher.js";
import { SandboxManager } from "./projectSandbox.js";
import { ensureLlamaServer, stopLlamaServer } from "./llamaServer.js";
import { ProjectExecutor } from "./projectExecutor.js";
import { ChannelManager } from "./channelManager.js";
import { createModuleHandlerFactory } from "./channelHandlers/module.js";

const PORT = parseInt(process.env.MICA_PORT || "3002");

// ── Global error handlers — prevent process crashes ─────
process.on("unhandledRejection", (reason) => {
  console.error("[UNHANDLED REJECTION]", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[UNCAUGHT EXCEPTION]", err.message);
  // Give time to flush logs, then exit (restart via process manager)
  setTimeout(() => process.exit(1), 1000);
});

const app = express();
app.use(cors());
app.use(express.json({ limit: "5mb" }));

// ── Content Security Policy ──────────────────────────────
// Block browser-side exfiltration: cards can only talk to the Mica server.
// External CDN resources are served via server-side proxy/cache (future).
app.use((_req, res, next) => {
  res.setHeader(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://unpkg.com",
      "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://unpkg.com",
      "connect-src 'self' ws://localhost:* http://localhost:* ws://127.0.0.1:* http://127.0.0.1:*",
      "img-src 'self' data: blob:",
      "font-src 'self' data: https://cdn.jsdelivr.net https://cdnjs.cloudflare.com",
    ].join("; ")
  );
  next();
});

// ── Helper: validate project+canvas from route params ────
async function validateParams(
  res: express.Response,
  project: string,
  canvas: string
): Promise<boolean> {
  try {
    await validateProjectCanvas(project, canvas);
    return true;
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
    return false;
  }
}

// ── REST Endpoints ─────────────────────────────────────────

// Health check
app.get("/api/health", async (_req, res) => {
  const projects = await listProjects();
  res.json({
    status: "ok",
    auth: "claude-subscription",
    projects: projects.map((p) => p.id),
  });
});

// ── Project Management ────────────────────────────────────

// List all projects
app.get("/api/projects", async (_req, res) => {
  try {
    const projects = await listProjects();
    res.json(projects);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Get project details
app.get("/api/projects/:project", async (req, res) => {
  try {
    const config = await getProjectConfig(req.params.project);
    if (!config) {
      res.status(404).json({ error: `Project not found: ${req.params.project}` });
      return;
    }
    res.json(config);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Create a new project (seeds a fresh directory)
app.post("/api/projects", async (req, res) => {
  const { id, name, agentProvider, canvasClass } = req.body;
  if (!id || !name) {
    res.status(400).json({ error: "id and name required" });
    return;
  }
  try {
    const config = await seedNewProject(id, name, agentProvider, canvasClass);

    // Add watchers for the new project
    await fileWatcher.addProject(id, config.canvases);

    res.json(config);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// Connect an existing directory/repo to Mica
app.post("/api/projects/connect", async (req, res) => {
  const { path: projectPath, name } = req.body;
  if (!projectPath) {
    res.status(400).json({ error: "path required" });
    return;
  }
  try {
    const config = await connectProject(projectPath, name);

    // Add watchers for the connected project
    await fileWatcher.addProject(config.id, config.canvases);

    res.json(config);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// Disconnect a project (leaves .mica/ intact)
app.post("/api/projects/:project/disconnect", async (req, res) => {
  try {
    await deleteProject(req.params.project);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// Delete a project (backward compat — same as disconnect)
app.delete("/api/projects/:project", async (req, res) => {
  try {
    await deleteProject(req.params.project);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// ── Canvas management ──────────────────────────────────────

app.post("/api/projects/:project/canvases", async (req, res) => {
  const { name } = req.body;
  if (!name) {
    res.status(400).json({ error: "name required" });
    return;
  }
  try {
    await addCanvasToProject(req.params.project, name);
    res.json({ success: true, canvas: name });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// ── Migration ─────────────────────────────────────────────

app.post("/api/migrate", async (req, res) => {
  try {
    const { targetDir } = req.body || {};
    const migrated = await migrateLegacyProjects(targetDir);
    res.json({ migrated: migrated.length, projects: migrated });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── Git endpoints (project-scoped) ────────────────────────

// ── Container endpoints (project-scoped) ──────────────────

// ── Project Card (top-level canvas card) ─────────────────────

// Get the canvas card filename from project config
async function getCanvasCardFilename(project: string): Promise<string> {
  const micaConfig = await readMicaConfig(project);
  return micaConfig?.canvasCard || "project.project";
}

// Get rendered project card (the layout shell)
app.get("/api/projects/:project/card", async (req, res) => {
  const { project } = req.params;
  try {
    const config = await getProjectConfig(project);
    if (!config) {
      res.status(404).json({ error: `Project not found: ${project}` });
      return;
    }

    const canvasFilename = await getCanvasCardFilename(project);

    // Read the canvas card's primary file directly from its directory
    // (the canvas card IS the directory, not a subdirectory within it)
    let projectContent = "";
    try {
      const canvasDir = await getCanvasDir(project, "_root");
      const { resolveCardClassFromFilename, getPrimaryFile } = await import("./cardFiles.js");
      const cardClass = resolveCardClassFromFilename(canvasFilename);
      const primaryFile = getPrimaryFile(cardClass);
      projectContent = await readFile(join(canvasDir, primaryFile), "utf-8");
    } catch { /* canvas card not yet created */ }

    // Get child card metadata — listFiles now returns cards from inside canvas card dir
    const files = await listFiles(project, "_root");
    const childMetas = [];
    for (const file of files) {
      if (file.name.startsWith(".")) continue;
      const meta = cardManager.resolveCardMeta(file.name, file.content);
      childMetas.push({
        filename: file.name,
        cardClass: meta.cardClass,
        title: meta.title,
        badge: meta.badge,
      });
    }

    const rendered = await cardManager.renderCard(
      project, "_root", canvasFilename, projectContent,
      { projectName: config.name, children: childMetas }
    );
    res.json({ ...rendered, canvasFilename });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Get rendered child cards for a project (individually rendered)
app.get("/api/projects/:project/children", async (req, res) => {
  const { project } = req.params;
  try {
    const files = await listFiles(project, "_root");
    const renderPromises = files
      .filter((f) => !f.name.startsWith("."))
      .map(async (file) => {
        const rendered = await cardManager.renderCard(project, "_root", file.name, file.content);
        return { filename: file.name, ...rendered };
      });
    const results = await Promise.all(renderPromises);
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── Canvas File Endpoints (project-scoped) ─────────────────

// List all files in a canvas
app.get("/api/projects/:project/canvases/:canvas/files", async (req, res) => {
  const { project, canvas } = req.params;
  if (!(await validateParams(res, project, canvas))) return;
  try {
    const files = await listFiles(project, canvas);
    res.json(files);
  } catch (err: unknown) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Read a single file
app.get("/api/projects/:project/canvases/:canvas/files/:filename", async (req, res) => {
  const { project, canvas, filename } = req.params;
  if (!(await validateParams(res, project, canvas))) return;
  try {
    const file = await readCanvasFile(project, canvas, filename);
    res.json(file);
  } catch (err: unknown) {
    res.status(404).json({ error: (err as Error).message });
  }
});

// Create or update a file
app.put("/api/projects/:project/canvases/:canvas/files/:filename", async (req, res) => {
  const { project, canvas, filename } = req.params;
  const { content } = req.body;
  if (!(await validateParams(res, project, canvas))) return;
  if (typeof content !== "string") {
    res.status(400).json({ error: "content (string) required" });
    return;
  }
  try {
    await writeCanvasFile(project, canvas, filename, content);
    res.json({ success: true });
  } catch (err: unknown) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// Delete a file
app.delete("/api/projects/:project/canvases/:canvas/files/:filename", async (req, res) => {
  const { project, canvas, filename } = req.params;
  if (!(await validateParams(res, project, canvas))) return;
  try {
    await deleteCanvasFile(project, canvas, filename);
    res.json({ success: true });
  } catch (err: unknown) {
    res.status(404).json({ error: (err as Error).message });
  }
});

// ── Layout persistence (stored as .layout.json in the canvas card directory) ───
app.get("/api/projects/:project/canvases/:canvas/layout", async (req, res) => {
  const { project, canvas } = req.params;
  if (!(await validateParams(res, project, canvas))) return;
  try {
    // .layout.json lives directly in the canvas card directory
    const canvasDir = await getCanvasDir(project, canvas);
    const layoutPath = join(canvasDir, ".layout.json");
    const data = await readFile(layoutPath, "utf-8");
    res.json(JSON.parse(data));
  } catch {
    res.json({});
  }
});

app.put("/api/projects/:project/canvases/:canvas/layout", async (req, res) => {
  const { project, canvas } = req.params;
  if (!(await validateParams(res, project, canvas))) return;
  try {
    const source = req.body.source;
    const dataToStore = { ...req.body };
    delete dataToStore.source;
    const canvasDir = await getCanvasDir(project, canvas);
    const layoutPath = join(canvasDir, ".layout.json");
    await writeFile(layoutPath, JSON.stringify(dataToStore, null, 2), "utf-8");
    broadcast({ type: "layout-changed", project, canvas, source });
    res.json({ success: true });
  } catch (err: unknown) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Report a browser-side card script error — triggers card-error event so agents can auto-fix
app.post("/api/projects/:project/canvases/:canvas/cards/:filename/error", (req, res) => {
  const { project, canvas, filename } = req.params;
  const { error } = req.body as { error?: string };
  if (error) {
    const { cardClass } = cardManager.resolveCardClass(filename, "");
    broadcastCardError(project, canvas, filename, `[browser] ${error}`, cardClass);
  }
  res.json({ ok: true });
});

// Get available card classes (for toolbar, card creation)
// Scans all connected projects for project-scoped classes
app.get("/api/card-classes", async (_req, res) => {
  try {
    const projects = await listProjects();
    for (const project of projects) {
      cardManager.reloadManifest(project.path);
    }
  } catch { /* use whatever manifest we have */ }
  res.json(cardManager.getManifest());
});

// Read a file from a card class directory (spec.md, ~brief.md)
// Checks project-scoped classes first (across all connected projects), then built-in
app.get("/api/card-classes/:className/files/:fileName", async (req, res) => {
  const { className, fileName } = req.params;
  try {
    const projects = await listProjects();
    for (const project of projects) {
      const classPath = cardManager.getClassPath(className, project.path);
      if (classPath.includes(".card-classes")) {
        const classDir = classPath.replace(/\/render\.js$/, "");
        try {
          const content = await readFile(join(classDir, fileName), "utf-8");
          return res.json({ content });
        } catch { /* try next */ }
      }
    }
    // Fall back to built-in
    const classPath = cardManager.getClassPath(className);
    const classDir = classPath.replace(/\/render\.js$/, "");
    const content = await readFile(join(classDir, fileName), "utf-8");
    res.json({ content });
  } catch (err: unknown) {
    res.status(404).json({ error: (err as Error).message });
  }
});

// Write a file to a card class directory (spec.md, ~brief.md)
app.put("/api/card-classes/:className/files/:fileName", async (req, res) => {
  const { className, fileName } = req.params;
  try {
    const projects = await listProjects();
    for (const project of projects) {
      const classPath = cardManager.getClassPath(className, project.path);
      if (classPath.includes(".card-classes")) {
        const classDir = classPath.replace(/\/render\.js$/, "");
        await writeFile(join(classDir, fileName), req.body.content, "utf-8");
        return res.json({ success: true });
      }
    }
    // Fall back to built-in
    const classPath = cardManager.getClassPath(className);
    const classDir = classPath.replace(/\/render\.js$/, "");
    await writeFile(join(classDir, fileName), req.body.content, "utf-8");
    res.json({ success: true });
  } catch (err: unknown) {
    res.status(500).json({ error: (err as Error).message });
  }
});



// Delete a project-scoped card class
app.delete("/api/card-classes/:className", async (req, res) => {
  const { className } = req.params;
  try {
    const projects = await listProjects();
    for (const project of projects) {
      const classDir = join(project.path, ".mica", ".card-classes", className);
      try {
        await import("fs").then(fs => fs.promises.rm(classDir, { recursive: true }));
        cardManager.invalidateClass(className);
        broadcast({ type: "classes-updated" });
        return res.json({ success: true });
      } catch { /* not in this project */ }
    }
    res.status(404).json({ error: `Card class "${className}" not found in any project` });
  } catch (err: unknown) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── Card class setup (setup.sh) ─────────────────────────────

// Check if a card class needs setup and its approval status
app.get("/api/projects/:project/card-classes/:className/setup", async (req, res) => {
  const { project, className } = req.params;
  try {
    const projectPath = await getProjectPath(project);
    const classPath = cardManager.getClassPath(className, projectPath);
    const classDir = classPath.replace(/\/render\.js$/, "");
    const setupPath = join(classDir, "setup.sh");

    let script = "";
    try {
      script = await readFile(setupPath, "utf-8");
    } catch {
      return res.json({ required: false });
    }

    // Check approval state
    const approvalPath = join(projectPath, ".mica", ".setup-approved.json");
    let approvals: Record<string, boolean> = {};
    try {
      approvals = JSON.parse(await readFile(approvalPath, "utf-8"));
    } catch { /* no approvals yet */ }

    res.json({
      required: true,
      approved: approvals[className] === true,
      script,
    });
  } catch (err: unknown) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Approve and run setup.sh for a card class
app.post("/api/projects/:project/card-classes/:className/setup/approve", async (req, res) => {
  const { project, className } = req.params;
  try {
    const projectPath = await getProjectPath(project);
    const classPath = cardManager.getClassPath(className, projectPath);
    const classDir = classPath.replace(/\/render\.js$/, "");
    const setupPath = join(classDir, "setup.sh");

    const script = await readFile(setupPath, "utf-8");

    // Save approval
    const approvalPath = join(projectPath, ".mica", ".setup-approved.json");
    let approvals: Record<string, boolean> = {};
    try {
      approvals = JSON.parse(await readFile(approvalPath, "utf-8"));
    } catch { /* fresh */ }
    approvals[className] = true;
    await writeFile(approvalPath, JSON.stringify(approvals, null, 2), "utf-8");

    // Run setup.sh in the project container
    const containerName = await sandboxManager.getContainerName(project);
    const { stdout, stderr } = await execFileAsync("docker", [
      "exec", "-u", "root", containerName, "/bin/bash", "-c", script,
    ], { timeout: 120000 });

    console.log(`[setup] ${className} setup complete for project "${project}"`);
    if (stdout.trim()) console.log(`[setup] stdout: ${stdout.trim().slice(0, 500)}`);
    if (stderr.trim()) console.log(`[setup] stderr: ${stderr.trim().slice(0, 500)}`);

    res.json({ success: true, output: (stdout + stderr).trim().slice(0, 2000) });
  } catch (err: unknown) {
    console.error(`[setup] ${className} setup failed:`, (err as Error).message);
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── Widget Card System ──────────────────────────────────────

const sandboxManager = new SandboxManager();
const executor = new ProjectExecutor(sandboxManager);
const cardManager = new CardManager();
const fileWatcher = new FileWatcher();

// Container runtime management — one per project, started lazily
const containerRuntimes = new Map<string, ContainerRuntime>();

// Track which card caused a file write — used to populate `source` in file-changed events.
// Key: "project/filename", Value: cardName that wrote it. Cleared after event fires.
const writeSourceTracker = new Map<string, string>();

async function getOrCreateContainerRuntime(projectId: string): Promise<ContainerRuntime> {
  let runtime = containerRuntimes.get(projectId);
  if (runtime) return runtime;

  // Ensure the container is running
  await sandboxManager.getPool(projectId);
  const containerName = `mica-project-${projectId}`;

  runtime = new ContainerRuntime(containerName, projectId);
  runtime.setBridgeCallbacks({
    onSend: (cardName, data) => {
      channelManager.broadcastToSession(projectId, "_root", cardName, data);
    },
    onReply: (cardName, clientId, data) => {
      channelManager.sendToClient(clientId, data);
    },
    onLog: (cardName, message) => {
      const timestamp = new Date().toISOString().replace("T", " ").slice(0, 16);
      const line = `- **${timestamp}** — ${message}\n`;
      readCanvasFile(projectId, "_root", "log.md")
        .then((f) => writeCanvasFile(projectId, "_root", "log.md", f.content + line))
        .catch(() => writeCanvasFile(projectId, "_root", "log.md", `# Activity Log\n\n${line}`));
    },
    onCreateCard: (name) => {
      createCard(projectId, "_root", name).catch((err) => {
        console.error(`[container] createCard failed for "${name}":`, (err as Error).message);
      });
    },
    onWriteNotify: (cardName, _filename) => {
      // Tag this card as the source of the next file change.
      // The file watcher reports card-level changes (cardName), not internal files.
      writeSourceTracker.set(`${projectId}/${cardName}`, cardName);
    },
  });

  await runtime.start();
  containerRuntimes.set(projectId, runtime);
  cardManager.setContainerRuntime(projectId, runtime);
  return runtime;
}

// MicaBridge factory — creates a bridge instance for a specific card context.
// Used when calling card class exports that need server-side mica operations.
function createMicaBridge(project: string, canvas: string, filename: string): MicaBridge {
  return {
    project,
    canvas,
    filename,
    send(data: unknown) {
      broadcast({ type: "card-data", project, canvas, filename, data });
    },
    reply(data: unknown) {
      broadcast({ type: "card-data", project, canvas, filename, data });
    },
    async read(fname: string) {
      return readCardFile(project, canvas, filename, fname);
    },
    async write(fname: string, content: string) {
      writeSourceTracker.set(`${project}/${filename}`, filename);
      await writeCardFile(project, canvas, filename, fname, content);
    },
    async exec(command: string, opts?: { cwd?: string; timeout?: number }) {
      return executor.exec(project, command, opts);
    },
    async log(message: string) {
      const timestamp = new Date().toISOString().replace("T", " ").slice(0, 16);
      const line = `- **${timestamp}** — ${message}\n`;
      try {
        const existing = await readCanvasFile(project, canvas, "log.md");
        await writeCanvasFile(project, canvas, "log.md", existing.content + line);
      } catch {
        await writeCanvasFile(project, canvas, "log.md", `# Activity Log\n\n${line}`);
      }
    },
    async createCard(name: string) {
      await createCard(project, canvas, name);
    },
    on(_event: string, _cb: (data: unknown) => void) {
      // Host-mode bridge: file-changed events delivered via container runtime only
      return () => {};
    },
  };
}

// Get all rendered cards for a canvas
app.get("/api/projects/:project/canvases/:canvas/cards", async (req, res) => {
  const { project, canvas } = req.params;
  if (!(await validateParams(res, project, canvas))) return;
  try {
    // Ensure container runtime is started for this project
    await getOrCreateContainerRuntime(project);
    const cards = await cardManager.renderAllCards(project, canvas);
    res.json(cards);
  } catch (err: unknown) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Render a single card (used by mica.refresh())
app.get("/api/projects/:project/canvases/:canvas/cards/:filename", async (req, res) => {
  const { project, canvas, filename } = req.params;
  if (!(await validateParams(res, project, canvas))) return;
  try {
    const file = await readCanvasFile(project, canvas, filename);
    const rendered = await cardManager.renderCard(project, canvas, filename, file.content);
    res.json(rendered);
  } catch (err: unknown) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Read a file inside a card's directory (for flip/inspect)
app.get("/api/projects/:project/canvases/:canvas/cards/:cardName/files/:fileName", async (req, res) => {
  const { project, canvas, cardName, fileName } = req.params;
  if (!(await validateParams(res, project, canvas))) return;
  try {
    const content = await readCardFile(project, canvas, cardName, fileName);
    res.json({ content });
  } catch (err: unknown) {
    res.status(404).json({ error: (err as Error).message });
  }
});

// Write a file inside a card's directory (for flip/inspect)
app.put("/api/projects/:project/canvases/:canvas/cards/:cardName/files/:fileName", async (req, res) => {
  const { project, canvas, cardName, fileName } = req.params;
  if (!(await validateParams(res, project, canvas))) return;
  try {
    await writeCardFile(project, canvas, cardName, fileName, req.body.content);
    res.json({ success: true });
  } catch (err: unknown) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Create a new card instance (with seed files from card class)
app.post("/api/projects/:project/canvases/:canvas/cards", async (req, res) => {
  const { project, canvas } = req.params;
  const { name } = req.body;
  if (!(await validateParams(res, project, canvas))) return;
  if (!name) {
    res.status(400).json({ error: "name is required" });
    return;
  }
  try {
    await createCard(project, canvas, name);
    // Render the new card and return it
    const file = await readCanvasFile(project, canvas, name);
    const rendered = await cardManager.renderCard(project, canvas, name, file.content);
    res.json({ ok: true, card: rendered });
  } catch (err: unknown) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Call an export function on a card
app.post("/api/projects/:project/canvases/:canvas/cards/:filename/call/:fn", async (req, res) => {
  req.setTimeout(300000);
  res.setTimeout(300000);
  const { project, canvas, filename, fn } = req.params;
  if (!(await validateParams(res, project, canvas))) return;
  try {
    const mica = createMicaBridge(project, canvas, filename);
    const result = await cardManager.callExport(project, canvas, filename, fn, req.body || {}, mica);
    res.json({ result });
  } catch (err: unknown) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Context stats — estimate token usage for agent calls
app.get("/api/projects/:project/canvases/:canvas/context-stats", async (req, res) => {
  const { project, canvas } = req.params;
  if (!(await validateParams(res, project, canvas))) return;
  try {
    const files = await listFiles(project, canvas);
    let totalChars = 0;
    const fileStats: { name: string; chars: number }[] = [];
    for (const f of files) {
      const chars = f.content.length;
      totalChars += chars;
      fileStats.push({ name: f.name, chars });
    }

    // Chat history size
    let chatHistoryChars = 0;
    const chatFile = files.find((f) => f.name === ".chat-history.json");
    if (chatFile) chatHistoryChars = chatFile.content.length;

    // Fixed system prompt ~2100 chars
    const systemPromptChars = 2100;
    const totalContextChars = totalChars + systemPromptChars;

    // Rough token estimate: ~4 chars per token for English text
    const estimatedTokens = Math.round(totalContextChars / 4);

    res.json({
      project,
      canvas,
      files: fileStats.length,
      fileContentChars: totalChars,
      systemPromptChars,
      chatHistoryChars,
      totalContextChars,
      estimatedTokens,
    });
  } catch (err: unknown) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── Start ──────────────────────────────────────────────────

// Initialize projects (seed or migrate) on startup
initializeProjects().catch((err) =>
  console.error("Failed to initialize projects:", err.message)
);

// Express global error handler
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("[express] Unhandled error:", err.message);
  res.status(500).json({ error: "Internal server error" });
});

const server = http.createServer(app);
server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(`[server] Port ${PORT} is already in use. Kill the other process and retry.`);
  } else {
    console.error("[server] HTTP error:", err.message);
  }
  process.exit(1);
});

// WebSocket server for real-time card updates
const wss = new WebSocketServer({ server, path: "/ws/cards" });
const wsClients = new Set<WebSocket>();
const wsChannels = new Map<WebSocket, Set<string>>(); // ws → set of channel IDs

// Unified channel manager — handles chat, terminal, and future card types.
// Transport-agnostic: index.ts is the WebSocket adapter.
const channelManager = new ChannelManager();


// Module-based channel handler — bridges card class stream exports (onConnect/onMessage/onDestroy)
// to the ChannelHandler interface. Registered dynamically per card class when stream support is detected.
const moduleHandlerFactory = createModuleHandlerFactory({
  moduleLoader: cardManager.getModuleLoader(),
  getClassPath: (className, projectPath) => cardManager.getClassPath(className, projectPath),
  resolveCardClass: (filename, content) => cardManager.resolveCardClass(filename, content),
  getProjectPath,
  createExecFn: (project) => (command, opts) => executor.exec(project, command, opts),
  readCardFile,
  writeCardFile,
  getContainerRuntime: (project) => cardManager.getContainerRuntime(project),
});

/** Ensure a module-based handler is registered for a card class with stream exports. */
function ensureModuleHandler(cardClass: string): void {
  if (!channelManager.hasHandler(cardClass)) {
    channelManager.registerHandler(cardClass, moduleHandlerFactory);
  }
}

wss.on("error", (err) => {
  console.error("[websocket-server] Error:", (err as Error).message);
});

wss.on("connection", (ws) => {
  wsClients.add(ws);

  // Clean up channels when WebSocket disconnects.
  // channelManager.detach() is a soft close — sessions stay alive for reconnect.
  // Agent channels get hard-closed (they don't use the unified manager yet).
  const cleanupWsChannels = () => {
    wsClients.delete(ws);
    const channels = wsChannels.get(ws);
    if (channels) {
      for (const channelId of channels) {
        if (channelManager.has(channelId)) {
          channelManager.detach(channelId); // soft — session stays alive
        }
      }
      wsChannels.delete(ws);
    }
  };

  ws.on("close", cleanupWsChannels);
  ws.on("error", (err) => {
    console.error("[websocket] Connection error:", err.message);
    cleanupWsChannels();
  });

  // ── Full WebSocket message router ──
  ws.on("message", async (raw) => {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return; // Ignore invalid JSON
    }

    const { type, id, project, canvas, filename, fn, args } = msg as {
      type: string; id?: string; project?: string; canvas?: string;
      filename?: string; fn?: string; args?: Record<string, unknown>;
      event?: string; data?: unknown;
    };

    switch (type) {
      // Pattern 1: Request/Response (call + legacy export_call)
      case "call":
      case "export_call": {
        try {
          const mica = createMicaBridge(project as string, canvas as string, filename as string);
          const result = await cardManager.callExport(
            project as string, canvas as string, filename as string,
            fn as string, (args || {}) as Record<string, unknown>,
            mica
          );
          ws.send(JSON.stringify({ type: "result", id, result }));
        } catch (err) {
          ws.send(JSON.stringify({ type: "error", id, error: (err as Error).message }));
        }
        break;
      }

      // Pattern 2: Fire-and-forget
      case "send": {
        const mica = createMicaBridge(project as string, canvas as string, filename as string);
        cardManager.callExport(
          project as string, canvas as string, filename as string,
          fn as string, (args || {}) as Record<string, unknown>,
          mica
        ).catch((err) => console.error(`[ws] send error:`, (err as Error).message));
        break;
      }

      // Pattern 4: Widget-to-widget broadcast
      case "broadcast": {
        const event = (msg as { event?: string }).event;
        const data = (msg as { data?: Record<string, unknown> }).data || {};
        if (event) {
          broadcast({ type: event, ...data });
        }
        break;
      }

      // Pattern 5: Bidirectional channel — open
      case "channel_open": {
        const cid = id as string;

        try {
          const fname = filename as string;
          const channelArgs = (args || {}) as Record<string, unknown>;
          const proj = project as string;
          const canv = canvas as string;

          const onData = (data: unknown) => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: "channel_data", id, data }));
            }
          };
          const onClose = () => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: "channel_close", id }));
            }
            wsChannels.get(ws)?.delete(cid);
          };

          // Ensure container runtime is ready before opening channels
          await getOrCreateContainerRuntime(proj);

          // Try the unified channel manager (chat, terminal, module-based handlers)
          const cardClass = channelManager.resolveCardClass(fname);

          // If no handler registered yet, check if the card class has stream exports
          if (!channelManager.hasHandler(cardClass)) {
            const { cardClass: resolvedClass } = cardManager.resolveCardClass(fname);
            let projectPath: string | undefined;
            try { projectPath = await getProjectPath(proj); } catch { /* fallback */ }
            const classPath = cardManager.getClassPath(resolvedClass, projectPath);
            if (classPath) {
              const streamHandlers = await cardManager.getModuleLoader().getStreamHandlers(resolvedClass, classPath);
              if (streamHandlers) {
                ensureModuleHandler(cardClass);
              }
            }
          }

          if (channelManager.hasHandler(cardClass)) {
            await channelManager.open(cid, proj, canv, fname, fn as string, channelArgs, onData, onClose);
            if (!wsChannels.has(ws)) wsChannels.set(ws, new Set());
            wsChannels.get(ws)!.add(cid);
          } else {
            throw new Error(`No channel handler for card class "${cardClass}" (file: ${fname})`);
          }
        } catch (err) {
          console.error(`[ws] channel_open error for ${project}/${canvas}/${filename}#${fn}:`, (err as Error).message);
          ws.send(JSON.stringify({ type: "error", id, error: (err as Error).message }));
        }
        break;
      }

      // Pattern 5: Bidirectional channel — data
      case "channel_data": {
        const cid = id as string;
        if (channelManager.has(cid)) {
          channelManager.sendData(cid, (msg as { data?: unknown }).data);
        }
        break;
      }

      // Pattern 5: Bidirectional channel — close (hard destroy from browser)
      case "channel_close": {
        const cid = id as string;
        if (channelManager.has(cid)) {
          channelManager.detach(cid);
        }
        wsChannels.get(ws)?.delete(cid);
        break;
      }
    }
  });
});

function broadcast(msg: Record<string, unknown>) {
  const data = JSON.stringify(msg);
  for (const ws of wsClients) {
    if (ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(data);
      } catch {
        wsClients.delete(ws);
      }
    }
  }
}

// Broadcast card render errors to browsers and server-side agent sessions
function broadcastCardError(project: string, canvas: string, filename: string, error: string, cardClass?: string) {
  console.log(`[card-error] ${project}/${canvas}/${filename}: ${error.slice(0, 100)}`);
  broadcast({ type: "card-error", project, canvas, filename, error, cardClass });

  // Deliver to server-side agent sessions so they can auto-fix
  const runtime = containerRuntimes.get(project);
  if (runtime) {
    const sessions = channelManager.getProjectSessions(project, canvas);
    for (const cardName of sessions) {
      runtime.sendEvent(cardName, "card-error", { filename, error, cardClass });
    }
  }
}

// File watcher → broadcast events (card classes own their own update lifecycle)
fileWatcher.on("file-change", async (event: { type: string; project: string; canvas: string; filename: string }) => {
  if (event.filename.startsWith(".")) return;

  console.log(`[file-watcher] ${event.type}: ${event.project}/${event.canvas}/${event.filename}`);

  if (event.type === "deleted") {
    cardManager.invalidateCard(event.project, event.canvas, event.filename);
    channelManager.destroySession(event.project, event.canvas, event.filename);
    broadcast({ type: "file-deleted", project: event.project, canvas: event.canvas, filename: event.filename });
    return;
  }

  // For created cards, resolve meta so the canvas can display them
  if (event.type === "created") {
    try {
      const file = await readCanvasFile(event.project, event.canvas, event.filename);
      const rendered = await cardManager.renderCard(
        event.project, event.canvas, event.filename, file.content
      );
      if (rendered.hasStream && rendered.meta?.cardClass) {
        ensureModuleHandler(rendered.meta.cardClass);
      }
      broadcast({
        type: "file-created",
        project: event.project,
        canvas: event.canvas,
        filename: event.filename,
        html: rendered.html,
        exports: rendered.exports,
        dependencies: rendered.dependencies,
        hasStream: rendered.hasStream,
        meta: rendered.meta,
      });
      if (rendered.error) {
        broadcastCardError(event.project, event.canvas, event.filename, rendered.error, rendered.meta?.cardClass);
      }
    } catch (err) {
      console.error(`[file-watcher] Render failed for new card ${event.filename}:`, (err as Error).message);
    }
  }

  // Resolve write source — which card (or "user") caused this file change.
  // Used by both browser broadcast and server-side session delivery.
  const sourceKey = `${event.project}/${event.filename}`;
  const source = writeSourceTracker.get(sourceKey) || "user";
  writeSourceTracker.delete(sourceKey);

  if (event.type === "changed") {
    // file-changed: broadcast with source so cards can distinguish self-writes from external edits
    cardManager.invalidateCard(event.project, event.canvas, event.filename);
    broadcast({
      type: "file-changed",
      project: event.project,
      canvas: event.canvas,
      filename: event.filename,
      source,
    });
  }

  const runtime = containerRuntimes.get(event.project);
  if (runtime) {
    const sessions = channelManager.getProjectSessions(event.project, event.canvas);
    for (const cardName of sessions) {
      runtime.sendFileChanged(cardName, { filename: event.filename, source });
    }
  }

});

// Card class changes → invalidate cache, broadcast so cards can refresh
fileWatcher.on("class-change", async (event: { className: string }) => {
  console.log(`[file-watcher] Card class changed: ${event.className}`);
  cardManager.invalidateClass(event.className);

  // Notify all clients that the available card classes have changed
  console.log(`[file-watcher] Broadcasting classes-updated`);
  broadcast({ type: "classes-updated" });

  // Broadcast class-changed so all cards of this class can refresh themselves
  try {
    const projects = await listProjects();
    for (const project of projects) {
      const config = await getProjectConfig(project.id);
      const canvases = config?.canvases || ["_root"];
      for (const canvas of canvases) {
        const files = await listFiles(project.id, canvas);
        for (const file of files) {
          if (file.name.startsWith(".")) continue;
          const { cardClass } = cardManager.resolveCardClass(file.name, file.content);
          if (cardClass === event.className) {
            try {
              const rendered = await cardManager.renderCard(
                project.id, canvas, file.name, file.content
              );
              broadcast({
                type: "class-changed",
                project: project.id,
                canvas,
                filename: file.name,
                html: rendered.html,
                exports: rendered.exports,
                dependencies: rendered.dependencies,
                meta: rendered.meta,
              });
              if (rendered.error) {
                broadcastCardError(project.id, canvas, file.name, rendered.error, rendered.meta?.cardClass);
              }
            } catch (err) {
              console.error(`[file-watcher] Re-render failed for ${file.name}:`, (err as Error).message);
            }
          }
        }
      }
    }
  } catch (err) {
    console.error(`[file-watcher] Class re-render sweep failed:`, (err as Error).message);
  }
});

// Start everything
(async () => {
  try {
    await fileWatcher.start();
  } catch (err) {
    console.error("[startup] File watcher failed:", (err as Error).message);
  }

  // Start container runtimes for all connected projects eagerly
  try {
    const projects = await listProjects();
    for (const project of projects) {
      try {
        await getOrCreateContainerRuntime(project.id);
        console.log(`[startup] Container runtime ready for "${project.id}"`);
      } catch (err) {
        console.error(`[startup] Container runtime failed for "${project.id}":`, (err as Error).message);
      }
    }
  } catch (err) {
    console.error("[startup] Failed to start container runtimes:", (err as Error).message);
  }

  // Start llama-server eagerly so local LLM agents can connect
  ensureLlamaServer().catch((err) => {
    console.warn("[startup] llama-server failed to start:", (err as Error).message);
  });

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`
╔══════════════════════════════════════════════════════════╗
║                   Mica AI Team Server                    ║
╠══════════════════════════════════════════════════════════╣
║  REST API:  http://localhost:${PORT}/api                     ║
║  WebSocket: ws://localhost:${PORT}/ws/cards                  ║
╠══════════════════════════════════════════════════════════╣
║  Card System:                                            ║
║    Module Loader: ES module card classes                  ║
║    Per-Project Sandboxes: Docker isolation               ║
║    Card Classes: card-classes/                           ║
║    File Watcher: active                                  ║
╠══════════════════════════════════════════════════════════╣
║  Security: CSP + env filtering + container isolation     ║
║  Auth: Claude Code subscription (Pro/Max)                ║
╚══════════════════════════════════════════════════════════╝
`);
  });

  // Graceful shutdown
  const shutdown = async () => {
    console.log("\n[shutdown] Stopping channels, sandboxes, and llama-server...");
    channelManager.destroyAll();
    await stopLlamaServer();
    await sandboxManager.stopAll();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
})();
