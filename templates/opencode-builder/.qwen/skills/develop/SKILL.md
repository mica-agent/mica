---
name: develop
description: FIRST tool call for any build-shaped request — for any artifact type (card class, standalone program, doc set). Triggers on EITHER (a) verb-led build phrasing — "build / create / implement / make / write / design / ship / develop / construct" — OR (b) **noun-led artifact naming**: when the user names a new artifact (card, dashboard, page, monitor, viewer, calculator, planner, tracker, board, panel, widget, table, chart, map, timer, …) without an explicit build verb. A noun phrase that names a new artifact has the same intent as the verb-led form; enter this skill any time a new artifact gets named. Owns plan-before-build, canvas-update, and doc-consistency invariants. Dispatches to artifact-specific skills (`card-class-handbook`, `decompose-task`) at the appropriate step. Invoke this BEFORE `decompose-task` or `card-class-handbook` — those are downstream specifics; develop is the universal gate. Skip ONLY for bug fixes (use `fix-bug`), pure Q&A about an existing artifact, or when the user explicitly overrides ("just do it directly", "skip the plan").
---

# develop — top-level build flow

Every build-shaped request enters here. Plan-before-build (tenet 11),
canvas-update (`participate-fully`), and doc-consistency are universal
invariants that apply regardless of artifact type. Specific tools
differ by type; this skill enforces the flow and dispatches by type.

For cross-skill discipline (reading, library reuse, API discipline,
decomposition gates, approval flow, naming) see
`.qwen/skills/_conventions.md`. Tenet numbers refer to
ARCHITECTURE.md / CLAUDE.md.

## The artifact can be

- **Canvas**: a card class on the Mica canvas.
- **Standalone**: a program / script / library / tool that lives in
  the project but doesn't mount on the canvas (e.g. `src/main.py`).
- **Doc-only**: spec, design, decisions, README.

The artifact type drives step 4's branch. Steps 1–3 and 5–7 are
universal.

## The flow

### 0. Mandate: track the flow with `todo_write`

**The first tool you call in this flow is `todo_write`** — before research, before reading any project files, before any other build action. Pre-populate the develop steps as items. The discrete checklist:

