// opencodeServer.ts — a POOL of `opencode serve` daemons, one per
// (tenant, credential-signature).
//
// Earlier this was a single shared daemon. That couldn't isolate concurrent
// sessions: opencode's `/global/event` stream + per-call sessionID stamping
// cross between sessions running at the same time, so two tenants building
// concurrently bled each other's progress/tool events. A shared daemon also
// can't hold more than one credential set, which forced a churning respawn.
//
// The pool fixes both: each (tenant, creds) gets its OWN daemon — its own port,
// its own event stream, its own XDG_DATA_HOME session store, its own baked-in
// credentials. Different tenants → different daemons → no bleed. Same tenant +
// same creds → shared daemon (correct; same trust + key). A creds change just
// routes to a different pool entry instead of respawning one slot.
//
// Bounded: daemons idle > IDLE_MS are reaped; at most MAX_DAEMONS live at once
// (LRU-evicted beyond that). Single-tenant main → key "" + one signature → a
// single daemon, exactly as before.
//
// Spawns are serialized (spawnChain) because each spawn temporarily sets
// process.env (creds + XDG_DATA_HOME) for the SDK's cross-spawn to capture, then
// restores it — concurrent spawns would race on that shared env.

import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync } from "node:fs";
import { createOpencodeServer, createOpencodeClient, type OpencodeClient, type OpencodeClientConfig } from "@opencode-ai/sdk";
import { buildOpencodeConfig } from "./opencodeConfig.js";
import { readOpenRouterKey, readOpenAICompatConfig } from "./files.js";
import { runWithTenant } from "./tenantContext.js";
import { AGENT_TOOL_AUTH_SECRET } from "./agentTools/registry.js";

interface ServerHandle {
  url: string;
  client: OpencodeClient;
  close(): void;
  /** Pool key (`${tenant}::${credSig}`) this daemon serves. */
  key: string;
  /** Monotonic spawn counter — lets a caller detect that ITS daemon was reaped
   *  and re-spawned (opencodeAgent revalidates its session when this changes). */
  generation: number;
}

interface PoolEntry {
  handle: ServerHandle;
  lastUsedAt: number;
}

const IDLE_MS = 10 * 60 * 1000;   // reap daemons unused for 10 minutes
const MAX_DAEMONS = 6;            // hard ceiling (~366MB RSS each); LRU beyond
const REAP_INTERVAL_MS = 60 * 1000;
const DATA_BASE = process.env.MICA_OPENCODE_DATA_BASE || join(tmpdir(), "mica-opencode-data");

const pool = new Map<string, PoolEntry>();
let spawnChain: Promise<unknown> = Promise.resolve();
let generation = 0;
let reapTimer: ReturnType<typeof setInterval> | null = null;

// Managed env vars: set per-spawn for the SDK's cross-spawn to capture, then
// restored to this module-load baseline so a spawn's tenant key never lingers in
// the main process's env (where readOpenAICompatConfig's env fallback would pick
// it up for a DIFFERENT tenant).
const MANAGED_ENV = ["OPENROUTER_API_KEY", "OPENAI_BASE_URL", "OPENAI_API_KEY", "XDG_DATA_HOME"] as const;
const ENV_BASE: Record<string, string | undefined> = Object.fromEntries(
  MANAGED_ENV.map((k) => [k, process.env[k]]),
);

/** Bind the tenant (if any) for a callback so getEffectiveWorkspaceDir-based
 *  config/credential reads resolve to the right tenant. The pool's spawn runs in
 *  a detached promise chain, so we can't rely on ambient AsyncLocalStorage. */
function runT<T>(tenant: string | undefined, fn: () => Promise<T>): Promise<T> {
  return tenant ? runWithTenant(tenant, fn) : fn();
}

/** Get (or lazily spawn) the opencode daemon for (tenant, project)'s
 *  credentials. Different tenants / credential sets get different daemons. */
export async function getOpencodeServer(tenant?: string, project?: string): Promise<ServerHandle> {
  ensureReapTimer();
  const sig = await runT(tenant, () => credentialSignature(project));
  const key = `${tenant || ""}::${sig}`;

  const hit = pool.get(key);
  if (hit) { hit.lastUsedAt = Date.now(); return hit.handle; }

  // Miss → spawn, serialized (env mutation during spawn must not race).
  const run = spawnChain.then(async () => {
    const again = pool.get(key);
    if (again) { again.lastUsedAt = Date.now(); return again.handle; }
    evictIfAtCap();
    const handle = await runT(tenant, () => doSpawn(tenant, project, key));
    pool.set(key, { handle, lastUsedAt: Date.now() });
    console.log(`[opencode-server] pool size=${pool.size} (spawned ${key})`);
    return handle;
  });
  spawnChain = run.then(() => undefined, () => undefined);
  return run as Promise<ServerHandle>;
}

/** Signature of the credentials a daemon would be built with for `project` —
 *  the OpenRouter key and the OpenAI-compat baseUrl+key (the latter also carries
 *  the one-key Gemini endpoint+key via readOpenAICompatConfig's fallback).
 *  Equal signatures ⇒ the same daemon can serve them. */
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

