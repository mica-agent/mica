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
import { AGENT_TOOL_AUTH_SECRET } from "./agentTools/registry.js";
import { readPasteKey } from "./connections.js";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

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
    // webfetch stays allowed. We tried denying it (it routes pages through
    // the LLM and costs 4+ min per call on local models), but the SDK
    // translates `curl <URL>` to a virtual webfetch operation for
    // permission checks — denying webfetch also denies every curl,
    // which breaks discover-dependency's smoke-test path. The webfetch
    // deterrent stays in the prelude prose only.
    webfetch: "allow",
    // external_directory stays "allow" — the auto-approve path stalls in
    // opencode 1.15.10 (confirmed empirically: replying `always` to a
    // permission.asked event doesn't unblock the tool). Path scoping is
    // enforced in opencodePlugin.mjs's `tool.execute.before` hook
    // instead, which throws an educational error before opencode's
    // permission system fires. See Step B in
    // .claude/plans/check-logs-for-hotdog-vectorized-bunny.md.
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

  // ── Local LLM as a first-class opencode provider ─────────────────
  // The opencode card's "Local" radio (mirroring the chat card's
  // Local/OpenRouter/OpenAI-compat picker) routes prompts to Mica's
  // own llama-server/vLLM. opencode itself doesn't know about that
  // endpoint, so we declare a custom provider `mica-local` here
  // pointing at LLAMA_URL via the Vercel AI SDK's openai-compatible
  // adapter (which opencode bundles). Models are discovered live
  // from /v1/models so whichever container vLLM started serves is
  // selectable in the card's dropdown — no hardcoded model list to
  // drift against deployment.
  await injectMicaLocalProvider(config);

  // ── OpenRouter live-model extension ──────────────────────────────
  // opencode validates `body.model.modelID` against its internal
  // provider registry (sourced from models.dev) BEFORE forwarding to
  // OpenRouter. That registry drifts behind OpenRouter's actual model
  // catalog — e.g. `google/gemini-3.5-flash` is live on openrouter.ai
  // but absent from opencode 1.15.5's bundled cache, producing a
  // client-side "Model not found" rejection (observed in the
  // gemini-3.6 test project). We fetch OpenRouter's authoritative
  // model list at spawn time and inject every entry into
  // `Config.provider.openrouter.models` so opencode accepts whatever
  // OpenRouter actually exposes — no models.dev refresh required.
  await injectOpenRouterModels(config);

  // ── MCP servers ─────────────────────────────────────────────────
  const mcp: Record<string, McpLocalConfig> = {};

  // Tavily — readPasteKey resolves credentials.json → env var, so Connections-
  // panel-managed keys take precedence over .env. Skip silently if neither is
  // set so opencode-only users don't get a startup warning.
  //
  // MICA_OPENCODE_DISABLE_TAVILY=1 skips registering Tavily for the opencode
  // path even when a key is present. Workspace-wide opt-out for opencode only
  // (qwen/Claude don't go through this config). Off by default. Use case:
  // testing whether a frontier model (e.g. gemini-3.5-flash) actually needs
  // Tavily, or if its training recall + mica_inspect_url + opencode's
  // built-in webfetch suffice. See the discussion + test plan in
  // .claude/plans/check-logs-for-hotdog-vectorized-bunny.md.
  const tavilyKey = (await readPasteKey("tavily"))?.key;
  if (tavilyKey && process.env.MICA_OPENCODE_DISABLE_TAVILY !== "1") {
    mcp.tavily = {
      type: "local",
      command: ["npx", "-y", "tavily-mcp"],
      environment: { TAVILY_API_KEY: tavilyKey },
      enabled: true,
    };
  } else if (tavilyKey) {
    console.log("[opencode-config] MICA_OPENCODE_DISABLE_TAVILY=1 — skipping Tavily MCP for opencode");
  }

  // mica-builtins — unified hub for Mica-internal tools. Same surface as
  // qwen and Claude get via SDK-embedded MCPs; opencode reaches it via a
  // tiny stdio bridge child process that forwards to /api/tools/*.
  // Auth secret is per-backend-startup; passed in env so cards (which
  // can't see process env) cannot reach the tool API. See
  // server/agentTools/registry.ts and opencodeBridge.mjs.
  //
  // Project context: bridge does NOT pass X-Mica-Project header (one
  // bridge serves all sessions; can't tell which session is calling).
  // Mica's REST falls back to the last-active opencode project, set by
  // opencodeAgent.ts on each turn start (setLastActiveOpencodeProject).
  // For typical 1-active-session use this resolves correctly; concurrent
  // multi-session tool calls can race — accepted v1 limitation.
  const bridgePath = join(dirname(fileURLToPath(import.meta.url)), "agentTools", "opencodeBridge.mjs");
  const micaPort = process.env.MICA_PORT || "3002";
  mcp["mica-builtins"] = {
    type: "local",
    command: ["node", bridgePath],
    environment: {
      MICA_TOOLS_AUTH_SECRET: AGENT_TOOL_AUTH_SECRET,
      MICA_TOOLS_BASE_URL: `http://127.0.0.1:${micaPort}`,
    },
    enabled: true,
  };

  if (Object.keys(mcp).length > 0) config.mcp = mcp;

  // Mica's opencode plugin — stamps the calling session's ID onto every
  // mica-builtins tool call's args. The bridge reads it off, sends it as
  // a header, and Mica's REST handler maps the ID back to a project.
  // Without this, two concurrent .opencode sessions racing tool calls
  // would route through a single global "last active project" that one
  // of them just overwrote. See server/agentTools/opencodePlugin.mjs
  // for the full rationale and upstream issue #15117.
  const pluginPath = join(dirname(fileURLToPath(import.meta.url)), "agentTools", "opencodePlugin.mjs");
  config.plugin = [pluginPath];

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
  // Mica-builtins tools (mica_* + render_capture) reach opencode via the
  // stdio MCP bridge under the namespaced id `mica-builtins_<name>`.
  // When a Mica subagent's `.qwen/agents/<name>.md` allowlist names one
  // of these directly, translate it to the namespaced opencode id so
  // the subagent's allowlist actually matches what opencode sees in
  // its tool list. Without this, subagents lose access to mica_inspect_url,
  // mica_list_handlers, mica_pin_shared_doc, etc. — even though the
  // tools are globally registered via the bridge — because the
  // allowlist contract silently drops them.
  if (toolName.startsWith("mica_") || toolName === "render_capture") {
    return `mica-builtins_${toolName}`;
  }
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
    web_search: "websearch",         // opencode has both webfetch + websearch
    web_fetch: "webfetch",
    todo_write: "todowrite",
    // No equivalents — drop:
    //   list_directory  (opencode uses bash `ls` or glob)
    //   todo_read       (opencode bundles read+write into todowrite)
  };
  return map[toolName] ?? null;
}

