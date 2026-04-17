// Mica Server — multi-project planning canvas.
// Serves a workspace with project subdirectories.
// Each project has its own files, layout, canvas, and AI context.

import express from "express";
import cors from "cors";
import http from "http";
import { WebSocketServer, WebSocket } from "ws";
import {
  WORKSPACE_DIR,
  micaDir,
  projectDir,
  getWorkspaceName,
  getProjectName,
  listProjects,
  createProject,
  renameProject,
  deleteProject,
  initProject,
  listFiles,
  listCanvasFiles,
  readCanvasConfig,
  updateCanvasConfig,
  listSkills,
  readSkill,
  writeSkill,
  deleteSkill,
  syncSkillsToQwen,
  promoteProjectSkill,
  readProjectFile,
  resolveFilePath,
  writeProjectFile,
  deleteProjectFile,
} from "./files.js";
import { readFile, writeFile, mkdir, stat as fsStat } from "fs/promises";
import { createReadStream, createWriteStream } from "fs";
import mimeTypes from "mime-types";
import { join } from "path";
import { existsSync } from "fs";
import { exec as execCb } from "child_process";
import { promisify } from "util";
import { FileWatcher } from "./fileWatcher.js";
import { ChannelManager, setActiveProject as setChannelProject } from "./channelManager.js";
import { ensureLlamaServer, stopLlamaServer, getLlamaServerStatus } from "./vllmServer.js";
import { chatHandler, setActiveProject as setChatProject } from "./micaChat.js";
import { createAgentHandler, setActiveProject as setAgentProject } from "./micaAgent.js";
import { execHandler, setActiveProject as setExecProject } from "./plugins/exec.js";
import { createPtyHandler, setActiveProject as setPtyProject } from "./plugins/pty.js";
import { createLlmChatHandler } from "./plugins/llmChat.js";

const execAsync = promisify(execCb);
const PORT = parseInt(process.env.MICA_PORT || "3002");

