// cardSidecar.ts — lifecycle manager for card-class-private HTTP sidecars.
//
// A card class can declare a sidecar in its metadata.json:
//
//   {
//     "sidecar": {
//       "entry": "server.py",         // relative to the card-class dir
//       "ready_path": "/health",
//       "ready_timeout_ms": 30000
//     }
//   }
//
// On the first card.js call to `mica.fetch('mica-internal://card-server/<path>')`,
// we spawn the sidecar (Python, via the voice venv), wait for `/health` to
// return 200, then proxy the request to its localhost port. Subsequent
// requests reuse the same process. Idle for 10 minutes → SIGTERM. On
// backend shutdown → SIGTERM all, then SIGKILL after 5s.
//
// Modeled directly on server/voiceServers.ts: same spawn shape, same wait-
// for-/health loop, same kill ladder. The only structural differences:
//
//   - one sidecar PER card class (not two fixed sidecars total)
//   - lazy spawn on first reference (not eager at backend start)
//   - port allocated from a pool, not hardcoded
//   - sidecars can come and go with idle shutdown

import { spawn, type ChildProcess } from "child_process";
import { existsSync } from "fs";
import { join } from "path";
import { readFile } from "fs/promises";
import { WORKSPACE_DIR } from "./files.js";

const REPO_ROOT = process.env.REPO_ROOT || process.cwd();
// Default Python interpreter. /usr/bin/python3 has the broadest package
// availability in the devcontainer (sentence-transformers, fastapi, numpy,
// PyPDF2, etc. — installed by the user/agent over time). The voice venv at
// scripts/benchmarks/voice/.venv exists too but is scoped to STT/TTS deps;
// a card class that needs voice-venv-specific packages can declare
// `"sidecar": { "python": "voice-venv" }` in metadata.json.
const DEFAULT_PYTHON = "/usr/bin/python3";
const VOICE_VENV_PYTHON = join(REPO_ROOT, "scripts", "benchmarks", "voice", ".venv", "bin", "python");

// TypeScript sidecars run via tsx (no separate build step). We use Mica's
// own tsx — the same one running the backend — so card-class authors get
// the same TS support without per-class node_modules. Card classes that
// `import` external libraries can rely on Mica's node_modules being on
// NODE_PATH (set in the spawn env below): zod, hono, fastify-mini, etc.
// already-shipped Mica deps work out of the box.
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const NODE_BIN = "node";

// Port pool. 100 ports = 100 simultaneous card classes with active
// sidecars. If exhausted, ensureSidecar throws — surface to the agent
// so it can investigate (probably a forgotten unused sidecar).
const POOL_START = 8200;
const POOL_END = 8299;
const usedPorts = new Set<number>();

// Idle window — sidecar gets SIGTERM if no fetch in last IDLE_SHUTDOWN_MS.
// 10 min is generous; the cost of cold-restart is the model load (a few
// seconds), so we err on the side of keeping warm.
const IDLE_SHUTDOWN_MS = 10 * 60 * 1000;
const IDLE_SWEEP_MS = 60 * 1000;

interface SidecarHandle {
  className: string;
  project: string;
  port: number;
  proc: ChildProcess;
  ready: boolean;
  readyPath: string;
  lastActivityAt: number;
  startedAt: number;
  // Promise that resolves when /health is OK. Cached so concurrent first-callers
  // don't all spawn duplicate processes.
  readyPromise: Promise<void>;
}

// Keyed by `<project>::<className>` — same class in different projects gets
// its own process (different chunks, different state). Two card instances
// within ONE project sharing a class share the sidecar.
const sidecars = new Map<string, SidecarHandle>();

function key(project: string, className: string): string {
  return `${project}::${className}`;
}

function allocatePort(): number {
  for (let p = POOL_START; p <= POOL_END; p++) {
    if (!usedPorts.has(p)) {
      usedPorts.add(p);
      return p;
    }
  }
  throw new Error(`Card-sidecar port pool exhausted (${POOL_START}-${POOL_END}). Too many sidecars active.`);
}

function freePort(port: number): void {
  usedPorts.delete(port);
}

