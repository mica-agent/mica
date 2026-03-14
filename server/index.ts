// Mica AI Team Server
// Express server bridging the frontend to Claude Agent SDK-powered layer agents.
// Auth: Uses Claude Code subscription (Pro/Max) — no API key needed.

import express from "express";
import cors from "cors";
import http from "http";
import { WebSocketServer, WebSocket } from "ws";
import {
  chatWithAgent,
  consultLayer,
  teamDiscuss,
  convertDrawingToMermaid,
  resetLayer,
  resetAll,
  AGENT_META,
} from "./agents.js";
import type { LayerId } from "./agents.js";
import {
  listFiles,
  readLayerFile,
  writeLayerFile,
  deleteLayerFile,
} from "./layerFiles.js";
import { seedMissionLayer } from "./seedLayers.js";
import { WorkerPool } from "./workerPool.js";
import { CardManager } from "./cardManager.js";
import { FileWatcher } from "./fileWatcher.js";

const PORT = parseInt(process.env.MICA_PORT || "3001");

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

// ── REST Endpoints ─────────────────────────────────────────

// Health check
app.get("/api/health", (_req, res) => {
  res.json({
    status: "ok",
    auth: "claude-subscription",
    agents: ["mission", "experience", "architecture", "implementation"],
  });
});

// Agent metadata
app.get("/api/agents", (_req, res) => {
  res.json(AGENT_META);
});

// Chat with a specific layer agent
app.post("/api/chat/:layer", async (req, res) => {
  req.setTimeout(120000);
  res.setTimeout(120000);
  const layer = req.params.layer as LayerId;
  const validLayers: LayerId[] = [
    "mission",
    "experience",
    "architecture",
    "implementation",
  ];
  if (!validLayers.includes(layer)) {
    res.status(400).json({ error: `Invalid layer: ${layer}` });
    return;
  }

  const { message } = req.body;
  if (!message) {
    res.status(400).json({ error: "Message required" });
    return;
  }

  try {
    const response = await chatWithAgent(layer, message);

    // If there's a pending consultation, forward it
    if (response.consultation) {
      const consultationResponse = await consultLayer(
        layer,
        response.consultation.targetLayer,
        response.consultation.question,
        response.consultation.context
      );
      res.json({ response, consultationResponse });
      return;
    }

    res.json({ response });
  } catch (err: unknown) {
    const error = err as Error;
    console.error(`[${layer}] Error:`, error.message);
    res.status(500).json({ error: error.message });
  }
});

// Team discussion — all agents respond to a topic
app.post("/api/team/discuss", async (req, res) => {
  const { topic } = req.body;
  if (!topic) {
    res.status(400).json({ error: "Topic required" });
    return;
  }

  try {
    const responses = await teamDiscuss(topic);
    res.json({ responses });
  } catch (err: unknown) {
    const error = err as Error;
    console.error("[team] Error:", error.message);
    res.status(500).json({ error: error.message });
  }
});

// Cross-layer consultation
app.post("/api/consult", async (req, res) => {
  const { fromLayer, toLayer, question, context } = req.body;

  try {
    const response = await consultLayer(
      fromLayer,
      toLayer,
      question,
      context
    );
    res.json({ response });
  } catch (err: unknown) {
    const error = err as Error;
    console.error("[consult] Error:", error.message);
    res.status(500).json({ error: error.message });
  }
});

// Reset conversations
app.post("/api/reset", (req, res) => {
  const { layer } = req.body;
  if (layer) {
    resetLayer(layer);
  } else {
    resetAll();
  }
  res.json({ success: true });
});

// ── Layer File Endpoints ─────────────────────────────────────

const validLayers: LayerId[] = [
  "mission",
  "experience",
  "architecture",
  "implementation",
];

function isValidLayer(layer: string): layer is LayerId {
  return validLayers.includes(layer as LayerId);
}

