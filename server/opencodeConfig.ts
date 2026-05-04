// opencodeConfig.ts — translate Mica's subagents + MCP declarations into
// opencode's Config shape. Called once at spawn time; the resulting Config
// is handed to createOpencodeServer({ config }).
//
// Translations:
//   .qwen/agents/*.md (and server/builtin-agents/*.md) → Config.agent map
//   ${TAVILY_API_KEY} from env                         → Config.mcp.tavily (stdio MCP)
//
// What's NOT translated in v1 (documented limitations):
//   - Per-project .qwen/settings.json mcpServers — opencode is one daemon
//     per backend, so per-project MCPs would require either union-of-all-
//     projects-at-spawn or per-session ConfigUpdate. Both have edge cases;
//     v1 ships with workspace-env MCPs only (Tavily). Upgrade path:
//     ConfigUpdate per session via client.config.update().
//   - SDK-embedded MCPs (mica-render, mica-card-class, mica-tools) —
//     these ride inside the qwen/Claude SDK, not as standalone stdio MCP
//     servers, so opencode can't reach them. Upgrade path: stand them up
//     as remote HTTP MCP servers and pass via McpRemoteConfig.

import type { Config, AgentConfig, McpLocalConfig } from "@opencode-ai/sdk";
import { loadProjectSubagents, type ParsedSubagent } from "./subagents.js";

/** Build an opencode Config object from Mica's subagent files + workspace env.
 *  Project parameter is null for v1 (we use workspace-shared subagents only,
 *  not per-project overrides — same set of subagents across all .opencode
 *  cards in any project, until per-session ConfigUpdate lands). */
export async function buildOpencodeConfig(): Promise<Config> {
  const config: Config = {};

  // Permission: yolo for v1 — matches existing chat card trust model.
  // The user has already trusted the Mica project; opencode gating their
  // file edits behind "ask" prompts adds friction without adding safety.
  //
  // external_directory MATTERS: opencode's default ruleset asks before
  // reading/writing outside the session's directory. Mica's chat cards
  // legitimately need to read across the workspace (e.g. .qwen/skills/,
  // templates/, sibling projects). Without this, every cross-project
  // read fires permission.asked, our auto-approve handler ACKs it, but
  // the tool stays "running" while opencode caches the rule per-path —
  // and the next path triggers another ask. Net effect: agent stalls.
  // Granting external_directory: "allow" bypasses the dance entirely.
  // doom_loop similarly defaults to "ask"; same reasoning.
  config.permission = {
    edit: "allow",
    bash: "allow",
    webfetch: "allow",
    external_directory: "allow",
    doom_loop: "allow",
  };

  // opencode's `question` tool stays enabled — server/opencodeAgent.ts
  // bridges its TUI-control request/response flow to Mica's chat-card
  // user_question dialog. See "TUI control bridge" in opencodeAgent.ts.

  // ── Subagents ───────────────────────────────────────────────────
  // Read Mica's subagent .md files (built-in + project overrides if a
  // project context were threaded; v1 uses null = built-ins only) and
  // translate each one into an opencode AgentConfig.
  const parsed: ParsedSubagent[] = await loadProjectSubagents(null, "qwen");
  if (parsed.length > 0) {
    const agentMap: Record<string, AgentConfig> = {};
    for (const a of parsed) agentMap[a.name] = translateSubagent(a);
    config.agent = agentMap;
  }

  // ── MCP servers ─────────────────────────────────────────────────
  const mcp: Record<string, McpLocalConfig> = {};

  // Tavily — same env var used by the qwen/claude paths. Skip silently if
  // the key isn't set so opencode-only users don't get a startup warning.
  if (process.env.TAVILY_API_KEY) {
    mcp.tavily = {
      type: "local",
      command: ["npx", "-y", "tavily-mcp"],
      environment: { TAVILY_API_KEY: process.env.TAVILY_API_KEY },
      enabled: true,
    };
  }

  if (Object.keys(mcp).length > 0) config.mcp = mcp;

  return config;
}

