/**
 * ProjectSandbox — Manages per-project Docker containers with --network=none.
 *
 * Each project gets an isolated container running Python workers.
 * All untrusted card code executes inside this container.
 * The Mica server (on the host) communicates with workers via docker exec pipes.
 */

import { execFile } from "child_process";
import { promisify } from "util";
import path from "path";
import { fileURLToPath } from "url";
import { WorkerPool, dockerSpawnFn, localSpawnFn, buildWorkerEnv, type WorkerPoolOptions, type RpcHandler } from "./workerPool.js";
import { getProjectPath, getProjectConfig } from "./projectConnection.js";

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

const SANDBOX_IMAGE = "mica-sandbox:base";
const CARD_CLASSES_DIR = path.resolve("card-classes");
const SDK_DIR = path.join(__dirname, "mica_sdk");
const WORKER_PATH_IN_CONTAINER = "/mica-sdk/mica_worker.py";

// ── SandboxManager ─────────────────────────────────────────

export class SandboxManager {
  private sandboxes: Map<string, ProjectSandboxInfo> = new Map();
  private rpcHandler: RpcHandler | null = null;
  private dockerAvailable: boolean | null = null;

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

  setRpcHandler(handler: RpcHandler) {
    this.rpcHandler = handler;
    for (const sandbox of this.sandboxes.values()) {
      sandbox.pool.setRpcHandler(handler);
    }
  }

  /** Get or create a sandbox for a project. */
  async getPool(projectId: string): Promise<WorkerPool> {
    const existing = this.sandboxes.get(projectId);
    if (existing && existing.status === "running") return existing.pool;
    return this.startSandbox(projectId);
  }

  /** Start a sandbox for a project. Idempotent — reuses existing if running. */
  async startSandbox(projectId: string): Promise<WorkerPool> {
    const existing = this.sandboxes.get(projectId);
    if (existing && existing.status === "running") return existing.pool;

    const useDocker = await this.isDockerAvailable();
    const containerName = `mica-project-${projectId}`;

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
      // Start the Docker container
      await this.startContainer(projectId, containerName, config);

      // Create worker pool that spawns via docker exec
      pool = new WorkerPool({
        warm,
        max,
        spawnFn: dockerSpawnFn(containerName, WORKER_PATH_IN_CONTAINER),
        label: projectId,
      });
    } else {
      // Fallback: local workers (no container isolation)
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
    // Stop existing container if any
    try {
      await execFileAsync("docker", ["rm", "-f", containerName], { timeout: 10000 });
    } catch { /* not running */ }

    const projectPath = await getProjectPath(projectId);
    const memory = config.memory ?? "1g";

    const dockerArgs = [
      "run", "-d",
      "--name", containerName,
      "--network", "none",
      "--memory", memory,
      "--cpus", "2.0",
      // Mount project directory
      "-v", `${projectPath}:/workspace:rw`,
      // Mount built-in card classes (read-only)
      "-v", `${CARD_CLASSES_DIR}:/card-classes:ro`,
      // Mount SDK (read-only)
      "-v", `${SDK_DIR}:/mica-sdk:ro`,
      // Working directory
      "-w", "/workspace",
      // Filtered environment
      "-e", `PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
      "-e", `HOME=/home/sandbox`,
      "-e", `TERM=xterm-256color`,
      "-e", `PYTHONPATH=/mica-sdk`,
      // Image + keep alive
      SANDBOX_IMAGE,
      "sleep", "infinity",
    ];

    try {
      await execFileAsync("docker", dockerArgs, { timeout: 30000 });
      console.log(`[sandbox] Started container ${containerName} for project "${projectId}" (--network=none, ${memory} RAM)`);
    } catch (err) {
      console.error(`[sandbox] Failed to start container for "${projectId}":`, (err as Error).message);
      throw err;
    }
  }

  /** Stop a project's sandbox. */
  async stopSandbox(projectId: string): Promise<void> {
    const sandbox = this.sandboxes.get(projectId);
    if (!sandbox) return;

    sandbox.status = "stopped";
    await sandbox.pool.stop();

    if (await this.isDockerAvailable()) {
      try {
        await execFileAsync("docker", ["rm", "-f", sandbox.containerName], { timeout: 10000 });
        console.log(`[sandbox] Stopped container ${sandbox.containerName}`);
      } catch { /* already stopped */ }
    }

    this.sandboxes.delete(projectId);
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