async function doSpawn(tenant: string | undefined, project: string | undefined, key: string): Promise<ServerHandle> {
  // Per-daemon session store so instances don't share opencode's SQLite. Stable
  // per key (not random) so sessions persist across idle-reap → respawn.
  const dataDir = join(DATA_BASE, createHash("sha1").update(key).digest("hex").slice(0, 16));
  mkdirSync(dataDir, { recursive: true });

  await applySpawnEnv(project, dataDir);
  try {
    const config = await buildOpencodeConfig(project);
    console.log(`[opencode-server] spawning daemon for tenant=${tenant ?? "-"} project=${project ?? "(workspace)"} data=${dataDir} (mcp: ${Object.keys(config.mcp ?? {}).join(", ") || "none"})`);
    const start = Date.now();
    const { url, close } = await createOpencodeServer({
      hostname: "127.0.0.1",
      port: 0,            // auto-assign — each daemon its own port
      timeout: 60_000,    // first spawn into a fresh data dir runs a one-time DB migration
      config,
    });
    const clientConfig: OpencodeClientConfig = { baseUrl: url };
    const client = createOpencodeClient(clientConfig);
    generation += 1;
    const gen = generation;
    console.log(`[opencode-server] ready at ${url} (${Date.now() - start}ms, gen ${gen}, key ${key})`);
    await reportProviderState(client);
    return {
      url,
      client,
      key,
      generation: gen,
      close: () => {
        try { close(); } catch (err) {
          console.warn(`[opencode-server] close() failed: ${(err as Error).message}`);
        }
      },
    };
  } finally {
    restoreSpawnEnv();
  }
}

/** Set the managed env for ONE spawn: the project's resolved credentials (so
 *  opencode auto-discovers the right provider) + this daemon's XDG_DATA_HOME +
 *  the agent-tool callback config. Resets to baseline first so nothing leaks
 *  from the previous spawn. Called under the serialized spawn + bound tenant. */
async function applySpawnEnv(project: string | undefined, dataDir: string): Promise<void> {
  restoreSpawnEnv();
  process.env.XDG_DATA_HOME = dataDir;
  process.env.MICA_TOOLS_AUTH_SECRET = AGENT_TOOL_AUTH_SECRET;
  if (!process.env.MICA_TOOLS_BASE_URL) {
    process.env.MICA_TOOLS_BASE_URL = `http://127.0.0.1:${process.env.MICA_PORT || "3002"}`;
  }
  try {
    const orKey = await readOpenRouterKey(project);
    if (orKey) process.env.OPENROUTER_API_KEY = orKey;
  } catch (err) {
    console.warn(`[opencode-server] OpenRouter key read failed: ${(err as Error).message}`);
  }
  try {
    const oc = await readOpenAICompatConfig(project);
    if (oc.baseUrl) process.env.OPENAI_BASE_URL = oc.baseUrl;
    if (oc.key) process.env.OPENAI_API_KEY = oc.key;
  } catch (err) {
    console.warn(`[opencode-server] OpenAI-compat config read failed: ${(err as Error).message}`);
  }
}

/** Restore managed env vars to the module-load baseline. */
function restoreSpawnEnv(): void {
  for (const k of MANAGED_ENV) {
    const v = ENV_BASE[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

async function reportProviderState(client: OpencodeClient): Promise<void> {
  // Asks opencode which providers can serve a prompt — covers cloud auth and
  // user-configured providers. Zero usable ⇒ prompts would hang; warn loudly.
  try {
    const res = await client.config.providers();
    const providers = res.data?.providers ?? [];
    const usable = providers.filter((p) => p.models && Object.keys(p.models).length > 0);
    if (usable.length === 0) {
      console.warn(
        "[opencode-server] WARNING: no usable provider found. " +
        ".opencode cards will fail on first prompt. Configure a key in the gear, " +
        "or add a provider via `opencode providers login` / opencode.jsonc.",
      );
      return;
    }
    console.log(`[opencode-server] ${usable.length} usable provider(s): ${usable.map((p) => p.id).join(", ")}`);
  } catch (err) {
    console.warn(`[opencode-server] provider check failed: ${(err as Error).message}`);
  }
}

/** Evict the least-recently-used daemon when the pool is at capacity. */
function evictIfAtCap(): void {
  if (pool.size < MAX_DAEMONS) return;
  let lruKey: string | undefined;
  let lruAt = Infinity;
  for (const [k, e] of pool) {
    if (e.lastUsedAt < lruAt) { lruAt = e.lastUsedAt; lruKey = k; }
  }
  if (lruKey) {
    const e = pool.get(lruKey)!;
    console.log(`[opencode-server] pool at cap (${MAX_DAEMONS}) — evicting LRU ${lruKey}`);
    try { e.handle.close(); } catch { /* ignore */ }
    pool.delete(lruKey);
  }
}

/** Close daemons idle longer than IDLE_MS. Their session store persists on disk
 *  (stable XDG_DATA_HOME), so a later turn re-spawns and resumes sessions. */
function reapIdle(): void {
  const now = Date.now();
  for (const [k, e] of pool) {
    if (now - e.lastUsedAt > IDLE_MS) {
      console.log(`[opencode-server] reaping idle daemon ${k} (idle ${Math.round((now - e.lastUsedAt) / 1000)}s)`);
      try { e.handle.close(); } catch { /* ignore */ }
      pool.delete(k);
    }
  }
}

function ensureReapTimer(): void {
  if (reapTimer) return;
  reapTimer = setInterval(reapIdle, REAP_INTERVAL_MS);
  reapTimer.unref?.(); // don't keep the process alive just for reaping
}

/** Shutdown hook for server/index.ts — close every daemon. */
export function stopOpencodeServer(): void {
  if (pool.size === 0 && !reapTimer) return;
  console.log(`[opencode-server] shutting down ${pool.size} daemon(s)`);
  for (const [, e] of pool) {
    try { e.handle.close(); } catch { /* ignore */ }
  }
  pool.clear();
  if (reapTimer) { clearInterval(reapTimer); reapTimer = null; }
}
