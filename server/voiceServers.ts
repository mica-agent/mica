// VoiceServers — lifecycle manager for the two voice sidecars.
//
//   voice-stt  (Parakeet-TDT-0.6b-v2)  → 127.0.0.1:8013/transcribe
//   voice-tts  (Kokoro-82M)            → 127.0.0.1:8014/synthesize
//
// Mirrors llamaServer.ts's pattern: lazy-spawn on first ensureVoiceServers()
// call, expose status, gracefully shut down on backend exit. The Python
// scripts live at scripts/sidecars/voice-{stt,tts}-server.py and run inside
// the venv at scripts/benchmarks/voice/.venv (created by the benchmark
// install.sh — same deps, no need to duplicate).
//
// MICA_DISABLE_VOICE=1 skips spawning entirely; .voice cards then show
// a "voice servers disabled" placeholder.

import { spawn, type ChildProcess } from "child_process";
import { existsSync } from "fs";
import { join } from "path";

const REPO_ROOT = process.env.REPO_ROOT || process.cwd();
const VENV_PYTHON = join(
  REPO_ROOT,
  "scripts",
  "benchmarks",
  "voice",
  ".venv",
  "bin",
  "python",
);
const STT_SCRIPT = join(REPO_ROOT, "scripts", "sidecars", "voice-stt-server.py");
const TTS_SCRIPT = join(REPO_ROOT, "scripts", "sidecars", "voice-tts-server.py");

const STT_PORT = parseInt(process.env.VOICE_STT_PORT || "8013", 10);
const TTS_PORT = parseInt(process.env.VOICE_TTS_PORT || "8014", 10);
const STT_HOST = process.env.VOICE_STT_HOST || "127.0.0.1";
const TTS_HOST = process.env.VOICE_TTS_HOST || "127.0.0.1";

interface VoiceServerHandle {
  proc: ChildProcess | null;
  ready: boolean;
  url: string;
  label: string;
}

const stt: VoiceServerHandle = {
  proc: null,
  ready: false,
  url: `http://${STT_HOST}:${STT_PORT}`,
  label: "voice-stt",
};
const tts: VoiceServerHandle = {
  proc: null,
  ready: false,
  url: `http://${TTS_HOST}:${TTS_PORT}`,
  label: "voice-tts",
};

let starting: Promise<void> | null = null;

/** Spawn the two sidecars (idempotent). Resolves once both /health
 *  endpoints return 200, or rejects with a clear error if anything
 *  fails (missing venv, missing script, model load timeout). Subsequent
 *  calls return the cached promise. */
export async function ensureVoiceServers(): Promise<void> {
  if (process.env.MICA_DISABLE_VOICE === "1") {
    return; // disabled — caller endpoints will 503
  }
  if (stt.ready && tts.ready && stt.proc && tts.proc) return;
  if (starting) return starting;

  // Sanity checks before spawning — fail fast with actionable messages.
  if (!existsSync(VENV_PYTHON)) {
    throw new Error(
      `voice venv not found at ${VENV_PYTHON}. ` +
        `Run: bash scripts/benchmarks/voice/install.sh`,
    );
  }
  if (!existsSync(STT_SCRIPT)) {
    throw new Error(`voice-stt script missing: ${STT_SCRIPT}`);
  }
  if (!existsSync(TTS_SCRIPT)) {
    throw new Error(`voice-tts script missing: ${TTS_SCRIPT}`);
  }

  starting = (async () => {
    spawnHandle(stt, [STT_SCRIPT]);
    spawnHandle(tts, [TTS_SCRIPT]);
    // Generous timeout — Parakeet load is ~10s, Kokoro is ~2s, but on a
    // first run both pull weights from HuggingFace.
    await Promise.all([
      waitForHealth(stt, 180_000),
      waitForHealth(tts, 60_000),
    ]);
    stt.ready = true;
    tts.ready = true;
    console.log(
      `[voice-servers] ready (stt=${stt.url}, tts=${tts.url})`,
    );
  })();
  try {
    await starting;
  } finally {
    starting = null;
  }
}

function spawnHandle(h: VoiceServerHandle, args: string[]): void {
  if (h.proc && !h.proc.killed) return;
  console.log(`[${h.label}] spawning: ${VENV_PYTHON} ${args.join(" ")}`);
  const proc = spawn(VENV_PYTHON, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env },
  });
  proc.stdout?.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString().split("\n").filter(Boolean)) {
      console.log(`[${h.label}] ${line}`);
    }
  });
  proc.stderr?.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString().split("\n").filter(Boolean)) {
      console.log(`[${h.label}] ${line}`);
    }
  });
  proc.on("exit", (code, signal) => {
    console.log(`[${h.label}] exited (code=${code}, signal=${signal})`);
    h.ready = false;
    h.proc = null;
  });
  proc.on("error", (err) => {
    console.error(`[${h.label}] spawn error: ${err.message}`);
    h.ready = false;
    h.proc = null;
  });
  h.proc = proc;
}

async function waitForHealth(
  h: VoiceServerHandle,
  timeoutMs: number,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${h.url}/health`);
      if (res.ok) return;
    } catch {
      /* not ready yet */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(
    `${h.label} did not become healthy at ${h.url} within ${timeoutMs / 1000}s`,
  );
}

export async function stopVoiceServers(): Promise<void> {
  for (const h of [stt, tts]) {
    if (!h.proc) continue;
    console.log(`[${h.label}] stopping...`);
    h.proc.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        h.proc?.kill("SIGKILL");
        resolve();
      }, 5000);
      h.proc?.on("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
    h.proc = null;
    h.ready = false;
  }
}

export function getVoiceServerStatus(): {
  stt: { url: string; ready: boolean };
  tts: { url: string; ready: boolean };
  disabled: boolean;
} {
  return {
    stt: { url: stt.url, ready: stt.ready },
    tts: { url: tts.url, ready: tts.ready },
    disabled: process.env.MICA_DISABLE_VOICE === "1",
  };
}

export function getSttUrl(): string {
  return stt.url;
}
export function getTtsUrl(): string {
  return tts.url;
}
