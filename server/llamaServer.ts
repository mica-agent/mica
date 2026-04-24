// LlamaServer — singleton lifecycle manager for llama.cpp's llama-server.
// Starts on first request, stays running until Mica shuts down.
// Exposes an OpenAI-compatible API at http://127.0.0.1:{port}/v1/chat/completions.
//
// Used for the primary chat/coding model (Qwen3-Coder-Next GGUF).
// vLLM is used separately for the VLM model (Gemma 4) — see scripts/start-vlm.sh.

import { spawn, type ChildProcess } from "child_process";

const DEFAULT_PORT = 8012;
// HuggingFace repo + file. Default = Qwen3.6-35B-A3B (April 2026 release).
// Hybrid Linear+Gated Attention MoE: 35B total / 3B active. Strong code +
// agentic abilities (73.4% SWE-Bench). Override via LLAMA_HF_REPO + LLAMA_HF_FILE
// to A/B against Qwen3-Coder-Next ("unsloth/Qwen3-Coder-Next-GGUF" /
// "Qwen3-Coder-Next-UD-Q4_K_XL.gguf").
const HF_REPO = process.env.LLAMA_HF_REPO || "unsloth/Qwen3.6-35B-A3B-GGUF";
const HF_FILE = process.env.LLAMA_HF_FILE || "Qwen3.6-35B-A3B-UD-Q6_K_XL.gguf";
const MODEL_PATH = process.env.MODEL_PATH || "";
// Per-slot context size. llama.cpp divides `--ctx-size` across slots, so to
// give EACH slot this many tokens we pass -np × CTX_SIZE_PER_SLOT below.
// Override with LLAMA_CTX_SIZE for tighter budgets.
const CTX_SIZE_PER_SLOT = process.env.LLAMA_CTX_SIZE || "65536";
// Default 3 parallel slots so the chat agent can fan out subagent tasks on
// the local llama-server without queueing. KV-cache cost for Qwen3.6's
// hybrid Linear+Gated Delta Net architecture is small (~100-500 MiB/slot),
// cheap on DGX Spark. Override via LLAMA_N_PARALLEL for tighter GPU budgets.
const N_PARALLEL = process.env.LLAMA_N_PARALLEL || "3";
// Total context across all slots. llama-server's --ctx-size is shared.
const CTX_SIZE_TOTAL = String(parseInt(CTX_SIZE_PER_SLOT, 10) * parseInt(N_PARALLEL, 10));

let serverProcess: ChildProcess | null = null;
let serverPort: number = DEFAULT_PORT;
let serverReady = false;
let startingPromise: Promise<string> | null = null;
let loadProgress = "starting";
let lastStartupSummary = "";
let loadedModel = "";

export async function ensureLlamaServer(): Promise<string> {
  if (serverReady && serverProcess && !serverProcess.killed) {
    return `http://127.0.0.1:${serverPort}`;
  }
  if (startingPromise) return startingPromise;
  startingPromise = startServer();
  try {
    return await startingPromise;
  } finally {
    startingPromise = null;
  }
}

export async function stopLlamaServer(): Promise<void> {
  if (!serverProcess) return;
  console.log("[llama-server] Stopping...");
  serverProcess.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      serverProcess?.kill("SIGKILL");
      resolve();
    }, 10000);
    serverProcess?.on("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
  serverProcess = null;
  serverReady = false;
  console.log("[llama-server] Stopped.");
}

export function getLlamaServerStatus(): { running: boolean; ready: boolean; pid?: number; port?: number; progress?: string; startupSummary?: string; model?: string } {
  const isAlive = !!(serverProcess && !serverProcess.killed);
  if (serverReady && isAlive) {
    return { running: true, ready: true, pid: serverProcess?.pid, port: serverPort, startupSummary: lastStartupSummary, model: loadedModel };
  }
  if (isAlive) {
    return { running: true, ready: false, pid: serverProcess?.pid, port: serverPort, progress: loadProgress };
  }
  return { running: false, ready: false, progress: loadProgress };
}

