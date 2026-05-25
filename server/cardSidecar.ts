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
import { randomBytes } from "crypto";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { readFile } from "fs/promises";
import { createConnection } from "net";
import { WORKSPACE_DIR } from "./files.js";

// Per-backend-startup secret. Sidecars include this in the `x-mica-sidecar-auth`
// header on every call to Mica's internal REST APIs (POST /api/llm/chat etc.).
// Generated fresh on each backend restart — no persistence. Sidecars receive
// it via the MICA_SIDECAR_TOKEN env var injected at spawn time. Other local
// processes (a curl from the user, a different daemon) can't reach the API
// without the token.
export const MICA_SIDECAR_TOKEN = randomBytes(32).toString("hex");

// The backend's own HTTP port — sidecars POST to ${MICA_BACKEND_URL}/api/llm/chat.
// Falls back to 3002 (the default backend port; same default as
// sdkMcpBuilder.ts uses for its loopback fetches).
const BACKEND_PORT = parseInt(process.env.MICA_PORT || "3002", 10);
const BACKEND_URL = `http://127.0.0.1:${BACKEND_PORT}`;

// PYTHONPATH / NODE_PATH addition — Mica's `vendor/` directory holds the
// `mica_sidecar` Python package and the `mica-sidecar` TS package. Sidecars
// get this on their PYTHONPATH and NODE_PATH so `import mica_sidecar` /
// `import mica from "mica-sidecar"` work without any per-card-class setup.

const REPO_ROOT = process.env.REPO_ROOT || process.cwd();
// Default Python interpreter. /usr/bin/python3 has the broadest package
// availability in the devcontainer (sentence-transformers, fastapi, numpy,
// PyPDF2, etc. — installed by the user/agent over time). The voice venv at
// scripts/voice/.venv exists too but is scoped to STT/TTS deps;
// a card class that needs voice-venv-specific packages can declare
// `"sidecar": { "python": "voice-venv" }` in metadata.json.
const DEFAULT_PYTHON = "/usr/bin/python3";
const VOICE_VENV_PYTHON = join(REPO_ROOT, "scripts", "voice", ".venv", "bin", "python");

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

// Per-class log ring buffer. Survives the sidecar process lifecycle so the
// agent can fetch the traceback EVEN AFTER the process has exited (the most
// common case after a crashing handler). Capped at LOG_BUFFER_MAX_LINES per
// key; oldest lines drop. Same key shape as `sidecars` so a respawn after
// crash continues appending to the same buffer.
//
// Surfaces via `getCardSidecarLog()` for the `mica_sidecar_log` agent tool.
// The line content is the BARE stdout/stderr line (no `[card-sidecar:<name>]`
// prefix); the prefix is implicit because the caller queries by class name.
const logBuffers = new Map<string, string[]>();
const LOG_BUFFER_MAX_LINES = 500;

function appendLog(k: string, line: string): void {
  let buf = logBuffers.get(k);
  if (!buf) {
    buf = [];
    logBuffers.set(k, buf);
  }
  buf.push(line);
  if (buf.length > LOG_BUFFER_MAX_LINES) {
    buf.splice(0, buf.length - LOG_BUFFER_MAX_LINES);
  }
}

/** Return the last `lines` log lines for the sidecar identified by
 *  (project, className). Includes stdout, stderr, spawn/exit notes, and
 *  restart events. Survives sidecar exit — the buffer holds post-mortem
 *  output that crashing sidecars left behind. */
export function getCardSidecarLog(project: string, className: string, lines = 50): string[] {
  const buf = logBuffers.get(key(project, className));
  if (!buf || buf.length === 0) return [];
  const n = Math.max(1, Math.min(lines, LOG_BUFFER_MAX_LINES));
  return buf.slice(-n);
}

function key(project: string, className: string): string {
  return `${project}::${className}`;
}

/** TCP-probe a port on 127.0.0.1. Resolves true if SOMETHING is listening,
 *  false if the connection refuses (port genuinely free) or the probe
 *  hits any other error. ~200ms cap. Used to dodge races where a recently-
 *  killed sidecar's port hasn't fully released yet, or where a non-mica
 *  process is squatting on a pool port (e.g. orphan from a prior crash
 *  that orphan-reap didn't catch). */
function probePortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = createConnection({ host: "127.0.0.1", port });
    const done = (inUse: boolean): void => {
      try { sock.destroy(); } catch { /* best-effort */ }
      resolve(inUse);
    };
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
    sock.setTimeout(200, () => done(false));
  });
}

/** Pick the next free port in the pool. Two filters:
 *   1. Not in our local `usedPorts` set (cheap, in-process).
 *   2. TCP probe shows nothing listening (catches OS-level races: previous
 *      sidecar SIGTERMed but socket still in TIME_WAIT, or an orphan from
 *      before this backend started).
 *  Async because the probe is async. Caller (ensureCardSidecar) is already
 *  async so no restructure needed. */