// List all files in a layer
app.get("/api/layers/:layer/files", async (req, res) => {
  const { layer } = req.params;
  if (!isValidLayer(layer)) {
    res.status(400).json({ error: `Invalid layer: ${layer}` });
    return;
  }
  try {
    const files = await listFiles(layer);
    res.json(files);
  } catch (err: unknown) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Read a single file
app.get("/api/layers/:layer/files/:filename", async (req, res) => {
  const { layer, filename } = req.params;
  if (!isValidLayer(layer)) {
    res.status(400).json({ error: `Invalid layer: ${layer}` });
    return;
  }
  try {
    const file = await readLayerFile(layer, filename);
    res.json(file);
  } catch (err: unknown) {
    res.status(404).json({ error: (err as Error).message });
  }
});

// Create or update a file
app.put("/api/layers/:layer/files/:filename", async (req, res) => {
  const { layer, filename } = req.params;
  const { content } = req.body;
  if (!isValidLayer(layer)) {
    res.status(400).json({ error: `Invalid layer: ${layer}` });
    return;
  }
  if (typeof content !== "string") {
    res.status(400).json({ error: "content (string) required" });
    return;
  }
  try {
    await writeLayerFile(layer, filename, content);
    res.json({ success: true });
  } catch (err: unknown) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// Delete a file
app.delete("/api/layers/:layer/files/:filename", async (req, res) => {
  const { layer, filename } = req.params;
  if (!isValidLayer(layer)) {
    res.status(400).json({ error: `Invalid layer: ${layer}` });
    return;
  }
  try {
    await deleteLayerFile(layer, filename);
    res.json({ success: true });
  } catch (err: unknown) {
    res.status(404).json({ error: (err as Error).message });
  }
});

// Convert a drawing to mermaid via Claude Vision
app.post("/api/layers/:layer/convert-drawing", async (req, res) => {
  const { layer } = req.params;
  const { imageBase64 } = req.body;
  if (!isValidLayer(layer)) {
    res.status(400).json({ error: `Invalid layer: ${layer}` });
    return;
  }
  if (!imageBase64) {
    res.status(400).json({ error: "imageBase64 required" });
    return;
  }
  try {
    const result = await convertDrawingToMermaid(layer as LayerId, imageBase64);
    res.json(result);
  } catch (err: unknown) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── Widget Card System ──────────────────────────────────────

const workerPool = new WorkerPool({ poolSize: 4, pythonPath: "/usr/bin/python3" });
const cardManager = new CardManager(workerPool);
const fileWatcher = new FileWatcher();

// RPC handler: Python card classes can call mica.write(), mica.agent.chat(), etc.
workerPool.setRpcHandler(async (method, args, context) => {
  const layer = context.layer as LayerId;

  switch (method) {
    case "write": {
      await writeLayerFile(layer, context.filename, args.content as string);
      return { success: true };
    }
    case "write_file": {
      await writeLayerFile(layer, args.filename as string, args.content as string);
      return { success: true };
    }
    case "read_file": {
      try {
        const file = await readLayerFile(layer, args.filename as string);
        return file.content;
      } catch {
        return null;
      }
    }
    case "log": {
      const timestamp = new Date().toISOString().replace("T", " ").slice(0, 16);
      const line = `- **${timestamp}** — ${args.message}\n`;
      try {
        const existing = await readLayerFile(layer, "_log.md");
        await writeLayerFile(layer, "_log.md", existing.content + line);
      } catch {
        await writeLayerFile(layer, "_log.md", `# Activity Log\n\n${line}`);
      }
      return { success: true };
    }
    case "agent.chat": {
      const response = await chatWithAgent(layer, args.message as string);
      return {
        message: response.message,
        agentName: AGENT_META[layer].name,
        filesChanged: response.filesChanged,
      };
    }
    default:
      throw new Error(`Unknown RPC method: ${method}`);
  }
});

// Get all rendered cards for a layer
app.get("/api/layers/:layer/cards", async (req, res) => {
  const { layer } = req.params;
  if (!isValidLayer(layer)) {
    res.status(400).json({ error: `Invalid layer: ${layer}` });
    return;
  }
  try {
    const cards = await cardManager.renderAllCards(layer);
    res.json(cards);
  } catch (err: unknown) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Call an export function on a card
app.post("/api/layers/:layer/cards/:filename/call/:fn", async (req, res) => {
  req.setTimeout(120000);
  res.setTimeout(120000);
  const { layer, filename, fn } = req.params;
  if (!isValidLayer(layer)) {
    res.status(400).json({ error: `Invalid layer: ${layer}` });
    return;
  }
  try {
    const result = await cardManager.callExport(layer, filename, fn, req.body || {});
    res.json({ result });
  } catch (err: unknown) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Context stats — estimate token usage for agent calls
app.get("/api/layers/:layer/context-stats", async (req, res) => {
  const { layer } = req.params;
  if (!isValidLayer(layer)) {
    res.status(400).json({ error: `Invalid layer: ${layer}` });
    return;
  }
  try {
    const files = await listFiles(layer);
    let totalChars = 0;
    const fileStats: { name: string; chars: number }[] = [];
    for (const f of files) {
      const chars = f.content.length;
      totalChars += chars;
      fileStats.push({ name: f.name, chars });
    }

    // Chat history size
    let chatHistoryChars = 0;
    const chatFile = files.find((f) => f.name === "_chat-history.json");
    if (chatFile) chatHistoryChars = chatFile.content.length;

    // Fixed system prompt ~2100 chars
    const systemPromptChars = 2100;
    const totalContextChars = totalChars + systemPromptChars;

    // Rough token estimate: ~4 chars per token for English text
    const estimatedTokens = Math.round(totalContextChars / 4);

    res.json({
      layer,
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

// Seed mission layer on startup
seedMissionLayer().catch((err) =>
  console.error("Failed to seed mission layer:", err.message)
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

wss.on("error", (err) => {
  console.error("[websocket-server] Error:", (err as Error).message);
});

wss.on("connection", (ws) => {
  wsClients.add(ws);
  ws.on("close", () => wsClients.delete(ws));
  ws.on("error", (err) => {
    console.error("[websocket] Connection error:", err.message);
    wsClients.delete(ws);
  });

  // Handle export calls from browser via WebSocket
  ws.on("message", async (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "export_call") {
        const { id, layer, filename, fn, args } = msg;
        try {
          const result = await cardManager.callExport(layer, filename, fn, args || {});
          ws.send(JSON.stringify({ type: "export_result", id, result }));
        } catch (err) {
          ws.send(JSON.stringify({ type: "export_error", id, error: (err as Error).message }));
        }
      }
    } catch {
      // Ignore invalid messages
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

// File watcher → re-render + broadcast
fileWatcher.on("file-change", async (event: { type: string; layer: string; filename: string }) => {
  console.log(`[file-watcher] ${event.type}: ${event.layer}/${event.filename}`);

  if (event.type === "deleted") {
    cardManager.invalidateCard(event.layer, event.filename);
    broadcast({ type: "file-deleted", layer: event.layer, filename: event.filename });
    return;
  }

  // Skip chat history from rendering (it's data, not a card)
  if (event.filename === "_chat-history.json") return;

  // Re-render the changed card
  cardManager.invalidateCard(event.layer, event.filename);
  try {
    const file = await readLayerFile(event.layer as LayerId, event.filename);
    const rendered = await cardManager.renderCard(
      event.layer as LayerId,
      event.filename,
      file.content
    );
    broadcast({
      type: event.type === "created" ? "file-created" : "file-changed",
      layer: event.layer,
      filename: event.filename,
      html: rendered.html,
      exports: rendered.exports,
      meta: rendered.meta,
    });
  } catch (err) {
    console.error(`[file-watcher] Re-render failed for ${event.layer}/${event.filename}:`, (err as Error).message);
  }
});

// Card class changes → invalidate + re-render all instances
fileWatcher.on("class-change", (event: { className: string }) => {
  console.log(`[file-watcher] Card class changed: ${event.className}`);
  cardManager.invalidateClass(event.className);
  // TODO: re-render all instances of this class and broadcast
});

// Start everything
(async () => {
  try {
    await workerPool.start();
    await fileWatcher.start();
  } catch (err) {
    console.error("[startup] Worker pool or file watcher failed:", (err as Error).message);
    console.error("[startup] Widget rendering will be unavailable. Card classes need Python 3.");
  }

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`
╔══════════════════════════════════════════════════════════╗
║                   Mica AI Team Server                    ║
╠══════════════════════════════════════════════════════════╣
║  REST API:  http://localhost:${PORT}/api                     ║
║  WebSocket: ws://localhost:${PORT}/ws/cards                  ║
╠══════════════════════════════════════════════════════════╣
║  Widget System:                                          ║
║    Worker Pool: 4 Python workers                         ║
║    Card Classes: card-classes/                           ║
║    File Watcher: active                                  ║
╠══════════════════════════════════════════════════════════╣
║  Auth: Claude Code subscription (Pro/Max)                ║
║  No API key needed — uses your existing login            ║
╚══════════════════════════════════════════════════════════╝
`);
  });
})();
