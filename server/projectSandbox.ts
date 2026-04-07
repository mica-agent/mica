/**
 * ProjectSandbox — Manages per-project Docker containers.
 *
 * Each project gets an isolated container for card runtime, agent
 * subprocesses, and shell commands. The container provides blast
 * radius — filesystem scoping and resource limits.
 *
 * Lifecycle guarantees:
 * - Stale containers from previous runs are cleaned up on first use.
 * - Container liveness is verified before dispatching work.
 * - Dead containers are automatically recreated.
 * - Failed startups use exponential backoff.
 */

import { execFile } from "child_process";
import { promisify } from "util";
import { existsSync } from "fs";
import { getProjectConfig } from "./projectConnection.js";
import { getProjectMounts, SANDBOX_IMAGE } from "./dockerSpawn.js";

const execFileAsync = promisify(execFile);

/** Detect GPU passthrough strategy. Cached after first probe. */
let gpuArgs: string[] | null = null;
async function getGpuArgs(): Promise<string[]> {
  if (gpuArgs !== null) return gpuArgs;

  // Try --gpus all (works when host has NVIDIA Container Toolkit)
  try {
    await execFileAsync("docker", [
      "run", "--rm", "--gpus", "all", SANDBOX_IMAGE, "true",
    ], { timeout: 15000 });
    gpuArgs = ["--gpus", "all"];
    console.log("[sandbox] GPU passthrough: --gpus all");
    return gpuArgs;
  } catch { /* not available */ }

  // Fallback: device mounts (Docker-in-Docker)
  const devices = ["/dev/nvidia0", "/dev/nvidiactl", "/dev/nvidia-uvm"];
  if (devices.every((d) => existsSync(d))) {
    gpuArgs = [];
    for (const d of devices) gpuArgs.push("--device", d);
    console.log("[sandbox] GPU passthrough: device mounts");
    return gpuArgs;
  }

  // No GPU available
  gpuArgs = [];
  console.log("[sandbox] GPU passthrough: none (no GPU detected)");
  return gpuArgs;
}

// ── Types ──────────────────────────────────────────────────

interface SandboxConfig {
  memory?: string;
}

interface ProjectSandboxInfo {
  projectId: string;
  containerName: string;
  status: "starting" | "running" | "stopped";
}

// ── Constants ──────────────────────────────────────────────

const CONTAINER_PREFIX = "mica-project-";
const BACKOFF_BASE_MS = 5000;
const BACKOFF_MAX_MS = 60000;

// ── SandboxManager ─────────────────────────────────────────

export class SandboxManager {
  private sandboxes: Map<string, ProjectSandboxInfo> = new Map();
  private dockerAvailable: boolean | null = null;
  private failedProjects: Map<string, { at: number; attempts: number }> = new Map();
  private cleanedUp = false;

  private async isDockerAvailable(): Promise<boolean> {
    if (this.dockerAvailable !== null) return this.dockerAvailable;
    try {
      await execFileAsync("docker", ["info"], { timeout: 5000 });
      this.dockerAvailable = true;
    } catch {
      console.warn("[sandbox] Docker not available");
      this.dockerAvailable = false;
    }
    return this.dockerAvailable;
  }

  private async cleanupStaleContainers(): Promise<void> {
    if (this.cleanedUp) return;
    this.cleanedUp = true;
    if (!(await this.isDockerAvailable())) return;

    try {
      const { stdout } = await execFileAsync("docker", [
        "ps", "-a", "--filter", `name=${CONTAINER_PREFIX}`, "--format", "{{.Names}}",
      ], { timeout: 5000 });
      const names = stdout.trim().split("\n").filter(Boolean);
      if (names.length === 0) return;
      console.log(`[sandbox] Cleaning up ${names.length} stale container(s): ${names.join(", ")}`);
      await execFileAsync("docker", ["rm", "-f", ...names], { timeout: 15000 });
    } catch (err) {
      console.warn("[sandbox] Stale container cleanup failed:", (err as Error).message);
    }
  }

  private async isContainerAlive(containerName: string): Promise<boolean> {
    try {
      const { stdout } = await execFileAsync("docker", [
        "inspect", "-f", "{{.State.Running}}", containerName,
      ], { timeout: 5000 });
      return stdout.trim() === "true";
    } catch {
      return false;
    }
  }

