/**
 * ProjectExecutor — centralized execution layer for project containers.
 *
 * ALL code execution within a project goes through this class:
 * - Shell commands (mica.exec)
 * - Interactive PTY sessions (terminal cards, shell channels)
 * - Agent subprocess spawning (Claude Code CLI)
 *
 * This is the single point where the containerization policy is enforced.
 * Callers never touch Docker directly — they call ProjectExecutor methods,
 * which route to the appropriate sandbox.
 */

import { execFile } from "child_process";
import { spawn } from "child_process";
import { promisify } from "util";
import type { SandboxManager } from "./projectSandbox.js";
import type { SpawnOptions, SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import { getProjectPath } from "./projectConnection.js";
import { CONTAINER_PROJECT_DIR } from "./dockerSpawn.js";

const execFileAsync = promisify(execFile);

export class ProjectExecutor {
  constructor(private sandboxManager: SandboxManager) {}

  // ── Shell command execution (request/response) ──────────────

  /**
   * Run a shell command inside the project container.
   * Used by mica.exec() RPC handler.
   */
  async exec(
    project: string,
    command: string,
    opts?: { cwd?: string; timeout?: number },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const containerName = await this.sandboxManager.getContainerName(project);
    const cwd = opts?.cwd || CONTAINER_PROJECT_DIR;
    const timeout = Math.min(opts?.timeout || 30000, 300000);

    return new Promise((resolve) => {
      execFile("docker", [
        "exec", "-w", cwd, containerName,
        "/bin/bash", "-c", command,
      ], { timeout, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
        resolve({
          stdout: stdout || "",
          stderr: stderr || "",
          exitCode: err && "code" in err ? (err as { code?: number }).code ?? 1 : 0,
        });
      });
    });
  }

  // ── Interactive PTY (bidirectional channel) ─────────────────

  /**
   * Get spawn override for running a PTY inside the project container.
   * Used by terminal cards and shell channels — passed to TerminalChannelManager.
   */
  async getContainerShell(project: string): Promise<{
    shell: string;
    args: string[];
    cwd: string;
  }> {
    const containerName = await this.sandboxManager.getContainerName(project);
    return {
      shell: "docker",
      args: ["exec", "-it", containerName, "/bin/bash", "--login"],
      cwd: CONTAINER_PROJECT_DIR,
    };
  }

  // ── Agent subprocess spawning ───────────────────────────────

  /**
   * Create a spawner function for Claude Agent SDK subprocesses.
   * The spawner runs `docker exec` into the project container.
   * Used by agents.ts and claudeCode.ts.
   */
  async createAgentSpawner(
    project: string,
    canvas: string,
    onStderr?: (line: string) => void,
  ): Promise<(options: SpawnOptions) => SpawnedProcess> {
    const containerName = await this.sandboxManager.getContainerName(project);

    return (spawnOpts: SpawnOptions): SpawnedProcess => {
      const dockerArgs = [
        "exec", "-i",
      ];

      // Forward environment variables (auth tokens, etc.)
      const blockedEnv = new Set(["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT"]);
      for (const [key, value] of Object.entries(spawnOpts.env)) {
        if (value !== undefined && !blockedEnv.has(key)) {
          dockerArgs.push("-e", `${key}=${value}`);
        }
      }
      dockerArgs.push("-e", "HOME=/home/sandbox");

      dockerArgs.push(containerName);
      dockerArgs.push(spawnOpts.command, ...spawnOpts.args);

      const proc = spawn("docker", dockerArgs, {
        stdio: ["pipe", "pipe", "pipe"],
      });

      // Wire abort signal
      if (spawnOpts.signal) {
        const onAbort = () => {
          proc.kill("SIGTERM");
        };
        spawnOpts.signal.addEventListener("abort", onAbort, { once: true });
        proc.on("exit", () => {
          spawnOpts.signal.removeEventListener("abort", onAbort);
        });
      }

      // Log stderr for debugging + forward to caller if requested
      proc.stderr?.on("data", (data: Buffer) => {
        const line = data.toString().trim();
        console.error(`[agent:${project}/${canvas}] ${line}`);
        onStderr?.(line);
      });

      return proc as unknown as SpawnedProcess;
    };
  }

  // ── Docker exec helpers (for app runtime, etc.) ─────────────

  /**
   * Run a detached command in the project container.
   * Used by app runtime launcher (projectContainer.ts).
   */
  async execDetached(
    project: string,
    command: string,
    opts?: { cwd?: string; env?: Record<string, string> },
  ): Promise<void> {
    const containerName = await this.sandboxManager.getContainerName(project);

    const dockerArgs = ["exec", "-d", "-w", opts?.cwd || CONTAINER_PROJECT_DIR];
    if (opts?.env) {
      for (const [key, value] of Object.entries(opts.env)) {
        dockerArgs.push("-e", `${key}=${value}`);
      }
    }
    dockerArgs.push(containerName, "/bin/bash", "-c", command);

    await execFileAsync("docker", dockerArgs);
  }

  /**
   * Run a command and capture output.
   * Used by projectContainer.ts for pkill, docker inspect, etc.
   */
  async execCapture(
    project: string,
    args: string[],
    opts?: { timeout?: number },
  ): Promise<{ stdout: string; stderr: string }> {
    const containerName = await this.sandboxManager.getContainerName(project);
    return execFileAsync("docker", ["exec", containerName, ...args], {
      timeout: opts?.timeout || 10000,
    });
  }

  /**
   * Get container name for a project (passthrough to SandboxManager).
   * Ensures the container is running.
   */
  async getContainerName(project: string): Promise<string> {
    return this.sandboxManager.getContainerName(project);
  }
}