/** Inject a `mica-local` provider into opencode's Config so the
 *  opencode card's "Local" radio routes to Mica's own LLM endpoint
 *  (vLLM or llama-server, whichever is running on LLAMA_URL). Uses
 *  the @ai-sdk/openai-compatible adapter — opencode bundles a
 *  superset of the Vercel AI SDK providers, so npm declaration here
 *  is enough.
 *
 *  Model discovery: probes /v1/models on the local endpoint and
 *  registers each served id as a model. Best-effort — a probe
 *  timeout / no-response leaves opencode without the local provider
 *  (the card's "Local" radio then falls back to "no override" and
 *  hits opencode's free-tier proxy). Better than hardcoding a model
 *  name that drifts as the user swaps containers. */
async function injectMicaLocalProvider(config: Config): Promise<void> {
  const baseUrlRaw = process.env.LLAMA_URL || "http://127.0.0.1:8012";
  const baseUrl = baseUrlRaw.replace(/\/+$/, "") + "/v1";

  // Probe served models. 1.5s timeout — long enough for the local
  // endpoint to respond, short enough not to delay opencode spawn
  // when the endpoint is down. AbortSignal.timeout is Node 18+ native.
  let modelIds: string[] = [];
  try {
    const res = await fetch(`${baseUrl}/models`, { signal: AbortSignal.timeout(1500) });
    if (res.ok) {
      const data = await res.json() as { data?: Array<{ id?: string }> };
      modelIds = (data.data ?? [])
        .map((m) => m?.id)
        .filter((id): id is string => typeof id === "string" && id.length > 0);
    }
  } catch (err) {
    console.warn(`[opencode-config] mica-local model probe failed (${baseUrl}/models): ${(err as Error).message}`);
  }

  if (modelIds.length === 0) {
    console.warn(`[opencode-config] mica-local: no models discovered at ${baseUrl}/models — skipping provider injection. .opencode cards with provider=Local will fall through to opencode's default.`);
    return;
  }

  // De-duplicate while preserving order (vLLM often serves aliases
  // alongside the canonical id; both deserve a dropdown entry).
  const seen = new Set<string>();
  const unique = modelIds.filter((id) => seen.has(id) ? false : (seen.add(id), true));

  const models: Record<string, { name?: string }> = {};
  for (const id of unique) models[id] = { name: id };

  config.provider = config.provider || {};
  config.provider["mica-local"] = {
    npm: "@ai-sdk/openai-compatible",
    name: "Mica Local",
    options: {
      baseURL: baseUrl,
      apiKey: "none",  // vLLM/llama-server ignore auth; supplying any string satisfies the SDK
    },
    models,
  };
  console.log(`[opencode-config] mica-local provider registered at ${baseUrl} (${unique.length} model(s): ${unique.join(", ")})`);
}

