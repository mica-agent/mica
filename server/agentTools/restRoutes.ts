// REST endpoints for agent tools. Each tool in registry gets one POST
// route under /api/tools/. Auth is gated by AGENT_TOOL_AUTH_SECRET (set
// per-backend startup; agents include it in headers; cards can't reach it).

import type { Express } from "express";
import { z } from "zod";
import {
  AGENT_TOOLS,
  AGENT_TOOL_AUTH_HEADER,
  AGENT_TOOL_AUTH_SECRET,
  AGENT_TOOL_PROJECT_HEADER,
  AGENT_TOOL_CHAT_FILENAME_HEADER,
  getLastActiveOpencodeProject,
  getOpencodeSessionProject,
  getOpencodeSessionChatFilename,
} from "./registry.js";

const AGENT_TOOL_OPENCODE_SESSION_HEADER = "x-mica-opencode-session-id";

export function registerAgentToolRoutes(app: Express): void {
  // Discovery endpoint — the opencode stdio MCP bridge fetches this at
  // startup to learn the full tool surface and registers each entry
  // dynamically with opencode's MCP SDK. Eliminates the drift that
  // accumulated when the bridge hardcoded its own subset (10 tools
  // shipped to qwen but missing from opencode before this endpoint
  // existed). Auth-gated like the per-tool POST endpoints so card
  // browsers can't enumerate the surface.
  //
  // For each tool we also expose `params: [{name, description, optional}]`
  // — extracted from the zod shape so the bridge can recreate
  // permissive-typed but name+description-rich MCP input schemas. The
  // canonical zod schemas stay server-side; validation happens at
  // tool POST time, not bridge-side.
  app.get("/api/tools", (req, res) => {
    const supplied = req.header(AGENT_TOOL_AUTH_HEADER);
    if (supplied !== AGENT_TOOL_AUTH_SECRET) {
      res.status(401).json({ error: "agent auth required" });
      return;
    }
    res.json(AGENT_TOOLS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      restPath: tool.restPath,
      params: paramShapeOf(tool.inputSchema),
    })));
  });

  for (const tool of AGENT_TOOLS) {
    app.post(tool.restPath, async (req, res) => {
      // Auth — reject any request that doesn't carry the per-startup secret.
      const supplied = req.header(AGENT_TOOL_AUTH_HEADER);
      if (supplied !== AGENT_TOOL_AUTH_SECRET) {
        res.status(401).json({ error: "agent auth required" });
        return;
      }

      // Project context, in priority order:
      //   1. X-Mica-Project header — explicit, used by qwen/Claude SDKs.
      //   2. X-Mica-Opencode-Session-Id header — stamped on by the
      //      opencode bridge from the per-call session ID injected by
      //      opencodePlugin.mjs. Maps back to project via the per-session
      //      map in registry.ts. This is what gives concurrent opencode
      //      sessions correct, race-free routing.
      //   3. Last-active opencode project — legacy fallback for when the
      //      plugin failed to load (or this is somehow a pre-plugin
      //      caller). Single-active-session case still works.
      const headerProject = req.header(AGENT_TOOL_PROJECT_HEADER);
      const headerOcSession = req.header(AGENT_TOOL_OPENCODE_SESSION_HEADER);
      const project: string | null =
        (typeof headerProject === "string" && headerProject.trim()) ? headerProject.trim() :
        getOpencodeSessionProject(typeof headerOcSession === "string" ? headerOcSession.trim() : null) ??
        getLastActiveOpencodeProject();

      // Chat-card filename of the originating agent session, used by
      // session-scoped predicate gates (e.g. spec-approval-gate). Same
      // fallback chain as project resolution above:
      //   1. Explicit x-mica-chat-filename header — qwen/Claude SDK adapters
      //      set this directly (see sdkMcpBuilder.ts).
      //   2. Opencode session-ID-stamping path — the opencode bridge can't
      //      set arbitrary per-call headers, so opencodePlugin.mjs stamps
      //      the calling sessionID onto tool args; the bridge translates it
      //      to x-mica-opencode-session-id; the registry maps that ID to
      //      the originating .opencode card's filename (populated by
      //      opencodeAgent.ts at session-attach time). Without this fallback,
      //      session-scoped gates skip silently for opencode-routed calls.
      const headerChat = req.header(AGENT_TOOL_CHAT_FILENAME_HEADER);
      const chatFilename: string | null =
        (typeof headerChat === "string" && headerChat.trim()) ? headerChat.trim() :
        getOpencodeSessionChatFilename(typeof headerOcSession === "string" ? headerOcSession.trim() : null);

      // Validate input against the tool's zod schema.
      const schema = z.object(tool.inputSchema);
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: "invalid input",
          issues: parsed.error.issues,
        });
        return;
      }

      try {
        const result = await tool.handler(parsed.data, { project, chatFilename });
        res.json(result);
      } catch (err) {
        res.status(500).json({
          isError: true,
          text: `Tool handler threw: ${(err as Error).message}`,
        });
      }
    });
  }
  console.log(`[agent-tools] registered ${AGENT_TOOLS.length} tool route(s): ${AGENT_TOOLS.map((t) => t.restPath).join(", ")}`);
}

/** Extract a serializable parameter summary from a tool's zod input
 *  shape. The bridge uses this to reconstruct MCP input schemas that
 *  carry the model-facing description but accept any value type
 *  (canonical type validation happens at POST time, server-side). */
function paramShapeOf(inputSchema: Record<string, z.ZodTypeAny>): Array<{ name: string; description: string; optional: boolean }> {
  return Object.entries(inputSchema).map(([name, zodType]) => {
    // zod stores describe() text in `_def.description`. The public
    // `.description` getter forwards to it but isn't always typed; the
    // cast covers older zod minor versions that ship _def differently.
    const def = (zodType as { _def?: { description?: string } })._def ?? {};
    const description = typeof def.description === "string" ? def.description : "";
    // ZodOptional / ZodDefault / ZodNullable all report isOptional() === true;
    // we treat any of these as "not required" for MCP-input purposes.
    const optional = typeof zodType.isOptional === "function" ? zodType.isOptional() : false;
    return { name, description, optional };
  });
}
