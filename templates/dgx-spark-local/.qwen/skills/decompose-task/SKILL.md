---
name: decompose-task
description: Triggers when the work is large enough that decomposition pays AND a sufficient integration contract is writable upfront — i.e. you can specify (in interfaces.md) DOM IDs, function signatures, data shapes, init order, lifecycle, library versions, etc. with enough detail that two implementers honoring the contract on their side, ignorant of each other, would integrate cleanly. The contract is the central deliverable; without it, parallel subagents produce incompatible code and serial dispatch is just slow inline work. Examples that trigger: multi-card-class projects (chat + calendar + todo), multi-module refactors with stable interfaces, anything where the integration surface is namable. Examples that do NOT trigger: a single small card class (use `create-card-class` inline), tightly coupled work where the contract becomes a partial implementation (animation wedded to data flow, novel UI patterns being explored), bug fixes (use `fix-bug`). Planning-shaped asks (review / design / audit / plan / "figure out next steps") still trigger so a plan and contract land on canvas. If both this and `fix-bug` could match, prefer `fix-bug`. If both this and `create-card-class` could match for a single card, prefer `create-card-class`.
---

# Decompose the task — but don't decompose it yourself

Your context slot has a finite budget. Read your `## Detected runtime` block at the top of the system prompt for the exact numbers — both your slot AND each subagent's slot. Decomposing a multi-component build inline (in YOUR turn), then writing each component inline, can blow past that budget on tighter slots, leaving you mid-task with no room left.

**The structural fix:** planning lives on the canvas, not in your transcript. You are the *orchestrator*. A `task-decomposer` subagent does the planning in its own context slot, producing four artifacts on the canvas (spec.md, interfaces.md, decomposition.md, plan.todo). A `component-coder` subagent does each piece of implementation in its own context slot. You read the artifacts and dispatch.

The orchestrator pattern is **runtime-budget-aware**: on a generous slot the parent might inline most work and only orchestrate genuinely large builds; on a tight slot the threshold drops and orchestration kicks in earlier. Read your runtime numbers; don't apply a fixed file-count rule.

## The orchestrator workflow

The decision is not "is this multi-component?" but **"can a sufficient contract be written upfront?"** A contract is sufficient when two implementers, ignorant of each other, would honor it on their side and integrate cleanly. With a sufficient contract, parallel subagents are safe and the orchestrator pays off. Without one, naive decomposition fragments the build — each subagent invents its own version of the integration surface and the outputs don't compose.

