// SDK-MCP builder — used by qwen-code SDK and Claude Agent SDK paths.
// Both SDKs export a `createSdkMcpServer({ name, tools })` factory and a
// `tool(name, desc, schema, handler)` helper. We accept those as
// dependencies (the caller injects whichever SDK's helpers they want)
// and produce an MCP server whose tools each fetch the matching REST
// endpoint over loopback HTTP. Single source of truth for tool defs;
// per-SDK plumbing differs only in WHO consumes the resulting server.

import { z } from "zod";
import { AGENT_TOOLS, AGENT_TOOL_AUTH_HEADER, AGENT_TOOL_AUTH_SECRET, AGENT_TOOL_PROJECT_HEADER, AGENT_TOOL_CHAT_FILENAME_HEADER } from "./registry.js";

const MICA_PORT = parseInt(process.env.MICA_PORT || "3002", 10);
const MICA_TOOLS_BASE = `http://127.0.0.1:${MICA_PORT}`;

/* eslint-disable @typescript-eslint/no-explicit-any */
type ToolFn = (
  name: string,
  description: string,
  schema: z.ZodRawShape,
  handler: (args: any) => Promise<any>,
) => any;

type CreateServerFn = (opts: { name: string; version?: string; tools?: any[] }) => any;
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Build an MCP server containing every tool in AGENT_TOOLS. The caller
 *  supplies the SDK-specific `tool()` and `createSdkMcpServer()` helpers
 *  so the resulting server is the right concrete type for that SDK.
 *  The handlers fetch /api/tools/<path> on loopback with the right auth +
 *  project headers — so the actual logic lives in a single place
 *  (renderCapture.ts etc.) regardless of which SDK called.
 *
 *  Pass `sessionProject` so each tool call carries the correct project
 *  context. The session-scope binding is closed over here at server build
 *  time (one instance per turn is cheap; matches the prior pattern from
 *  micaAgent.ts buildRenderMcpServer). */
export function buildAgentToolsMcpServer(opts: {
  toolFn: ToolFn;
  createServerFn: CreateServerFn;
  sessionProject: string | null;
  /** Chat-card filename of the originating session, forwarded as a
   *  header so server-side predicate gates can scope per-chat state
   *  (e.g. "has skill('card-class-handbook') been invoked here?").
   *  Null when the caller can't supply it (e.g. shared opencode bridge). */
  sessionChatFilename?: string | null;
  serverName?: string;  // defaults to "mica-builtins" (the unified hub)
}): unknown {
  const tools = AGENT_TOOLS.map((def) =>
    opts.toolFn(
      def.name,
      def.description,
      def.inputSchema,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async (args: any) => {
        const url = `${MICA_TOOLS_BASE}${def.restPath}`;
        try {
          const res = await fetch(url, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              [AGENT_TOOL_AUTH_HEADER]: AGENT_TOOL_AUTH_SECRET,
              [AGENT_TOOL_PROJECT_HEADER]: opts.sessionProject ?? "",
              [AGENT_TOOL_CHAT_FILENAME_HEADER]: opts.sessionChatFilename ?? "",
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
          const result = (await res.json()) as { text?: string; isError?: boolean };
          return {
            content: [{ type: "text", text: result.text ?? "(empty result)" }],
            ...(result.isError ? { isError: true } : {}),
          };
        } catch (err) {
          return {
            isError: true,
            content: [{ type: "text", text: `Loopback fetch failed: ${(err as Error).message}` }],
          };
        }
      },
    ),
  );
  return opts.createServerFn({
    name: opts.serverName ?? "mica-builtins",
    version: "1.0.0",
    tools,
  });
}
