/**
 * ProjectSandbox — Manages per-project Docker containers with --network=none.
 *
 * Each project gets an isolated container running Python workers.
 * All untrusted card code executes inside this container.
 * The Mica server (on the host) communicates with workers via docker exec pipes.
 *
 * Lifecycle guarantees:
 * - Stale containers from previous runs are cleaned up on first use.
 * - Container liveness is verified before dispatching work.
 * - Dead containers are automatically recreated.
 * - Failed startups use exponential backoff (not fixed 60s blacklist).
 */

import { execFile } from "child_process";
import { promisify } from "util";
import path from "path";
import { fileURLToPath } from "url";
import { WorkerPool, dockerSpawnFn, localSpawnFn, buildWorkerEnv, type WorkerPoolOptions, type RpcHandler } from "./workerPool.js";
import { getProjectPath, getProjectConfig } from "./projectConnection.js";
import { getProjectMounts, SANDBOX_IMAGE } from "./dockerSpawn.js";

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── Types ──────────────────────────────────────────────────

interface SandboxConfig {
  warm?: number;
  max?: number;
  memory?: string;
}

interface ProjectSandboxInfo {
  projectId: string;
  containerName: string;
  pool: WorkerPool;
  status: "starting" | "running" | "stopped";
}

// ── Constants ──────────────────────────────────────────────

const CONTAINER_PREFIX = "mica-project-";

// Backoff: 5s, 10s, 20s, 40s, 60s cap
const BACKOFF_BASE_MS = 5000;
const BACKOFF_MAX_MS = 60000;

// ── SandboxManager ─────────────────────────────────────────

export class SandboxManager {
  private sandboxes: Map<string, ProjectSandboxInfo> = new Map();
  private rpcHandler: RpcHandler | null = null;
  private dockerAvailable: boolean | null = null;
  private failedProjects: Map<string, { at: number; attempts: number }> = new Map();
  private cleanedUp = false;

  /** Check if Docker is available. Cached after first check. */
  private async isDockerAvailable(): Promise<boolean> {
    if (this.dockerAvailable !== null) return this.dockerAvailable;
    try {
      await execFileAsync("docker", ["info"], { timeout: 5000 });
      this.dockerAvailable = true;
    } catch {
      console.warn("[sandbox] Docker not available — running workers locally (no container isolation)");
      this.dockerAvailable = false;
    }
    return this.dockerAvailable;
  }

  /**
   * Remove any mica-project-* containers left over from a previous server run.
   * Called once on first getPool() — ensures a clean slate.
   */
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

  /** Check if a Docker container is running. */
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

  setRpcHandler(handler: RpcHandler) {
    this.rpcHandler = handler;
    for (const sandbox of this.sandboxes.values()) {
      sandbox.pool.setRpcHandler(handler);
    }
  }

  /** Get the container name for a project (ensures container is running). */
  async getContainerName(projectId: string): Promise<string> {
    await this.getPool(projectId); // ensures container + pool are up
    const sandbox = this.sandboxes.get(projectId);
    if (!sandbox) throw new Error(`No sandbox for project: ${projectId}`);
    return sandbox.containerName;
  }

  /** Get or create a sandbox for a project. Verifies liveness before returning. */
  async getPool(projectId: string): Promise<WorkerPool> {
    // First call: clean up containers from previous server runs
    await this.cleanupStaleContainers();

    const existing = this.sandboxes.get(projectId);
    if (existing && existing.status === "running") {
      // Verify container is still alive
      const useDocker = await this.isDockerAvailable();
      if (useDocker) {
        const alive = await this.isContainerAlive(existing.containerName);
        if (!alive) {
          console.warn(`[sandbox] Container ${existing.containerName} is dead — recreating`);
          await this.teardownSandbox(projectId);
          return this.startSandbox(projectId);
        }
      }
      return existing.pool;
    }

    return this.startSandbox(projectId);
  }

