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

import { createHash } from "node:crypto";
import { createOpencodeServer, createOpencodeClient, type OpencodeClient, type OpencodeClientConfig } from "@opencode-ai/sdk";
import { buildOpencodeConfig } from "./opencodeConfig.js";
import { readOpenRouterKey, readOpenAICompatConfig } from "./files.js";
import { AGENT_TOOL_AUTH_SECRET } from "./agentTools/registry.js";

interface ServerHandle {
  url: string;
  client: OpencodeClient;
  close(): void;
  /** Credential signature this daemon was spawned with (see credentialSignature). */
  signature: string;
  /** Monotonic spawn counter — lets a caller detect that the daemon re-spawned
   *  under it (opencodeAgent recreates its session when this changes). */
  generation: number;
}

let cached: ServerHandle | null = null;
let opChain: Promise<unknown> = Promise.resolve();
let generation = 0;
let activeProject: string | undefined = undefined;

// Snapshot the credential-related env vars at module load. A per-project
// (re)spawn resets to this baseline before overlaying the project's keys, so a
// previous project's injected key never leaks into the next spawn (and a user's
// explicit .env / shell export remains the fallback when a project sets none).
const ENV_BASE: Record<string, string | undefined> = {
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
  OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
};

/** The agent sets the project whose credentials the daemon should use for the
 *  current turn, BEFORE any getOpencodeServer() call in that turn. Module-global
 *  because opencode is ONE shared daemon (see the concurrency note below). */
export function setOpencodeProject(project?: string): void { activeProject = project; }

/** Get (or lazily spawn) the shared opencode daemon, configured for the
 *  credentials of the project set via setOpencodeProject(). If those credentials
 *  differ from the running daemon's, the daemon is torn down and re-spawned —
 *  this is how a per-project / per-tenant key (e.g. set in the card gear) takes
 *  effect without a manual restart.
 *
 *  CONCURRENCY: opencode is a single shared daemon, so it can hold only ONE
 *  credential set at a time. Sequential / single-active use is correct. Two
 *  tenants running opencode turns with DIFFERENT keys *concurrently* will fight
 *  over respawns — serialized through opChain so they never corrupt each other,
 *  but each turn restarts the daemon and a turn can land on a daemon respawned
 *  by the other. True concurrent multi-tenant opencode is NOT supported; use the
 *  .qwen card (per-turn key resolution) for that. */
export async function getOpencodeServer(): Promise<ServerHandle> {
  const project = activeProject;
  const run = opChain.then(async () => {
    const sig = await credentialSignature(project);
    if (cached && cached.signature === sig) return cached;
    if (cached) {
      console.log(`[opencode-server] credentials changed — respawning daemon (was gen ${generation})`);
      try { cached.close(); } catch { /* ignore */ }
      cached = null;
    }
    cached = await spawn(project, sig);
    return cached;
  });
  // Keep the chain alive regardless of this run's outcome so a failed spawn
  // doesn't wedge every future call.
  opChain = run.then(() => undefined, () => undefined);
  return run as Promise<ServerHandle>;
}

/** Signature of the credentials a daemon would be built with for `project`.
 *  Equal signatures ⇒ the running daemon already has the right keys (no respawn).
 *  Covers the credential sources baked in at spawn: the OpenRouter key and the
 *  OpenAI-compat baseUrl+key (the latter also carries the one-key Gemini
 *  endpoint+key via readOpenAICompatConfig's fallback). */
async function credentialSignature(project?: string): Promise<string> {
  let orKey: string | null = null;
  let oc: { baseUrl: string | null; key: string | null } = { baseUrl: null, key: null };
  try { orKey = await readOpenRouterKey(project); } catch { /* ignore */ }
  try { oc = await readOpenAICompatConfig(project); } catch { /* ignore */ }
  return createHash("sha256")
    .update(JSON.stringify([orKey || "", oc.baseUrl || "", oc.key || ""]))
    .digest("hex")
    .slice(0, 16);
}

