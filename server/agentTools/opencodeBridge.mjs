#!/usr/bin/env node
// opencodeBridge.mjs — stdio MCP server registered as a Local MCP in
// opencode-serve's Config.mcp. opencode spawns this as a child process;
// this script speaks MCP over stdio and forwards tool calls to Mica's
// /api/tools/* REST endpoints with the right auth + project headers.
//
// **Dynamic tool registration** — at startup the bridge fetches the
// canonical tool list from Mica's `GET /api/tools` discovery endpoint.
// No hardcoded array here. The single source of truth for what tools
// exist is `server/agentTools/registry.ts:AGENT_TOOLS`; adding a tool
// there auto-flows to opencode with no bridge edit. Eliminates the
// drift the prior hardcoded bridge accumulated (10 tools shipped to
// qwen but never added here).
//
// Per-tool input schemas are deliberately permissive (z.object({}).
// passthrough()) at the MCP level. Each tool's canonical zod schema
// lives server-side; Mica's REST endpoint validates the parsed body
// against it and returns a structured 400 on shape mismatch. The
// model still gets full param guidance from the description text,
// which the registry writes generously for exactly this reason.
//
// Project resolution: opencodePlugin.mjs (loaded into opencode-serve
// at startup via config.plugin) stamps the calling session's ID onto
// each mica-builtins tool call's args under `_mica_session_id`. The
// bridge reads that off, removes it, and sends it as the
// `x-mica-opencode-session-id` header. Mica's REST handler maps the
// ID back to a project via a per-session map kept in registry.ts.
// Concurrent sessions route correctly with no global state to race on.
// Falls back to the legacy last-active-project global when the stamp
// is missing (plugin failed to load, non-opencode caller, etc.).

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const MICA_BASE = process.env.MICA_TOOLS_BASE_URL || "http://127.0.0.1:3002";
const AUTH = process.env.MICA_TOOLS_AUTH_SECRET || "";
// Set by opencodeConfig when the spawn's project uses the "Google (Gemini)"
// provider — opts the Gemini media tools into the /api/tools surface.
const INCLUDE_GEMINI_MEDIA = process.env.MICA_INCLUDE_GEMINI_MEDIA === "1";

if (!AUTH) {
  console.error("[opencode-bridge] FATAL: MICA_TOOLS_AUTH_SECRET env var not set");
  process.exit(1);
}

// Fetch the canonical tool list from Mica's discovery endpoint. The
// retry loop tolerates the brief window where opencode spawns its MCP
// children before Mica's REST routes have finished registering — rare
// but observed during cold-start races on slower machines.
async function fetchTools() {
  const maxAttempts = 10;
  let lastErr = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(`${MICA_BASE}/api/tools`, {
        headers: {
          "x-mica-agent-auth": AUTH,
          ...(INCLUDE_GEMINI_MEDIA ? { "x-mica-gemini-media": "1" } : {}),
        },
      });
      if (!res.ok) {
        lastErr = new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      } else {
        const tools = await res.json();
        if (!Array.isArray(tools)) {
          throw new Error(`expected array, got ${typeof tools}`);
        }
        return tools;
      }
    } catch (err) {
      lastErr = err;
    }
    // Linear backoff — 200ms each attempt. Total max wait ~2s before
    // surfacing the failure as a fatal exit.
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`[opencode-bridge] failed to fetch tool list after ${maxAttempts} attempts: ${lastErr?.message || "unknown"}`);
}

const tools = await fetchTools();
console.error(`[opencode-bridge] loaded ${tools.length} tool(s) from ${MICA_BASE}/api/tools`);

const server = new McpServer({ name: "mica-builtins", version: "1.0.0" });

// Build a permissive-typed but name-and-description-rich MCP input
// schema from the registry's param list. The model sees each parameter
// by name + description (so it composes correct calls), but the type
// is z.any() — the canonical per-param type validation happens
// server-side when Mica's REST endpoint parses the body against its
// own zod schema and returns a structured 400 on mismatch.
function buildInputSchema(params) {
  const shape = {};
  if (!Array.isArray(params)) return shape;
  for (const p of params) {
    if (!p || typeof p.name !== "string") continue;
    let s = z.any();
    if (typeof p.description === "string" && p.description) s = s.describe(p.description);
    if (p.optional) s = s.optional();
    shape[p.name] = s;
  }
  return shape;
}

for (const t of tools) {
  if (typeof t?.name !== "string" || typeof t?.restPath !== "string") {
    console.error(`[opencode-bridge] skipping malformed tool entry: ${JSON.stringify(t).slice(0, 100)}`);
    continue;
  }
  server.registerTool(
    t.name,
    {
      description: t.description || "(no description)",
      inputSchema: buildInputSchema(t.params),
    },
    async (args) => {
      // args arrives as the parsed top-level object the model produced,
      // possibly with `_mica_session_id` stamped on by opencodePlugin.mjs
      // (see the project-resolution note at the top of this file).
      const payload = { ...(args ?? {}) };
      const ocSessionId = typeof payload._mica_session_id === "string"
        ? payload._mica_session_id
        : null;
      // Strip the synthetic field before forwarding — Mica's REST handler
      // validates the body against the tool's zod schema, which doesn't
      // know about `_mica_session_id`.
      delete payload._mica_session_id;
      const headers = {
        "Content-Type": "application/json",
        "x-mica-agent-auth": AUTH,
      };
      if (ocSessionId) headers["x-mica-opencode-session-id"] = ocSessionId;
      try {
        const res = await fetch(`${MICA_BASE}${t.restPath}`, {
          method: "POST",
          headers,
          body: JSON.stringify(payload),
        });
        if (!res.ok) {
          const body = await res.text();
          return {
            isError: true,
            content: [{ type: "text", text: `HTTP ${res.status}: ${body.slice(0, 500)}` }],
          };
        }
        const result = await res.json();
        return {
          content: [{ type: "text", text: result.text ?? "(empty)" }],
          ...(result.isError ? { isError: true } : {}),
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: `Bridge fetch failed: ${err.message}` }],
        };
      }
    },
  );
}

const transport = new StdioServerTransport();
await server.connect(transport);
// Stay alive until stdin closes (opencode-serve will SIGTERM us on shutdown).