interface SidecarMetadata {
  entry: string;
  ready_path: string;
  ready_timeout_ms: number;
  python: string;  // "system" (default) | "voice-venv" | absolute path
  interpreter: string | null;  // explicit override (absolute path); null = auto-detect by extension
}

async function readSidecarMetadata(classDir: string): Promise<SidecarMetadata | null> {
  const metaPath = join(classDir, "metadata.json");
  if (!existsSync(metaPath)) return null;
  try {
    const raw = await readFile(metaPath, "utf-8");
    const obj = JSON.parse(raw) as { sidecar?: Partial<SidecarMetadata> };
    if (!obj.sidecar || typeof obj.sidecar !== "object") return null;
    const s = obj.sidecar;
    return {
      entry: typeof s.entry === "string" ? s.entry : "server.py",
      ready_path: typeof s.ready_path === "string" ? s.ready_path : "/health",
      ready_timeout_ms: typeof s.ready_timeout_ms === "number" ? s.ready_timeout_ms : 30000,
      python: typeof s.python === "string" ? s.python : "system",
      interpreter: typeof s.interpreter === "string" ? s.interpreter : null,
    };
  } catch {
    return null;
  }
}

function resolvePython(spec: string): string {
  if (spec === "system") return DEFAULT_PYTHON;
  if (spec === "voice-venv") return VOICE_VENV_PYTHON;
  return spec; // assume absolute path
}

/** Pick the interpreter for the sidecar based on the entry file's extension,
 *  with an explicit override path if metadata.json supplies one.
 *
 *  Supported extensions:
 *    .py            → Python (chosen via meta.python: system | voice-venv | path)
 *    .ts / .tsx     → tsx (Mica's TypeScript runner — same one running the backend)
 *    .mjs / .cjs    → node
 *    .js            → node
 *
 *  Anything else → treat the entry file as directly executable (`#!/usr/bin/env ...`
 *  shebang assumed); spawn it without an interpreter wrapper.
 *
 *  Returns { command, args } — `args` is the leading arg list before the entry
 *  path. We append the entry path in the spawn site so this function stays
 *  pure-decisions. */
function resolveRuntime(entry: string, meta: SidecarMetadata): { command: string; preArgs: string[] } {
  if (meta.interpreter) {
    // Explicit absolute-path override wins. Author knows what they want.
    return { command: meta.interpreter, preArgs: [] };
  }
  const ext = entry.slice(entry.lastIndexOf(".")).toLowerCase();
  switch (ext) {
    case ".py":
      return { command: resolvePython(meta.python), preArgs: [] };
    case ".ts":
    case ".tsx":
      return { command: TSX_BIN, preArgs: [] };
    case ".mjs":
    case ".cjs":
    case ".js":
      return { command: NODE_BIN, preArgs: [] };
    default:
      // Direct execution — entry has its own shebang line.
      return { command: "", preArgs: [] };
  }
}

/** Ensure a sidecar is running for (project, className). Spawns lazily on
 *  first call; returns the cached port immediately on subsequent calls.
 *  Throws if the card class has no sidecar declared, the entry script is
 *  missing, or the sidecar doesn't reach /health within the timeout. */