async function spawn(project: string | undefined, signature: string): Promise<ServerHandle> {
  // Plumb workspace API credentials into env BEFORE spawning opencode so
  // its subprocess inherits them. opencode auto-discovers cloud providers
  // by env var convention (OPENROUTER_API_KEY → openrouter,
  // OPENAI_API_KEY + OPENAI_BASE_URL → openai), so populating these is
  // the cheapest way to make the chat card's "OpenRouter" and
  // "OpenAI-compatible" radio options actually route through opencode.
  // Project-scope: read the credentials for the project this daemon is being
  // spawned for (set via setOpencodeProject) so a per-project / per-tenant key
  // takes effect. Resets to the env baseline first so a prior project's key
  // doesn't leak. Failure to read leaves the env at baseline (opencode reports
  // "no usable provider" at spawn — reportProviderState() surfaces that loudly).
  await injectProjectCredentials(project);

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
  const config = await buildOpencodeConfig(project);

  console.log(`[opencode-server] spawning opencode serve for project=${project ?? "(workspace)"} (mcp servers: ${Object.keys(config.mcp ?? {}).join(", ") || "none"}, agents: ${Object.keys(config.agent ?? {}).join(", ") || "none"})`);

  const start = Date.now();
  const { url, close } = await createOpencodeServer({
    hostname: "127.0.0.1",
    port: 0,            // auto-assign
    timeout: 30_000,    // 30s ready-wait — first-launch SQLite migration can take a beat
    config,
  });

  const clientConfig: OpencodeClientConfig = { baseUrl: url };
  const client = createOpencodeClient(clientConfig);
  generation += 1;
  const gen = generation;
  console.log(`[opencode-server] ready at ${url} (${Date.now() - start}ms, gen ${gen}, sig ${signature})`);

  // Pre-flight provider check. If opencode has zero usable providers,
  // session.prompt would hang waiting for a model response that never
  // arrives — warn loudly at spawn time so the failure mode shows up in
  // startup logs, not just as a frozen chat UI.
  await reportProviderState(client);

  return {
    url,
    client,
    signature,
    generation: gen,
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

/** Read `project`'s OpenRouter key + OpenAI-compat baseUrl/key from Mica's
 *  persisted config and inject into `process.env` so opencode's subprocess
 *  (inheriting our env) sees the credentials and auto-registers the matching
 *  providers. Resets the managed vars to the module-load baseline first, so a
 *  prior project's injected key doesn't leak and a user's explicit `.env` /
 *  shell export still wins when the project sets no key of its own.
 *  (Gemini is carried in the config object, not env — see injectOpenaiGemini-
 *  Provider — but the one-key fallback in readOpenAICompatConfig also surfaces
 *  the Gemini endpoint+key here for opencode's env-based auto-discovery.) */
async function injectProjectCredentials(project?: string): Promise<void> {
  for (const k of Object.keys(ENV_BASE)) {
    const v = ENV_BASE[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    const orKey = await readOpenRouterKey(project);
    if (orKey) {
      process.env.OPENROUTER_API_KEY = orKey;
      console.log("[opencode-server] injected OPENROUTER_API_KEY from credentials");
    }
  } catch (err) {
    console.warn(`[opencode-server] OpenRouter key read failed: ${(err as Error).message}`);
  }
  try {
    const oc = await readOpenAICompatConfig(project);
    if (oc.baseUrl) {
      process.env.OPENAI_BASE_URL = oc.baseUrl;
      console.log(`[opencode-server] injected OPENAI_BASE_URL=${oc.baseUrl} from credentials`);
    }
    if (oc.key) {
      process.env.OPENAI_API_KEY = oc.key;
      console.log("[opencode-server] injected OPENAI_API_KEY from credentials");
    }
  } catch (err) {
    console.warn(`[opencode-server] OpenAI-compat config read failed: ${(err as Error).message}`);
  }
}

/** Shutdown hook for server/index.ts. No-op if the server was never spawned. */
export function stopOpencodeServer(): void {
  if (!cached) return;
  console.log("[opencode-server] shutting down");
  try { cached.close(); } catch { /* ignore */ }
  cached = null;
}
