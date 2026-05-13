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
} from "./registry.js";

export function registerAgentToolRoutes(app: Express): void {
  for (const tool of AGENT_TOOLS) {
    app.post(tool.restPath, async (req, res) => {
      // Auth — reject any request that doesn't carry the per-startup secret.
      const supplied = req.header(AGENT_TOOL_AUTH_HEADER);
      if (supplied !== AGENT_TOOL_AUTH_SECRET) {
        res.status(401).json({ error: "agent auth required" });
        return;
      }

      // Project context — header takes priority. If absent, fall back to
      // the last-active opencode session's project (the bridge can't easily
      // pass session-scoped headers; see registry.ts comment).
      const headerProject = req.header(AGENT_TOOL_PROJECT_HEADER);
      const project: string | null =
        (typeof headerProject === "string" && headerProject.trim()) ? headerProject.trim() :
        getLastActiveOpencodeProject();

      // Chat-card filename of the originating agent session, used by
      // session-scoped predicate gates. Empty string from SDK adapters
      // that don't supply it → null.
      const headerChat = req.header(AGENT_TOOL_CHAT_FILENAME_HEADER);
      const chatFilename: string | null =
        (typeof headerChat === "string" && headerChat.trim()) ? headerChat.trim() : null;

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
