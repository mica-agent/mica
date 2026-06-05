// REST endpoints for agent tools. Each tool in registry gets one POST
// route under /api/tools/. Auth is gated by AGENT_TOOL_AUTH_SECRET (set
// per-backend startup; agents include it in headers; cards can't reach it).

import type { Express } from "express";
import { z } from "zod";
import { join } from "node:path";
import {
  AGENT_TOOLS,
  GEMINI_MEDIA_TOOLS,
  AGENT_TOOL_AUTH_HEADER,
  AGENT_TOOL_AUTH_SECRET,
  AGENT_TOOL_PROJECT_HEADER,
  AGENT_TOOL_CHAT_FILENAME_HEADER,
  getLastActiveOpencodeProject,
  getLastActiveOpencodeChatFilename,
  getOpencodeSessionProject,
  getOpencodeSessionChatFilename,
  getOpencodeSessionTenant,
} from "./registry.js";
import { WORKSPACE_DIR, getEffectiveWorkspaceDir, SHARED_DIR, getIncludeProjects } from "../files.js";
import { runWithTenant } from "../tenantContext.js";

const AGENT_TOOL_OPENCODE_SESSION_HEADER = "x-mica-opencode-session-id";

export function registerAgentToolRoutes(app: Express): void {
  // Media tools that aren't already in AGENT_TOOLS (i.e. when GEMINI_API_KEY
  // wasn't set globally at startup). We still register their POST routes so a
  // per-project Gemini config can call them; they're only LISTED in /api/tools
  // when the request opts in (env key, or the opencode bridge's gemini flag).
  const extraMediaTools = GEMINI_MEDIA_TOOLS.filter(
    (m) => !AGENT_TOOLS.some((t) => t.restPath === m.restPath),
  );
  const ALL_ROUTE_TOOLS = [...AGENT_TOOLS, ...extraMediaTools];

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
    // Include the Gemini media tools when this caller has a Gemini key in scope:
    // either the global env key, or the opencode bridge signalling that its
    // spawn's project uses the "Google (Gemini)" provider (x-mica-gemini-media).
    // Without this opt-in they stay hidden (no prelude pollution for non-Gemini
    // agents/projects). The per-call handler still guards via readGeminiKey.
    const wantMedia = !!process.env.GEMINI_API_KEY || req.header("x-mica-gemini-media") === "1";
    const listed = wantMedia ? [...AGENT_TOOLS, ...extraMediaTools] : AGENT_TOOLS;
    res.json(listed.map((tool) => ({
      name: tool.name,
      description: tool.description,
      restPath: tool.restPath,
      params: paramShapeOf(tool.inputSchema),
    })));
  });

  // opencode-session-scope — the path allowlist for a given opencode session.
  // Consumed by server/agentTools/opencodePlugin.mjs's `tool.execute.before`
  // hook to gate path-taking tool calls (read/write/edit/glob/grep/list)
  // BEFORE opencode's own permission system fires. Necessary because
  // opencode 1.15.10's external_directory: "ask" path stalls after our
  // auto-approve — verified empirically in Step A
  // (see .claude/plans/check-logs-for-hotdog-vectorized-bunny.md). Plugin
  // throws an educational error on out-of-scope paths; the agent reads it
  // as a tool failure and self-corrects to in-project paths.
  //
  // Returns: { project, allowlist: string[] } where allowlist is absolute
  // path prefixes the session is allowed to read/write/touch. Empty
  // allowlist when the session ID isn't registered (fail-closed at the
  // boundary of "we don't know what project this session belongs to").
  app.get("/api/tools/opencode-session-scope", (req, res) => {
    const supplied = req.header(AGENT_TOOL_AUTH_HEADER);
    if (supplied !== AGENT_TOOL_AUTH_SECRET) {
      res.status(401).json({ error: "agent auth required" });
      return;
    }
    const sid = req.query.sessionID;
    if (typeof sid !== "string" || !sid.trim()) {
      res.status(400).json({ error: "missing sessionID query param" });
      return;
    }
    const project = getOpencodeSessionProject(sid.trim());
    if (!project) {
      // Unknown session — the plugin should fail-open (don't gate) for
      // resilience, but we tell the truth: no project, no allowlist.
      res.json({ project: null, allowlist: [] });
      return;
    }
    const allowlist: string[] = [
      join(getEffectiveWorkspaceDir(), project),
      join(getEffectiveWorkspaceDir(), ".mica"),
      SHARED_DIR,
      ...getIncludeProjects(),
    ];
    res.json({ project, allowlist });
  });

  for (const tool of ALL_ROUTE_TOOLS) {
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
        getOpencodeSessionChatFilename(typeof headerOcSession === "string" ? headerOcSession.trim() : null) ??
        getLastActiveOpencodeChatFilename();

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

      // Tenant binding (multi-tenant fork). opencode's mica-builtins tool calls
      // reach here as internal HTTP with no user cookie, so the /api auth
      // middleware bound no tenant — recover it and bind it for the handler so
      // getEffectiveWorkspaceDir() scopes file ops to the calling tenant (not the
      // bare root). Primary: the per-session map (via the sessionID stamp).
      // Fallback: x-mica-tenant, which the opencode bridge sends unconditionally
      // (the pool runs one daemon per tenant) — reliable even when the per-call
      // sessionID stamp is absent. No-op in single-tenant main (both empty).
      const headerTenant = req.header("x-mica-tenant");
      const ocTenant =
        getOpencodeSessionTenant(typeof headerOcSession === "string" ? headerOcSession.trim() : null) ||
        (typeof headerTenant === "string" && headerTenant.trim() ? headerTenant.trim() : null);
      const runHandler = () => tool.handler(parsed.data, { project, chatFilename });
      try {
        const result = ocTenant ? await runWithTenant(ocTenant, runHandler) : await runHandler();
        res.json(result);
      } catch (err) {
        res.status(500).json({
          isError: true,
          text: `Tool handler threw: ${(err as Error).message}`,
        });
      }
    });
  }
  console.log(`[agent-tools] registered ${ALL_ROUTE_TOOLS.length} tool route(s): ${ALL_ROUTE_TOOLS.map((t) => t.restPath).join(", ")}`);
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