export async function ensureCardSidecar(
  project: string,
  className: string,
  classDir: string,
): Promise<{ port: number }> {
  const k = key(project, className);
  const existing = sidecars.get(k);
  if (existing) {
    if (existing.ready) {
      existing.lastActivityAt = Date.now();
      return { port: existing.port };
    }
    // Spawn in flight; wait for it.
    await existing.readyPromise;
    existing.lastActivityAt = Date.now();
    return { port: existing.port };
  }

  const meta = await readSidecarMetadata(classDir);
  if (!meta) {
    throw new Error(`Card class '${className}' has no sidecar declaration in metadata.json`);
  }
  const entryPath = join(classDir, meta.entry);
  if (!existsSync(entryPath)) {
    throw new Error(`Sidecar entry script missing: ${entryPath}`);
  }

  // Select interpreter from entry file extension (or explicit override).
  const runtime = resolveRuntime(meta.entry, meta);
  let command: string;
  let args: string[];
  if (runtime.command === "") {
    // Direct-execution shebang path: spawn the entry script as the program.
    command = entryPath;
    args = [];
  } else {
    command = runtime.command;
    args = [...runtime.preArgs, entryPath];
  }
  // Verify the interpreter exists (for absolute paths). System binaries like
  // `node` resolve via PATH and don't have a meaningful `existsSync` check.
  if (command.startsWith("/") && !existsSync(command)) {
    throw new Error(`Interpreter not found: ${command} (resolved from entry='${meta.entry}', python='${meta.python}', interpreter='${meta.interpreter ?? ""}')`);
  }

  const port = allocatePort();
  const label = `card-sidecar:${className}`;
  const env = {
    ...process.env,
    MICA_PORT: String(port),
    MICA_PROJECT: project,
    MICA_PROJECT_DIR: join(WORKSPACE_DIR, project),
    MICA_CARD_CLASS: className,
    MICA_CARD_CLASS_DIR: classDir,
    MICA_WORKSPACE_DIR: WORKSPACE_DIR,
    // PYTHONUNBUFFERED so [card-sidecar:X] logs appear in real time for
    // Python sidecars. Harmless for Node/tsx.
    PYTHONUNBUFFERED: "1",
    // NODE_PATH so TypeScript/Node sidecars can `import` Mica's own
    // node_modules (zod, fastify, hono, etc. — anything Mica ships). Cards
    // that want libraries not in Mica's deps would need a project-local
    // node_modules or vendoring; not addressed in this prototype.
    NODE_PATH: join(REPO_ROOT, "node_modules"),
  };

  console.log(`[${label}] spawning on :${port} (${command} ${args.join(" ")})`);
  const proc = spawn(command, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env,
  });

  const handle: SidecarHandle = {
    className,
    project,
    port,
    proc,
    ready: false,
    readyPath: meta.ready_path,
    lastActivityAt: Date.now(),
    startedAt: Date.now(),
    readyPromise: Promise.resolve(),
  };

  proc.stdout?.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString().split("\n").filter(Boolean)) {
      console.log(`[${label}] ${line}`);
    }
  });
  proc.stderr?.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString().split("\n").filter(Boolean)) {
      console.log(`[${label}] ${line}`);
    }
  });
  proc.on("exit", (code, signal) => {
    console.log(`[${label}] exited (code=${code}, signal=${signal})`);
    handle.ready = false;
    freePort(handle.port);
    sidecars.delete(k);
  });
  proc.on("error", (err) => {
    console.error(`[${label}] spawn error: ${err.message}`);
    handle.ready = false;
    freePort(handle.port);
    sidecars.delete(k);
  });

  handle.readyPromise = waitForReady(handle, meta.ready_timeout_ms).then(() => {
    handle.ready = true;
    console.log(`[${label}] ready (${Date.now() - handle.startedAt}ms to /${meta.ready_path.replace(/^\//, "")})`);
  });

  sidecars.set(k, handle);

  await handle.readyPromise;
  handle.lastActivityAt = Date.now();
  return { port };
}

async function waitForReady(handle: SidecarHandle, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!handle.proc || handle.proc.killed) {
      throw new Error(`card-sidecar:${handle.className} died before ready`);
    }
    try {
      const res = await fetch(`http://127.0.0.1:${handle.port}${handle.readyPath}`);
      if (res.ok) return;
    } catch { /* not ready yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  // Timeout — try to kill the half-spawned process so we don't leak.
  try { handle.proc.kill("SIGTERM"); } catch { /* best-effort */ }
  throw new Error(`card-sidecar:${handle.className} did not reach ${handle.readyPath} within ${timeoutMs / 1000}s`);
}

/** Returns the running sidecar handle for (project, className) if any, or
 *  null. Caller should NOT spawn — use ensureCardSidecar for that. */
export function getCardSidecarPort(project: string, className: string): number | null {
  const h = sidecars.get(key(project, className));
  return h && h.ready ? h.port : null;
}

/** Touch the activity timestamp — caller invokes after a successful proxy. */
export function touchCardSidecar(project: string, className: string): void {
  const h = sidecars.get(key(project, className));
  if (h) h.lastActivityAt = Date.now();
}

