---
name: decompose-task
description: Triggers on any non-trivial multi-file work — including planning-shaped asks. Activates for verbs like build / implement / create / develop / refactor / extend / add (feature work) AND review / design / audit / plan / assess / figure out next steps / determine best implementation path (planning work). Also triggers when the user references multiple files / components / modules in one ask. Tells the agent to delegate planning to the task-decomposer subagent BEFORE any inline file reads — review and design ARE planning, not "investigate by reading."
---

# Decompose the task — but don't decompose it yourself

The local model has a 65K-token context slot. Decomposing a multi-component build inline (in YOUR turn), then writing each component inline, blows past that slot around the 7th–10th file. By the time you'd be ready to `write_file`, the plan and the contracts and the prior file contents are already crowding the budget.

**The structural fix:** planning lives on the canvas, not in your transcript. You are the *orchestrator*. A `task-decomposer` subagent does the planning in its own context slot. A `component-coder` subagent does each piece of implementation in its own context slot. You read the plan from `canvas/plan.todo` and dispatch.

## The orchestrator workflow

Triggers on non-trivial multi-file work AND on planning-shaped asks. Examples:

- "build me a TV dashboard"
- "implement the email monitor"
- "refactor app.js into modules"
- "review the spec and figure out next steps"
- "design the auth module"
- "audit the codebase"
- "what's the best implementation path"
- "plan how we'd add billing"
- Any ask involving >2 files or >200 lines, or any "review/design/figure out" phrasing.

**STOP — before you reach for `read_file`:** Reviewing IS planning. Designing IS planning. Figuring out next steps IS planning. The temptation to "just look at spec.md and the code first" is your prior pulling you toward a pattern that overflows. Don't.

The first thing you do on any of the above asks is **delegate to `task-decomposer`**, NOT read files. The decomposer reads what it needs in its own context slot. You stay light, dispatching from the plan it produces.

Steps:

1. **Restate the ask** in one sentence. If genuinely ambiguous (the user said "build me a music player" with no other context), ask the clarifying question and stop. If the ask is clear enough to plan, continue.

2. **Delegate the planning IMMEDIATELY** — call `task({ agent: "task-decomposer", prompt: "<the user's request, verbatim, plus any clarifying context they gave>" })`. **Make this your first tool call.** Do NOT read any files first — the decomposer reads the canvas itself. If you find yourself thinking "let me just check spec.md first to give the decomposer context," stop: the decomposer has the same canvas you do, in its own slot. The decomposer writes/updates `canvas/spec.md`, `canvas/interfaces.md`, and `canvas/plan.todo`, then returns a one-line status.

3. **Read the plan** — `read_file canvas/plan.todo`. Each `## Active` item is one delegation-ready task. Items name the assignee (`@component-coder`) and the spec section the subagent should reference.

4. **Show the user** — paste the plan items into your turn response so they can see what's about to ship. If they want to edit before execution, they will say so (or edit `plan.todo` directly).

5. **Mark in-progress, dispatch, mark complete — per item, in that order.** Each plan item has a *lifecycle* on the `.todo` card the user is watching:

   - **Before dispatch:** `edit` plan.todo to flip `[ ]` → `[~]` on this item (in-progress marker). The .todo card renders this as a pulsing blue dot — the user sees exactly which item is being worked on right now.
   - **Then dispatch:** `task({ agent: "component-coder", prompt: "<plan item text verbatim>" })`. Independent items can be dispatched together (multiple `task` calls in one response, each preceded by its own `[~]` flip).
   - **On successful return:** `edit` plan.todo to flip `[~]` → `[x]` (done marker). The .todo card renders ✓ and the user sees the item complete.
   - **On failure return** (component-coder responds `failed: ...`): `edit` plan.todo to flip `[~]` → `[!]` (failed marker, red). Optionally add a one-line comment under the item with the failure reason. The user can click the `!` to reset the item to `[ ]` for retry, or fix the issue and ask you to re-dispatch.

   **Do NOT batch.** The .todo card watches its own file and re-renders on every save. Per-item edits become live UI progress: pending → in-progress → done. Batching breaks that — the user sees nothing for minutes, then everything flips at once. Worse, if you hit context-overflow mid-turn the un-flushed progress is lost.

   **Markers summary:** `[ ]` = pending, `[~]` = in progress (you're working on it now), `[x]` = done, `[!]` = failed (user should review).

6. **Iterate** until `## Active` has no `[ ]` or `[~]` items left. Each parent turn handles one or two batches of dispatches; the user sees progress in real time as items move pending → in-progress → done on the .todo card.

7. **Final summary** — when the plan is empty, summarize what shipped and ask if the user wants anything refined. Do NOT include file contents in your summary — the user can scroll or open the cards.

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

## Why this matters more on local Qwen

The cloud Claude path has a much larger context window and stronger working memory — it can hold 8 files in flight without overflow. The local Qwen 65K slot can't. For local, the orchestrator pattern isn't a nice-to-have — it's the only way to ship multi-component features without the turn errrring out mid-stream. For cloud, it's a cleaner pattern that produces a visible plan but isn't strictly required.

The skills file you're reading is loaded on Qwen. Apply the orchestrator pattern by default.
