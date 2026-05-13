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

### 1. Brief + research (BEFORE writing the spec)

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

Write `canvas/<name>-spec.md`: what, why, files involved, **dependencies
(with the library decisions from step 1 already baked in — versions,
CDN URLs, global names)**, subproblems → solutions (each subproblem's
solution references its researched library or the documented
"no-library-fits, custom" decision), out-of-scope items. If a spec
exists, update it instead of starting fresh. Use `grow-canvas` if a
new doc dimension is needed.

**Approval gate (tenet 14)**: After writing the spec, **your turn
ENDS**. Do NOT invoke any further tools this turn — not
`card-class-handbook`, not `decompose-task`, nothing. Your chat
reply is: *"Drafted spec.md — review and OK to build?"* If the
request had vague areas the spec couldn't pin down (color choices,
exact edge behavior, library tradeoffs you couldn't pick between,
missing constraints), surface those as bullet questions in the
same chat reply — don't guess defaults silently. Wait for the
user's next message before proceeding to step 3. Doc-only edits
don't need approval; anything that produces code does. See
`_conventions.md` § Approval flow.

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

Invoke `skill('card-class-handbook')` BEFORE calling
`mica_create_class`. The handbook is the contract those tools
enforce — CANONICAL CARD.JS shape, CARD_SHIM globals
(`container`, `mica` are injected — do NOT redeclare), metadata
schema, channel handlers, `render_capture` verification. Without
it in working memory, common violations (top-level CARD_SHIM
redeclaration, IIFE wrapping, `document.getElementById` instead
of `container.querySelector`) surface only as post-write lint
errors and burn iteration cycles.

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