async function allocatePort(): Promise<number> {
  for (let p = POOL_START; p <= POOL_END; p++) {
    if (usedPorts.has(p)) continue;
    if (await probePortInUse(p)) {
      console.warn(`[card-sidecar] port :${p} is held by an unknown process — skipping`);
      continue;
    }
    usedPorts.add(p);
    return p;
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

/** Detect whether a Python sidecar is a FastAPI app missing its own
 *  uvicorn bootstrap — the single most-common Tier 4 footgun. The author
 *  defines `app = FastAPI()` and routes but never calls `uvicorn.run(app, ...)`,
 *  so `python3 server.py` imports the module, runs to end-of-file, and exits
 *  cleanly with code=0 leaving Mica's spawn watcher confused.
 *
 *  Detection is conservative: require BOTH a FastAPI app construction AND
 *  the absence of any uvicorn.run call. False positives would over-shim a
 *  sidecar that already starts uvicorn properly; false negatives just keep
 *  the current direct-python behavior.
 *
 *  Returns `{ shim: true, module }` when we should run via uvicorn —
 *  `module` is the import name (entry-file stem) for `<module>:app`. */
function detectFastApiBootstrap(entryPath: string, entry: string): { shim: true; module: string } | { shim: false } {
  if (!entry.toLowerCase().endsWith(".py")) return { shim: false };
  let src: string;
  try {
    src = readFileSync(entryPath, "utf-8");
  } catch {
    return { shim: false };  // can't read → fall back to direct spawn, error surfaces there
  }
  // Look for `app = FastAPI(`. Whitespace-tolerant; covers the canonical
  // template and the common variants (typed: `app: FastAPI = FastAPI()`).
  if (!/^\s*app\s*(?::\s*\w+\s*)?=\s*FastAPI\s*\(/m.test(src)) return { shim: false };
  // If the file calls uvicorn.run anywhere, the author has their own
  // bootstrap (possibly inside `if __name__ == "__main__":`). Don't shim.
  if (/\buvicorn\.run\s*\(/.test(src)) return { shim: false };
  // entry like "server.py" → module "server". Subdirs (rare) survive too:
  // "app/main.py" → "app.main".
  const stem = entry.replace(/\.py$/i, "").replace(/\//g, ".");
  return { shim: true, module: stem };
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
  // Allocate port first — FastAPI auto-bootstrap (below) bakes the port into
  // the args list, and we want one source of truth for the chosen port.
  const port = await allocatePort();
  let command: string;
  let args: string[];
  // FastAPI auto-bootstrap: if entry is a .py FastAPI app with no uvicorn.run
  // of its own, run it via `python -m uvicorn server:app --host 127.0.0.1
  // --port $PORT` so the author's job is just routes + state. Eliminates the
  // most common Tier 4 footgun (FastAPI app defined but never started, sidecar
  // exits cleanly with code=0 and nobody knows why).
  const fastapi = detectFastApiBootstrap(entryPath, meta.entry);
  const usedFastApiShim = fastapi.shim && runtime.command !== "";
  if (usedFastApiShim) {
    command = runtime.command;
    args = [
      "-m", "uvicorn",
      `${(fastapi as { module: string }).module}:app`,
      "--host", "127.0.0.1",
      "--port", String(port),
      "--log-level", "warning",
    ];
  } else if (runtime.command === "") {
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
    freePort(port);  // don't leak the slot on early-throw paths
    throw new Error(`Interpreter not found: ${command} (resolved from entry='${meta.entry}', python='${meta.python}', interpreter='${meta.interpreter ?? ""}')`);
  }

  const label = `card-sidecar:${className}`;
  const env = {
    ...process.env,
    MICA_PORT: String(port),
    MICA_PROJECT: project,
    MICA_PROJECT_DIR: join(WORKSPACE_DIR, project),
    MICA_CARD_CLASS: className,
    MICA_CARD_CLASS_DIR: classDir,
    MICA_WORKSPACE_DIR: WORKSPACE_DIR,
    // Backend loopback URL + sidecar auth token. The mica_sidecar Python /
    // mica-sidecar TS packages use these to call Mica's internal REST APIs
    // (POST /api/llm/chat, etc.). Sidecars never need to know the URL or
    // model name — it lives on the Mica side of the token.
    MICA_BACKEND_URL: BACKEND_URL,
    MICA_SIDECAR_TOKEN,
    // PYTHONUNBUFFERED so [card-sidecar:X] logs appear in real time for
    // Python sidecars. Harmless for Node/tsx.
    PYTHONUNBUFFERED: "1",
    // PYTHONPATH: prepend Mica's vendor/ so `import mica_sidecar` resolves
    // to Mica's bundled client (vendor/mica_sidecar/), AND prepend classDir
    // so `python -m uvicorn server:app` (FastAPI auto-bootstrap path) can
    // import the sidecar entry as a module from any cwd. Direct-python
    // entries don't need classDir on PYTHONPATH (sys.path[0] is the script
    // dir for `python3 server.py`), but having it there too is harmless.
    // Preserves any pre-existing PYTHONPATH from the backend env.
    PYTHONPATH: (() => {
      const parts = [classDir, join(REPO_ROOT, "vendor")];
      if (process.env.PYTHONPATH) parts.push(process.env.PYTHONPATH);
      return parts.join(":");
    })(),
    // NODE_PATH so TypeScript/Node sidecars can `import` Mica's own
    // node_modules (zod, fastify, hono, etc. — anything Mica ships) AND
    // Mica's vendor/ directory (where `mica-sidecar` lives). Cards that
    // want libraries not in Mica's deps would need a project-local
    // node_modules or vendoring; not addressed in this prototype.
    NODE_PATH: `${join(REPO_ROOT, "node_modules")}:${join(REPO_ROOT, "vendor")}`,
  };

  if (usedFastApiShim) {
    const note = `FastAPI auto-bootstrap: ${meta.entry} defines an app but has no uvicorn.run — invoking via 'python -m uvicorn ${(fastapi as { module: string }).module}:app'`;
    console.log(`[${label}] ${note}`);
    appendLog(k, note);
  }
  console.log(`[${label}] spawning on :${port} (${command} ${args.join(" ")})`);
  appendLog(k, `--- spawning on :${port} (${command} ${args.join(" ")}) ---`);
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
      appendLog(k, line);
    }
  });
  proc.stderr?.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString().split("\n").filter(Boolean)) {
      console.log(`[${label}] ${line}`);
      appendLog(k, line);
    }
  });
  proc.on("exit", (code, signal) => {
    console.log(`[${label}] exited (code=${code}, signal=${signal})`);
    appendLog(k, `--- exited (code=${code}, signal=${signal}) ---`);
    handle.ready = false;
    freePort(handle.port);
    sidecars.delete(k);
  });
  proc.on("error", (err) => {
    console.error(`[${label}] spawn error: ${err.message}`);
    appendLog(k, `--- spawn error: ${err.message} ---`);
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

/** Kill the running sidecar for (project, className) so the next call
 *  spawns a fresh process. Returns a structured status describing what
 *  happened — caller surfaces this to the agent.
 *
 *  Why this exists: editing server.py doesn't restart the running sidecar
 *  (Python holds the old bytecode in memory). Agents reach for
 *  `mica_shell pkill -f "card-classes/<X>/server"` to force a respawn, but
 *  that bash subprocess has the pattern in its OWN argv, so pkill matches
 *  itself (and sometimes the agent's CLI process whose argv contains the
 *  user's prompt mentioning the card class name). Server-side SIGTERM via
 *  the tracked PID avoids both failure modes. */
export async function restartCardSidecar(
  project: string,
  className: string,
): Promise<{ status: "killed" | "not_running"; oldPid?: number; port?: number }> {
  const k = key(project, className);
  const h = sidecars.get(k);
  if (!h) {
    return { status: "not_running" };
  }
  const oldPid = h.proc.pid;
  const oldPort = h.port;
  console.log(`[card-sidecar:${className}] restart requested (pid=${oldPid}, port=${oldPort})`);
  try { h.proc.kill("SIGTERM"); } catch { /* best effort */ }
  // Wait up to 5s for the existing exit handler to fire (it deletes from
  // the map and frees the port).
  const softDeadline = Date.now() + 5000;
  while (Date.now() < softDeadline && sidecars.has(k)) {
    await new Promise((r) => setTimeout(r, 100));
  }
  if (sidecars.has(k)) {
    // Process is ignoring SIGTERM — escalate.
    console.log(`[card-sidecar:${className}] SIGTERM ignored after 5s, escalating to SIGKILL`);
    try { h.proc.kill("SIGKILL"); } catch { /* best effort */ }
    const hardDeadline = Date.now() + 2000;
    while (Date.now() < hardDeadline && sidecars.has(k)) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  return { status: "killed", oldPid, port: oldPort };
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

/** SIGTERM every sidecar belonging to `project`, then SIGKILL stragglers
 *  after 5s. Called from the project-delete path so a deleted project
 *  doesn't leave sidecars holding ports + RAM for the rest of the idle
 *  window (up to ~10 min). Same kill ladder as `stopAllCardSidecars`,
 *  scoped to one project. */
export async function stopSidecarsForProject(project: string): Promise<void> {
  const handles = [...sidecars.values()].filter((h) => h.project === project);
  if (handles.length === 0) return;
  for (const h of handles) {
    console.log(`[card-sidecar:${h.className}] project "${project}" deleted — stopping...`);
    try { h.proc.kill("SIGTERM"); } catch { /* best effort */ }
  }
  // Wait up to 5s for graceful exit; the 'exit' handler removes each
  // from the map. Then SIGKILL anything still alive.
  const deadline = Date.now() + 5000;
  while (
    Date.now() < deadline &&
    handles.some((h) => sidecars.has(key(h.project, h.className)))
  ) {
    await new Promise((r) => setTimeout(r, 200));
  }
  for (const h of handles) {
    if (!h.proc.killed) {
      try { h.proc.kill("SIGKILL"); } catch { /* best effort */ }
    }
  }
}