// Idle sweep — runs every IDLE_SWEEP_MS. SIGTERMs sidecars whose last
// activity was more than IDLE_SHUTDOWN_MS ago. The 'exit' handler does
// the bookkeeping (port free, map delete).
const idleSweep = setInterval(() => {
  const now = Date.now();
  for (const [k, h] of sidecars) {
    if (now - h.lastActivityAt > IDLE_SHUTDOWN_MS) {
      console.log(`[card-sidecar:${h.className}] idle ${Math.round((now - h.lastActivityAt) / 1000)}s — shutting down`);
      try { h.proc.kill("SIGTERM"); } catch { /* best effort */ }
      // The exit handler removes from the map; we don't pre-delete.
      void k;
    }
  }
}, IDLE_SWEEP_MS);
// Don't keep Node alive just because of this timer.
idleSweep.unref();

/** Scan the port pool for orphan sidecars left over from a previous backend
 *  that died abruptly (e.g. SIGKILL, crash, the agent's `pkill tsx` pattern).
 *  Detected by: port in pool is held + responds to /health. Kill the holder.
 *
 *  Called once at backend startup from index.ts. Best-effort; logs each
 *  finding. Free ports are silently skipped.
 *
 *  Why not write PIDs to a file and check on startup: the lsof+health pattern
 *  has zero state to maintain and detects orphans regardless of how the
 *  previous backend died (including pre-existing orphans from before this
 *  cleanup mechanism shipped). The PID file pattern misses cases where the
 *  PID file itself didn't get cleaned. */
export async function reapOrphanCardSidecars(): Promise<void> {
  const { exec } = await import("child_process");
  const { promisify } = await import("util");
  const execAsync = promisify(exec);

  // For each port in pool, check if it's held and respond to /health. The
  // /health probe filters out non-Mica services that happen to occupy a
  // port in our range; only sidecars we'd recognize get killed.
  let reaped = 0;
  for (let port = POOL_START; port <= POOL_END; port++) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 500);
      const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: ctrl.signal }).catch(() => null);
      clearTimeout(t);
      if (!res || !res.ok) continue;

      // Port is held by a /health-responsive process. Find its PID via lsof
      // and confirm it's a python script under a card-class dir (don't kill
      // unrelated services that happen to land in our pool).
      const { stdout } = await execAsync(`lsof -iTCP:${port} -sTCP:LISTEN -P -t 2>/dev/null || true`).catch(() => ({ stdout: "" }));
      const pid = parseInt(stdout.trim().split("\n")[0] || "0", 10);
      if (!pid) continue;

      const { stdout: cmdline } = await execAsync(`cat /proc/${pid}/cmdline 2>/dev/null | tr '\\0' ' ' || true`).catch(() => ({ stdout: "" }));
      const cmd = cmdline.toString();
      // Match our own spawn shape: python interpreter + card-classes/...server.py
      if (!/card-classes\/.*server\.py/.test(cmd)) continue;

      console.log(`[card-sidecar:orphan-reap] killing orphan on :${port} pid=${pid} (${cmd.slice(0, 120).trim()})`);
      process.kill(pid, "SIGTERM");
      reaped++;
      // Brief wait so the next backend start sees a free port even if the
      // process is slow to release it.
      await new Promise((r) => setTimeout(r, 200));
    } catch { /* skip this port, continue scan */ }
  }
  if (reaped > 0) {
    console.log(`[card-sidecar:orphan-reap] reaped ${reaped} orphan sidecar(s)`);
  }
}

/** SIGTERM all sidecars, then SIGKILL after 5s. Called from server shutdown. */
export async function stopAllCardSidecars(): Promise<void> {
  const handles = [...sidecars.values()];
  for (const h of handles) {
    console.log(`[card-sidecar:${h.className}] stopping...`);
    try { h.proc.kill("SIGTERM"); } catch { /* best effort */ }
  }
  // Wait up to 5s for graceful exit, then SIGKILL stragglers.
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && sidecars.size > 0) {
    await new Promise((r) => setTimeout(r, 200));
  }
  for (const h of handles) {
    if (!h.proc.killed) {
      try { h.proc.kill("SIGKILL"); } catch { /* best effort */ }
    }
  }
}
