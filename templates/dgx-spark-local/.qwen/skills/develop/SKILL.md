---
name: develop
description: FIRST tool call for any build-shaped request — "build / create / implement / make / write / design / ship / develop / construct" — for any artifact type (card class, standalone program, doc set). Owns plan-before-build, canvas-update, and doc-consistency invariants. Dispatches to artifact-specific skills (`card-class-handbook`, `decompose-task`) at the appropriate step. Invoke this BEFORE `decompose-task` or `card-class-handbook` — those are downstream specifics; develop is the universal gate. Skip ONLY for bug fixes (use `fix-bug`), pure Q&A, or when the user explicitly overrides ("just do it directly").
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
— invoke `skill('discover-dependency')`. Verify the libraries are
reachable (CDN URLs return 200) before committing them to the
spec. If a `<lib>-skills` package exists, install via
`mica_install_skills` so the library's patterns are in your
context for step 4+.

**Why research first.** Writing a spec before research presupposes
you'll build everything from scratch, then forces a spec rewrite
when research reveals a library does it for you. Library decisions
shape architecture — surface them up front so the spec describes
how to *compose* the libraries, not how to *reinvent* them. Mica
should not be reluctant to take on a dependency; the discover step
is cheap (≤30 seconds per subproblem) and produces a documented
decision either way.

For subproblems that don't need external libs (string formatting,
simple state, trivial DOM) — skip research; first-principles is
right.

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

Write `canvas/<name>-spec.md`: what, why, files involved, **dependencies
(with the library decisions from step 1 already baked in — versions,
CDN URLs, global names)**, subproblems → solutions (each subproblem's
solution references its researched library or the documented
"no-library-fits, custom" decision), out-of-scope items. If a spec
exists, update it instead of starting fresh. Use `grow-canvas` if a
new doc dimension is needed.

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
framework conventions. **Don't** impose Mica-specific structure
on standalone work (no `.mica/card-classes/`, no `canvas/`
artifact directory for the code itself — though spec/plan still
live on canvas).

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
  mid-build** ("12 cities not 20", "1Hz update not 1 minute",
  "remove the UTC display"). Edit the spec to reflect the new
  state BEFORE making the code change. The spec is the contract —
  when it gets out of sync with what's built, the next session
  reads a stale design and makes wrong decisions. The same applies
  to research artifacts: if the user redirects a candidate
  ("use Leaflet, not D3"), update the research's chosen-stack
  before re-running the build.

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

Untested code is unfinished code. Don't skip verify.

### 7. Doc-consistency reconcile

Per `skill('doc-consistency')`. Any code change that contradicts
a doc gets the doc updated in the same turn. Bug fixes and
refactors are not exceptions. Trigger: "would a reader of the
doc be misled by the new code?"

## Anti-patterns

- **Writing the spec before researching libraries.** Pre-commits
  architecture to from-scratch and forces a spec rewrite when
  research reveals a library does the job. Lead with research.
- **Skipping the spec gate** because the request "seems small."
  One-line request → one-line spec. The gate stays.
- **Moving past plan-or-inline without recording the decision**
  (in spec or decomposition.md).
- **Invoking `card-class-handbook` or `decompose-task` directly,
  skipping this skill.** Those are downstream specifics; this
  skill owns the universal invariants they rely on.
- **Writing code without invoking the appropriate sub-skill** —
  your training prior is "write code"; the skill registry exists
  to override that prior.
- **Ending a turn that wrote code without updating the canvas.**
  The canvas IS the project's memory; uncommitted changes there
  drift the project's truth.
