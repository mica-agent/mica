// Mica AI Team Server
// Express server bridging the frontend to Claude Agent SDK-powered layer agents.
// Auth: Uses Claude Code subscription (Pro/Max) — no API key needed.

import express from "express";
import cors from "cors";
import {
  chatWithAgent,
  escalateToAgent,
  teamDiscuss,
  resetLayer,
  resetAll,
  AGENT_META,
} from "./agents.js";
import type { LayerId } from "./agents.js";

const PORT = parseInt(process.env.MICA_PORT || "3001");

const app = express();
app.use(cors());
app.use(express.json());

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

// ── Start ──────────────────────────────────────────────────

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
