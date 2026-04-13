// Mica Lite Server — single project planning canvas.
// Serves files from PROJECT_DIR, provides layout persistence,
// file watching, terminal channels, and AI via llama-server.

import express from "express";
import cors from "cors";
import http from "http";
import { WebSocketServer, WebSocket } from "ws";
import {
  PROJECT_DIR,
  micaDir,
  getProjectName,
  listFiles,
  readProjectFile,
  writeProjectFile,
  deleteProjectFile,
} from "./files.js";
import { readFile, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { existsSync } from "fs";
import { FileWatcher } from "./fileWatcher.js";
import { ChannelManager } from "./channelManager.js";
import { ensureLlamaServer, stopLlamaServer } from "./llamaServer.js";
import { chatHandler } from "./micaChat.js";
import { createAgentHandler } from "./micaAgent.js";
import { createTerminalHandler } from "./micaTerminal.js";

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
app.use(express.json({ limit: "5mb" }));

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

// ── REST Endpoints ───────────────────────────────────────────

// Project info
app.get("/api/project", async (_req, res) => {
  const name = await getProjectName();
  res.json({ name, path: PROJECT_DIR });
});

// ── Card Classes ─────────────────────────────────────────────

const CARD_CLASSES_DIR = join(process.cwd(), "card-classes");

// Resolve card class directory: .mica/card-classes/:name first, then built-in
function resolveCardClassDir(className: string): string | null {
  const projectScoped = join(micaDir(), "card-classes", className);
  if (existsSync(join(projectScoped, "render.js"))) return projectScoped;
  const builtIn = join(CARD_CLASSES_DIR, className);
  if (existsSync(join(builtIn, "render.js"))) return builtIn;
  return null;
}

// Get render.js content for a card class
app.get("/api/card-classes/:className/render.js", async (req, res) => {
  const dir = resolveCardClassDir(req.params.className);
  if (!dir) {
    res.status(404).json({ error: `Card class not found: ${req.params.className}` });
    return;
  }
  try {
    const content = await readFile(join(dir, "render.js"), "utf-8");
    res.type("application/javascript").send(content);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
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
      if (existsSync(join(CARD_CLASSES_DIR, name, "render.js"))) {
        classes[name] = { builtIn: true };
      }
    }
  } catch { /* no card-classes dir */ }

  // Project-scoped (overrides built-in)
  try {
    const projectDir = join(micaDir(), "card-classes");
    const entries = await rd(projectDir);
    for (const name of entries) {
      if (existsSync(join(projectDir, name, "render.js"))) {
        classes[name] = { builtIn: false };
      }
    }
  } catch { /* no project card-classes */ }

  res.json(classes);
});