// ── Internal ─────────────────────────────────────────────

async function startServer(): Promise<string> {
  const port = DEFAULT_PORT;
  serverPort = port;

  // Resolve model path: explicit MODEL_PATH wins, otherwise look in HF cache,
  // otherwise pass HF args so llama-server downloads on demand.
  const cachedPath = await findHfCachedFile(HF_REPO, HF_FILE);
  const useCachedPath = MODEL_PATH || cachedPath;

  const modelArgs = useCachedPath
    ? ["--model", useCachedPath]
    : ["-hfr", HF_REPO, "-hff", HF_FILE];

  // Per-request log file. llama-server emits prompt tokens, prefill time, decode
  // time, and tokens-generated per request — useful for correlating against
  // Mica's per-turn metrics (see server/metrics.ts). Workspace-scoped since
  // llama-server is a singleton across projects. Override via LLAMA_LOG_FILE.
  const WORKSPACE_ROOT = process.env.PROJECT_DIR || `${process.env.HOME}/mica-workspace`;
  const llamaLogFile = process.env.LLAMA_LOG_FILE || `${WORKSPACE_ROOT}/.mica-llama-server.log`;

  // Host-memory prompt cache (llama.cpp PR #16391, merged Oct 2025). Catches
  // evicted slot KV so the next matching request restores it from host RAM
  // instead of re-prefilling. Directly targets our subagent fan-out pattern
  // where shared canvas-baseline prefixes otherwise re-prefill on every slot
  // reassignment. Default 16384 MiB — generous on Spark's 128 GB unified
  // memory, and the GPU↔host restore is NVLink-C2C speed (near-free).
  // Override via LLAMA_CACHE_RAM (MiB); set to "0" to disable, "-1" for unlimited.
  const CACHE_RAM = process.env.LLAMA_CACHE_RAM || "16384";

  const args = [
    ...modelArgs,
    "--host", "0.0.0.0",
    "--port", String(port),
    "--n-gpu-layers", "999",
    "--jinja",
    "--flash-attn", "on",
    "--ctx-size", CTX_SIZE_TOTAL,
    "-np", N_PARALLEL,
    "--cache-ram", CACHE_RAM,
    "--log-file", llamaLogFile,
    "--reasoning-format", "deepseek",
    // Default thinking OFF for ALL requests, regardless of caller.
    // Per-request override possible via chat_template_kwargs.enable_thinking,
    // but most Mica surfaces (chat agents, llm-chat, skill compose) want
    // immediate output, not 500-2000 tokens of <think> overhead per turn.
    "--reasoning", "off",
    // Sampling defaults per Qwen3.6 "precise coding" recommendations.
    // (Qwen3-Coder-Next used temp=1.0/top_k=40/min_p=0.01 — different model,
    // different optima.) Lower temp + tighter top_k for deterministic code.
    "--temp", "0.6",
    "--top-p", "0.95",
    "--top-k", "20",
    "--min-p", "0.0",
    "--presence-penalty", "0.0",
    "--repeat-penalty", "1.0",
  ];

  const LLAMA_BIN = process.env.LLAMA_BIN || "llama-server";

  // Log copy-pasteable command line
  const quoteArg = (a: string) => /[\s"'`$]/.test(a) ? `'${a.replace(/'/g, "'\\''")}'` : a;
  const cmdStr = args.map(quoteArg).join(" ");
  console.log(`[llama-server] Starting on port ${port}...`);
  console.log(`[llama-server] Model: ${useCachedPath || `${HF_REPO}/${HF_FILE}`}`);
  console.log(`[llama-server] Command: ${LLAMA_BIN} ${cmdStr}`);

  // Phase timing
  const startTime = Date.now();
  const phaseTimes: Record<string, number> = {};
  let lastPhase = "init";
  let lastPhaseStart = startTime;
  function markPhase(name: string) {
    if (name === lastPhase) return;
    const now = Date.now();
    phaseTimes[lastPhase] = (phaseTimes[lastPhase] || 0) + (now - lastPhaseStart);
    const dur = ((now - lastPhaseStart) / 1000).toFixed(1);
    console.log(`[llama-timing] ${lastPhase} took ${dur}s → entering: ${name}`);
    lastPhase = name;
    lastPhaseStart = now;
  }

  const proc = spawn(LLAMA_BIN, args, {
    stdio: ["ignore", "pipe", "pipe"],
  });

  serverProcess = proc;

  function trackProgress(line: string) {
    if (line.includes("loading model tensors")) { loadProgress = "Loading model tensors..."; markPhase("loading_tensors"); }
    else if (line.includes("CUDA buffer size")) { loadProgress = "Allocating GPU buffers..."; markPhase("allocating"); }
    else if (line.includes("KV self size")) { loadProgress = "Allocating KV cache..."; markPhase("kv_cache"); }
    else if (line.includes("graph splits")) { loadProgress = "Building compute graph..."; markPhase("graph"); }
    else if (line.includes("HTTP server is listening") || line.includes("server is listening")) {
      loadProgress = "Ready";
      markPhase("ready");
      const total = ((Date.now() - startTime) / 1000).toFixed(1);
      const breakdown = Object.entries(phaseTimes)
        .filter(([k]) => k !== "ready")
        .map(([k, v]) => `${k}=${(v / 1000).toFixed(1)}s`)
        .join(" ");
      console.log(`[llama-timing] TOTAL: ${total}s — ${breakdown}`);
      lastStartupSummary = `Ready in ${total}s (${breakdown})`;
    }
  }

  proc.stdout?.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString().split("\n").filter(Boolean)) {
      console.log(`[llama-server] ${line}`);
      trackProgress(line);
    }
  });
  proc.stderr?.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString().split("\n").filter(Boolean)) {
      console.log(`[llama-server] ${line}`);
      trackProgress(line);
    }
  });

  proc.on("exit", (code, signal) => {
    console.log(`[llama-server] Exited (code=${code}, signal=${signal})`);
    serverReady = false;
    serverProcess = null;
  });

  proc.on("error", (err) => {
    console.error("[llama-server] Spawn error:", err.message);
    serverReady = false;
    serverProcess = null;
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForHealth(baseUrl, 600_000);
  serverReady = true;
  // Cache the loaded model id from /v1/models so chat cards can display the
  // real served model rather than guess from config. Best-effort — if the
  // query fails we just leave loadedModel empty.
  try {
    const r = await fetch(`${baseUrl}/v1/models`);
    if (r.ok) {
      const data = await r.json() as { data?: Array<{ id?: string }> };
      const id = data.data?.[0]?.id;
      if (typeof id === "string" && id) loadedModel = id;
    }
  } catch { /* ignore — leave loadedModel empty */ }
  console.log(`[llama-server] Ready at ${baseUrl} (model=${loadedModel || "unknown"})`);
  return baseUrl;
}

/** Locate a cached GGUF file under ~/.cache/huggingface/hub/models--<owner>--<repo>/snapshots/ */
async function findHfCachedFile(repo: string, filename: string): Promise<string | null> {
  const { readdir, stat } = await import("fs/promises");
  const { join } = await import("path");
  const cacheRoot = `/home/${process.env.USER || "vscode"}/.cache/huggingface/hub`;
  const repoDir = `${cacheRoot}/models--${repo.replace("/", "--")}/snapshots`;
  try {
    const snapshots = await readdir(repoDir);
    for (const snap of snapshots) {
      const candidate = join(repoDir, snap, filename);
      try {
        await stat(candidate);
        return candidate;
      } catch { /* not in this snapshot */ }
    }
  } catch { /* repo not cached */ }
  return null;
}

async function waitForHealth(baseUrl: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.ok) return;
    } catch {
      // Not ready yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`llama-server failed to become healthy within ${timeoutMs / 1000}s`);
}
