// git.ts — REST endpoints for the .gitrepo card class.
//
// Every route scopes to a project via X-Mica-Project (or ?project=) and
// runs the `git` CLI from that project's directory using execFile — NOT
// execAsync. execFile passes the command and its arguments as distinct
// argv entries, so user-supplied strings (commit messages, file paths)
// can never be shell-interpolated into additional commands.
//
// The card class only exposes MVP operations: status, stage, unstage,
// commit, push, pull (ff-only), init. Destructive or history-rewriting
// ops (force-push, reset --hard, rebase, clean) stay the agent's job
// via the terminal card — keeping them out of the button surface is a
// deliberate safety choice, not a TODO.

import type { Express, Request, Response } from "express";
import { execFile as execFileCb } from "child_process";
import { promisify } from "util";
import { existsSync } from "fs";
import { join } from "path";
import { projectDir } from "../files.js";

const execFile = promisify(execFileCb);

interface RegisterOpts {
  getRequestProject: (req: Request) => string | null;
}

/**
 * Resolve the project's absolute working dir, or respond with 400 and
 * return null if the project is missing / invalid.
 */
function resolveCwd(req: Request, res: Response, getRequestProject: (req: Request) => string | null): string | null {
  const proj = getRequestProject(req);
  if (!proj) {
    res.status(400).json({ error: "missing project (X-Mica-Project header)" });
    return null;
  }
  try {
    return projectDir(proj);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
    return null;
  }
}

/**
 * Validate a list of project-relative file paths: must be strings, must
 * not contain .. segments, must not be absolute. Matches the discipline
 * in server/files.ts validateFilename without requiring that export.
 */
function validatePaths(paths: unknown): string[] | { error: string } {
  if (!Array.isArray(paths)) return { error: "`files` must be an array of relative paths" };
  const out: string[] = [];
  for (const p of paths) {
    if (typeof p !== "string" || !p) return { error: "each file path must be a non-empty string" };
    if (p.includes("..")) return { error: `path traversal not allowed: ${p}` };
    if (p.startsWith("/") || p.startsWith("\\")) return { error: `absolute paths not allowed: ${p}` };
    out.push(p);
  }
  return out;
}

/** Run `git <args>` in cwd and return captured stdout/stderr. Never
 *  throws — on non-zero exit, returns { ok: false, code, stdout, stderr }. */
async function runGit(cwd: string, args: string[], opts: { maxBuffer?: number; timeout?: number } = {}): Promise<{
  ok: boolean; code: number; stdout: string; stderr: string;
}> {
  try {
    const { stdout, stderr } = await execFile("git", args, {
      cwd,
      maxBuffer: opts.maxBuffer ?? 5 * 1024 * 1024,
      timeout: opts.timeout ?? 30_000,
    });
    return { ok: true, code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string; message?: string };
    return {
      ok: false,
      code: typeof e.code === "number" ? e.code : 1,
      stdout: e.stdout || "",
      stderr: e.stderr || (e.message ?? "git failed"),
    };
  }
}

/** Parse `git status --porcelain=v1 -b` into the card's expected shape.
 *  The branch header line is `## <branch>` or `## <branch>...<upstream>
 *  [ahead N, behind M]`. Detached HEAD: `## HEAD (no branch)`. */
function parseStatus(porcelain: string): {
  branch: string; ahead: number; behind: number; hasRemote: boolean;
  staged: string[]; unstaged: string[]; untracked: string[];
} {
  const lines = porcelain.split("\n");
  let branch = "(unknown)";
  let ahead = 0;
  let behind = 0;
  let hasRemote = false;
  const staged: string[] = [];
  const unstaged: string[] = [];
  const untracked: string[] = [];

  for (const raw of lines) {
    if (!raw) continue;
    if (raw.startsWith("## ")) {
      const rest = raw.slice(3);
      // Detached: "HEAD (no branch)"
      if (rest.startsWith("HEAD (no branch)")) { branch = "HEAD (detached)"; continue; }
      // Normal: "<branch>" or "<branch>...<upstream> [ahead 2, behind 1]"
      const upstreamIdx = rest.indexOf("...");
      if (upstreamIdx !== -1) {
        branch = rest.slice(0, upstreamIdx);
        hasRemote = true;
        const bracket = rest.indexOf(" [", upstreamIdx);
        if (bracket !== -1) {
          const inner = rest.slice(bracket + 2, rest.lastIndexOf("]"));
          const aheadMatch = inner.match(/ahead (\d+)/);
          const behindMatch = inner.match(/behind (\d+)/);
          if (aheadMatch) ahead = parseInt(aheadMatch[1], 10);
          if (behindMatch) behind = parseInt(behindMatch[1], 10);
        }
      } else {
        branch = rest.trim();
      }
      continue;
    }
    // File lines: "XY path" where X = index state, Y = worktree state.
    // Untracked is "??". Rename/copy entries ("R  old -> new") split at
    // " -> " — we report the NEW path.
    const x = raw[0];
    const y = raw[1];
    let path = raw.slice(3);
    const arrow = path.indexOf(" -> ");
    if (arrow !== -1) path = path.slice(arrow + 4);
    if (x === "?" && y === "?") { untracked.push(path); continue; }
    if (x !== " " && x !== "?") staged.push(path);
    if (y !== " " && y !== "?") unstaged.push(path);
  }
  return { branch, ahead, behind, hasRemote, staged, unstaged, untracked };
}