function translateSubagent(a: ParsedSubagent): AgentConfig {
  // Map Mica's subagent shape onto opencode's AgentConfig.
  //   level: "session" → mode: "subagent" (opencode's term for delegated runs)
  //   permissionMode: "yolo" → permission: { edit/bash/webfetch: "allow" }
  //   tools allowlist: convert each Mica tool name to opencode's tool key
  //     and emit { [name]: true }. Anything unknown gets dropped with a
  //     warning; rest stays inherited from session config.
  //   color: passed through verbatim (opencode accepts a hex color)
  //   model: NOT forwarded — Mica's subagent files reference local-model
  //     names (e.g. "qwen3-vl-local") that opencode wouldn't recognize.
  //     Subagents inherit opencode's session model.
  const ac: AgentConfig = {
    description: a.description,
    prompt: a.systemPrompt,
    mode: "subagent",
  };
  // opencode validates color as ^#[0-9a-fA-F]{6}$. Mica's subagents use color
  // names (blue, orange, purple, ...). Translate common names; drop unknowns
  // silently rather than fail the whole Config.
  const colorHex = toHexColor(a.color);
  if (colorHex) ac.color = colorHex;

  if (a.permissionMode === "yolo") {
    ac.permission = { edit: "allow", bash: "allow", webfetch: "allow" };
  }

  if (a.tools && a.tools.length > 0) {
    const toolMap: Record<string, boolean> = {};
    let kept = 0;
    let dropped = 0;
    for (const t of a.tools) {
      const mapped = mapToolName(t);
      if (mapped) {
        toolMap[mapped] = true;
        kept++;
      } else {
        dropped++;
      }
    }
    if (kept > 0) ac.tools = toolMap;
    if (dropped > 0) {
      console.log(`[opencode-config] subagent "${a.name}": kept ${kept} tool(s), dropped ${dropped} unmappable`);
    }
  }

  return ac;
}

function toHexColor(c: string | undefined): string | null {
  if (!c) return null;
  if (/^#[0-9a-fA-F]{6}$/.test(c)) return c;
  const named: Record<string, string> = {
    red: "#ef4444",
    orange: "#f97316",
    yellow: "#eab308",
    green: "#22c55e",
    blue: "#3b82f6",
    indigo: "#6366f1",
    purple: "#8b5cf6",
    pink: "#ec4899",
    cyan: "#06b6d4",
    teal: "#14b8a6",
    gray: "#6b7280",
    grey: "#6b7280",
    white: "#f3f4f6",
    black: "#1f2937",
  };
  return named[c.toLowerCase()] ?? null;
}

/** Map Mica's tool names (Qwen-flavored snake_case + mcp__ prefix style)
 *  onto opencode's tool keys. Returns null for tools that don't have an
 *  opencode equivalent — caller drops them with a warning rather than
 *  silently passing through (which would fail at request time). */
function mapToolName(toolName: string): string | null {
  // MCP-prefixed tools pass through if the MCP server is registered. v1
  // exposes Tavily (mcp__tavily__*); other Mica-internal MCPs are not
  // available in opencode and get dropped here.
  if (toolName.startsWith("mcp__tavily__")) return toolName;
  if (toolName.startsWith("mcp__")) return null;

  // Qwen → opencode primary tool name map. Best-effort: opencode's actual
  // tool registry is provider-driven; the booleans here ride along as
  // hints (true = enabled). Any mismatched name is tolerated by opencode
  // (just becomes a no-op flag), but dropping unknowns keeps the agent
  // config tidy. Names taken from opencode's openapi /tool/ids endpoint
  // and the docs at https://opencode.ai/docs/tools.
  // Map verified against opencode's /experimental/tool/ids (1.14.33):
  //   bash, read, glob, grep, edit, write, webfetch, websearch, todowrite,
  //   task, skill, apply_patch, question, invalid
  // Names not in this list ARE NOT VALID opencode tools and would silently
  // no-op if listed in an agent's tools allowlist — drop them at translation
  // time instead.
  const map: Record<string, string> = {
    read_file: "read",
    read_many_files: "read",
    write_file: "write",
    edit: "edit",
    edit_file: "edit",
    patch_file: "apply_patch",       // qwen patch_file maps to opencode's apply_patch
    glob: "glob",
    grep: "grep",
    run_shell_command: "bash",
    bash: "bash",
    web_search: "websearch",         // opencode has both webfetch + websearch (Exa)
    web_fetch: "webfetch",
    todo_write: "todowrite",
    // No equivalents — drop:
    //   list_directory  (opencode uses bash `ls` or glob)
    //   todo_read       (opencode bundles read+write into todowrite)
  };
  return map[toolName] ?? null;
}
