// Mica AI Team Server
// Express server bridging the frontend to Claude Agent SDK-powered layer agents.
// Auth: Uses Claude Code subscription (Pro/Max) — no API key needed.

import express from "express";
import cors from "cors";
import {
  chatWithAgent,
  escalateToAgent,
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

const PORT = parseInt(process.env.MICA_PORT || "3001");

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

    // If there's an escalation, automatically forward it
    if (response.escalation) {
      const escalationResponse = await escalateToAgent(
        layer,
        response.escalation.targetLayer,
        response.escalation.question,
        response.escalation.context
      );
      res.json({ response, escalationResponse });
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

// Cross-layer escalation
app.post("/api/escalate", async (req, res) => {
  const { fromLayer, toLayer, question, context } = req.body;

  try {
    const response = await escalateToAgent(
      fromLayer,
      toLayer,
      question,
      context
    );
    res.json({ response });
  } catch (err: unknown) {
    const error = err as Error;
    console.error("[escalate] Error:", error.message);
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

// ── Start ──────────────────────────────────────────────────

// Seed mission layer on startup
seedMissionLayer().catch((err) =>
  console.error("Failed to seed mission layer:", err.message)
);

app.listen(PORT, "0.0.0.0", () => {
  console.log(`
╔══════════════════════════════════════════════════════════╗
║                   Mica AI Team Server                    ║
╠══════════════════════════════════════════════════════════╣
║  REST API:  http://localhost:${PORT}/api                     ║
╠══════════════════════════════════════════════════════════╣
║  Agents:                                                 ║
║    ◆ Mission Strategist    — Product vision & scope      ║
║    ◇ Experience Designer   — UX flows & wireframes       ║
║    ⬡ System Architect      — Technical design & APIs     ║
║    ⬢ Implementation Eng.   — Code, tests & deployment    ║
╠══════════════════════════════════════════════════════════╣
║  Auth: Claude Code subscription (Pro/Max)                ║
║  No API key needed — uses your existing login            ║
╚══════════════════════════════════════════════════════════╝
`);
});