- Makes each step concrete rather than implicit prose.
- Lets you (and the user, via the chat card's status panel) see where you are.
- Forces you to confront the APPROVAL GATE as an explicit row rather than a paragraph you've already absorbed.

Example seed call (adjust the items for the artifact type — drop step 2 for non-canvas artifacts, replace step 6/7 for standalone or doc-only):

```
todo_write({
  todos: [
    { id: "1", content: "Research dependencies (discover-dependency)", status: "in_progress" },
    { id: "2", content: "Load card-class-handbook (canvas builds only)", status: "pending" },
    { id: "3", content: "Write canvas/<name>-spec.md", status: "pending" },
    { id: "4", content: "🛑 APPROVAL GATE — wait for user's NEXT message", status: "pending" },
    { id: "5", content: "Plan-or-inline decision", status: "pending" },
    { id: "6", content: "Execute: create class + edit files", status: "pending" },
    { id: "7", content: "Verify with render_capture", status: "pending" },
    { id: "8", content: "Doc-consistency reconcile", status: "pending" }
  ]
})
```

Mark items `in_progress` when you start them, `completed` when the corresponding tool call returns success.

**Item 4 (🛑 APPROVAL GATE) is special: it stays `pending` until the START of your NEXT turn, after a NEW user message arrives. DO NOT mark it `completed` in the same turn that wrote the spec.** If you find yourself about to call `todo_write` to mark item 4 complete inside the same turn as the spec write, that is the exact rationalization pattern the gate exists to catch — STOP, write your chat reply, end the turn. The user's next message is what marks item 4 complete; you do that update at the top of the next turn.

If you already advanced past the spec in your current turn (you noticed mid-stream), call `todo_write` now to record current state honestly — don't backfill `completed` for steps you skipped through. The state of the todo list is also a self-check: an `in_progress` item with no corresponding tool call recently means you forgot what you were doing.

### 1. Brief + research (BEFORE writing the spec)

*(Step 1 begins after the seed `todo_write` call from the mandate above — research is item 1, already `in_progress`.)*

First, identify the subproblems. For each subproblem that involves
non-trivial domain work — rendering, time zones, sun/moon position,
geo math, drag-and-drop, charts, parsing, audio, file diffing, etc.
— **you MUST invoke `skill('discover-dependency')` before writing
the spec.** This is not a "should" or "when in doubt"; it is a
prerequisite for the spec write. Verify the libraries are reachable
(CDN URLs return 200) before committing them to the spec. If a
`<lib>-skills` package exists, install via `mica_install_skills`
so the library's patterns are in your context for step 4+.

**Why this is the contract.** `discover-dependency`'s output IS
the source of truth for which subproblems route to a library, an
asset, a service, or bespoke code. With it loaded, the spec
records verified options. Without it, the spec records the agent's
training prior, which leans toward "compute it myself" even when
a one-line library call exists. Run it per subproblem; the skill
takes ≤30 seconds per item and produces a documented decision row
either way (library / asset / service / "bespoke because Z").

Run it on every subproblem, including the ones that look trivial.
String formatting, simple state, and DOM glue still go through the
skill — the output is just a quick "bespoke" row. Pre-judging a
subproblem as "obviously no library needed" is the training-prior
shortcut the skill exists to interrupt.

### 2. Spec on canvas

**If the artifact is a canvas card class**: invoke
`skill('card-class-handbook')` BEFORE writing the spec. The handbook's
`mica.*` API table is the source of truth — without it loaded, the
spec tends to name plausible-sounding methods that don't exist
(`mica.files.get` instead of `mica.files.read`) or apply the wrong
scope (`mica.fetch` is the external HTTP proxy — SSRF-blocked,
loopback-blocked; for Mica's own `/api/*` use raw `fetch('/api/...')`
or `mica.files.read('/.mica/...')`). The handbook loaded here serves
both this spec step and the code step (4a); no double-load.

**For standalone / doc-only artifacts**: skip the handbook — no
`mica.*` surface to ground against.

Write `canvas/<name>-spec.md`. **For canvas card classes**, the spec uses a structured shape: a YAML frontmatter block at the top (the contract `mica_create_class` reads directly), then human-readable prose below for review.

```markdown
---
card-class:
  name: <class-name>                     # MUST match the spec filename stem (lowercase + dashes only, no dots)
  badge: <1-4 chars>                     # short uppercase tag shown in the card chrome
  default_title: <Display Name>
  handler: ~                             # null unless using a built-in handler (llm-direct, llm-agent, process)
  sidecar: ~                             # null unless this card needs a server.py / server.ts
  dependencies:
    umd_scripts:                         # <script>-tag-loaded UMD URLs ONLY
      - {url: "https://cdn.jsdelivr.net/npm/<pkg>@<version>/<umd-path>.js", format: UMD, version: "<version>"}
    styles:
      - "https://cdn.jsdelivr.net/npm/<pkg>@<version>/<css-path>.css"
    # ESM URLs do NOT go in umd_scripts. Load them inside card.js via:
    #   const NS = await import("https://cdn.jsdelivr.net/npm/<pkg>@<ver>/<esm-path>");
    # The CARD_SHIM wraps card.js in an async function — top-level await works.
    # Document ESM deps in the prose body below for human review.
  subtasks:
    - {name: "<subtask description>", tier: 1, mechanism: "card.js + <library> UMD", verify: "render_capture"}
    - {name: "<subtask description>", tier: 1, mechanism: "card.js + <browser-API>", verify: "render_capture"}
  out_of_scope:
    - "<feature deferred to a later version>"
    - "<feature ruled out as unnecessary>"
---

# <Class Name>

## Overview
A canvas card that <does X by mechanism Y>.
[1–3 paragraphs of human-readable intent, tradeoffs, and any open questions]
```

**The frontmatter is the contract.** `mica_create_class` reads it directly when the agent calls the tool with just `{ name }`. Explicit args to the tool still override, but the agent's life is easier when they don't have to be passed twice. Fill the frontmatter once; the build flows from there.

**Required frontmatter fields**: `name`. **Strongly recommended**: `badge`, `default_title`, `dependencies` (verified URLs from step 1), `subtasks` (one row per subtask with its tier assignment per `card-class-handbook` § decomposition). **As-needed**: `handler` (only when a built-in channel handler fits), `sidecar` (only when Tier-4 server compute is required), `out_of_scope` (capture things you decided NOT to build).

**The `subtasks` array is the decomposition forcing function.** Each entry asks for `{ name, tier, mechanism, verify? }` — the same thinking the older Markdown table forced, in the schema. **Don't skip it on Tier-1-only cards** (just write one row; that's still the discipline working). Skipping it is the failure mode where every card silently grows a sidecar.

