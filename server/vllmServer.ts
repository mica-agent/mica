// VllmServer — singleton lifecycle manager for vLLM inference server.
// Starts on first request, stays running until Mica shuts down.
// Exposes an OpenAI-compatible API at http://127.0.0.1:{port}/v1/chat/completions.

import { spawn, type ChildProcess } from "child_process";

const DEFAULT_PORT = 8012;
const MODEL_ID = process.env.MODEL_ID || "Qwen/Qwen3-Coder-Next-FP8";
const QUANTIZATION = process.env.QUANTIZATION || "";

let serverProcess: ChildProcess | null = null;
let serverPort: number = DEFAULT_PORT;
let serverReady = false;
let startingPromise: Promise<string> | null = null;
let loadProgress = "starting";

/** Ensure vLLM server is running. Returns the base URL. */
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

/** Stop vLLM server gracefully. */
export async function stopLlamaServer(): Promise<void> {
  if (!serverProcess) return;
  console.log("[vllm] Stopping...");
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
  console.log("[vllm] Stopped.");
}

/** Get current status. */
export function getLlamaServerStatus(): { running: boolean; ready: boolean; pid?: number; port?: number; progress?: string } {
  const isAlive = !!(serverProcess && !serverProcess.killed);
  if (serverReady && isAlive) {
    return { running: true, ready: true, pid: serverProcess?.pid, port: serverPort };
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

  const args = [
    "serve", MODEL_ID,
    "--host", "0.0.0.0",
    "--port", String(port),
    "--trust-remote-code",
    "--enable-auto-tool-choice",
    "--tool-call-parser", "qwen3_coder",
    "--gpu-memory-utilization", "0.7",
    "--enable-prefix-caching",
    // Aliases: "openai:local" (Qwen SDK), "coder" (llm-chat card), plus the HF id
    "--served-model-name", "openai:local", "local", "coder", "qwen", MODEL_ID,
  ];
  if (QUANTIZATION) args.push("--quantization", QUANTIZATION);

  // vLLM is installed in the container's system Python
  const VLLM_BIN = process.env.VLLM_BIN || "vllm";

  const envOverrides = {
    // Latency backend recommended for SM121 (throughput backend has bugs)
    VLLM_FLASHINFER_MOE_BACKEND: "latency",
    // flashinfer JIT-compiles cutlass kernels for SM120 — needs writable dir
    FLASHINFER_WORKSPACE_BASE: "/home/vscode/.cache/flashinfer",
    FLASHINFER_JIT_DIR: "/home/vscode/.cache/flashinfer/jit",
  };

  // Log exact launch command (quote args with spaces or special chars for copy-paste)
  const quoteArg = (a: string) => /[\s"'`$]/.test(a) ? `'${a.replace(/'/g, "'\\''")}'` : a;
  const envStr = Object.entries(envOverrides).map(([k, v]) => `${k}=${quoteArg(v)}`).join(" ");
  const cmdStr = args.map(quoteArg).join(" ");
  console.log(`[vllm] Starting on port ${port}...`);
  console.log(`[vllm] Model: ${MODEL_ID}`);
  console.log(`[vllm] Command: ${envStr} ${VLLM_BIN} ${cmdStr}`);

  const proc = spawn(VLLM_BIN, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...envOverrides },
  });

  serverProcess = proc;

  // Parse progress from log lines for loading status
  function trackProgress(line: string) {
    const shardMatch = line.match(/Loading.*?shards:\s*(\d+)% Completed \|\s*(\d+)\/(\d+)/);
    if (shardMatch) {
      loadProgress = `Loading model ${shardMatch[2]}/${shardMatch[3]} shards (${shardMatch[1]}%)`;
      return;
    }
    // Capturing CUDA graphs (decode, FULL): 50%|████| 18/35 [00:03<00:03,  4.85it/s]
    const cudaMatch = line.match(/Capturing CUDA graphs[^:]*:\s*(\d+)%\|.*?\|\s*(\d+)\/(\d+)/);
    if (cudaMatch) {
      loadProgress = `Compiling CUDA graphs ${cudaMatch[2]}/${cudaMatch[3]} (${cudaMatch[1]}%)`;
      return;
    }
    if (line.includes("Loading weights took")) loadProgress = "Allocating KV cache...";
    else if (line.includes("Model loading took")) loadProgress = "Profiling memory...";
    else if (line.includes("determine_available_memory")) loadProgress = "Profiling memory...";
    else if (line.includes("Capturing CUDA graph") && !cudaMatch) loadProgress = "Starting CUDA graph capture...";
    else if (line.includes("Starting to load model")) loadProgress = "Starting model load...";
    else if (line.includes("Loading model weights")) loadProgress = "Loading model weights...";
    else if (line.includes("Application startup complete") || line.includes("Started server process")) loadProgress = "Ready";
  }

  proc.stdout?.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString().split("\n").filter(Boolean)) {
      console.log(`[vllm] ${line}`);
      trackProgress(line);
    }
  });
  proc.stderr?.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString().split("\n").filter(Boolean)) {
      console.log(`[vllm] ${line}`);
      trackProgress(line);
    }
  });

  proc.on("exit", (code, signal) => {
    console.log(`[vllm] Exited (code=${code}, signal=${signal})`);
    serverReady = false;
    serverProcess = null;
  });

  proc.on("error", (err) => {
    console.error("[vllm] Spawn error:", err.message);
    serverReady = false;
    serverProcess = null;
  });

  // Wait for health endpoint (vLLM can take a while to load models)
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForHealth(baseUrl, 600_000);
  serverReady = true;
  console.log(`[vllm] Ready at ${baseUrl}`);
  return baseUrl;
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
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`vLLM server failed to become healthy within ${timeoutMs / 1000}s`);
}