export function registerGitEndpoints(app: Express, opts: RegisterOpts): void {
  const { getRequestProject } = opts;

  app.get("/api/git/status", async (req, res) => {
    const cwd = resolveCwd(req, res, getRequestProject);
    if (!cwd) return;
    if (!existsSync(join(cwd, ".git"))) {
      res.json({ hasGit: false });
      return;
    }
    const s = await runGit(cwd, ["status", "--porcelain=v1", "-b"]);
    if (!s.ok) {
      res.status(500).json({ error: s.stderr || "git status failed" });
      return;
    }
    const parsed = parseStatus(s.stdout);
    res.json({ hasGit: true, ...parsed });
  });

  app.post("/api/git/stage", async (req, res) => {
    const cwd = resolveCwd(req, res, getRequestProject);
    if (!cwd) return;
    const body = (req.body || {}) as { files?: unknown };
    const paths = validatePaths(body.files);
    if (!Array.isArray(paths)) { res.status(400).json(paths); return; }
    if (paths.length === 0) { res.json({ ok: true }); return; }
    const r = await runGit(cwd, ["add", "--", ...paths]);
    if (!r.ok) { res.status(500).json({ ok: false, error: r.stderr, stdout: r.stdout }); return; }
    res.json({ ok: true });
  });

  app.post("/api/git/unstage", async (req, res) => {
    const cwd = resolveCwd(req, res, getRequestProject);
    if (!cwd) return;
    const body = (req.body || {}) as { files?: unknown };
    const paths = validatePaths(body.files);
    if (!Array.isArray(paths)) { res.status(400).json(paths); return; }
    if (paths.length === 0) { res.json({ ok: true }); return; }
    // `git reset HEAD --` is the classic unstage form and works whether
    // HEAD exists or not (returns fatal on an empty repo — surface the
    // stderr so the user knows). Git 2.23+ has `git restore --staged`
    // but we prefer broader compatibility.
    const r = await runGit(cwd, ["reset", "HEAD", "--", ...paths]);
    if (!r.ok) { res.status(500).json({ ok: false, error: r.stderr, stdout: r.stdout }); return; }
    res.json({ ok: true });
  });

  app.post("/api/git/commit", async (req, res) => {
    const cwd = resolveCwd(req, res, getRequestProject);
    if (!cwd) return;
    const body = (req.body || {}) as { message?: unknown };
    const message = typeof body.message === "string" ? body.message.trim() : "";
    if (!message) { res.status(400).json({ error: "message required" }); return; }
    const r = await runGit(cwd, ["commit", "-m", message]);
    if (!r.ok) {
      res.status(400).json({ ok: false, error: r.stderr || r.stdout, stdout: r.stdout, stderr: r.stderr });
      return;
    }
    // Resolve the resulting SHA so the card can echo it. Fail-open: if
    // rev-parse can't read HEAD (bizarre), still report ok with no sha.
    const h = await runGit(cwd, ["rev-parse", "HEAD"]);
    const sha = h.ok ? h.stdout.trim().slice(0, 7) : "";
    res.json({ ok: true, sha, stdout: r.stdout, stderr: r.stderr });
  });

  app.post("/api/git/push", async (req, res) => {
    const cwd = resolveCwd(req, res, getRequestProject);
    if (!cwd) return;
    let r = await runGit(cwd, ["push"], { timeout: 60_000 });
    // First-push case: a fresh branch has no upstream tracking ref, so
    // `git push` errors with "no upstream branch" and suggests
    // --set-upstream. The button can't ask the user to drop into a
    // terminal for that — auto-retry with the current branch as the
    // tracking target. This is the one-time setup almost everyone wants;
    // modern git ships push.autoSetupRemote=true for the same reason.
    if (!r.ok && /no upstream branch/i.test(r.stderr || "")) {
      const branchR = await runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
      const branch = branchR.ok ? branchR.stdout.trim() : "";
      if (branch && branch !== "HEAD") {
        r = await runGit(cwd, ["push", "--set-upstream", "origin", branch], { timeout: 60_000 });
      }
    }
    if (!r.ok) {
      res.status(400).json({ ok: false, error: r.stderr || r.stdout, stdout: r.stdout, stderr: r.stderr });
      return;
    }
    res.json({ ok: true, stdout: r.stdout, stderr: r.stderr });
  });

  app.post("/api/git/pull", async (req, res) => {
    const cwd = resolveCwd(req, res, getRequestProject);
    if (!cwd) return;
    // ff-only: refuse to create a merge commit if the branches have
    // diverged. Surface the stderr so the user sees exactly why and can
    // resolve via the terminal card.
    const r = await runGit(cwd, ["pull", "--ff-only"], { timeout: 60_000 });
    if (!r.ok) {
      res.status(400).json({ ok: false, error: r.stderr || r.stdout, stdout: r.stdout, stderr: r.stderr });
      return;
    }
    res.json({ ok: true, stdout: r.stdout, stderr: r.stderr });
  });

  app.post("/api/git/init", async (req, res) => {
    const cwd = resolveCwd(req, res, getRequestProject);
    if (!cwd) return;
    if (existsSync(join(cwd, ".git"))) {
      res.json({ ok: true, alreadyInitialized: true });
      return;
    }
    const r = await runGit(cwd, ["init"]);
    if (!r.ok) {
      res.status(500).json({ ok: false, error: r.stderr || r.stdout });
      return;
    }
    res.json({ ok: true });
  });
}