// ── Global error handlers ────────────────────────────────────
process.on("unhandledRejection", (reason) => {
  console.error("[UNHANDLED REJECTION]", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[UNCAUGHT EXCEPTION]", err.message);
  setTimeout(() => process.exit(1), 1000);
});

const app = express();
app.use(cors());
// JSON body parser — skip binary upload routes
const jsonParser = express.json({ limit: "5mb" });
app.use((req, res, next) => {
  if (req.path.endsWith("/upload") && req.method === "POST") return next();
  jsonParser(req, res, next);
});

// ── CSP ──────────────────────────────────────────────────────
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

// ── Active project tracking ─────────────────────────────────

let activeProject: string | null = null;
const fileWatcher = new FileWatcher();

function switchProject(projectName: string) {
  if (activeProject === projectName) return;
  fileWatcher.stop();
  activeProject = projectName;
  setChatProject(projectName);
  setAgentProject(projectName);
  setExecProject(projectName);
  setPtyProject(projectName);
  setChannelProject(projectName);
  fileWatcher.setWatchDir(projectDir(projectName));
  fileWatcher.start().catch((err) => {
    console.error(`[startup] File watcher failed for ${projectName}:`, (err as Error).message);
  });
  console.log(`[mica] Active project: ${projectName}`);
}

// ── REST Endpoints ───────────────────────────────────────────

// Workspace info
app.get("/api/workspace", async (_req, res) => {
  const name = getWorkspaceName();
  res.json({ name, path: WORKSPACE_DIR });
});

// Backwards-compatible: /api/project returns active project info
app.get("/api/project", async (_req, res) => {
  if (!activeProject) {
    res.json({ name: getWorkspaceName(), path: WORKSPACE_DIR });
    return;
  }
  const name = await getProjectName(activeProject);
  res.json({ name, path: projectDir(activeProject), project: activeProject });
});

// ── Projects ────────────────────────────────────────────────

// List all projects
app.get("/api/projects", async (_req, res) => {
  try {
    const projects = await listProjects();
    res.json(projects);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Create a new project
app.post("/api/projects", async (req, res) => {
  const { name, docsDir } = req.body as { name?: string; docsDir?: string };
  if (!name) {
    res.status(400).json({ error: "name required" });
    return;
  }
  try {
    await createProject(name, docsDir || "docs");
    res.json({ success: true, name });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// Clone a git repo as a new project
app.post("/api/projects/clone", async (req, res) => {
  const { url, name, docsDir } = req.body as { url?: string; name?: string; docsDir?: string };
  if (!url) {
    res.status(400).json({ error: "url required" });
    return;
  }
  try {
    // Derive project name from URL if not provided
    const projectName = name || url.split("/").pop()?.replace(/\.git$/, "") || "project";
    const destDir = join(WORKSPACE_DIR, projectName);
    if (existsSync(destDir)) {
      res.status(400).json({ error: `Project already exists: ${projectName}` });
      return;
    }

    console.log(`[mica] Cloning ${url} -> ${destDir}`);
    await execAsync(`git clone ${JSON.stringify(url)} ${JSON.stringify(destDir)}`, {
      timeout: 120000,
      maxBuffer: 10 * 1024 * 1024,
    });

    // Initialize .mica directory
    await initProject(projectName, docsDir || "docs");

    res.json({ success: true, name: projectName });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Rename a project
app.put("/api/projects/:project/rename", async (req, res) => {
  const { newName } = req.body as { newName?: string };
  if (!newName) {
    res.status(400).json({ error: "newName required" });
    return;
  }
  try {
    const oldName = req.params.project;
    // If this is the active project, stop watching first
    if (activeProject === oldName) {
      fileWatcher.stop();
      activeProject = null;
    }
    await renameProject(oldName, newName);
    res.json({ success: true, name: newName });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// Delete a project
app.delete("/api/projects/:project", async (req, res) => {
  try {
    const name = req.params.project;
    if (activeProject === name) {
      fileWatcher.stop();
      activeProject = null;
    }
    await deleteProject(name);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// Open/activate a project (switches file watcher, initializes .mica if needed)
app.post("/api/projects/:project/open", async (req, res) => {
  const name = req.params.project;
  try {
    const dir = projectDir(name);
    if (!existsSync(dir)) {
      res.status(404).json({ error: `Project not found: ${name}` });
      return;
    }
    // Initialize .mica if not present
    if (!existsSync(join(dir, ".mica"))) {
      const { docsDir } = req.body as { docsDir?: string };
      await initProject(name, docsDir || "docs");
    }
    switchProject(name);

    // Auto-create agent card if no .chat file exists in the project
    try {
      const files = await listFiles(name);
      const hasChatCard = files.some((f: { name: string }) => f.name.endsWith(".chat"));
      if (!hasChatCard) {
        // Read canvasRoot — seed cards go in the canvas directory
        const cfg = await readCanvasConfig(name);
        const canvasRoot = cfg.canvasRoot;
        const prefix = canvasRoot === "." ? "" : canvasRoot.replace(/\/$/, "") + "/";

        const agentId = "agent-" + Date.now().toString(36);
        const chatFilename = prefix + agentId + ".chat";
        const stub = "---\nmica: chat\nid: " + agentId + "\n---\nMica project agent.\n";
        await writeProjectFile(chatFilename, stub, name);

        // Write default behavior instructions on the agent card's back
        const cardsDir = join(micaDir(name), "cards");
        await mkdir(cardsDir, { recursive: true });

        // Sanitize filename for context filename (replace / with _)
        const contextKey = chatFilename.replace(/\//g, "_");

        await writeFile(join(cardsDir, contextKey + ".context.md"), [
          "## Your Role",
          "You are a team member on this project, not a tool.",
          "- Ask clarifying questions before acting on ambiguous requests",
          "- Propose your plan and wait for confirmation before creating files",
          "- Explain trade-offs when there are multiple approaches",
          "- Flag when you're uncertain rather than guessing",
          "",
          "## On Project Open",
          "- Scan project files and identify the project type",
          "- Briefly describe what you found and suggest next steps",
          `- Propose creating ${canvasRoot}/decisions.md and a TODO if they don't exist`,
          "",
          "## On File Changes",
          "- Check todo files for @agent tasks and work on them",
          "- Update dependent docs when specs change",
          `- Log decisions and actions to ${canvasRoot}/decisions.md`,
          "- If you have questions, add a todo item assigned to @human",
          "",
          "## On User Message",
          "- Answer questions about the project",
          `- Write all new cards and planning files in ${canvasRoot}/`,
          "- NEVER write files to .mica/ (managed by Mica internally)",
          "- When asked to build something interactive, confirm what they want before using the create-card-class skill",
        ].join("\n"), "utf-8");
        console.log(`[project-open] Created agent card: ${chatFilename}`);
      }
    } catch (err) {
      console.warn("[project-open] Failed to create agent card:", (err as Error).message);
    }

    // Sync global skills to project's .qwen/skills/ (flatten categorized layout)
    try {
      await syncSkillsToQwen(join(dir, ".qwen", "skills"));
    } catch { /* ignore */ }

    const displayName = await getProjectName(name);
    res.json({ success: true, name: displayName, project: name });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── Card Classes ─────────────────────────────────────────────

const CARD_CLASSES_DIR = join(process.cwd(), "card-classes");

// Resolve card class directory: project .mica/card-classes/:name first, then built-in
function resolveCardClassDir(className: string): string | null {
  if (activeProject) {
    const projectScoped = join(micaDir(activeProject), "card-classes", className);
    if (existsSync(join(projectScoped, "card.html")) || existsSync(join(projectScoped, "render.js"))) return projectScoped;
  }
  const builtIn = join(CARD_CLASSES_DIR, className);
  if (existsSync(join(builtIn, "card.html")) || existsSync(join(builtIn, "render.js"))) return builtIn;
  return null;
}

// Serve any file from a card class directory
app.get("/api/card-classes/:className/:file", async (req, res) => {
  const dir = resolveCardClassDir(req.params.className);
  if (!dir) {
    res.status(404).json({ error: `Card class not found: ${req.params.className}` });
    return;
  }
  const fileName = req.params.file;
  const allowed = ["render.js", "card.html", "card.js", "card.css", "metadata.json", "spec.md"];
  if (!allowed.includes(fileName)) {
    res.status(403).json({ error: `Not allowed: ${fileName}` });
    return;
  }
  try {
    const content = await readFile(join(dir, fileName), "utf-8");
    const types: Record<string, string> = {
      ".js": "application/javascript", ".html": "text/html", ".css": "text/css",
      ".json": "application/json", ".md": "text/markdown",
    };
    const ext = fileName.substring(fileName.lastIndexOf("."));
    res.type(types[ext] || "text/plain").send(content);
  } catch (err) {
    res.status(404).json({ error: (err as Error).message });
  }
});

// List available card classes
app.get("/api/card-classes", async (_req, res) => {
  const { readdir: rd } = await import("fs/promises");
  const classes: Record<string, unknown> = {};

  // Built-in
  try {
    const entries = await rd(CARD_CLASSES_DIR);
    for (const name of entries) {
      const dir = join(CARD_CLASSES_DIR, name);
      const hasHtml = existsSync(join(dir, "card.html"));
      const hasRenderJs = existsSync(join(dir, "render.js"));
      if (hasHtml || hasRenderJs) {
        classes[name] = { builtIn: true, format: hasHtml ? "html" : "renderjs" };
      }
    }
  } catch { /* no card-classes dir */ }

  // Project-scoped (overrides built-in)
  if (activeProject) {
    try {
      const projDir = join(micaDir(activeProject), "card-classes");
      const entries = await rd(projDir);
      for (const name of entries) {
        const dir = join(projDir, name);
        const hasHtml = existsSync(join(dir, "card.html"));
        const hasRenderJs = existsSync(join(dir, "render.js"));
        if (hasHtml || hasRenderJs) {
          classes[name] = { builtIn: false, format: hasHtml ? "html" : "renderjs" };
        }
      }
    } catch { /* no project card-classes */ }
  }

  res.json(classes);
});

// Render the canvas card (assembles card.html + card.css + card.js)
app.get("/api/canvas-card", async (_req, res) => {
  try {
    let canvasClass = "canvas";
    if (activeProject) {
      try {
        const cfg = JSON.parse(await readFile(join(micaDir(activeProject), "config.json"), "utf-8"));
        if (cfg.canvasClass) canvasClass = cfg.canvasClass;
      } catch { /* use default */ }
    }
    const classDir = resolveCardClassDir(canvasClass);
    if (!classDir) throw new Error(`Canvas card class not found: ${canvasClass}`);

    const cardHtml = await readFile(join(classDir, "card.html"), "utf-8");

    let cardCss = "";
    try { cardCss = await readFile(join(classDir, "card.css"), "utf-8"); } catch { /* no card.css */ }

    let cardJs = "";
    try { cardJs = await readFile(join(classDir, "card.js"), "utf-8"); } catch { /* no card.js */ }

    let meta: Record<string, unknown> = {};
    let deps: { scripts?: string[]; styles?: string[] } = {};
    try {
      const raw = await readFile(join(classDir, "metadata.json"), "utf-8");
      meta = JSON.parse(raw);
      deps = (meta.dependencies as { scripts?: string[]; styles?: string[] }) || {};
    } catch { /* no metadata.json */ }

    const html =
      cardHtml +
      (cardCss ? `<style>${cardCss}</style>` : "") +
      (cardJs ? `<script>${cardJs}</script>` : "");

    res.json({ html, exports: [], dependencies: deps, meta });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── Card error/ok reporting ─────────────────────────────────

app.post("/api/cards/:filename/error", (req, res) => {
  const { filename } = req.params;
  const { error } = req.body as { error?: string };
  if (error) console.log(`[card-error] ${filename}: ${error.slice(0, 200)}`);
  res.json({ ok: true });
});

app.post("/api/cards/:filename/ok", (_req, res) => {
  res.json({ ok: true });
});

// ── Project-scoped File Endpoints ───────────────────────────

// List files for active project (metadata only — no content)
// ?canvas=true returns only canvas-visible files (direct children of canvasRoot + pinned)
app.get("/api/files", async (req, res) => {
  try {
    const proj = activeProject || undefined;
    if (req.query.canvas === "true") {
      res.json(await listCanvasFiles(proj));
    } else {
      res.json(await listFiles(proj));
    }
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Pin/unpin files to canvas
app.post("/api/canvas/pin", async (req, res) => {
  try {
    const { filename } = req.body as { filename?: string };
    if (!filename) { res.status(400).json({ error: "filename required" }); return; }
    const proj = activeProject || undefined;
    const cfg = await readCanvasConfig(proj);
    if (!cfg.pinned.includes(filename)) {
      cfg.pinned.push(filename);
      await updateCanvasConfig(proj, { pinned: cfg.pinned });
    }
    res.json({ ok: true, pinned: cfg.pinned });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.delete("/api/canvas/pin", async (req, res) => {
  try {
    const { filename } = req.body as { filename?: string };
    if (!filename) { res.status(400).json({ error: "filename required" }); return; }
    const proj = activeProject || undefined;
    const cfg = await readCanvasConfig(proj);
    cfg.pinned = cfg.pinned.filter((f: string) => f !== filename);
    await updateCanvasConfig(proj, { pinned: cfg.pinned });
    res.json({ ok: true, pinned: cfg.pinned });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Get/update canvas config
app.get("/api/canvas/config", async (_req, res) => {
  try {
    res.json(await readCanvasConfig(activeProject || undefined));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.put("/api/canvas/config", async (req, res) => {
  try {
    const updates = req.body as { canvasRoot?: string; pinned?: string[] };
    await updateCanvasConfig(activeProject || undefined, updates);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// LLM server status — for chat cards to show loading state
app.get("/api/llm/status", (_req, res) => {
  res.json(getLlamaServerStatus());
});

// ── Skills (global) ──────────────────────────────────────────

app.get("/api/skills", async (_req, res) => {
  try {
    res.json(await listSkills(activeProject || undefined));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.get("/api/skills/:category/:name", async (req, res) => {
  try {
    const content = await readSkill(req.params.category, req.params.name, activeProject || undefined);
    res.type("text/markdown").send(content);
  } catch (err) {
    res.status(404).json({ error: (err as Error).message });
  }
});

app.put("/api/skills/:category/:name", async (req, res) => {
  try {
    const { content } = req.body as { content?: string };
    if (typeof content !== "string") {
      res.status(400).json({ error: "content (string) required" });
      return;
    }
    await writeSkill(req.params.category, req.params.name, content, activeProject || undefined);
    try { await syncSkillsToQwen(join(WORKSPACE_DIR, ".qwen", "skills")); } catch { /* best-effort */ }
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

app.delete("/api/skills/:category/:name", async (req, res) => {
  try {
    await deleteSkill(req.params.category, req.params.name, activeProject || undefined);
    try { await syncSkillsToQwen(join(WORKSPACE_DIR, ".qwen", "skills")); } catch { /* best-effort */ }
    res.json({ ok: true });
  } catch (err) {
    res.status(404).json({ error: (err as Error).message });
  }
});

// Promote a project-scoped agent-generated skill into a global category
app.post("/api/skills/promote", async (req, res) => {
  try {
    const { name, category } = req.body as { name?: string; category?: string };
    if (!name || !category) {
      res.status(400).json({ error: "name and category required" });
      return;
    }
    if (!activeProject) {
      res.status(400).json({ error: "No active project" });
      return;
    }
    await promoteProjectSkill(name, category, activeProject);
    try { await syncSkillsToQwen(join(WORKSPACE_DIR, ".qwen", "skills")); } catch { /* best-effort */ }
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// Read a file — returns raw bytes with content-type header
app.get("/api/files/:filename", async (req, res) => {
  const filename = req.params.filename;
  try {
    const filePath = resolveFilePath(filename, activeProject || undefined);
    const fileStat = await fsStat(filePath);
    if (!fileStat.isFile()) {
      res.status(404).json({ error: "Not a file" });
      return;
    }
    const contentType = mimeTypes.lookup(filename) || "application/octet-stream";
    res.setHeader("Content-Type", contentType as string);
    res.setHeader("Content-Length", fileStat.size);
    res.setHeader("Last-Modified", fileStat.mtime.toUTCString());
    createReadStream(filePath).pipe(res);
  } catch (err) {
    res.status(404).json({ error: (err as Error).message });
  }
});

// Track which source caused a file write
const writeSourceTracker = new Map<string, string>();

// Create or update a file
// Accepts JSON body: { content: string, source?: string }
app.put("/api/files/:filename", async (req, res) => {
  const filename = req.params.filename;
  const { content, source } = req.body;
  if (typeof content !== "string") {
    res.status(400).json({ error: "content (string) required" });
    return;
  }
  try {
    if (source) writeSourceTracker.set(filename, source);
    await writeProjectFile(filename, content, activeProject || undefined);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// Upload a binary file (streamed to disk — no size limit, constant memory)
app.post("/api/files/:filename/upload", async (req, res) => {
  const filename = req.params.filename;
  const root = activeProject ? join(WORKSPACE_DIR, activeProject) : WORKSPACE_DIR;
  const filePath = join(root, filename);
  if (!filePath.startsWith(root + "/")) {
    res.status(400).json({ error: "Invalid filename" });
    return;
  }
  try {
    await mkdir(join(filePath, ".."), { recursive: true });
  } catch { /* dir exists */ }

  const ws = createWriteStream(filePath);
  let bytes = 0;
  req.on("data", (chunk: Buffer) => { bytes += chunk.length; });
  req.pipe(ws);
  ws.on("finish", () => { res.json({ success: true, size: bytes }); });
  ws.on("error", (err) => {
    res.status(500).json({ error: err.message });
  });
  req.on("error", (err) => {
    ws.destroy();
    res.status(500).json({ error: err.message });
  });
});

// Delete a file
app.delete("/api/files/:filename", async (req, res) => {
  const filename = req.params.filename;
  try {
    await deleteProjectFile(filename, activeProject || undefined);
    res.json({ success: true });
  } catch (err) {
    res.status(404).json({ error: (err as Error).message });
  }
});

// ── Layout persistence (.mica/layout.json, keyed by device class) ────

app.get("/api/layout", async (req, res) => {
  if (!activeProject) { res.json({}); return; }
  const device = (req.query.device as string) || "desktop";
  try {
    const data = await readFile(join(micaDir(activeProject), "layout.json"), "utf-8");
    const all = JSON.parse(data);
    if (all[device] && typeof all[device] === "object" && all[device].cards) {
      res.json(all[device]);
    } else if (all.cards) {
      res.json(all);
    } else {
      res.json({});
    }
  } catch {
    res.json({});
  }
});

app.put("/api/layout", async (req, res) => {
  if (!activeProject) { res.status(400).json({ error: "No active project" }); return; }
  const device = (req.query.device as string) || "desktop";
  try {
    const dir = micaDir(activeProject);
    await mkdir(dir, { recursive: true });
    const source = req.body.source;
    const dataToStore = { ...req.body };
    delete dataToStore.source;

    let all: Record<string, unknown> = {};
    try {
      const existing = await readFile(join(dir, "layout.json"), "utf-8");
      all = JSON.parse(existing);
      if (all.cards && !all.desktop) {
        all = { desktop: all };
      }
    } catch { /* fresh file */ }

    all[device] = dataToStore;
    await writeFile(join(dir, "layout.json"), JSON.stringify(all, null, 2), "utf-8");
    broadcast({ type: "layout-changed", source, device });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── Canvas Back (project-level AI context) ───────────────────

app.get("/api/canvas-back", async (_req, res) => {
  if (!activeProject) { res.json({ content: "" }); return; }
  try {
    const content = await readFile(join(micaDir(activeProject), "canvas-back.md"), "utf-8");
    res.json({ content });
  } catch {
    res.json({ content: "" });
  }
});

app.put("/api/canvas-back", async (req, res) => {
  if (!activeProject) { res.status(400).json({ error: "No active project" }); return; }
  try {
    const dir = micaDir(activeProject);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "canvas-back.md"), req.body.content || "", "utf-8");
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── Card Backs (per-card AI context) ─────────────────────────

app.get("/api/card-back/:filename", async (req, res) => {
  if (!activeProject) { res.json({ content: "" }); return; }
  const filename = req.params.filename;
  try {
    // Replace path separators with -- for flat storage
    const safeFilename = filename.replace(/\//g, "--") + ".context.md";
    const content = await readFile(join(micaDir(activeProject), "cards", safeFilename), "utf-8");
    res.json({ content });
  } catch {
    res.json({ content: "" });
  }
});

app.put("/api/card-back/:filename", async (req, res) => {
  if (!activeProject) { res.status(400).json({ error: "No active project" }); return; }
  const filename = req.params.filename;
  try {
    const cardsDir = join(micaDir(activeProject), "cards");
    await mkdir(cardsDir, { recursive: true });
    const safeFilename = filename.replace(/\//g, "--") + ".context.md";
    await writeFile(join(cardsDir, safeFilename), req.body.content || "", "utf-8");
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── mica.* API (server-side bridge for client library) ───────

const micaHandlers = new Map<string, (method: string, params: unknown) => Promise<unknown>>();

export function registerMicaHandler(namespace: string, handler: (method: string, params: unknown) => Promise<unknown>) {
  micaHandlers.set(namespace, handler);
  console.log(`[mica] Registered handler: mica.${namespace}.*`);
}

app.post("/api/mica/:namespace/:method", async (req, res) => {
  const { namespace, method } = req.params;
  const handler = micaHandlers.get(namespace);
  if (!handler) {
    res.status(404).json({ error: `No handler for mica.${namespace}` });
    return;
  }
  try {
    const result = await handler(method, req.body);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── Server Setup ─────────────────────────────────────────────

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("[express] Unhandled error:", err.message);
  res.status(500).json({ error: "Internal server error" });
});

const server = http.createServer(app);
server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(`[server] Port ${PORT} is already in use.`);
  } else {
    console.error("[server] HTTP error:", err.message);
  }
  process.exit(1);
});

// ── WebSocket ────────────────────────────────────────────────

const wss = new WebSocketServer({ server, path: "/ws/cards" });
const wsClients = new Set<WebSocket>();
const wsChannels = new Map<WebSocket, Set<string>>();
const wsCardChannels = new Map<WebSocket, Map<string, string>>();

const channelManager = new ChannelManager();

wss.on("error", (err) => {
  console.error("[websocket-server] Error:", (err as Error).message);
});

wss.on("connection", (ws) => {
  wsClients.add(ws);

  const cleanupWsChannels = () => {
    wsClients.delete(ws);
    const channels = wsChannels.get(ws);
    if (channels) {
      for (const channelId of channels) {
        if (channelManager.has(channelId)) {
          channelManager.detach(channelId);
        }
      }
      wsChannels.delete(ws);
    }
    wsCardChannels.delete(ws);
  };

  ws.on("close", cleanupWsChannels);
  ws.on("error", (err) => {
    console.error("[websocket] Connection error:", err.message);
    cleanupWsChannels();
  });

  ws.on("message", async (raw) => {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw.toString());
    } catch { return; }

    const { type, id, filename, fn, args } = msg as {
      type: string; id?: string; filename?: string;
      fn?: string; args?: Record<string, unknown>;
    };

    switch (type) {
      case "broadcast": {
        const event = (msg as { event?: string }).event;
        const data = (msg as { data?: Record<string, unknown> }).data || {};
        if (event) broadcast({ type: event, ...data });
        break;
      }

      case "channel_open": {
        const cid = id as string;
        try {
          const fname = filename as string;
          const channelArgs = (args || {}) as Record<string, unknown>;
          const msgTabId = (msg.tabId as string | undefined) ?? null;

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

          const cardClass = channelManager.resolveCardClass(fname);

          if (channelManager.hasHandler(cardClass)) {
            const cardKey = `${fname}#${fn}`;
            if (!wsCardChannels.has(ws)) wsCardChannels.set(ws, new Map());
            const cardMap = wsCardChannels.get(ws)!;
            const oldCid = cardMap.get(cardKey);
            if (oldCid && channelManager.has(oldCid)) {
              channelManager.detach(oldCid);
              wsChannels.get(ws)?.delete(oldCid);
            }

            await channelManager.open(cid, fname, fn as string, channelArgs, msgTabId, onData, onClose);
            if (!wsChannels.has(ws)) wsChannels.set(ws, new Set());
            wsChannels.get(ws)!.add(cid);
            cardMap.set(cardKey, cid);
          } else {
            throw new Error(`No channel handler for "${cardClass}"`);
          }
        } catch (err) {
          console.error(`[ws] channel_open error:`, (err as Error).message);
          ws.send(JSON.stringify({ type: "error", id, error: (err as Error).message }));
        }
        break;
      }

      case "channel_data": {
        const cid = id as string;
        if (channelManager.has(cid)) {
          channelManager.sendData(cid, (msg as { data?: unknown }).data);
        }
        break;
      }

      case "channel_close": {
        const cid = id as string;
        if (channelManager.has(cid)) channelManager.detach(cid);
        wsChannels.get(ws)?.delete(cid);
        const cardMap = wsCardChannels.get(ws);
        if (cardMap) {
          for (const [key, val] of cardMap) {
            if (val === cid) { cardMap.delete(key); break; }
          }
        }
        break;
      }
    }
  });
});

function broadcast(msg: Record<string, unknown>) {
  const data = JSON.stringify(msg);
  for (const ws of wsClients) {
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(data); } catch { wsClients.delete(ws); }
    }
  }
}

// ── File Watcher Events ──────────────────────────────────────

fileWatcher.on("file-change", async (event: { type: string; filename: string }) => {
  console.log(`[file-watcher] ${event.type}: ${event.filename}`);

  if (event.type === "deleted") {
    broadcast({ type: "file-deleted", filename: event.filename });
    return;
  }

  if (event.type === "created") {
    broadcast({ type: "file-created", filename: event.filename });
  }

  if (event.type === "changed") {
    const source = writeSourceTracker.get(event.filename) || "external";
    writeSourceTracker.delete(event.filename);
    broadcast({ type: "file-changed", filename: event.filename, source });
  }
});

// ── Startup ──────────────────────────────────────────────────

(async () => {
  // Ensure workspace directory exists
  await mkdir(WORKSPACE_DIR, { recursive: true });

  // Sync global skills (mica/skills/<category>/<name>/) to workspace .qwen/skills/
  // so the Qwen SDK can discover them (it expects a flat directory structure).
  try {
    const dstSkills = join(WORKSPACE_DIR, ".qwen", "skills");
    const count = await syncSkillsToQwen(dstSkills);
    if (count > 0) console.log(`[startup] Synced ${count} skills to workspace .qwen/skills/`);
  } catch (err) {
    console.warn("[startup] Failed to sync skills:", (err as Error).message);
  }

  // Register mica.* RPC plugins
  registerMicaHandler("chat", chatHandler);  // mica.chat.*
  registerMicaHandler("exec", execHandler);  // mica.exec.*

  // Register channel-based plugins
  channelManager.registerHandler("chat", createAgentHandler(fileWatcher));  // .chat files -> Qwen agent
  channelManager.registerHandler("terminal", createPtyHandler());  // .terminal files -> PTY
  channelManager.registerHandler("llm-chat", createLlmChatHandler());  // .llm-chat files -> direct LLM chat

  // Start llama-server for local AI
  ensureLlamaServer().catch((err) => {
    console.warn("[startup] llama-server failed to start:", (err as Error).message);
  });

  const workspaceName = getWorkspaceName();

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`
======================================================
                     Mica
======================================================
  Workspace:  ${workspaceName}
  Path:       ${WORKSPACE_DIR}
  Canvas:     http://localhost:${PORT}
======================================================
`);
  });

  const shutdown = async () => {
    console.log("\n[shutdown] Stopping...");
    channelManager.destroyAll();
    fileWatcher.stop();
    await stopLlamaServer();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
})();
