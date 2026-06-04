// mica_install_skills — clone a third-party skills package into the project
// so future turns can invoke its skills via the `skill` tool. Fits into the
// canonical agent flow:
//   discover-dependency: "use Three.js 0.158.0"
//   → check if a Three.js skills package exists ("threejs-skills")
//   → mica_install_skills source="threejs-skills"
//   → next turn: agent has Three.js-specific procedural guidance available
//
// The package is cloned into `<project>/.qwen/skills/<name>/` and symlinked
// into `<project>/.claude/skills/<name>/` so all three agent backends pick
// up the new skills on their next turn through their standard skill-discovery
// mechanisms (qwen-code SDK auto-discovers SKILL.md files; Claude Agent SDK
// likewise; opencode reads Config.skills directories).

import { z } from "zod";
import { join } from "path";
import { mkdir, readdir, readFile, symlink, writeFile, lstat, unlink } from "fs/promises";
import { existsSync } from "fs";
import { execFile } from "child_process";
import { promisify } from "util";
import { WORKSPACE_DIR, getEffectiveWorkspaceDir, micaDir } from "../files.js";
import type { AgentToolDef, AgentToolResult } from "./registry.js";

const execFileP = promisify(execFile);

// Curated lookup table — well-known library → skills repo. Hint list, not a
// registry. Agent can also pass `github:owner/repo` or full URL directly.
// Expand as the ecosystem grows; ship empty rather than wrong.
//
// Each entry carries a `canonicalName` so EVERY alias for the same package
// resolves to the SAME install dirname. Without this, `source: "three"`
// installed to `.qwen/skills/three/` while `source: "threejs-skills"`
// installed to `.qwen/skills/threejs/` — and the `required-library-skills-installed`
// predicate in toolPrerequisites.ts (which only knows one dirname per
// library) would report "not installed" for the wrong-alias install. The
// canonicalName decouples agent-facing alias choice from on-disk layout.
interface SkillPackageEntry {
  url: string;
  canonicalName: string;
}
export const KNOWN_SKILL_PACKAGES: Record<string, SkillPackageEntry> = {
  three:             { url: "https://github.com/cloudai-x/threejs-skills.git", canonicalName: "threejs" },
  threejs:           { url: "https://github.com/cloudai-x/threejs-skills.git", canonicalName: "threejs" },
  "three.js":        { url: "https://github.com/cloudai-x/threejs-skills.git", canonicalName: "threejs" },
  "threejs-skills":  { url: "https://github.com/cloudai-x/threejs-skills.git", canonicalName: "threejs" },
  "three-skills":    { url: "https://github.com/cloudai-x/threejs-skills.git", canonicalName: "threejs" },
};

const inputSchema = {
  source: z
    .string()
    .describe(
      "Where to fetch the skills from. Accepts: " +
        "(a) a known shorthand like 'threejs-skills' or 'three' (lookup table), " +
        "(b) 'github:owner/repo' (clones https://github.com/owner/repo.git), or " +
        "(c) a full https:// URL to a git repo on github.com / gitlab.com / bitbucket.org. " +
        "The repository should follow the SKILL.md convention — each skill is a directory " +
        "containing SKILL.md with YAML frontmatter (name, description) and a markdown body.",
    ),
  name: z
    .string()
    .optional()
    .describe(
      "**OMIT THIS for curated shorthands** (e.g. 'threejs-skills'). The default " +
        "dirname is part of Mica's contract — the `required-library-skills-installed` " +
        "predicate looks at a specific dirname per library, and overriding it here " +
        "silently breaks that predicate (the install succeeds, then mica_create_class " +
        "still reports 'not installed'). Server-side enforces this for curated " +
        "shorthands by ignoring any override. " +
        "Only meaningful for github:/https: sources where you want a non-default " +
        "dirname. Alphanumeric, dash, underscore only.",
    ),
  approve: z
    .boolean()
    .optional()
    .describe(
      "Set to true ONLY after the user has explicitly approved installing a non-curated " +
        "URL via the chat. Curated shorthands (e.g. 'threejs-skills') and previously-approved " +
        "URLs install without this flag. For a new URL the agent has discovered (e.g. via " +
        "web_search), first call WITHOUT this flag — the tool returns a 'pending approval' " +
        "report listing the resolved URL; show it to the user; if they say yes, retry with " +
        "approve: true. The tool records the approval in <project>/.mica/skills-approvals.json " +
        "so subsequent installs of the same URL skip the gate.",
    ),
} as const;

