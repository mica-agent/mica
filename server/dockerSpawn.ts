/**
 * dockerSpawn — Docker-based sandboxing for all container operations.
 *
 * Provides shared container configuration (image, mounts) and the
 * spawner factory for Claude Agent SDK subprocess containers.
 *
 * Two container systems use this shared config:
 * - Card workers (projectSandbox.ts): long-lived, network-isolated after setup
 * - Agent subprocesses (this file): ephemeral, network-connected for API access
 */

import { spawn, execSync } from "child_process";
import { createHash } from "crypto";
import { writeFileSync, unlinkSync } from "fs";
import { join, resolve } from "path";
import { tmpdir } from "os";
import { fileURLToPath } from "url";
import type { SpawnOptions, SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import { getProjectPath, getCanvasDir } from "./projectConnection.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = join(__filename, "..");
export const SANDBOX_IMAGE = "mica-sandbox:base";
export const CARD_CLASSES_DIR = resolve("card-classes");

// ── Shared project mount config ─────────────────────────────
// Single source of truth for how project files are mounted into containers.

export interface ProjectMounts {
  projectPath: string;
  volumes: string[];     // Docker -v args (pairs: mount spec)
  workdir: string;
}

/**
 * Get the standard Docker volume mounts for a project.
 * Used by both card worker containers and agent subprocess containers.
 */
// Node modules path — mounted so agent CLI (claude-agent-sdk) is available inside container
const NODE_MODULES_DIR = resolve("node_modules");

// Container-internal paths — isolate from host paths for blast radius containment.
// The project, card-classes, and SDK are mounted at fixed paths inside the container
// so cards/agents can't discover or traverse host filesystem structure.
export const CONTAINER_PROJECT_DIR = "/project";
const CONTAINER_CARD_CLASSES = "/opt/mica/card-classes";
const CONTAINER_NODE_MODULES = "/opt/mica/node_modules";
const CONTAINER_RUNTIME_DIR = "/opt/mica/runtime";
export const RUNTIME_DIR = join(__dirname, "container-runtime");

export async function getProjectMounts(projectId: string): Promise<ProjectMounts> {
  const projectPath = await getProjectPath(projectId);
  // Mount the canvas card directory (where child cards live) as /project
  const canvasDir = await getCanvasDir(projectId, "_root");
  return {
    projectPath,
    volumes: [
      `${canvasDir}:${CONTAINER_PROJECT_DIR}:rw`,
      `${CARD_CLASSES_DIR}:${CONTAINER_CARD_CLASSES}:rw`,
      `${NODE_MODULES_DIR}:${CONTAINER_NODE_MODULES}:ro`,
      `${RUNTIME_DIR}:${CONTAINER_RUNTIME_DIR}:ro`,
      // ~/.claude/ for Claude Code CLI: credentials, settings, plugins, sessions.
      `${process.env.HOME}/.claude:/home/sandbox/.claude:rw`,
      `${process.env.HOME}/.claude.json:/home/sandbox/.claude.json:ro`,
    ],
    workdir: CONTAINER_PROJECT_DIR,
  };
}

// Cache of already-verified image tags
const imageCache = new Set<string>();

// ── brief.md dependency parsing ─────────────────────────────

export interface SandboxDeps {
  apt: string[];
  pip: string[];
}

export function parseDependencies(briefContent: string): SandboxDeps {
  const deps: SandboxDeps = { apt: [], pip: [] };

  // Find ## Dependencies section
  const match = briefContent.match(
    /## Dependencies\s*\n([\s\S]*?)(?=\n## |\n# |$)/i
  );
  if (!match) return deps;

  const section = match[1];
  for (const line of section.split("\n")) {
    const trimmed = line.trim();
    // Skip HTML comments and empty lines
    if (!trimmed || trimmed.startsWith("<!--")) continue;

    const aptMatch = trimmed.match(/^-\s*apt:\s*(.+)/i);
    if (aptMatch) {
      deps.apt.push(
        ...aptMatch[1].split(",").map((s) => s.trim()).filter(Boolean)
      );
      continue;
    }

    const pipMatch = trimmed.match(/^-\s*pip:\s*(.+)/i);
    if (pipMatch) {
      deps.pip.push(
        ...pipMatch[1].split(",").map((s) => s.trim()).filter(Boolean)
      );
    }
  }

  return deps;
}

// ── Image management ─────────────────────────────────────────

function depsHash(deps: SandboxDeps): string {
  const key = `apt:${[...deps.apt].sort().join(",")}|pip:${[...deps.pip].sort().join(",")}`;
  return createHash("sha256").update(key).digest("hex").slice(0, 12);
}

function imageExists(tag: string): boolean {
  if (imageCache.has(tag)) return true;
  try {
    execSync(`docker image inspect ${tag}`, { stdio: "ignore" });
    imageCache.add(tag);
    return true;
  } catch {
    return false;
  }
}

export async function getOrBuildImage(deps: SandboxDeps): Promise<string> {
  // No custom deps — use base image directly
  if (deps.apt.length === 0 && deps.pip.length === 0) {
    return BASE_IMAGE;
  }

  const hash = depsHash(deps);
  const tag = `mica-sandbox:${hash}`;

  if (imageExists(tag)) return tag;

  // Build a derived image with the requested packages
  console.log(`[docker-spawn] Building image ${tag} with deps:`, deps);

  const lines = [`FROM ${BASE_IMAGE}`, "USER root"];
  if (deps.apt.length > 0) {
    lines.push(
      `RUN apt-get update && apt-get install -y --no-install-recommends ${deps.apt.join(" ")} && rm -rf /var/lib/apt/lists/*`
    );
  }
  if (deps.pip.length > 0) {
    lines.push(`RUN pip install --no-cache-dir ${deps.pip.join(" ")}`);
  }
  lines.push("USER sandbox");

  const tmpDockerfile = join(tmpdir(), `mica-sandbox-${hash}.Dockerfile`);
  writeFileSync(tmpDockerfile, lines.join("\n") + "\n");

  try {
    execSync(`docker build -t ${tag} -f ${tmpDockerfile} .`, {
      cwd: tmpdir(),
      stdio: "inherit",
      timeout: 300000, // 5 min build timeout
    });
    imageCache.add(tag);
  } finally {
    try { unlinkSync(tmpDockerfile); } catch { /* ignore */ }
  }

  return tag;
}

// ── Docker spawner factory ───────────────────────────────────
// Runs the Claude Agent SDK CLI inside the shared project container
// via `docker exec`, not `docker run`. The container is managed by
// SandboxManager and shared with card workers and app runtime.

export function createAgentSpawner(
  containerName: string,
  project: string,
  canvas: string,
  onStderr?: (line: string) => void,
): (options: SpawnOptions) => SpawnedProcess {
  return (spawnOpts: SpawnOptions): SpawnedProcess => {
    const dockerArgs = [
      "exec", "-i",
      // Container runs as 'sandbox' (UID 1000), matching the host user.
      // No --user override needed — inherits the container's default user.
    ];

    // Forward environment variables (auth tokens, etc.)
    // Filter out CLAUDECODE — it prevents the CLI from running inside the container
    // (the host sets CLAUDECODE=1 to detect nested sessions, but the container is independent)
    const blockedEnv = new Set(["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT"]);
    for (const [key, value] of Object.entries(spawnOpts.env)) {
      if (value !== undefined && !blockedEnv.has(key)) {
        dockerArgs.push("-e", `${key}=${value}`);
      }
    }
    // Point HOME to the sandbox user dir where credentials are mounted
    dockerArgs.push("-e", "HOME=/home/sandbox");

    dockerArgs.push(containerName);

    // Append the original command and args
    dockerArgs.push(spawnOpts.command, ...spawnOpts.args);

    const proc = spawn("docker", dockerArgs, {
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Wire abort signal
    if (spawnOpts.signal) {
      const onAbort = () => {
        // Kill the exec'd process, not the container
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