**For sidecar-bearing cards (`sidecar:` non-null OR any subtask `tier: 4`)**: before locking the frontmatter, call `mica_inspect_python_package({ name, python })` for each Python import the sidecar will use. Record the version + top-level surface in the prose section below — humans skim this when reviewing. If any package returns `installed: false`, change the package or the interpreter selection BEFORE the spec ships. Same Tier-1-pattern as verifying CDN URLs return 200 and Tier-3-pattern as verifying CLI tools are on PATH — pre-write verification at every tier.

**The frontmatter is what the user approves at the gate.** When the user wants to redirect a tier choice ("don't sidecar that — use `process`"), they edit the YAML directly OR send a chat message naming the change. Either way, the structured part is small enough to skim in seconds.

Standalone and doc-only artifacts skip frontmatter entirely — the four-tier hierarchy only applies to Mica cards.

**Approval gate (tenet 14)**: After writing the spec, **your turn
ENDS**. Do NOT advance to step 3 or 4 in this turn — no
`decompose-task`, no `mica_create_class`, no code writes. (The
handbook may already be in context from earlier in this same turn
for canvas builds — that's fine; the gate is about advancing the
flow, not about which skills have been loaded.) Your chat
reply is: *"Drafted spec.md — review and OK to build?"* If the
request had vague areas the spec couldn't pin down (color choices,
exact edge behavior, library tradeoffs you couldn't pick between,
missing constraints), surface those as bullet questions in the
same chat reply — don't guess defaults silently. Wait for the
user's next message before proceeding to step 3. Doc-only edits
don't need approval; anything that produces code does. See
`_conventions.md` § Approval flow.

**The gate fires on tool-return, not on user reply.** "Approval" is
the user's NEXT MESSAGE — nothing else. Do not interpret continued
tool calls in the same turn as "implicit approval"; the user has
not seen the spec yet at that point. Do not write a thinking block
that reasons "the user is still here so I should keep going" —
they're "still here" because the SDK hasn't ended your turn yet,
not because they've approved anything. The gate exists specifically
to catch specs that the user wants to correct BEFORE code is
written; bypassing it because the spec "feels right" is the failure
mode it's designed to prevent.

**Your `todo_write` list's item 4 ("🛑 APPROVAL GATE — wait for user's NEXT message") stays in `pending` status.** Do NOT mark it `completed` this turn. Marking it complete is how the gate gets bypassed; the discipline of leaving an unchecked checkbox on the screen is the cue that stops you. If you're about to issue a `todo_write` call that flips item 4 to `completed`, you are about to bypass the gate — STOP, end the turn, write your chat reply instead.

### 3. Plan-or-inline (tenet 12)

Apply the decomposition gates from `_conventions.md` §
Decomposition gates. Default to inline.

- **Both gates pass** → invoke `skill('decompose-task')`. The
  decomposer produces `canvas/interfaces.md`,
  `canvas/decomposition.md`, `canvas/plan.todo`, and orchestrates
  `component-coder` dispatches per plan item.
- **Either gate fails** → inline. Record the inline decision and
  rationale in the spec ("Inline because: <reason>").

### 4. Execute — branch by artifact type

#### 4a. Canvas artifact

