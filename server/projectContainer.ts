// Per-project app runtime — runs the user's app inside the shared project container.
// Uses `docker exec` on the sandbox container (managed by SandboxManager),
// rather than creating a separate container.

import { execFile } from "child_process";
import { promisify } from "util";
import { readFile } from "fs/promises";
import { join } from "path";
import { existsSync } from "fs";
import { getProjectPath } from "./projectConnection.js";
import type { SandboxManager } from "./projectSandbox.js";

const execFileAsync = promisify(execFile);

// ── Types ──────────────────────────────────────────────────

export interface RuntimeConfig {
  entrypoint?: string;
  ports?: number[];
  env?: Record<string, string>;
  workdir?: string;
}

export interface ContainerInfo {
  containerName: string;
  projectId: string;
  ports: Array<{ container: number; host: number }>;
  status: "running" | "starting" | "stopped";
  pid?: string;
}

export interface ContainerStatus {
  running: boolean;
  status: string;
  uptime?: string;
  ports: Array<{ container: number; host: number }>;
  memoryUsage?: string;
}

// ── Port Mapping ──────────────────────────────────────────
// Ports 8080-8089 inside the container are mapped to 9000-9009 on the host
// (configured in projectSandbox.ts when the container starts).

const PORT_BASE_CONTAINER = 8080;
const PORT_BASE_HOST = 9000;

function mapPort(containerPort: number): number {
  const offset = containerPort - PORT_BASE_CONTAINER;
  if (offset < 0 || offset >= 10) {
    throw new Error(`Container port ${containerPort} outside mapped range ${PORT_BASE_CONTAINER}-${PORT_BASE_CONTAINER + 9}`);
  }
  return PORT_BASE_HOST + offset;
}

// ── Runtime Config ─────────────────────────────────────────

async function readRuntimeConfig(projectPath: string): Promise<RuntimeConfig> {
  // Try .mica/config.json runtime section first
  const micaConfigPath = join(projectPath, ".mica", ".config.json");
  try {
    const raw = await readFile(micaConfigPath, "utf-8");
    const config = JSON.parse(raw);
    if (config.runtime) return config.runtime;
  } catch { /* no config */ }

  // Try _runtime.json at project root
  const runtimePath = join(projectPath, "_runtime.json");
  try {
    const raw = await readFile(runtimePath, "utf-8");
    return JSON.parse(raw);
  } catch { /* no runtime file */ }

  // Auto-detect
  if (existsSync(join(projectPath, "app.py"))) {
    return { entrypoint: "python3 app.py", ports: [8080] };
  }
  if (existsSync(join(projectPath, "index.html"))) {
    return { entrypoint: "python3 -m http.server 8080", ports: [8080] };
  }
  if (existsSync(join(projectPath, "package.json"))) {
    return { entrypoint: "npm start", ports: [3000] };
  }

  // Default: no-op
  return { entrypoint: "sleep infinity", ports: [] };
}

// ── State ─────────────────────────────────────────────────

const appProcesses = new Map<string, ContainerInfo>();
let _sandboxManager: SandboxManager | null = null;

/** Set the SandboxManager so we can get the shared container name. */
export function setSandboxManager(sm: SandboxManager): void {
  _sandboxManager = sm;
}

// ── Operations ─────────────────────────────────────────────

export async function startProjectContainer(
  projectId: string
): Promise<ContainerInfo> {
  if (!_sandboxManager) {
    throw new Error("SandboxManager not set — call setSandboxManager() first");
  }

  // Stop existing app process if running
  try {
    await stopProjectContainer(projectId);
  } catch { /* not running */ }

  const containerName = await _sandboxManager.getContainerName(projectId);
  const projectPath = await getProjectPath(projectId);
  const runtime = await readRuntimeConfig(projectPath);

  // Build docker exec command
  const execArgs = [
    "exec", "-d",
    "-w", runtime.workdir || projectPath,
  ];

  // Environment variables
  if (runtime.env) {
    for (const [key, value] of Object.entries(runtime.env)) {
      execArgs.push("-e", `${key}=${value}`);
    }
  }

  execArgs.push(containerName, "/bin/bash", "-c", runtime.entrypoint || "sleep infinity");

  await execFileAsync("docker", execArgs);

  const containerPorts = runtime.ports || [];
  const info: ContainerInfo = {
    containerName,
    projectId,
    ports: containerPorts.map((cp) => ({ container: cp, host: mapPort(cp) })),
    status: "running",
  };

  appProcesses.set(projectId, info);
  console.log(`[app] Started app in ${containerName} for "${projectId}" (ports: ${containerPorts.join(", ") || "none"})`);

  return info;
}

export async function stopProjectContainer(projectId: string): Promise<void> {
  if (!_sandboxManager) return;

  try {
    const containerName = await _sandboxManager.getContainerName(projectId);
    // Kill the app process (pkill the entrypoint), not the container itself
    await execFileAsync("docker", [
      "exec", containerName, "pkill", "-f", "app.py|npm start|http.server",
    ], { timeout: 5000 });
  } catch { /* process may not be running */ }

  appProcesses.delete(projectId);
  console.log(`[app] Stopped app for "${projectId}"`);
}

export async function getContainerStatus(
  projectId: string
): Promise<ContainerStatus> {
  if (!_sandboxManager) {
    return { running: false, status: "no sandbox manager", ports: [] };
  }

  try {
    const containerName = await _sandboxManager.getContainerName(projectId);
    const { stdout } = await execFileAsync("docker", [
      "inspect",
      "--format",
      "{{.State.Status}}|{{.State.StartedAt}}|{{.HostConfig.Memory}}",
      containerName,
    ]);

    const [status, startedAt, memory] = stdout.trim().split("|");
    const cached = appProcesses.get(projectId);

    return {
      running: status === "running",
      status,
      uptime: status === "running" ? startedAt : undefined,
      ports: cached?.ports || [],
      memoryUsage: memory,
    };
  } catch {
    return {
      running: false,
      status: "not found",
      ports: [],
    };
  }
}

export async function getContainerLogs(
  projectId: string,
  tail: number = 100
): Promise<string> {
  if (!_sandboxManager) return "(No sandbox manager)";

  try {
    const containerName = await _sandboxManager.getContainerName(projectId);
    const { stdout, stderr } = await execFileAsync("docker", [
      "logs",
      "--tail", String(tail),
      containerName,
    ]);
    return stdout + stderr;
  } catch (err) {
    return `(No logs available: ${(err as Error).message})`;
  }
}
