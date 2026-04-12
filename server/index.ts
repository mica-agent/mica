// Mica Lite Server
// Express + WebSocket server for the planning canvas.
// Files are files. The server provides: file I/O, layout persistence,
// file watching, terminal channels, and state sync.

import express from "express";
import cors from "cors";
import http from "http";
import { WebSocketServer, WebSocket } from "ws";
import {
  listFiles,
  readCanvasFile,
  writeCanvasFile,
  deleteCanvasFile,
  listProjects,
  getProjectConfig,
  validateProjectCanvas,
} from "./files.js";
import { readFile, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import {
  connectProject,
  addCanvasToProject,
  getProjectPath,
  getCanvasDir,
} from "./projectConnection.js";
import { FileWatcher } from "./fileWatcher.js";
import { ChannelManager } from "./channelManager.js";
import { ensureLlamaServer, stopLlamaServer } from "./llamaServer.js";

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

// ── Content Security Policy ──────────────────────────────────
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

// ── Helper: validate project+canvas from route params ────────
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

// ── REST Endpoints ───────────────────────────────────────────

// Health check
app.get("/api/health", async (_req, res) => {
  const projects = await listProjects();
  res.json({ status: "ok", projects: projects.map((p) => p.id) });
});

// ── Project Management ───────────────────────────────────────

app.get("/api/projects", async (_req, res) => {
  try {
    res.json(await listProjects());
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

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

// Connect an existing directory to Mica
app.post("/api/projects/connect", async (req, res) => {
  const { path: projectPath, name } = req.body;
  if (!projectPath) {
    res.status(400).json({ error: "path required" });
    return;
  }
  try {
    const config = await connectProject(projectPath, name);
    await fileWatcher.addProject(config.id, config.canvases);
    res.json(config);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// ── Canvas management ────────────────────────────────────────

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

// ── File Endpoints ───────────────────────────────────────────

// List all files in a canvas/project directory
app.get("/api/projects/:project/canvases/:canvas/files", async (req, res) => {
  const { project, canvas } = req.params;
  if (!(await validateParams(res, project, canvas))) return;
  try {
    res.json(await listFiles(project, canvas));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Read a single file
app.get("/api/projects/:project/canvases/:canvas/files/:filename", async (req, res) => {
  const { project, canvas, filename } = req.params;
  if (!(await validateParams(res, project, canvas))) return;
  try {
    res.json(await readCanvasFile(project, canvas, filename));
  } catch (err) {
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
  } catch (err) {
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
  } catch (err) {
    res.status(404).json({ error: (err as Error).message });
  }
});

// ── Layout persistence (.mica/layout.json) ───────────────────

app.get("/api/projects/:project/canvases/:canvas/layout", async (req, res) => {
  const { project, canvas } = req.params;
  if (!(await validateParams(res, project, canvas))) return;
  try {
    const projectPath = await getProjectPath(project);
    const layoutPath = join(projectPath, ".mica", "layout.json");
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
    const projectPath = await getProjectPath(project);
    const layoutDir = join(projectPath, ".mica");
    await mkdir(layoutDir, { recursive: true });
    await writeFile(join(layoutDir, "layout.json"), JSON.stringify(dataToStore, null, 2), "utf-8");
    broadcast({ type: "layout-changed", project, canvas, source });
    res.json({ success: true });
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
    } catch {
      return;
    }

    const { type, id, project, canvas, filename, fn, args } = msg as {
      type: string; id?: string; project?: string; canvas?: string;
      filename?: string; fn?: string; args?: Record<string, unknown>;
      event?: string; data?: unknown;
    };

    switch (type) {
      // Widget-to-widget broadcast
      case "broadcast": {
        const event = (msg as { event?: string }).event;
        const data = (msg as { data?: Record<string, unknown> }).data || {};
        if (event) {
          broadcast({ type: event, ...data });
        }
        break;
      }

      // Bidirectional channel — open (terminal, future chat)
      case "channel_open": {
        const cid = id as string;
        try {
          const fname = filename as string;
          const channelArgs = (args || {}) as Record<string, unknown>;
          const proj = project as string;
          const canv = canvas as string;
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
            // Dedup: if this WebSocket already has a channel for this card, detach old one
            const cardKey = `${proj}/${canv}/${fname}#${fn}`;
            if (!wsCardChannels.has(ws)) wsCardChannels.set(ws, new Map());
            const cardMap = wsCardChannels.get(ws)!;
            const oldCid = cardMap.get(cardKey);
            if (oldCid && channelManager.has(oldCid)) {
              channelManager.detach(oldCid);
              wsChannels.get(ws)?.delete(oldCid);
            }

            await channelManager.open(cid, proj, canv, fname, fn as string, channelArgs, msgTabId, onData, onClose);
            if (!wsChannels.has(ws)) wsChannels.set(ws, new Set());
            wsChannels.get(ws)!.add(cid);
            cardMap.set(cardKey, cid);
          } else {
            throw new Error(`No channel handler for "${cardClass}" (file: ${fname})`);
          }
        } catch (err) {
          console.error(`[ws] channel_open error:`, (err as Error).message);
          ws.send(JSON.stringify({ type: "error", id, error: (err as Error).message }));
        }
        break;
      }

      // Bidirectional channel — data
      case "channel_data": {
        const cid = id as string;
        if (channelManager.has(cid)) {
          channelManager.sendData(cid, (msg as { data?: unknown }).data);
        }
        break;
      }

      // Bidirectional channel — close
      case "channel_close": {
        const cid = id as string;
        if (channelManager.has(cid)) {
          channelManager.detach(cid);
        }
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

fileWatcher.on("file-change", async (event: { type: string; project: string; canvas: string; filename: string }) => {
  if (event.filename.startsWith(".")) return;

  console.log(`[file-watcher] ${event.type}: ${event.project}/${event.canvas}/${event.filename}`);

  if (event.type === "deleted") {
    broadcast({ type: "file-deleted", project: event.project, canvas: event.canvas, filename: event.filename });
    return;
  }

  if (event.type === "created") {
    try {
      const file = await readCanvasFile(event.project, event.canvas, event.filename);
      broadcast({
        type: "file-created",
        project: event.project,
        canvas: event.canvas,
        filename: event.filename,
        content: file.content,
      });
    } catch (err) {
      console.error(`[file-watcher] Read failed for new file ${event.filename}:`, (err as Error).message);
    }
  }

  if (event.type === "changed") {
    broadcast({
      type: "file-changed",
      project: event.project,
      canvas: event.canvas,
      filename: event.filename,
    });
  }
});

// ── Startup ──────────────────────────────────────────────────

(async () => {
  try {
    await fileWatcher.start();
  } catch (err) {
    console.error("[startup] File watcher failed:", (err as Error).message);
  }

  // Start llama-server for local AI (Qwen3)
  ensureLlamaServer().catch((err) => {
    console.warn("[startup] llama-server failed to start:", (err as Error).message);
  });

  // TODO: Register terminal channel handler
  // TODO: Register chat channel handler

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`
╔══════════════════════════════════════════════════════════╗
║                   Mica Lite Server                       ║
╠══════════════════════════════════════════════════════════╣
║  REST API:  http://localhost:${PORT}/api                     ║
║  WebSocket: ws://localhost:${PORT}/ws/cards                  ║
╠══════════════════════════════════════════════════════════╣
║  Planning canvas for files-as-files.                     ║
║  File watcher: active                                    ║
╚══════════════════════════════════════════════════════════╝
`);
  });

  // Graceful shutdown
  const shutdown = async () => {
    console.log("\n[shutdown] Stopping...");
    channelManager.destroyAll();
    await stopLlamaServer();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
})();
