#!/usr/bin/env node
// opencodeBridge.mjs — stdio MCP server registered as a Local MCP in
// opencode-serve's Config.mcp. opencode spawns this as a child process;
// this script speaks MCP over stdio and forwards tool calls to Mica's
// /api/tools/* REST endpoints with the right auth + project headers.
//
// Tool registry is duplicated here in JS-shape (we can't import
// the TS registry directly from a node script that runs as opencode's
// child). Mica's REST endpoints validate inputs against the canonical
// zod schemas server-side, so any shape drift surfaces as a 400 from
// the server — not silent corruption.
//
// Project resolution: see registry.ts comment. The bridge omits the
// X-Mica-Project header; Mica falls back to the last-active opencode
// session's project (set via setLastActiveOpencodeProject from
// opencodeAgent.ts on each turn start).

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const MICA_BASE = process.env.MICA_TOOLS_BASE_URL || "http://127.0.0.1:3002";
const AUTH = process.env.MICA_TOOLS_AUTH_SECRET || "";

if (!AUTH) {
  console.error("[opencode-bridge] FATAL: MICA_TOOLS_AUTH_SECRET env var not set");
  process.exit(1);
}

// Mirror of server/agentTools/registry.ts AGENT_TOOLS shape — schemas
// declared as zod (matches the MCP SDK's expectations). When a new tool
// is added to the TS registry, add the same name+schema+restPath here.
const TOOLS = [
  {
    name: "render_capture",
    description:
      "Capture a PNG screenshot of a card as it is currently rendered on the " +
      "canvas, then return a TEXT verification report describing what's in the " +
      "image. The server runs the screenshot through llama-server's vision " +
      "encoder (mmproj) directly and returns a 5-15 line description as the " +
      "tool result — layout, colors, visible text, anything that looks broken " +
      "or missing. You receive TEXT, not an image. Use this after building or " +
      "editing a card class to verify it rendered correctly. The browser tab " +
      "must be open to the project's canvas. The filename is the canvas-root- " +
      "relative path of the card instance file (e.g. 'canvas/my-widget.burndown'), " +
      "not the card class directory.",
    inputSchema: {
      filename: z.string().describe("Canvas-root-relative path of the instance file (e.g. 'canvas/my.burndown')"),
    },
    restPath: "/api/tools/render-capture",
  },
];

const server = new McpServer({ name: "mica-builtins", version: "1.0.0" });

for (const t of TOOLS) {
  server.registerTool(
    t.name,
    {
      description: t.description,
      inputSchema: t.inputSchema,
    },
    async (args) => {
      try {
        const res = await fetch(`${MICA_BASE}${t.restPath}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-mica-agent-auth": AUTH,
            // No X-Mica-Project here — bridge is one-per-server, can't
            // know the calling session's project. Mica falls back to
            // last-active opencode project (registry.ts).
          },
          body: JSON.stringify(args),
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