**First: re-read the decomposition table.** Before any
`mica_create_class` / `mica_edit_class_file` call, re-load
`canvas/<name>-spec.md`. The file is on disk but no longer in
your working memory by this step. Each row of the Architecture
Decomposition table is a **contract requirement**, not a
suggestion: if a row assigns its subtask to Tier 2/3/4, card.js
must use the named primitive (`llm-direct` handler, `process`
handler, or sidecar fetch) for that subtask — not a client-side
substitute, even if your training prior offers a familiar
browser-API path for the same job. The most common drift mode is
"spec assigned Tier 3 (or 4) but training prior offers a
familiar browser-native path, so card.js silently bypasses the
spec." Walk the table row by row and confirm each row's named
mechanism appears in card.js BEFORE writing the file. If a row's
mechanism can't be implemented as specified, the spec is wrong —
go back to step 2 and revise (re-approval required), don't drift
the implementation.

The handbook is already loaded from step 2 — re-invoke
`skill('card-class-handbook')` only if it was somehow skipped
(e.g. a partial flow that jumped here). The handbook is the
contract `mica_create_class` and `mica_edit_class_file` enforce
— CANONICAL CARD.JS shape, CARD_SHIM globals (`container`,
`mica` are injected — do NOT redeclare), metadata schema, channel
handlers, `render_capture` verification. Without it in working
memory, common violations (top-level CARD_SHIM redeclaration,
IIFE wrapping, `document.getElementById` instead of
`container.querySelector`) surface only as post-write lint errors
and burn iteration cycles.

If you took the decompose path at step 3, `component-coder`
dispatches per file follow `card-class-handbook`'s contract per
dispatch.

#### 4b. Standalone program / tool

Use `write_file` per file. Project layout follows the spec +
framework conventions. Standalone work uses its own framework's
layout — Mica-specific paths (`.mica/card-classes/`, `canvas/` for
code) apply only to canvas card classes. Spec and plan still live
on canvas for any artifact type.

#### 4c. Doc-only artifact

The spec IS the artifact. Skip to step 7.

### 5. Canvas update — every working turn

Per `skill('participate-fully')`. When a turn writes code, update
the canvas in the same turn:

- `plan.todo` items: `[ ]` → `[~]` → `[x]` (per the orchestrator
  lifecycle in `decompose-task` / `_conventions.md`).
- `canvas/decisions.md` gains an entry for non-obvious choices.
- `canvas/<class>-spec.md` updates if: (a) implementation revealed
  a needed spec change, OR (b) **the user requested a change
  mid-build** (a different count, a different rate, a removed
  feature). Edit the spec to reflect the new state BEFORE making
  the code change. The spec is the contract — when it gets out of
  sync with what's built, the next session reads a stale design
  and makes wrong decisions. The same applies to research
  artifacts: if the user redirects a candidate, update the
  research's chosen-stack before re-running the build.

This applies to **every** working turn, not just here. Standalone
code can live anywhere (`src/`, `scripts/`) — the canvas log of
what was built still lives on canvas.

### 6. Verify — gate; mechanism per artifact

- **Canvas**: `render_capture` on the instance. Iterate with
  `mica_edit_class_file` partial edits if the visual diff is
  wrong. `card-class-handbook` covers this in detail.
- **Standalone**: run tests, start the process, probe the
  endpoint, exec the script. Report what passed and what didn't.
- **Doc-only**: review in chat; ask user to confirm.

Verify is mandatory — untested code is unfinished code.

### 7. Doc-consistency reconcile

Per `skill('doc-consistency')`. Any code change that contradicts
a doc gets the doc updated in the same turn. Bug fixes and
refactors are not exceptions. Trigger: "would a reader of the
doc be misled by the new code?"

## Step ordering — the moves that keep the flow on rails

- **Research first, spec second.** `discover-dependency` runs
  before the spec is written; the spec records its verified output.
- **Spec, then gate.** Any artifact that produces code goes through
  the approval gate. One-line request → one-line spec → same gate.
- **Plan-or-inline decision goes in the spec.** Record which path
  you took and why, in either `spec.md` or `decomposition.md`.
- **Enter through `develop`.** `card-class-handbook` and
  `decompose-task` assume the universal invariants this skill owns;
  invoking them directly skips the gates.
- **Match every code-writing turn with a sub-skill invocation.**
  Card-class work routes through `card-class-handbook`; decomposed
  work routes through `decompose-task`. The skill registry is what
  overrides the training-prior "just write code" reflex.
- **Update the canvas in the same turn as the code change.** Canvas
  is the project's memory; trailing updates drift the project's
  truth and the next session reads stale state.
