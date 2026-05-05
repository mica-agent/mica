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
//
// Schemas here are intentionally PERMISSIVE — Mica's REST endpoints
// validate inputs against the canonical zod schemas server-side, so any
// shape drift surfaces as a 400 from the server, not silent corruption.
// We declare the bare minimum so opencode shows useful tool descriptions
// to the model.
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
  {
    name: "mica_create_class",
    description:
      "Use this to create a new card class at `.mica/card-classes/<name>/` (writes " +
      "metadata.json + card.html + card.js + card.css). The framework picks the directory, " +
      "validates the metadata schema, and writes a canonical card.js stub when card_js is " +
      "omitted. Idempotent on identical args. Class creation does not go through write_file " +
      "— that path doesn't enforce the schema and produces extension/dirname mismatches that " +
      "silently render as TXT. Required: name (lowercase, dashes only). Optional: badge, " +
      "defaultTitle, extension, card_html, card_js, card_css, scripts (CDN URLs), styles, " +
      "handler, primaryFile.",
    inputSchema: {
      name: z.string().describe("Card class identifier (directory name and default extension)"),
      badge: z.string().optional(),
      defaultTitle: z.string().optional(),
      extension: z.string().optional(),
      card_html: z.string().optional(),
      card_js: z.string().optional(),
      card_css: z.string().optional(),
      scripts: z.array(z.string()).optional(),
      styles: z.array(z.string()).optional(),
      handler: z.string().optional(),
      primaryFile: z.string().optional(),
    },
    restPath: "/api/tools/mica-create-class",
  },
  {
    name: "mica_edit_class_file",
    description:
      "Use this for any edit to `.mica/card-classes/<name>/card.{js,html,css}`. Pre-write " +
      "lint catches CARD_SHIM-global redeclaration (`mica`, `container`), ESM `import`/" +
      "`export`, IIFE wrappers, etc. so failures surface in this same turn. Two edit modes: " +
      "partial (`old_string`+`new_string`) preserves all surrounding code untouched — safer " +
      "default for amending working files; full replace (`content=`) overwrites the whole " +
      "file. Class-file edits don't go through `write_file` or `edit` — those bypass the " +
      "lint and the partial-edit safety, and full-rewrites repeatedly regress working code. " +
      "metadata.json edits go through `mica_create_class`.",
    inputSchema: {
      class: z.string().describe("Card class name (directory name)"),
      file: z.enum(["card.html", "card.js", "card.css"]),
      content: z.string().optional(),
      old_string: z.string().optional(),
      new_string: z.string().optional(),
    },
    restPath: "/api/tools/mica-edit-class-file",
  },
  {
    name: "mica_create_card_instance",
    description:
      "Use this to put a new card instance on the canvas. Writes " +
      "`<canvasRoot>/<filename>.<class_extension>` and verifies the class is registered " +
      "first. Idempotent — calling twice with the same args returns no-op success on the " +
      "second call. Instance creation does not go through `write_file` — that path doesn't " +
      "know the canvas-root location or check class registration, so wrong paths silently " +
      "render as TXT.",
    inputSchema: {
      class_extension: z.string().describe("File extension of the class (with leading dot, e.g. '.world-clock')"),
      filename: z.string().describe("Filename without extension (e.g. 'my-clock')"),
      content: z.string().optional(),
    },
    restPath: "/api/tools/mica-create-card-instance",
  },
  {
    name: "mica_delete_card_instance",
    description: "Delete a card instance file. Accepts canvas-relative or project-relative paths.",
    inputSchema: {
      filename: z.string().describe("Path to the instance file"),
    },
    restPath: "/api/tools/mica-delete-card-instance",
  },
  {
    name: "mica_delete_class",
    description:
      "Delete a card class directory and all its files. Refuses if instance files of " +
      "this class exist on the canvas, unless force=true.",
    inputSchema: {
      name: z.string().describe("Card class name to delete"),
      force: z.boolean().optional().describe("If true, delete even when instances exist"),
    },
    restPath: "/api/tools/mica-delete-class",
  },
  {
    name: "mica_list_classes",
    description:
      "List all card classes available in this project (project-scoped + built-in). " +
      "Returns name, extension, badge, source. Useful before creating a new class to " +
      "check for naming collisions or before creating an instance.",
    inputSchema: {},
    restPath: "/api/tools/mica-list-classes",
  },
  {
    name: "mica_install_skills",
    description:
      "Install a third-party skills package into the current project so future turns can " +
      "invoke its skills via the `skill` tool. Use AFTER discover-library identifies a " +
      "library that has a known skills package (e.g. Three.js → 'threejs-skills'). The " +
      "package is cloned into both .qwen/skills/<name>/ and .claude/skills/<name>/ so all " +
      "agent backends pick it up. Common shorthands: 'threejs-skills', 'three'. " +
      "TWO-TIER TRUST: curated shorthands and previously-approved URLs install instantly. " +
      "For a new URL the agent has discovered (e.g. via web_search), the FIRST call returns " +
      "a 'pending approval' report — show the URL to the user, get explicit OK in chat, then " +
      "retry with approve: true.",
    inputSchema: {
      source: z.string().describe("Shorthand ('threejs-skills'), 'github:owner/repo', or full https:// URL"),
      name: z.string().optional().describe("Override install dir name (default: derived from source)"),
      approve: z.boolean().optional().describe("Set true ONLY after user explicitly approved this URL in chat. First call without approve for new URLs."),
    },
    restPath: "/api/tools/mica-install-skills",
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
