/**
 * dockerSpawn — Docker-based sandboxing for agent Bash execution (PROD mode).
 *
 * When MICA_MODE=prod, the Claude Agent SDK's CLI process is spawned inside
 * a Docker container instead of locally. MCP tools still run server-side —
 * only Bash tool execution is sandboxed.
 *
 * The container mounts only the relevant project/canvas directory and has
 * outbound HTTP access (for pip install, API calls, etc.).
 */

import { spawn, execSync } from "child_process";
import { createHash } from "crypto";
import { writeFileSync, mkdirSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { SpawnOptions, SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import { readCanvasFile, getProjectConfig } from "./canvasFiles.js";
import { getProjectPath, getCanvasDir } from "./projectConnection.js";

const SESSIONS_ROOT = join(process.cwd(), ".sessions");
const BASE_IMAGE = "mica-sandbox:base";

// Cache of already-verified image tags
const imageCache = new Set<string>();

// ── _brief.brief dependency parsing ─────────────────────────────

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

// ── DEV/PROD mode check ──────────────────────────────────────

export async function isDockerEnabled(project: string): Promise<boolean> {
  // Per-project override
  const config = await getProjectConfig(project);
  if (config && "sandbox" in config) {
    return (config as any).sandbox === "docker";
  }
  // Global switch
  return process.env.MICA_MODE === "prod";
}

// ── Docker spawner factory ───────────────────────────────────

export async function createDockerSpawner(
  project: string,
  canvas: string
): Promise<(options: SpawnOptions) => SpawnedProcess> {
  // Read _brief.brief for dependency declarations
  let deps: SandboxDeps = { apt: [], pip: [] };
  try {
    const brief = await readCanvasFile(project, canvas, "_brief.brief");
    deps = parseDependencies(brief.content);
  } catch {
    // No _brief.brief — use base image
  }

  const imageTag = await getOrBuildImage(deps);
  const canvasDir = await getCanvasDir(project, canvas);
  const sessionDir = join(SESSIONS_ROOT, project, canvas);

  // Ensure session directory exists
  mkdirSync(sessionDir, { recursive: true });

  return (spawnOpts: SpawnOptions): SpawnedProcess => {
    const containerName = `mica-sandbox-${project}-${canvas}-${Date.now()}`;

    const dockerArgs = [
      "run", "--rm", "-i",
      "--name", containerName,
      "--network", "bridge",
      "--memory", "512m",
      "--cpus", "1.0",
      "-v", `${canvasDir}:/workspace:rw`,
      "-v", `${sessionDir}:/home/sandbox/.claude:rw`,
      "-w", "/workspace",
    ];

    // Forward environment variables (auth tokens, etc.)
    for (const [key, value] of Object.entries(spawnOpts.env)) {
      if (value !== undefined) {
        dockerArgs.push("-e", `${key}=${value}`);
      }
    }

    dockerArgs.push(imageTag);

    // Append the original command and args
    dockerArgs.push(spawnOpts.command, ...spawnOpts.args);

    const proc = spawn("docker", dockerArgs, {
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Wire abort signal to kill the container
    if (spawnOpts.signal) {
      const onAbort = () => {
        try {
          execSync(`docker kill ${containerName}`, { stdio: "ignore" });
        } catch { /* container may already be gone */ }
      };
      spawnOpts.signal.addEventListener("abort", onAbort, { once: true });
      proc.on("exit", () => {
        spawnOpts.signal.removeEventListener("abort", onAbort);
      });
    }

    // Log stderr for debugging
    proc.stderr?.on("data", (data: Buffer) => {
      console.error(`[sandbox:${project}/${canvas}] ${data.toString().trim()}`);
    });

    return proc as unknown as SpawnedProcess;
  };
}
