// Per-project git operations — each project is a sovereign git repo.
// Mica reads/writes git state but doesn't own the repo.

import { execFile } from "child_process";
import { promisify } from "util";
import { getProjectPath } from "./projectConnection.js";

const execFileAsync = promisify(execFile);

// Per-project mutex to prevent concurrent git operations
const locks = new Map<string, Promise<unknown>>();

async function withLock<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(projectId) || Promise.resolve();
  const next = prev.then(fn, fn); // run even if prev failed
  locks.set(projectId, next);
  try {
    return await next;
  } finally {
    if (locks.get(projectId) === next) locks.delete(projectId);
  }
}

async function git(
  projectId: string,
  args: string[]
): Promise<string> {
  const cwd = await getProjectPath(projectId);
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout;
}

// ── Types ──────────────────────────────────────────────────

export interface GitStatus {
  clean: boolean;
  staged: string[];
  modified: string[];
  untracked: string[];
}

export interface GitLogEntry {
  hash: string;
  shortHash: string;
  message: string;
  date: string;
}

export interface GitCommitResult {
  hash: string;
  message: string;
  filesChanged: number;
}

export interface GitBranchInfo {
  current: string;
  branches: string[];
}

// ── Operations ─────────────────────────────────────────────

export async function getGitStatus(projectId: string): Promise<GitStatus> {
  return withLock(projectId, async () => {
    const output = await git(projectId, ["status", "--porcelain"]);
    const lines = output.trim().split("\n").filter(Boolean);

    const staged: string[] = [];
    const modified: string[] = [];
    const untracked: string[] = [];

    for (const line of lines) {
      const index = line[0];
      const work = line[1];
      const file = line.slice(3);

      if (index === "?" && work === "?") {
        untracked.push(file);
      } else if (index !== " " && index !== "?") {
        staged.push(file);
      }
      if (work !== " " && work !== "?") {
        modified.push(file);
      }
    }

    return {
      clean: lines.length === 0,
      staged,
      modified,
      untracked,
    };
  });
}

export async function gitCommit(
  projectId: string,
  message: string
): Promise<GitCommitResult> {
  return withLock(projectId, async () => {
    // Stage all changes
    await git(projectId, ["add", "-A"]);

    // Check if there's anything to commit
    const status = await git(projectId, ["status", "--porcelain"]);
    if (!status.trim()) {
      throw new Error("Nothing to commit");
    }

    // Commit
    await git(projectId, ["commit", "-m", message]);

    // Get the commit info
    const hashOutput = await git(projectId, ["rev-parse", "--short", "HEAD"]);
    const hash = hashOutput.trim();

    // Count files changed
    const diffOutput = await git(projectId, ["diff", "--stat", "HEAD~1..HEAD"]);
    const filesChanged = (diffOutput.match(/\d+ files? changed/)?.[0]?.match(/\d+/)?.[0]) || "0";

    return {
      hash,
      message,
      filesChanged: parseInt(filesChanged, 10),
    };
  });
}

export async function gitLog(
  projectId: string,
  limit: number = 50
): Promise<GitLogEntry[]> {
  try {
    const output = await git(projectId, [
      "log",
      `--max-count=${limit}`,
      "--format=%H|%h|%s|%aI",
    ]);

    return output
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [hash, shortHash, message, date] = line.split("|");
        return { hash, shortHash, message, date };
      });
  } catch {
    // No commits yet
    return [];
  }
}

export async function gitDiff(
  projectId: string,
  ref?: string
): Promise<string> {
  const args = ["diff"];
  if (ref) args.push(ref);
  return git(projectId, args);
}

export async function gitBranch(projectId: string): Promise<GitBranchInfo> {
  const output = await git(projectId, ["branch", "--no-color"]);
  const lines = output.trim().split("\n").filter(Boolean);
  let current = "main";
  const branches: string[] = [];

  for (const line of lines) {
    const name = line.replace(/^\*?\s+/, "").trim();
    branches.push(name);
    if (line.startsWith("*")) {
      current = name;
    }
  }

  // Handle empty repo (no branches yet)
  if (branches.length === 0) {
    branches.push("main");
  }

  return { current, branches };
}

export async function gitCheckout(
  projectId: string,
  branch: string,
  create: boolean = false
): Promise<void> {
  return withLock(projectId, async () => {
    const args = ["checkout"];
    if (create) args.push("-b");
    args.push(branch);
    await git(projectId, args);
  });
}