// Render the canvas card (server-side, returns HTML)
app.get("/api/canvas-card", async (_req, res) => {
  try {
    const classDir = resolveCardClassDir("canvas");
    if (!classDir) throw new Error("Canvas card class not found");

    const renderPath = join(classDir, "render.js");
    // Dynamic import with cache-busting for hot reload
    const mod = await import(renderPath + "?t=" + Date.now());
    const files = await listFiles();
    const html = mod.default("", {
      children: files.map((f: { name: string }) => ({ filename: f.name })),
    });

    res.json({
      html,
      exports: Object.keys(mod).filter(
        (k) => k !== "default" && k !== "metadata" && k !== "dependencies"
      ),
      dependencies: mod.dependencies || {},
      meta: mod.metadata || {},
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── Render a child card via its card class ───────────────────

// Map file extension to card class name
function cardClassForFile(filename: string): string | null {
  const ext = filename.split(".").pop()?.toLowerCase();
  if (!ext) return null;
  // Check if there's a card class with this extension
  const dir = resolveCardClassDir(ext);
  return dir ? ext : null;
}

app.get("/api/rendered-card/:filename", async (req, res) => {
  const { filename } = req.params;
  try {
    const cardClass = cardClassForFile(filename);
    if (!cardClass) {
      // No card class — return null so frontend does client-side rendering
      res.json({ html: null, cardClass: null });
      return;
    }

    const classDir = resolveCardClassDir(cardClass)!;
    const renderPath = join(classDir, "render.js");
    const mod = await import(renderPath + "?t=" + Date.now());

    // Read file content
    let content = "";
    try {
      const file = await readProjectFile(filename);
      content = file.content;
    } catch { /* new file, empty content */ }

    const html = mod.default(content, { filename });

    res.json({
      html,
      cardClass,
      exports: Object.keys(mod).filter(k => k !== "default" && k !== "metadata" && k !== "dependencies"),
      dependencies: mod.dependencies || {},
      meta: mod.metadata || {},
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── Card error/ok reporting (from CARD_SHIM) ────────────────

app.post("/api/cards/:filename/error", (req, res) => {
  const { filename } = req.params;
  const { error } = req.body as { error?: string };
  if (error) console.log(`[card-error] ${filename}: ${error.slice(0, 200)}`);
  res.json({ ok: true });
});

app.post("/api/cards/:filename/ok", (_req, res) => {
  res.json({ ok: true });
});

// List all files
app.get("/api/files", async (_req, res) => {
  try {
    res.json(await listFiles());
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Read a file
app.get("/api/files/:filename", async (req, res) => {
  try {
    res.json(await readProjectFile(req.params.filename));
  } catch (err) {
    res.status(404).json({ error: (err as Error).message });
  }
});

// Track which source caused a file write -- included in file-changed broadcast
const writeSourceTracker = new Map<string, string>();

// Create or update a file
app.put("/api/files/:filename", async (req, res) => {
  const { content, source } = req.body;
  if (typeof content !== "string") {
    res.status(400).json({ error: "content (string) required" });
    return;
  }
  try {
    if (source) writeSourceTracker.set(req.params.filename, source);
    await writeProjectFile(req.params.filename, content);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// Delete a file
app.delete("/api/files/:filename", async (req, res) => {
  try {
    await deleteProjectFile(req.params.filename);
    res.json({ success: true });
  } catch (err) {
    res.status(404).json({ error: (err as Error).message });
  }
});

// ── Layout persistence (.mica/layout.json) ───────────────────

app.get("/api/layout", async (_req, res) => {
  try {
    const data = await readFile(join(micaDir(), "layout.json"), "utf-8");
    res.json(JSON.parse(data));
  } catch {
    res.json({});
  }
});

app.put("/api/layout", async (req, res) => {
  try {
    const dir = micaDir();
    await mkdir(dir, { recursive: true });
    const source = req.body.source;
    const dataToStore = { ...req.body };
    delete dataToStore.source;
    await writeFile(join(dir, "layout.json"), JSON.stringify(dataToStore, null, 2), "utf-8");
    broadcast({ type: "layout-changed", source });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── Canvas Back (project-level AI context) ───────────────────

app.get("/api/canvas-back", async (_req, res) => {
  try {
    const content = await readFile(join(micaDir(), "canvas-back.md"), "utf-8");
    res.json({ content });
  } catch {
    res.json({ content: "" });
  }
});

app.put("/api/canvas-back", async (req, res) => {
  try {
    const dir = micaDir();
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "canvas-back.md"), req.body.content || "", "utf-8");
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── Card Backs (per-card AI context) ─────────────────────────

app.get("/api/card-back/:filename", async (req, res) => {
  try {
    const backFilename = req.params.filename.replace(/\//g, "--");
    const content = await readFile(join(micaDir(), "cards", backFilename), "utf-8");
    res.json({ content });
  } catch {
    res.json({ content: "" });
  }
});

app.put("/api/card-back/:filename", async (req, res) => {
  try {
    const cardsDir = join(micaDir(), "cards");
    await mkdir(cardsDir, { recursive: true });
    const backFilename = req.params.filename.replace(/\//g, "--");
    await writeFile(join(cardsDir, backFilename), req.body.content || "", "utf-8");
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── mica.* API (server-side bridge for client library) ───────

// Generic RPC endpoint — mica.* client calls go through here.
// Modular: handlers registered by namespace (chat, file, source, etc.)
const micaHandlers = new Map<string, (method: string, params: unknown) => Promise<unknown>>();

/** Register a mica.* namespace handler. e.g. registerMicaHandler("chat", handler) */
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

const fileWatcher = new FileWatcher();

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
    try {
      const file = await readProjectFile(event.filename);
      broadcast({ type: "file-created", filename: event.filename, content: file.content });
    } catch { /* ignore */ }
  }

  if (event.type === "changed") {
    const source = writeSourceTracker.get(event.filename) || "external";
    writeSourceTracker.delete(event.filename);
    broadcast({ type: "file-changed", filename: event.filename, source });
  }
});

// ── Startup ──────────────────────────────────────────────────

(async () => {
  // Ensure .mica/ exists
  await mkdir(micaDir(), { recursive: true });

  // Copy Mica's skills to project's .qwen/skills/ so the SDK discovers them
  try {
    const { cpSync, existsSync: ex } = await import("fs");
    const srcSkills = join(process.cwd(), ".qwen", "skills");
    const dstSkills = join(PROJECT_DIR, ".qwen", "skills");
    if (ex(srcSkills)) {
      await mkdir(dstSkills, { recursive: true });
      cpSync(srcSkills, dstSkills, { recursive: true, force: true });
      console.log("[startup] Copied skills to project .qwen/skills/");
    }
  } catch (err) {
    console.warn("[startup] Failed to copy skills:", (err as Error).message);
  }

  // Auto-create agent card if no .chat file exists in the project
  try {
    const files = await listFiles();
    const hasChatCard = files.some((f: { name: string }) => f.name.endsWith(".chat"));
    if (!hasChatCard) {
      const agentId = "agent-" + Date.now().toString(36);
      const chatFilename = agentId + ".chat";
      const stub = "---\nmica: chat\nid: " + agentId + "\n---\nMica project agent.\n";
      await writeProjectFile(chatFilename, stub);

      // Write default behavior instructions on the agent card's back
      const cardsDir = join(micaDir(), "cards");
      await mkdir(cardsDir, { recursive: true });
      await writeFile(join(cardsDir, chatFilename), [
        "## On Project Open",
        "- Scan project files and identify the project type",
        "- Write canvas-back.md with project context and purpose",
        "- Create decisions.md if none exists",
        "- Create a TODO file with initial tasks if none exists",
        "- Suggest how to organize files on the canvas",
        "",
        "## On File Changes",
        "- Check todo files for @agent tasks and work on them",
        "- Update dependent docs when specs change",
        "- Log decisions and actions to decisions.md",
        "- If you have questions, add a todo item assigned to @human",
        "",
        "## On User Message",
        "- Answer questions about the project",
        "- Create card classes when asked to build interactive components",
        "- Use the create-card-class skill for new visualizations",
      ].join("\n"), "utf-8");

      console.log("[startup] Created agent card: " + chatFilename);
    }
  } catch (err) {
    console.warn("[startup] Failed to create agent card:", (err as Error).message);
  }

  try {
    await fileWatcher.start();
  } catch (err) {
    console.error("[startup] File watcher failed:", (err as Error).message);
  }

  // Register mica.* handlers
  registerMicaHandler("chat", chatHandler);

  // Register channel handler for .chat files (Qwen Code agent)
  channelManager.registerHandler("chat", createAgentHandler(fileWatcher));

  // Register channel handler for .terminal files (PTY terminal)
  channelManager.registerHandler("terminal", createTerminalHandler());

  // Start llama-server for local AI
  ensureLlamaServer().catch((err) => {
    console.warn("[startup] llama-server failed to start:", (err as Error).message);
  });

  const projectName = await getProjectName();

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`
╔══════════════════════════════════════════════════════════╗
║                   Mica Lite                              ║
╠══════════════════════════════════════════════════════════╣
║  Project:   ${projectName.padEnd(42)}║
║  Path:      ${PROJECT_DIR.padEnd(42)}║
║  Canvas:    http://localhost:${PORT}${" ".repeat(28)}║
╚══════════════════════════════════════════════════════════╝
`);
  });

  const shutdown = async () => {
    console.log("\n[shutdown] Stopping...");
    channelManager.destroyAll();
    await stopLlamaServer();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
})();
