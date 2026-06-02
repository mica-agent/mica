// opencodeServer.ts — module-level singleton wrapping a single `opencode serve`
// subprocess for the lifetime of this backend.
//
// One server, many .opencode chat cards across many projects. The server
// itself is project-agnostic; the per-card directory is supplied at session-
// create time (via `query.directory`) so each card's session sees the right
// cwd. This matches opencode's HTTP-server design — the daemon is a
// long-lived endpoint, sessions are the unit of project scope.
//
// Lazy: not spawned until the first .opencode card mounts in this backend's
// lifetime. If the user never opens an .opencode card, no opencode subprocess
// runs.
//
// Lifecycle: spawned via the SDK's createOpencodeServer() helper. The SDK
// handles the cross-spawn + URL parsing + ready-wait for us. Shutdown happens
// via the global reapChildProcesses() in server/index.ts (the opencode subproc
// is a child of this backend, so the existing pgrep-based reaper kills it on
// graceful exit). server.close() from the SDK is also called at shutdown for
// a more graceful path.

import { createOpencodeServer, createOpencodeClient, type OpencodeClient, type OpencodeClientConfig } from "@opencode-ai/sdk";
import { buildOpencodeConfig } from "./opencodeConfig.js";
import { readOpenRouterKey, readOpenAICompatConfig } from "./files.js";
import { AGENT_TOOL_AUTH_SECRET } from "./agentTools/registry.js";

interface ServerHandle {
  url: string;
  client: OpencodeClient;
  close(): void;
}

let cached: ServerHandle | null = null;
let inflight: Promise<ServerHandle> | null = null;

export async function getOpencodeServer(): Promise<ServerHandle> {
  if (cached) return cached;
  if (inflight) return inflight;
  inflight = spawn().finally(() => { inflight = null; });
  cached = await inflight;
  return cached;
}

async function spawn(): Promise<ServerHandle> {
  // Plumb workspace API credentials into env BEFORE spawning opencode so
  // its subprocess inherits them. opencode auto-discovers cloud providers
  // by env var convention (OPENROUTER_API_KEY → openrouter,
  // OPENAI_API_KEY + OPENAI_BASE_URL → openai), so populating these is
  // the cheapest way to make the chat card's "OpenRouter" and
  // "OpenAI-compatible" radio options actually route through opencode.
  // Workspace-scope here (project=undefined) because opencode is one
  // daemon per backend, not per-project — the credentials are shared
  // across every .opencode card in the workspace. Failure to read leaves
  // the env unset (opencode reports "no usable provider" at spawn — the
  // existing reportProviderState() surfaces that loudly).
  await injectWorkspaceCredentials();

  // Plumb the agent-tool auth + base URL into process.env BEFORE the
  // opencode-serve child inherits it. opencodePlugin.mjs (loaded inside
  // opencode-serve via config.plugin) reads these to call back into Mica
  // for per-session path-scope lookups. Same env-var names as the MCP
  // bridge uses so the plugin and bridge share one config surface.
  // Idempotent — overwriting on re-spawn is fine (the secret is stable
  // per Mica startup).
  process.env.MICA_TOOLS_AUTH_SECRET = AGENT_TOOL_AUTH_SECRET;
  if (!process.env.MICA_TOOLS_BASE_URL) {
    process.env.MICA_TOOLS_BASE_URL = `http://127.0.0.1:${process.env.MICA_PORT || "3002"}`;
  }

  // Build config at spawn time. Subagents from server/builtin-agents/ + any
  // workspace-level MCPs from env (Tavily). Per-project MCPs are NOT merged
  // here — opencode is one daemon per backend, so all projects share the
  // same MCP set. v1 limitation; upgrade path is a per-session
  // ConfigUpdate call once we need it.
  const config = await buildOpencodeConfig();

  console.log(`[opencode-server] spawning opencode serve (mcp servers: ${Object.keys(config.mcp ?? {}).join(", ") || "none"}, agents: ${Object.keys(config.agent ?? {}).join(", ") || "none"})`);

  const start = Date.now();
  const { url, close } = await createOpencodeServer({
    hostname: "127.0.0.1",
    port: 0,            // auto-assign
    timeout: 30_000,    // 30s ready-wait — first-launch SQLite migration can take a beat
    config,
  });

  const clientConfig: OpencodeClientConfig = { baseUrl: url };
  const client = createOpencodeClient(clientConfig);
  console.log(`[opencode-server] ready at ${url} (${Date.now() - start}ms)`);

  // Pre-flight provider check. If opencode has zero usable providers,
  // session.prompt would hang waiting for a model response that never
  // arrives — warn loudly at spawn time so the failure mode shows up in
  // startup logs, not just as a frozen chat UI.
  await reportProviderState(client);

  return {
    url,
    client,
    close: () => {
      try { close(); } catch (err) {
        console.warn(`[opencode-server] close() failed: ${(err as Error).message}`);
      }
    },
  };
}