Examples that DO trigger (contract is writable AND the build is large enough that the contract's cost is worth paying):

- "build me three card classes — chat, calendar, and todo" — independent units, contract is each card class's metadata + its public file format. Three parallel orchestrator runs, each likely inline.
- "refactor app.js + plugins.js + storage.js into a new module layout" — contract is the new module boundaries + their public interfaces. Worth writing.
- "build a complex card with map, terminator, controls, persistence, undo/redo" — single card class but large. Contract is the DOM IDs + persistence shape + init order + lifecycle. Worth writing → parallel implementers per file are safe.
- "audit the codebase" / "review the spec and figure out next steps" — planning-shaped, lands a plan + contract on canvas regardless.

Examples that do NOT trigger:

- "create a small world clock card" — one card class, contract is trivially small. Overhead of writing it formally exceeds the parallelism win. Use `create-card-class` inline.
- "add a day/night overlay to the existing world clock" — one feature inside one card class, no new integration surface. Inline.
- "fix the addLayer bug in card.js" — bug, no plan needed. Use `fix-bug` inline.
- "build a tightly coupled animation where data flow and rendering are wedded" — contract would become a partial implementation. Inline.

## The decision rule — INLINE is the default

Before considering anything else, ask the **gate question**:

> **Can the parent (you) handle this inline in the current slot?**

Estimate the work: how many files (existing reads + new writes), roughly how many bytes total, how much reasoning room you'll need across the turn's tool iterations. Compare against the parent's spare context budget from the runtime block.

- **If the answer is YES, or even PROBABLY YES → inline. End decision.** Don't write a contract, don't dispatch a decomposer, don't produce decomposition.md / plan.todo. The orchestrator pattern's overhead (artifact writes, subagent bootstrap, dispatch round-trips, plan reconciliation) only pays off when the parent **cannot** inline — not when it merely **could** decompose.
- **If the answer is NO** — the work would overflow your spare budget — only then check the two remaining axes. Both must hold for decomposition to be safe AND useful:
  1. **Logical decomposability.** Can you name the integration surface (DOM IDs, function signatures, data shapes, init order, lifecycle) with enough detail that two ignorant implementers would integrate? If the contract becomes a partial implementation, the work isn't decomposable — push the user to scope it down so it fits inline rather than decompose anyway.
  2. **Each subcomponent fits a single subagent's slot.** Reads + writes + reasoning room. On tighter context windows this forces finer subcomponents and a more verbose contract.

**Why the gate is asymmetric.** "Could decompose" is a much weaker bar than "must decompose." Almost any non-trivial task has nameable seams in the abstract — that's not the question. The question is whether decomposition's overhead is justified by the parent's *actual incapacity* to do the work in one slot. It almost never is for single card classes, single-file edits, single bug fixes, single feature additions to existing code. It IS for multi-card-class greenfield builds, multi-module refactors against existing code, anything where the parent can foresee 7+ files of new writes plus comparable reads of existing code.

**Default to inline. Treat decomposition as the exception, not the equal-path alternative.** When in doubt, inline. The cost of an inline build that turns out to be a hair too big is mid-turn pressure (which you can recover from); the cost of decomposition for work that fit inline is artifact ceremony, subagent dispatch round-trips, and a slower iteration loop the user feels on every back-and-forth. The visible-engineering-feel of decomposition.md / plan.todo / parallel dispatches is NOT a justification on its own — those artifacts are tools that pay rent only when the parent genuinely couldn't have shipped the work directly.

**Model strength compounds.** A 7B local model overflows on a 4-file card class — decomposition is forced. A 200K-context cloud model holds even multi-card builds inline — decomposition is rarely correct there. A 65K-Qwen sits in between: typical card classes fit inline (use `create-card-class`); large complex cards (200+ lines per file across multiple subsystems plus heavy reads of existing code) genuinely don't. Read your runtime block; the gate question scales with what's actually configured.

If you decide to delegate, the **first** thing you do is invoke `task-decomposer`. Light reads (the user's spec.md, a quick glance at canvas state) are fine before deciding — the prohibition against reading isn't dogma, it's a hedge for when context is genuinely tight. Use the budget block in your system prompt: if you have headroom for a 3-5KB context-gathering read before deciding, do it; if not, delegate without reading.

Steps:

1. **Restate the ask** in one sentence. If genuinely ambiguous (the user said "build me a music player" with no other context), ask the clarifying question and stop. If the ask is clear enough to plan, continue.

2. **Apply the gate question — does this fit inline?** Estimate the work against the parent's spare context budget per the runtime block. If yes-or-probably-yes, **stop here**: drop out of this skill, invoke `create-card-class` (for card-class work), `fix-bug` (for bugs), or just do the edits directly. The orchestrator pattern is NOT for tasks that fit inline; using it anyway costs you artifact ceremony, subagent dispatch round-trips, and a slower loop. **Worked examples that fail the gate (decomposition is wrong):**

   - "build a world clock card" — single card class, ~500 total lines across four files, fits inline on any reasonable model. Use `create-card-class`.
   - "fix the addLayer bug" — single bug, single file, no plan needed. Use `fix-bug`.
   - "add a city to the world clock" — instance-data edit + maybe a doc ask. Inline.
   - "add a settings panel to the existing chat card" — feature addition to one existing card class, fits inline.

   **Worked examples that pass the gate (decomposition pays):**

   - "build me three card classes — chat, calendar, todo." Three independent units. Decompose.
   - "refactor app.js + plugins.js + storage.js into a new module layout." Multi-module, integration surface is namable. Decompose.
   - "build a complex card with map + terminator + controls + persistence + undo/redo + ~800 lines of card.js across multiple subsystems." Single card class but parent overflow risk on tight slots. Decompose IF runtime numbers say so.

3. **If the gate says NO (decomposition is justified), delegate the planning** — call `task({ agent: "task-decomposer", prompt: "<the user's request, verbatim, plus any clarifying context they gave>" })`. Light pre-reads (user's spec.md, quick canvas glance) are fine before deciding; if budget is tight, skip them. The decomposer writes/updates four artifacts: `canvas/spec.md`, `canvas/interfaces.md` (with named sections), `canvas/decomposition.md` (the design memory), `canvas/plan.todo` (with per-item `Context:` and `Skip:` manifests). It returns a one-line status.

   The decomposer may itself return `declined: parent can inline this work — ...` — that's a successful outcome confirming the gate. If you missed it, the decomposer catches it on its side. Drop the orchestrator path and inline the work yourself. **Don't re-invoke `task-decomposer` to force a plan.**

3. **Read the design + plan — and verify they're internally consistent.** `read_file canvas/decomposition.md` and `read_file canvas/plan.todo`. Decomposition.md is the canonical architecture doc (subcomponents, dependency graph, rejected seams, verification gates). Plan.todo is the dispatch queue with curated `Context:`/`Skip:` manifests per item.

   **Critical consistency check before any dispatch:** read `decomposition.md § Decision`. **If it says "Decision: Inline" — STOP. Do NOT dispatch any plan.todo item.** A buggy or stale decomposer can write a "Decision: Inline" verdict AND a plan.todo full of `@component-coder` items in the same run. The Decision line is authoritative; plan.todo's `@component-coder` entries are an artifact bug if the verdict is Inline. In that case: drop the orchestrator path, invoke `create-card-class` skill (for card-class work) or do the edits inline directly. The `plan.todo` items become advisory — they tell you what the work is, but YOU do it inline, not via subagent dispatch.

   Otherwise (Decision is Decompose, or there's no Decision line and plan.todo is sane): confirm they align — every plan item should reference a `## Subcomponents § <name>` entry from decomposition.md.

4. **Surface the design to the user.** In your turn response: paste the decomposition.md content (or summarize it) so the user sees the architecture you're about to ship. Mention plan.todo for the queue. The user can interject by replying or by editing `decomposition.md` / `plan.todo` directly — both files are on canvas. Do NOT pause/wait artificially; finish your turn and dispatch on the next, OR continue dispatching now if the design is clear and the user gave a green light. The point is visibility, not a forced gate.

5. **Mark in-progress, dispatch with role-context, mark complete — per item, in that order.** Each plan item has a lifecycle on the `.todo` card the user is watching:

   - **Before dispatch:** `edit` plan.todo to flip `[ ]` → `[~]` on this item.
   - **Then dispatch:** call `task({ agent: "component-coder", prompt: "<role-context + plan item text>" })`. **Construct the prompt** by reading the item's `Context:` line for the section names, then pasting:
     - The relevant `## Subcomponents § <name>` entry from decomposition.md (so the subagent knows what it owns and what's out of scope — the orchestrator does this paste because the subagent shouldn't burn its slot reading the whole decomposition.md).
     - The plan item text verbatim (Context:, Skip:, parallel-safe flag, etc).
     - The subagent reads its named contract/spec sections itself.
   - **Default to PARALLEL dispatch when items are marked `parallel-safe: true`** — that flag is the planner's assertion that the contract is sufficient. Issue multiple `task` calls in one response (each preceded by its own `[~]` flip). Drop to sequential only for items marked `parallel-safe: false`.
   - **On successful return:** flip `[~]` → `[x]`.
   - **On failure return** (`failed: ...`):
     - `failed: contract gap on <X>` or `failed: contract too coarse` — re-invoke `task-decomposer` with the gap description; it extends interfaces.md (and possibly decomposition.md), then re-dispatch the failed item.
     - `failed: context manifest insufficient — needed § <X>` — edit plan.todo to add `<X>` to the item's `Context:` line, then re-dispatch.
     - `failed: decomposition needs revision — <what>` — re-invoke `task-decomposer` with the discovery; it updates decomposition.md (adds a revision-log entry), updates plan.todo to match, then re-dispatch affected items.
     - `failed: scope too large` — re-invoke `task-decomposer` to split the item.
     - For other failures: flip `[~]` → `[!]` and surface to the user.

   **Do NOT batch state edits.** The .todo card watches its own file and re-renders on every save. Per-item edits become live UI progress: pending → in-progress → done.

   **Markers summary:** `[ ]` = pending, `[~]` = in progress, `[x]` = done, `[!]` = failed.

6. **Iterate** until `## Active` has no `[ ]` or `[~]` items left. Update decomposition.md with revision-log entries any time the design shifted during iteration (seams moved, new subcomponents added, scope changed). The decomposition stays current; future sessions inherit the current truth, not the original plan.

7. **Verify the contract held, then verify the artifact works.** Empty `## Active` is NOT success on its own. Subagents reported `done` based on their own slot's view; your job at the integration boundary is two-stage:

   **Stage 1 — contract verification.** Read each plan item's output and confirm it honors `interfaces.md`. The contract is the agreement that made parallel dispatch safe; integration only succeeds if every implementer kept their side. For card classes:
   - For each named DOM ID in `interfaces.md § DOM contract`, grep card.html for the ID — confirm it exists. Grep card.js for `getElementById('<id>')` and `querySelector('#<id>')` — confirm every reference resolves to an ID the contract names AND that card.html defines.
   - Confirm card.css has rules for the IDs/classes the contract says it must style.
   - Confirm card.js's init function follows the contract's specified order (read the function, walk the steps).
   - Confirm cleanup contract: every `setInterval` / `addEventListener` / `ResizeObserver` / Leaflet `L.map(...)` has a tear-down inside `mica.onDestroy`.

   If any contract violation is found, the parent's response is **NOT** to fix it inline. Re-dispatch the divergent subagent with a corrective prompt naming the contract section and the violation. Contract violations are localizable — that's the property contracts buy you.

   **Stage 2 — integration verification.** Once contracts are verified, run end-to-end:
   - For card-class builds: **`render_capture({ filename: "<canvas>/<instance>.<extension>" })`**. Inspect the returned PNG. Did the card mount? Is the layout right? Is there a red error banner? Also check `.mica/cards/<id>.json` for any errors the card emitted via `mica.reportError`.
   - For non-card builds: run the project's own integration test (`npm test`, `pytest`, etc.) or, if none exists, verify the artifacts compose (e.g. import the new module and invoke a smoke entry point).

   If Stage 2 fails despite Stage 1 passing, the contract had a behavioral gap — refine `interfaces.md` to close it (this is contract debt the next build benefits from), then re-dispatch the affected subagent.

   Do NOT skip either stage to ship faster. A broken card the user has to find is more expensive than two extra parent-side verification turns.

8. **Final summary** — when verification passes, summarize what shipped and ask if the user wants anything refined. Do NOT include file contents in your summary — the user can scroll or open the cards.

You produce no implementation code yourself. Your role is read-the-plan, dispatch, mark-done, repeat.

## When to skip the orchestrator workflow

The pattern above is for non-trivial multi-file work. Skip it for:

- **Single-file edits under ~50 lines** — just write the change inline. Subagent overhead exceeds the win.
- **Typo fixes, comment changes, single-config tweaks** — inline.
- **Bug fixes whose change set is one file** — inline. Use `edit`.
- **Read-only investigations** ("how does X work?", "where is Y handled?") — answer directly. No subagents needed.

If you're inside the orchestrator workflow and discover a tiny edit IS needed inline (e.g. you spot a one-line bug in a file the plan didn't cover), you can do it directly without going through `component-coder`. The threshold is roughly: if the change fits in your reply with the file contents visible, do it inline.

## When the user explicitly opts out

If the user says "just do it directly" or "don't bother with subagents" or "this is small, just write the file" — respect that. Inline the work. They have the context you don't (about scope or urgency).

## Concurrency

Subagent concurrency is capped per-project (default 3 concurrent local, 4 OpenRouter). If you dispatch 5 `component-coder` calls at once, two will queue. That's fine — you'll see them complete in order. Don't try to be clever about batching; the cap handles it.

## Failure modes

- **`task-decomposer` returns `failed: …`** — read the reason. Usually it means the request is too ambiguous or out of scope. Surface to the user and ask for the missing detail.
- **A `component-coder` returns `failed: …`** — read the reason. Often it's a missing interface contract. Update `canvas/interfaces.md` (you can do this inline; it's text), then re-invoke that one component-coder.
- **A `component-coder` claims success but the file is broken** — its summary should mention verification. If verification was N/A, you may need to verify yourself (`npx tsc --noEmit`, `bash -n`, `python -m py_compile`). Re-dispatch on real failures.

## Old-style fallback (avoid)

The pre-orchestrator pattern was: decompose inline → write contracts inline → dispatch component-coders. That works for small jobs but leaks the plan and contracts into the parent's context. Avoid it for >3 components. The orchestrator pattern is strictly better for multi-component work because the parent only ever holds the plan items, not the plan reasoning or the contract text.

## Verification per step

Once a `component-coder` returns successful, that component is presumed verified (the subagent's job spec requires verification before reporting success). Trust but spot-check: if a critical-path component succeeded, you can `read_file` to glance at it before dispatching the next batch. Don't read every component or you'll re-leak context into your parent slot.

## Why this matters more on tighter context budgets

The orchestrator pattern's value scales with how much the parent's slot can hold. On a 200K+ slot the parent can inline most builds; orchestration is a stylistic preference for visibility. On a 65K slot the parent overflows around the 7th–10th file in a multi-component build; orchestration is the only path that ships. On a 32K slot, even smaller builds force decomposition.

Read your runtime block. If your slot is generous and the work fits inline, decline (return early in step 2 or skip the skill entirely — invoke `create-card-class` or do the work directly). If your slot is tight and the work won't fit inline, the orchestrator pattern is your tool. The decision is per-runtime, not per-skill.

The contract-first / decomposition-as-design-memory / per-subagent curation patterns above are valuable regardless of slot size — they're how decomposed work stays coherent. But the *threshold for triggering decomposition* depends on the runtime, not on the skill.