/** Fetch OpenRouter's live model catalog and inject every entry into
 *  `config.provider.openrouter.models`. opencode validates the modelID
 *  against this map before forwarding a prompt; without the injection,
 *  models that postdate opencode's bundled models.dev cache (e.g.
 *  `google/gemini-3.5-flash` against opencode 1.15.5) get rejected
 *  client-side with `Model not found`. The injection overrides that
 *  validation so any model OpenRouter currently exposes becomes
 *  selectable from the .opencode card's gear panel.
 *
 *  Skips entirely when OPENROUTER_API_KEY isn't in env — `injectWorkspaceCredentials`
 *  in opencodeServer.ts populates the env var if the user has stored
 *  an OpenRouter key in workspace credentials, so absence means the
 *  user isn't using OpenRouter and there's no need to pay the fetch
 *  cost.
 *
 *  Failure paths leave opencode's bundled cache as the fallback. Worst
 *  case: spawn proceeds, user picks a model OpenRouter added recently,
 *  opencode rejects — same state as before this injection existed. */
async function injectOpenRouterModels(config: Config): Promise<void> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    // No key plumbed — user isn't routing through OpenRouter. Skip the
    // fetch; opencode's bundled cache is fine for the providers it ships.
    return;
  }

  let entries: Array<{ id?: string; name?: string }> = [];
  try {
    const res = await fetch("https://openrouter.ai/api/v1/models", {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) {
      console.warn(
        `[opencode-config] openrouter model fetch returned HTTP ${res.status} — ` +
          `falling back to opencode's bundled cache.`,
      );
      return;
    }
    const data = await res.json() as { data?: Array<{ id?: string; name?: string }> };
    entries = data.data ?? [];
  } catch (err) {
    console.warn(
      `[opencode-config] openrouter model fetch failed: ${(err as Error).message} — ` +
        `falling back to opencode's bundled cache.`,
    );
    return;
  }

  const models: Record<string, { name?: string }> = {};
  for (const m of entries) {
    if (typeof m.id !== "string" || !m.id) continue;
    // OpenRouter occasionally prefixes deprecated/migrated ids with `~`
    // (e.g. `~google/gemini-flash-latest`). The `~` form isn't a valid
    // identifier for a routed request — strip the prefix so it doesn't
    // surface as a bogus selectable id.
    const id = m.id.replace(/^~+/, "");
    if (!id) continue;
    models[id] = { name: typeof m.name === "string" && m.name ? m.name : id };
  }

  if (Object.keys(models).length === 0) {
    console.warn(`[opencode-config] openrouter live model list was empty after parsing — falling back to opencode's bundled cache.`);
    return;
  }

  config.provider = config.provider || {};
  // Preserve any options opencode's bundled openrouter entry already
  // declares (auth headers, api endpoint, etc.) by merging into the
  // existing entry if one's present. Our override only touches
  // `models` — everything else stays opencode-managed.
  const existing = config.provider.openrouter ?? {};
  config.provider.openrouter = {
    ...existing,
    models: { ...(existing.models ?? {}), ...models },
  };
  console.log(
    `[opencode-config] openrouter provider extended with ${Object.keys(models).length} model(s) from openrouter.ai/api/v1/models`,
  );
}
