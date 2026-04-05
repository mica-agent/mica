// LlamaServer — singleton lifecycle manager for llama-server (llama.cpp).
// Starts on first request, stays running until Mica shuts down.
// Exposes an OpenAI-compatible API at http://127.0.0.1:{port}/v1/chat/completions.

import { spawn, type ChildProcess } from "child_process";

const LLAMA_SERVER_BIN = "/usr/local/bin/llama-server";
const DEFAULT_PORT = 8012;
const MODEL_PATH = process.env.MODEL_PATH ||
  "/home/vscode/.cache/llama.cpp/unsloth_Qwen3-Next-80B-A3B-Instruct-GGUF_Qwen3-Next-80B-A3B-Instruct-UD-Q4_K_XL.gguf";

let serverProcess: ChildProcess | null = null;
let serverPort: number = DEFAULT_PORT;
let serverReady = false;
let startingPromise: Promise<string> | null = null;

/** Ensure llama-server is running. Returns the base URL. */
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

/** Stop llama-server gracefully. */
export async function stopLlamaServer(): Promise<void> {
  if (!serverProcess) return;
  console.log("[llama-server] Stopping...");
  serverProcess.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      serverProcess?.kill("SIGKILL");
      resolve();
    }, 5000);
    serverProcess?.on("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
  serverProcess = null;
  serverReady = false;
  console.log("[llama-server] Stopped.");
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

  console.log(`[llama-server] Starting on port ${port}...`);
  console.log(`[llama-server] Model: ${MODEL_PATH}`);

  const proc = spawn(LLAMA_SERVER_BIN, [
    "--model", MODEL_PATH,
    "--host", "0.0.0.0",
    "--port", String(port),
    "--jinja",
    "--ctx-size", "32768",
    "--flash-attn", "on",
    "--n-gpu-layers", "999",
    "-np", "2",
  ], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  serverProcess = proc;

  // Pipe output with prefix
  proc.stdout?.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString().split("\n").filter(Boolean)) {
      console.log(`[llama-server] ${line}`);
    }
  });
  proc.stderr?.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString().split("\n").filter(Boolean)) {
      console.log(`[llama-server] ${line}`);
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

  // Wait for health endpoint
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForHealth(baseUrl, 120_000);
  serverReady = true;
  console.log(`[llama-server] Ready at ${baseUrl}`);
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
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`llama-server failed to become healthy within ${timeoutMs / 1000}s`);
}
