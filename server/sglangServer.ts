// SglangServer — singleton lifecycle manager for SGLang inference server.
// Starts on first request, stays running until Mica shuts down.
// Exposes an OpenAI-compatible API at http://127.0.0.1:{port}/v1/chat/completions.

import { spawn, type ChildProcess } from "child_process";

const DEFAULT_PORT = 8012;
const MODEL_ID = process.env.MODEL_ID || "Qwen/Qwen3-Coder-Next-FP8";

let serverProcess: ChildProcess | null = null;
let serverPort: number = DEFAULT_PORT;
let serverReady = false;
let startingPromise: Promise<string> | null = null;

/** Ensure SGLang server is running. Returns the base URL. */
export async function ensureLlamaServer(): Promise<string> {
  if (serverReady && serverProcess && !serverProcess.killed) {
    return `http://127.0.0.1:${serverPort}`;
  }

  // If already starting, wait for that
  if (startingPromise) return startingPromise;

  startingPromise = startServer();
  try {
    return await startingPromise;
  } finally {
    startingPromise = null;
  }
}

/** Stop SGLang server gracefully. */
export async function stopLlamaServer(): Promise<void> {
  if (!serverProcess) return;
  console.log("[sglang] Stopping...");
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
  console.log("[sglang] Stopped.");
}

/** Get current status. */
export function getLlamaServerStatus(): { running: boolean; pid?: number; port?: number } {
  if (serverReady && serverProcess && !serverProcess.killed) {
    return { running: true, pid: serverProcess.pid, port: serverPort };
  }
  return { running: false };
}

// ── Internal ─────────────────────────────────────────────

async function startServer(): Promise<string> {
  const port = DEFAULT_PORT;
  serverPort = port;

  console.log(`[sglang] Starting on port ${port}...`);
  console.log(`[sglang] Model: ${MODEL_ID}`);

  const proc = spawn("python3", [
    "-m", "sglang.launch_server",
    "--model", MODEL_ID,
    "--host", "0.0.0.0",
    "--port", String(port),
    "--tool-call-parser", "qwen3_coder",
    "--mem-fraction-static", "0.4",
  ], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  serverProcess = proc;

  // Pipe output with prefix
  proc.stdout?.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString().split("\n").filter(Boolean)) {
      console.log(`[sglang] ${line}`);
    }
  });
  proc.stderr?.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString().split("\n").filter(Boolean)) {
      console.log(`[sglang] ${line}`);
    }
  });

  proc.on("exit", (code, signal) => {
    console.log(`[sglang] Exited (code=${code}, signal=${signal})`);
    serverReady = false;
    serverProcess = null;
  });

  proc.on("error", (err) => {
    console.error("[sglang] Spawn error:", err.message);
    serverReady = false;
    serverProcess = null;
  });

  // Wait for health endpoint (SGLang can take a while to load models)
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForHealth(baseUrl, 300_000);
  serverReady = true;
  console.log(`[sglang] Ready at ${baseUrl}`);
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
  throw new Error(`SGLang server failed to become healthy within ${timeoutMs / 1000}s`);
}