  /** Start a sandbox for a project. */
  async startSandbox(projectId: string): Promise<WorkerPool> {
    const existing = this.sandboxes.get(projectId);
    if (existing && existing.status === "running") return existing.pool;

    // Exponential backoff on repeated failures
    const failure = this.failedProjects.get(projectId);
    if (failure) {
      const backoff = Math.min(BACKOFF_BASE_MS * Math.pow(2, failure.attempts - 1), BACKOFF_MAX_MS);
      const elapsed = Date.now() - failure.at;
      if (elapsed < backoff) {
        const waitSec = ((backoff - elapsed) / 1000).toFixed(0);
        throw new Error(`Sandbox for "${projectId}" failed ${failure.attempts} time(s), retrying in ${waitSec}s`);
      }
    }

    const useDocker = await this.isDockerAvailable();
    const containerName = `${CONTAINER_PREFIX}${projectId}`;

    // Read project config for worker settings
    let config: SandboxConfig = {};
    try {
      const projectConfig = await getProjectConfig(projectId);
      config = (projectConfig as Record<string, unknown>).workers as SandboxConfig || {};
    } catch { /* defaults */ }

    const warm = config.warm ?? 1;
    const max = config.max ?? 6;

    let pool: WorkerPool;

    if (useDocker) {
      try {
        await this.startContainer(projectId, containerName, config);
        // Success — clear any failure history
        this.failedProjects.delete(projectId);
      } catch (err) {
        const prev = this.failedProjects.get(projectId);
        this.failedProjects.set(projectId, {
          at: Date.now(),
          attempts: (prev?.attempts ?? 0) + 1,
        });
        throw err;
      }

      pool = new WorkerPool({
        warm,
        max,
        spawnFn: dockerSpawnFn(containerName, WORKER_PATH),
        label: projectId,
      });
    } else {
      const workerPath = path.join(__dirname, "mica_sdk", "mica_worker.py");
      pool = new WorkerPool({
        warm,
        max,
        spawnFn: localSpawnFn("/usr/bin/python3", workerPath),
        label: projectId,
      });
    }

    if (this.rpcHandler) pool.setRpcHandler(this.rpcHandler);
    await pool.start();

    this.sandboxes.set(projectId, {
      projectId,
      containerName,
      pool,
      status: "running",
    });

    return pool;
  }

  /** Start a Docker container for a project. */
  private async startContainer(
    projectId: string,
    containerName: string,
    config: SandboxConfig
  ): Promise<void> {
    // Remove any existing container with this name (idempotent)
    try {
      await execFileAsync("docker", ["rm", "-f", containerName], { timeout: 10000 });
    } catch { /* not running */ }

    const mounts = await getProjectMounts(projectId);
    const memory = config.memory ?? "1g";

    // Single container for all project operations:
    // - Agent subprocesses (full network for Claude API)
    // - App runtime (serves on exposed ports)
    // Cards run in V8 isolates on the host — no card workers in the container.
    // Container's job: blast radius (filesystem scoping) + resource limits.
    const dockerArgs = [
      "run", "-d",
      "--name", containerName,
      "--network", "bridge",
      "--memory", memory,
      "--cpus", "2.0",
    ];

    // Shared project mounts (project repo, card-classes, SDK)
    for (const vol of mounts.volumes) {
      dockerArgs.push("-v", vol);
    }

    // Expose a port range for app runtime (8080-8089 inside → 9000-9009 on host)
    for (let i = 0; i < 10; i++) {
      dockerArgs.push("-p", `${9000 + i}:${8080 + i}`);
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

    // No setup phase needed — card classes run in V8 isolates on the host,
    // not in the container. Container is just blast radius for agents/apps.
  }

  /**
   * Tear down a sandbox's pool and remove it from tracking,
   * WITHOUT removing the Docker container (it may already be gone).
   */
  private async teardownSandbox(projectId: string): Promise<void> {
    const sandbox = this.sandboxes.get(projectId);
    if (!sandbox) return;

    sandbox.status = "stopped";
    await sandbox.pool.stop();
    this.sandboxes.delete(projectId);

    // Best-effort container removal
    if (await this.isDockerAvailable()) {
      try {
        await execFileAsync("docker", ["rm", "-f", sandbox.containerName], { timeout: 10000 });
      } catch { /* already gone */ }
    }
  }

  /** Stop a project's sandbox. */
  async stopSandbox(projectId: string): Promise<void> {
    await this.teardownSandbox(projectId);
    console.log(`[sandbox] Stopped container ${CONTAINER_PREFIX}${projectId}`);
  }

  /** Stop all sandboxes (server shutdown). */
  async stopAll(): Promise<void> {
    const ids = [...this.sandboxes.keys()];
    await Promise.all(ids.map((id) => this.stopSandbox(id)));
  }

  /** Evict idle workers under memory pressure for a project. */
  evictIdleWorkers(projectId: string) {
    const sandbox = this.sandboxes.get(projectId);
    if (sandbox) sandbox.pool.evictIdleWorkers();
  }

  /** Check if a project has a running sandbox. */
  hasSandbox(projectId: string): boolean {
    const sandbox = this.sandboxes.get(projectId);
    return sandbox?.status === "running";
  }

  /** Get stats for all sandboxes. */
  getStats(): Array<{ projectId: string; workers: number; idle: number; status: string }> {
    return [...this.sandboxes.values()].map((s) => ({
      projectId: s.projectId,
      workers: s.pool.workerCount,
      idle: s.pool.idleCount,
      status: s.status,
    }));
  }
}