interface ResolvedSource {
  url: string;
  defaultName: string;
  /** True when `source` was matched against the curated lookup table.
   *  Curated entries lock the install dirname to canonicalName — the
   *  agent's optional `name` arg is ignored for them, because the
   *  `required-library-skills-installed` predicate checks a specific
   *  dirname per library and a name override silently breaks that
   *  contract (observed: agent helpfully passed name="threejs-skills"
   *  expecting it to match, predicate then said "not installed"
   *  because it was looking for .qwen/skills/threejs/). */
  isCurated: boolean;
}

function resolveSource(source: string): ResolvedSource | { error: string } {
  // Lookup-table shorthand — preferred path; agent doesn't need to know URLs.
  // canonicalName from the table wins so every alias for the same package
  // installs to the same dirname (see KNOWN_SKILL_PACKAGES rationale).
  const entry = KNOWN_SKILL_PACKAGES[source];
  if (entry) {
    return { url: entry.url, defaultName: entry.canonicalName, isCurated: true };
  }
  // github:owner/repo[#ref]
  const ghMatch = source.match(/^github:([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+?)(?:\.git)?(?:#([a-zA-Z0-9_./-]+))?$/);
  if (ghMatch) {
    const [, owner, repo] = ghMatch;
    return {
      url: `https://github.com/${owner}/${repo}.git`,
      defaultName: repo.replace(/-skills$/, "").replace(/\.git$/, ""),
      isCurated: false,
    };
  }
  // Full https URL on a known git host.
  const urlMatch = source.match(
    /^https:\/\/(github\.com|gitlab\.com|bitbucket\.org)\/([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+?)(\.git)?$/,
  );
  if (urlMatch) {
    const repoPath = urlMatch[2];
    const repo = repoPath.split("/").pop() || "skills";
    return {
      url: source.endsWith(".git") ? source : `${source}.git`,
      defaultName: repo.replace(/-skills$/, ""),
      isCurated: false,
    };
  }
  return {
    error:
      `Unsupported source format: "${source}". Use one of: ` +
      "(a) known shorthand (e.g. 'threejs-skills'), " +
      "(b) 'github:owner/repo', or " +
      "(c) full https:// URL on github.com / gitlab.com / bitbucket.org.",
  };
}

// ── Per-project approval cache ──────────────────────────────────────
//
// A URL the user has approved installing once (via approve: true) gets
// recorded here. Subsequent installs of the same URL skip the approval
// gate. Stored as plain JSON at <project>/.mica/skills-approvals.json so
// it's editable by humans and survives across sessions.

interface ApprovalsFile {
  approved_urls: string[];
}

function approvalsPath(project: string): string {
  return join(micaDir(project), "skills-approvals.json");
}

async function loadApprovals(project: string): Promise<Set<string>> {
  try {
    const raw = await readFile(approvalsPath(project), "utf-8");
    const parsed = JSON.parse(raw) as ApprovalsFile;
    return new Set(parsed.approved_urls ?? []);
  } catch {
    return new Set();
  }
}

async function recordApproval(project: string, url: string): Promise<void> {
  const set = await loadApprovals(project);
  set.add(url);
  const data: ApprovalsFile = { approved_urls: Array.from(set).sort() };
  await mkdir(micaDir(project), { recursive: true });
  await writeFile(approvalsPath(project), JSON.stringify(data, null, 2) + "\n", "utf-8");
}

const CURATED_URLS = new Set(Object.values(KNOWN_SKILL_PACKAGES).map((e) => e.url));

async function summarizeSkills(skillsRoot: string): Promise<Array<{ name: string; description: string }>> {
  const found: Array<{ name: string; description: string }> = [];
  async function walk(dir: string): Promise<void> {
    let entries: Awaited<ReturnType<typeof readdir>>;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      // Skip hidden + .git internals; recurse into normal subdirectories.
      if (e.isDirectory() && !e.name.startsWith(".")) {
        await walk(full);
      } else if (e.isFile() && e.name === "SKILL.md") {
        try {
          const content = await readFile(full, "utf-8");
          const fm = content.match(/^---\n([\s\S]*?)\n---/);
          if (!fm) continue;
          const nameMatch = fm[1].match(/^name:\s*(.+)$/m);
          const descMatch = fm[1].match(/^description:\s*(.+(?:\n[ ]+.+)*)/m);
          const name = nameMatch?.[1].trim().replace(/^["']|["']$/g, "") ?? "(no name)";
          const description = (descMatch?.[1] ?? "")
            .replace(/\n[ ]+/g, " ")
            .trim()
            .replace(/^["']|["']$/g, "");
          found.push({ name, description: description.slice(0, 140) });
        } catch {
          // skip unreadable
        }
      }
    }
  }
  await walk(skillsRoot);
  return found;
}

export const installSkillsTool: AgentToolDef<typeof inputSchema> = {
  name: "mica_install_skills",
  description:
    "Install a third-party skills package into the current project so future turns can " +
    "invoke its skills via the `skill` tool. Use this AFTER `discover-dependency` identifies a " +
    "library that has a known skills package (e.g. Three.js → 'threejs-skills'). The package " +
    "is cloned into both `.qwen/skills/<name>/` (qwen-code SDK) and `.claude/skills/<name>/` " +
    "(Claude / opencode), so all three agent backends pick up the new skills automatically " +
    "on their next turn. To use a newly-installed skill in the SAME turn, read its SKILL.md " +
    "via read_file. Common shorthands: 'threejs-skills' / 'three'. " +
    "TWO-TIER TRUST: curated shorthands and previously-approved URLs install instantly. " +
    "For a new URL the agent has discovered (e.g. via web_search), the FIRST call returns a " +
    "'pending approval' report — show the URL to the user, get explicit OK in chat, then " +
    "retry with `approve: true`. Subsequent installs of the same URL skip the gate.",
  inputSchema,
  restPath: "/api/tools/mica-install-skills",
  handler: async (input, ctx): Promise<AgentToolResult> => {
    if (!ctx.project) {
      return { isError: true, text: "Active project required." };
    }
    const resolved = resolveSource(input.source);
    if ("error" in resolved) {
      return { isError: true, text: resolved.error };
    }
    // For curated packages, ignore any `name` override the agent passed.
    // The canonicalName is part of the contract that
    // `required-library-skills-installed` (toolPrerequisites.ts) reads;
    // honoring an override here silently breaks the predicate. The
    // agent's `name` arg only takes effect for github:/https: sources
    // where there's no curated dirname to enforce.
    const overrideName = input.name && input.name.trim() ? input.name.trim() : "";
    if (resolved.isCurated && overrideName && overrideName !== resolved.defaultName) {
      console.log(
        `[install-skills] ignoring name="${overrideName}" override for curated source — ` +
          `using canonical "${resolved.defaultName}" so the install dirname matches ` +
          `the prerequisite predicate's expectation.`,
      );
    }
    const rawName = resolved.isCurated ? resolved.defaultName : (overrideName || resolved.defaultName);
    if (!/^[a-zA-Z0-9_-]+$/.test(rawName)) {
      return {
        isError: true,
        text: `Invalid name "${rawName}" — use alphanumeric + dash/underscore only.`,
      };
    }
    const name = rawName;
    const projDir = join(getEffectiveWorkspaceDir(), ctx.project);
    const qwenTarget = join(projDir, ".qwen", "skills", name);
    const claudeTarget = join(projDir, ".claude", "skills", name);
    if (existsSync(qwenTarget)) {
      return {
        isError: true,
        text:
          `A skills package already exists at .qwen/skills/${name}/. To reinstall ` +
          `(e.g. to pick up upstream changes), remove that directory first via ` +
          `run_shell_command, then retry.`,
      };
    }

    // ── Two-tier trust gate ────────────────────────────────────────
    //
    //   1. Curated URL  → install (Mica-vetted, no gate)
    //   2. Previously-approved URL (per-project) → install
    //   3. approve: true → install + record approval for next time
    //   4. New URL, approve omitted → return pending-approval report;
    //      agent must surface to user and retry with approve: true.
    //
    // Curated entries live in KNOWN_SKILL_PACKAGES; approvals live in
    // <project>/.mica/skills-approvals.json. Both are plain data, no DB.
    const isCurated = CURATED_URLS.has(resolved.url);
    const approvedUrls = await loadApprovals(ctx.project);
    const isPreApproved = approvedUrls.has(resolved.url);
    const wantsExplicitApproval = input.approve === true;

    if (!isCurated && !isPreApproved && !wantsExplicitApproval) {
      return {
        text:
          `**Pending user approval** — this URL is not in Mica's curated registry and has ` +
          `not been previously approved for this project.\n\n` +
          `**Resolved URL:** ${resolved.url}\n` +
          `**Would install to:** \`.qwen/skills/${name}/\` (and symlinked into ` +
          `\`.claude/skills/${name}/\`)\n\n` +
          `Show this URL to the user in your reply and ask: *"Install skills package from ` +
          `${resolved.url}?"* If the user confirms (e.g. replies "yes" or "ok"), retry this ` +
          `tool call with the same arguments PLUS \`approve: true\`. Mica will record the ` +
          `approval in \`.mica/skills-approvals.json\` so future installs of the same URL ` +
          `skip this gate.\n\n` +
          `If the user wants a different URL or declines, do NOT retry — search for ` +
          `alternatives or proceed without library-specific skills.`,
      };
    }

    // Ensure parent dirs exist.
    await mkdir(join(projDir, ".qwen", "skills"), { recursive: true });
    await mkdir(join(projDir, ".claude", "skills"), { recursive: true });

    // Shallow clone via execFile (no shell — args passed as array, no
    // injection risk). 30s timeout caps a hung clone.
    try {
      await execFileP("git", ["clone", "--depth", "1", resolved.url, qwenTarget], { timeout: 30_000 });
    } catch (err) {
      const e = err as { stderr?: string; message?: string };
      const detail = (e.stderr || e.message || "(no detail)").slice(0, 400);
      return { isError: true, text: `git clone failed: ${detail}` };
    }

    // Symlink .claude/skills/<name>/ → relative path into .qwen/skills/<name>/.
    // Cheaper than a copy and stays in sync with the qwen tree if either is
    // updated. Falls back gracefully if the FS doesn't support symlinks
    // (rare in our Linux/Docker setup, but possible).
    //
    // Idempotency: a stale symlink from a prior install (e.g. one that the
    // user removed `.qwen/skills/<name>` from under, leaving a dangling
    // `.claude/skills/<name>` pointing at nothing) makes the bare
    // `symlink()` call fail with EEXIST. We `lstat` to see if anything's
    // already at the target; if it's a symlink, replace it (the new
    // symlink is the authoritative one); if it's a real file/directory,
    // leave it alone — the user may have put real content there
    // intentionally, and silently overwriting would lose data.
    let canSymlink = true;
    try {
      const s = await lstat(claudeTarget);
      if (s.isSymbolicLink()) {
        await unlink(claudeTarget);
      } else {
        console.warn(
          `[install-skills] .claude/skills/${name} exists and is not a symlink — leaving alone. ` +
            `qwen sees the skills; the existing path was preserved.`,
        );
        canSymlink = false;
      }
    } catch { /* nothing at target — clean install path */ }
    if (canSymlink) {
      try {
        await symlink(join("..", "..", ".qwen", "skills", name), claudeTarget);
      } catch (err) {
        console.warn(
          `[install-skills] symlink to .claude/skills/${name} failed: ${(err as Error).message}. ` +
            `qwen sees the skills; Claude/opencode may need a manual mirror.`,
        );
      }
    }

    // Record approval for future installs of the same URL. Curated and
    // pre-approved URLs already short-circuit; only newly-approved ones
    // need recording.
    if (wantsExplicitApproval && !isCurated && !isPreApproved) {
      try {
        await recordApproval(ctx.project, resolved.url);
      } catch (err) {
        console.warn(
          `[install-skills] failed to record approval for ${resolved.url}: ` +
            `${(err as Error).message}. Install succeeded; next install of the ` +
            `same URL will re-prompt.`,
        );
      }
    }

    const skills = await summarizeSkills(qwenTarget);
    const skillsList =
      skills.length > 0
        ? skills.map((s) => `- **${s.name}** — ${s.description}`).join("\n")
        : "(no SKILL.md files found at the expected paths — the upstream package may not follow the SKILL.md convention)";

    const approvalNote =
      wantsExplicitApproval && !isCurated && !isPreApproved
        ? `\n\n_Approval recorded — future installs of this URL in this project skip the gate._`
        : "";

    return {
      text:
        `Installed ${skills.length} skill(s) from ${resolved.url} into ` +
        `.qwen/skills/${name}/ (symlinked into .claude/skills/${name}/):\n\n${skillsList}\n\n` +
        `Available next turn via the \`skill\` tool. To use this turn, read the relevant ` +
        `SKILL.md with read_file — paths are .qwen/skills/${name}/<dir>/SKILL.md.${approvalNote}`,
    };
  },
};