async function reportProviderState(client: OpencodeClient): Promise<void> {
  // Asks opencode which providers can serve a prompt — covers both
  // cloud auth (auth.json) AND user-configured providers in opencode.jsonc
  // (llama-server, ollama-cloud, custom OpenAI-compatible endpoints).
  try {
    const res = await client.config.providers();
    const providers = res.data?.providers ?? [];
    const usable = providers.filter((p) => p.models && Object.keys(p.models).length > 0);
    if (usable.length === 0) {
      console.warn(
        "[opencode-server] WARNING: no usable provider found. " +
        ".opencode chat cards will fail on first prompt. " +
        "Run `opencode providers login` for cloud auth, or add a local provider to ~/.config/opencode/opencode.jsonc.",
      );
      return;
    }
    const names = usable.map((p) => p.id).join(", ");
    console.log(`[opencode-server] ${usable.length} usable provider(s): ${names}`);
  } catch (err) {
    console.warn(`[opencode-server] provider check failed: ${(err as Error).message}`);
  }
}

/** Read workspace-level OpenRouter key + OpenAI-compat baseUrl/key from
 *  Mica's persisted config and inject into `process.env` so opencode's
 *  subprocess (inheriting our env) sees the credentials and auto-registers
 *  the matching providers. Skips any env var that's already set so a
 *  user's explicit `.env` / shell export wins. */
async function injectWorkspaceCredentials(): Promise<void> {
  try {
    const orKey = await readOpenRouterKey(undefined);
    if (orKey && !process.env.OPENROUTER_API_KEY) {
      process.env.OPENROUTER_API_KEY = orKey;
      console.log("[opencode-server] injected OPENROUTER_API_KEY from workspace credentials");
    }
  } catch (err) {
    console.warn(`[opencode-server] OpenRouter key read failed: ${(err as Error).message}`);
  }
  try {
    const oc = await readOpenAICompatConfig(undefined);
    if (oc.baseUrl && !process.env.OPENAI_BASE_URL) {
      process.env.OPENAI_BASE_URL = oc.baseUrl;
      console.log(`[opencode-server] injected OPENAI_BASE_URL=${oc.baseUrl} from workspace credentials`);
    }
    if (oc.key && !process.env.OPENAI_API_KEY) {
      process.env.OPENAI_API_KEY = oc.key;
      console.log("[opencode-server] injected OPENAI_API_KEY from workspace credentials");
    }
  } catch (err) {
    console.warn(`[opencode-server] OpenAI-compat config read failed: ${(err as Error).message}`);
  }
  // Note: the one-key Gemini fallback lives in readOpenAICompatConfig (files.ts)
  // so the openai-compat read above already yields the Gemini endpoint+key when
  // appropriate — no separate injection needed here.
}

/** Shutdown hook for server/index.ts. No-op if the server was never spawned. */
export function stopOpencodeServer(): void {
  if (!cached) return;
  console.log("[opencode-server] shutting down");
  try { cached.close(); } catch { /* ignore */ }
  cached = null;
}
