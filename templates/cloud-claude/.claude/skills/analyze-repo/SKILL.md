---
name: analyze-repo
description: CODEBASE ANALYSIS. When the user asks to analyze, explore, understand, survey, read through, or map out any codebase, source directory, `src/`, repo, or repository — INVOKE THIS SKILL FIRST, before any `read_file` or `list_directory` calls. Applies to the current project's own source, any sub-directory inside it, or an external cloned repo. Produces bounded canvas cards plus `.mica/repo-analysis/<repo>/` detail. NEVER reads codebases inline — always delegates per-module to subagents. Triggers on phrases like "analyze the code", "analyze the src directory", "understand this codebase", "map out the repo", "explore the source".
---

# Analyze a codebase

**STOP before reading any more files.** If you are starting this skill
mid-turn after already reading a few files, that's fine — just do not
read any MORE. From here you run three explicit phases with subagent
delegation and file-backed handoffs. You do not analyze the codebase
inline. If you try to, you will overflow your context window within
10–15 files. The whole point of this skill is to prevent that.

The user wants to understand a codebase. You are the **orchestrator**.

This skill applies whether the code is:
- An external repository the user cloned into a scratch location
- A directory inside the current Mica project (like `src/`, `app/`,
  `packages/`)
- The whole current project's source tree

The output paths live in the current Mica project's `canvas/` and
`.mica/repo-analysis/<repo>/` regardless — they don't collide with
the analyzed code.

## STEP 0 — Confirm scope and read project config

Before starting, confirm the user has given you:

1. **A local path** to the repo root (e.g., `/home/user/repos/foo`).
   If they gave you a URL, stop and ask them to clone it first.
2. **What they want to do with the analysis.** This shapes the
   overview section (work on it → architectural notes; understand
   it → orientation; evaluate it → conventions + open questions).
   If unclear, ask.

Do a quick `ls <repo>` and `read_file <repo>/README.md` to sanity-check
the path. If the path isn't a repo or doesn't exist, stop.

**Read the project's canvas root.** Read `.mica/config.json` in the
current Mica project and note the `canvasRoot` field (e.g., `"docs"`,
`"canvas"`, or sometimes empty). All canvas cards you write in Phase
3 must go to `<canvasRoot>/...`. The skill uses `<canvasRoot>` as a
placeholder throughout — substitute the real value. If `canvasRoot`
is absent or empty, default to `docs`.

## Phase 1 — ENUMERATE (you, no subagents)

Read a bounded set of top-level files to understand the repo's shape:

- `README.md` and any sibling docs at the repo root.
- The primary manifest: `package.json`, `Cargo.toml`, `pyproject.toml`,
  `go.mod`, `Gemfile`, `pom.xml`, whichever exists.
- `ls` the top-level directory. If the repo has a `src/`, also `ls
  src/`.

From those, extract:

- **Language(s)** and **build system**.
- **Top-level directory structure** with one-line annotations.
- **Likely entry points** (main script, CLI command, server start).

Now **group the repo into 5–15 modules.** A module is a coherent
chunk you can analyze independently. Heuristic:

- Start with top-level directories inside source (`src/`, `app/`,
  `packages/`, etc.).
- **Merge trivial ones** (single file, or <100 lines total, or
  obvious utility folders like `constants/`) into a `misc` module.
- **Split very large ones** (>50 files) by obvious seams —
  `tests/` vs. source, sub-packages, layered folders.
- Group configs, scripts, and build files into a `project-config`
  module unless they're numerous enough to warrant their own.

Write the plan to `.mica/repo-analysis/<repo>/manifest.json`:

```json
{
  "repoPath": "<absolute path>",
  "repoName": "<basename of path>",
  "language": "<primary language>",
  "buildSystem": "<e.g. npm, cargo, poetry>",
  "topLevelTree": "<annotated tree, plain text>",
  "modules": [
    {
      "name": "auth",
      "repoPath": "src/auth/",
      "files": ["src/auth/handler.py", "src/auth/tokens.py", ...]
    },
    ...
  ]
}
```

**STOP HERE.** Report the module plan to the user in plain prose.
Show the list of modules, the files assigned to each, and ask for
confirmation. If the user edits the plan, update the manifest. Wait
for explicit "proceed" before Phase 2.

This pause is the load-bearing gate. Subagents are cheap but not
free; a bad module grouping wastes them. Confirm before dispatching.

## Phase 2 — DISPATCH (one subagent per module, parallel)

For each module in the approved manifest, invoke the
`repo-module-analyst` subagent. Batch all invocations into a single
message so they run concurrently (the per-project concurrency cap
will throttle them — default 4 on cloud — which is fine).

Invocation shape:

```
Agent({
  subagent_type: "repo-module-analyst",
  description: "Analyze <module> module of <repoName>",
  prompt:
    "Repo: <absolute repo path>\n" +
    "Module: <module name>\n" +
    "Output path: .mica/repo-analysis/<repoName>/modules/<module>.md\n" +
    "Files in scope:\n" +
    "  - <file1>\n" +
    "  - <file2>\n" +
    "  - ...\n" +
    "Follow your system prompt's output schema exactly. Return only 'done' or 'failed: <reason>'."
})
```

Each subagent reads its files, writes the analysis to the specified
path, and returns a single status line. **Your context accumulates
only status lines, not the analyses.** This is how you survive the
phase on a 500-file repo.

**On failure:** if a subagent returns `failed: ...`, retry it ONCE
with the same prompt. If it fails again, mark the module as
`analysis_failed` in the manifest and continue. Do not let one bad
module block the rest.

## Phase 3 — SYNTHESIZE (you, reading back your own output)

Now `read_file` each `.mica/repo-analysis/<repoName>/modules/
<module>.md` you just produced. These are compact — the whole set
typically fits in your context without issue.

Write exactly these canvas cards. Stop if a card would be
redundant; do not write more than three.

### `<canvasRoot>/<repoName>-overview.md` (always)

1–2 pages in plain markdown. Target under 1500 words. Contents:

```markdown
# <repoName>

<One-sentence description, drawn from the README and your Phase 1
observations.>

## Language and build
- **Language:** <...>
- **Build:** <...>
- **Run locally:** <one or two commands, if the README shows them>

## Structure
<Annotated top-level tree — the one from the manifest, cleaned up.>

## Architecture
<2–4 paragraphs synthesizing patterns you saw repeat across modules.
E.g., "dependency injection via <X>," "all HTTP handlers go through
<Y>," "state lives in <Z>." Grounded in what the per-module
analyses actually say, not guessed.>

## Conventions
- <pattern observed across multiple modules>
- ...

## Open questions
<Anything the per-module analysts flagged as unclear. Keep short;
detail is in the module files.>
```

### `<canvasRoot>/<repoName>-modules.md` (always)

A routing table, nothing more. Target under 500 words.

```markdown
# <repoName> — modules

| Module | Purpose | Repo path | Detail |
|---|---|---|---|
| auth | JWT-based auth + session management | `src/auth/` | `.mica/repo-analysis/<repoName>/modules/auth.md` |
| ... |

## Failed analyses
<List any modules marked `analysis_failed` in the manifest, with the
reason. Omit this section if none failed.>
```

### `<canvasRoot>/<repoName>-glossary.md` (only if warranted)

Write this card ONLY if the per-module analyses surfaced genuinely
repo-specific jargon — terms the repo uses in a non-standard way.
If there's no jargon worth documenting, omit this card.

```markdown
# <repoName> — glossary

- **<term>**: <one-line definition, grounded in how the repo uses it>
- ...
```

## STOP after Phase 3

When the three cards are written, stop. Report to the user:

- The three cards you wrote (or two, if no glossary).
- The number of modules analyzed successfully, and any that failed.
- The detail store location (`.mica/repo-analysis/<repoName>/`).

**Do NOT continue into planning or editing.** Those are separate
user requests against the now-durable canvas. If the user asks a
follow-up question about a module, read the corresponding
`.mica/repo-analysis/<repoName>/modules/<module>.md` file — don't
re-scan the repo.

## Rules

1. **Local paths only.** If the user gives a URL, ask them to
   clone first.
2. **Bounded canvas output: 2 or 3 cards.** Never more.
3. **Detail store always in `.mica/repo-analysis/<repoName>/`.**
   Never in the project's canvasRoot. Never inside the analyzed
   code directory.
4. **Pause after Phase 1 for user confirmation of the module
   plan.** Do not silently dispatch.
5. **Batch subagent invocations into one message** so the
   concurrency cap (not sequential wait) determines throughput.
6. **Stop after Phase 3.** Do not plan, edit, or refactor.
7. **Never read the whole codebase inline.** If you find yourself
   reading more than 3–4 files in Phase 1 orientation, stop. That
   is a sign you're doing Phase 2's work inline. Phase 1 is
   `README.md` + one manifest file + top-level `ls`, period.
   Everything else goes to subagents.

## Do NOT

- Do NOT put per-module analyses on the canvas. They're
  deliberately off-canvas so the canvas context stays bounded.
- Do NOT read the whole repo yourself. Even a small repo will
  overflow context if you read files inline.
- Do NOT let subagents roam outside their assigned module's files.
  The subagent system prompt already enforces this; your task
  prompt must explicitly list scope files.
- Do NOT merge all modules into one giant analysis to "save
  subagents." Per-module is the unit because it bounds scope.