  /** Ensure the container for a project is running. Returns the container name. */
  async ensureContainer(projectId: string): Promise<string> {
    await this.cleanupStaleContainers();

    const existing = this.sandboxes.get(projectId);
    if (existing && existing.status === "running") {
      if (await this.isDockerAvailable()) {
        const alive = await this.isContainerAlive(existing.containerName);
        if (!alive) {
          console.warn(`[sandbox] Container ${existing.containerName} is dead — recreating`);
          await this.teardownSandbox(projectId);
          return this.startSandbox(projectId);
        }
      }
      return existing.containerName;
    }

    return this.startSandbox(projectId);
  }

  // Keep getPool as alias for backward compatibility with executor
  async getPool(projectId: string): Promise<unknown> {
    await this.ensureContainer(projectId);
    return {};
  }

  /** Get the container name for a project. */
  async getContainerName(projectId: string): Promise<string> {
    return this.ensureContainer(projectId);
  }

  private async startSandbox(projectId: string): Promise<string> {
    const existing = this.sandboxes.get(projectId);
    if (existing && existing.status === "running") return existing.containerName;

    const failure = this.failedProjects.get(projectId);
    if (failure) {
      const backoff = Math.min(BACKOFF_BASE_MS * Math.pow(2, failure.attempts - 1), BACKOFF_MAX_MS);
      const elapsed = Date.now() - failure.at;
      if (elapsed < backoff) {
        const waitSec = ((backoff - elapsed) / 1000).toFixed(0);
        throw new Error(`Sandbox for "${projectId}" failed ${failure.attempts} time(s), retrying in ${waitSec}s`);
      }
    }

    const containerName = `${CONTAINER_PREFIX}${projectId}`;

    let config: SandboxConfig = {};
    try {
      const projectConfig = await getProjectConfig(projectId);
      config = (projectConfig as Record<string, unknown>).workers as SandboxConfig || {};
    } catch { /* defaults */ }

    if (await this.isDockerAvailable()) {
      try {
        await this.startContainer(projectId, containerName, config);
        this.failedProjects.delete(projectId);
      } catch (err) {
        const prev = this.failedProjects.get(projectId);
        this.failedProjects.set(projectId, {
          at: Date.now(),
          attempts: (prev?.attempts ?? 0) + 1,
        });
        throw err;
      }
    }

    this.sandboxes.set(projectId, {
      projectId,
      containerName,
      status: "running",
    });

    return containerName;
  }

  private async startContainer(
    projectId: string,
    containerName: string,
    config: SandboxConfig
  ): Promise<void> {
    try {
      await execFileAsync("docker", ["rm", "-f", containerName], { timeout: 10000 });
    } catch { /* not running */ }

    const mounts = await getProjectMounts(projectId);
    const memory = config.memory ?? "1g";

    const dockerArgs = [
      "run", "-d",
      "--name", containerName,
      "--network", "bridge",
      "--memory", memory,
      "--cpus", "2.0",
      ...await getGpuArgs(),
    ];

    for (const vol of mounts.volumes) {
      dockerArgs.push("-v", vol);
    }

    const portOffset = this.sandboxes.size * 10;
    for (let i = 0; i < 10; i++) {
      dockerArgs.push("-p", `${9000 + portOffset + i}:${8080 + i}`);
    }

    dockerArgs.push(
      "-w", mounts.workdir,
      "-e", `PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
      "-e", `HOME=/home/sandbox`,
      "-e", `TERM=xterm-256color`,
      "--entrypoint", "sleep",
      SANDBOX_IMAGE,
      "infinity",
    );

    try {
      await execFileAsync("docker", dockerArgs, { timeout: 30000 });
      console.log(`[sandbox] Started container ${containerName} for project "${projectId}" (setup phase)`);
    } catch (err) {
      console.error(`[sandbox] Failed to start container for "${projectId}":`, (err as Error).message);
      throw err;
    }
  }

  private async teardownSandbox(projectId: string): Promise<void> {
    const sandbox = this.sandboxes.get(projectId);
    if (!sandbox) return;
    sandbox.status = "stopped";
    this.sandboxes.delete(projectId);
    if (await this.isDockerAvailable()) {
      try {
        await execFileAsync("docker", ["rm", "-f", sandbox.containerName], { timeout: 10000 });
      } catch { /* already gone */ }
    }
  }

  async stopSandbox(projectId: string): Promise<void> {
    await this.teardownSandbox(projectId);
    console.log(`[sandbox] Stopped container ${CONTAINER_PREFIX}${projectId}`);
  }

  async stopAll(): Promise<void> {
    const ids = [...this.sandboxes.keys()];
    await Promise.all(ids.map((id) => this.stopSandbox(id)));
  }

  hasSandbox(projectId: string): boolean {
    const sandbox = this.sandboxes.get(projectId);
    return sandbox?.status === "running";
  }
}
