// Per-project container isolation — runs each project's app in its own Docker container.
// Reuses image-building infrastructure from dockerSpawn.ts.

import { execFile, execSync } from "child_process";
import { promisify } from "util";
import { readFile } from "fs/promises";
import { join } from "path";
import { existsSync } from "fs";
import { getProjectPath, type ConnectedProject, getProjectConfig } from "./projectConnection.js";
import { parseDependencies, getOrBuildImage, type SandboxDeps } from "./dockerSpawn.js";

const execFileAsync = promisify(execFile);

// ── Types ──────────────────────────────────────────────────

export interface RuntimeConfig {
  entrypoint?: string;
  ports?: number[];
  env?: Record<string, string>;
  workdir?: string;
}

export interface ContainerInfo {
  containerId: string;
  containerName: string;
  projectId: string;
  ports: Array<{ container: number; host: number }>;
  status: "running" | "starting" | "stopped";
}

export interface ContainerStatus {
  running: boolean;
  status: string;
  uptime?: string;
  ports: Array<{ container: number; host: number }>;
  memoryUsage?: string;
}

// ── Port Allocator ─────────────────────────────────────────

const PORT_RANGE = { start: 9000, end: 9099 };
const allocatedPorts = new Map<string, number[]>(); // projectId → host ports

function allocatePorts(projectId: string, count: number): number[] {
  // Collect all allocated ports
  const used = new Set<number>();
  for (const ports of allocatedPorts.values()) {
    for (const p of ports) used.add(p);
  }

  const allocated: number[] = [];
  for (let p = PORT_RANGE.start; p <= PORT_RANGE.end && allocated.length < count; p++) {
    if (!used.has(p)) {
      allocated.push(p);
    }
  }

  if (allocated.length < count) {
    throw new Error(`Not enough ports available (need ${count}, found ${allocated.length})`);
  }

  allocatedPorts.set(projectId, allocated);
  return allocated;
}

function releasePorts(projectId: string): void {
  allocatedPorts.delete(projectId);
}

// ── Runtime Config ─────────────────────────────────────────

async function readRuntimeConfig(projectPath: string): Promise<RuntimeConfig> {
  // Try .mica/config.json runtime section first
  const micaConfigPath = join(projectPath, ".mica", "config.json");
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

  // Default: sleep (user can exec into container)
  return { entrypoint: "sleep infinity", ports: [] };
}

// ── Container State ────────────────────────────────────────

const containers = new Map<string, ContainerInfo>();

function containerName(projectId: string): string {
  return `mica-app-${projectId}`;
}

// ── Operations ─────────────────────────────────────────────

export async function startProjectContainer(
  projectId: string
): Promise<ContainerInfo> {
  // Stop existing if running
  try {
    await stopProjectContainer(projectId);
  } catch { /* not running */ }

  const projectPath = await getProjectPath(projectId);
  const runtime = await readRuntimeConfig(projectPath);

  // Read deps from workspace _brief.md
  let deps: SandboxDeps = { apt: [], pip: [] };
  try {
    const briefPath = join(projectPath, ".mica", "workspace", "_brief.md");
    if (existsSync(briefPath)) {
      const briefContent = await readFile(briefPath, "utf-8");
      deps = parseDependencies(briefContent);
    }
  } catch { /* no brief */ }

  const imageTag = await getOrBuildImage(deps);
  const name = containerName(projectId);
  const containerPorts = runtime.ports || [];
  const hostPorts = containerPorts.length > 0
    ? allocatePorts(projectId, containerPorts.length)
    : [];

  const dockerArgs = [
    "run", "-d",
    "--name", name,
    "--network", "bridge",
    "--memory", "1g",
    "--cpus", "2.0",
    "-v", `${projectPath}:/workspace:rw`,
    "-w", runtime.workdir || "/workspace",
  ];

  // Port mappings
  for (let i = 0; i < containerPorts.length; i++) {
    dockerArgs.push("-p", `${hostPorts[i]}:${containerPorts[i]}`);
  }

  // Environment variables
  if (runtime.env) {
    for (const [key, value] of Object.entries(runtime.env)) {
      dockerArgs.push("-e", `${key}=${value}`);
    }
  }

  // Image + entrypoint
  dockerArgs.push("--entrypoint", "/bin/bash");
  dockerArgs.push(imageTag);
  dockerArgs.push("-c", runtime.entrypoint || "sleep infinity");

  const { stdout } = await execFileAsync("docker", dockerArgs);
  const containerId = stdout.trim().slice(0, 12);

  const info: ContainerInfo = {
    containerId,
    containerName: name,
    projectId,
    ports: containerPorts.map((cp, i) => ({ container: cp, host: hostPorts[i] })),
    status: "running",
  };

  containers.set(projectId, info);
  console.log(`[container] Started ${name} (${containerId}) for project "${projectId}"`);

  return info;
}

export async function stopProjectContainer(projectId: string): Promise<void> {
  const name = containerName(projectId);

  try {
    await execFileAsync("docker", ["stop", "-t", "10", name]);
  } catch { /* may not be running */ }

  try {
    await execFileAsync("docker", ["rm", "-f", name]);
  } catch { /* may not exist */ }

  releasePorts(projectId);
  containers.delete(projectId);
  console.log(`[container] Stopped ${name}`);
}

export async function getContainerStatus(
  projectId: string
): Promise<ContainerStatus> {
  const name = containerName(projectId);

  try {
    const { stdout } = await execFileAsync("docker", [
      "inspect",
      "--format",
      "{{.State.Status}}|{{.State.StartedAt}}|{{.HostConfig.Memory}}",
      name,
    ]);

    const [status, startedAt, memory] = stdout.trim().split("|");
    const running = status === "running";
    const cached = containers.get(projectId);

    return {
      running,
      status,
      uptime: running ? startedAt : undefined,
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
  const name = containerName(projectId);
  try {
    const { stdout, stderr } = await execFileAsync("docker", [
      "logs",
      "--tail", String(tail),
      name,
    ]);
    return stdout + stderr;
  } catch (err) {
    return `(No logs available: ${(err as Error).message})`;
  }
}
