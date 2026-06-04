---
name: decompose-task
description: Invoke whenever the user uses a build verb — "build", "create", "implement", "make", "develop", "ship", "construct" — for any non-trivial artifact, regardless of size. The verb is the trigger; do not gate on "is this complex enough." Tiny tasks produce tiny plans (1-2 items) — that overhead is acceptable because the orchestrator path is where decisions get documented (spec.md → interfaces.md → plan.todo → component-coder dispatches), where library research happens (`discover-dependency` per subproblem), and where card-class authoring routes through the Mica tools (`mica_create_class`, `mica_edit_class_file`). Skip ONLY for: bug fixes (use `fix-bug` instead), pure Q&A ("what does X do?"), doc-only edits ("update spec to say Z"), or when the user explicitly overrides ("just do it directly", "skip the planning"). Subagents (especially component-coder) inherit the working set; doing the work inline burns the parent's slot context with file reads and tool results that decompose-task would have isolated.
---

# Orchestrate decomposed work — but don't decompose yourself

You are the *orchestrator*. A `task-decomposer` subagent does the planning in its own slot, producing four artifacts on canvas. A `component-coder` subagent does each piece of implementation in its own slot. You read the artifacts and dispatch. **You produce no implementation code yourself.**

For cross-skill discipline (decomposition gates, approval flow, dispatch shape) see `.qwen/skills/_conventions.md`. Tenet numbers refer to ARCHITECTURE.md / CLAUDE.md.

## Apply the gates before invoking this skill

**Tenet 12 — decomposition gate.** Decompose only when both gates pass:

(a) Real architectural seams (named integration boundaries, distinct contracts).
(b) Integrated whole exceeds the parent's working set.

If either fails, drop the orchestrator path: invoke `card-class-handbook` for card-class work, `fix-bug` for bugs, or do edits directly. **Default to inline.** Almost any non-trivial task has nameable seams in the abstract — that's not the question. The question is whether the parent's *actual incapacity* to do the work in one slot justifies the overhead.

The full procedure (including non-arguments — "reusable design memory", "narrative cleanliness", "future flexibility") is in `_conventions.md` § Decomposition gates. Read it before invoking this skill if you're uncertain.

**Tenet 14 — approval gate.** Verify the user has explicitly approved the spec for implementation. Approval signals: *"ok build it"*, *"yes go ahead"*, *"let's build"*, *"ship it"*, *"start implementation"*, *"decompose this"*. **Do NOT invoke this skill if** the trigger was a `[File changes detected]` event listing spec.md (the user is editing, not approving), or the user's last message was a question/critique, or the spec is a one-line stub the user just updated. See `_conventions.md` § Approval flow.

**If approval is missing:** acknowledge the change in chat, optionally surface inconsistencies, post the explicit gate (*"Spec looks firm to me — ok to build?"*), then **wait**.

## The orchestrator workflow

If both gates pass, proceed:

1. **Restate the ask** in one sentence. If genuinely ambiguous, ask the clarifying question and stop.

2. **Delegate the planning.** Call `task({ agent: "task-decomposer", prompt: "<the user's request, verbatim, plus any clarifying context>" })`. Light pre-reads (user's spec.md, quick canvas glance) are fine before deciding; if budget is tight, skip them. The decomposer writes/updates four artifacts: `canvas/spec.md`, `canvas/interfaces.md` (named sections), `canvas/decomposition.md` (design memory), `canvas/plan.todo` (with per-item `Context:` and `Skip:` manifests).

   If the decomposer returns `declined: parent can inline this work` — that's a successful outcome confirming the gate. Drop the orchestrator path and inline the work yourself. **Don't re-invoke `task-decomposer` to force a plan.**

3. **Read the artifacts.** `read_file canvas/decomposition.md` and `read_file canvas/plan.todo`. Confirm every plan item references a `## Subcomponents § <name>` entry from decomposition.md.

4. **Surface the design to the user.** In your turn response: paste decomposition.md (or summarize) so the user sees the architecture. Mention plan.todo for the queue. Don't pause/wait artificially; finish your turn and dispatch on the next, OR continue dispatching now if the design is clear. The user can interject by replying or by editing the canvas files directly.

5. **Mark in-progress, dispatch with role-context, mark complete — per item, in that order.** Each plan item has a lifecycle:

   - **Before dispatch:** `edit` plan.todo to flip `[ ]` → `[~]`.
   - **Then dispatch:** `task({ agent: "component-coder", prompt: "<role-context + plan item>" })`. Construct the prompt by reading the item's `Context:` line for the section names, then pasting:
     - The relevant `## Subcomponents § <name>` entry from decomposition.md (so the subagent knows what it owns and what's out of scope).
     - The plan item text verbatim (Context:, Skip:, parallel-safe flag).
     - The subagent reads its named contract/spec sections itself.
   - **Default to PARALLEL dispatch** when items are marked `parallel-safe: true`. Issue multiple `task` calls in one response (each preceded by its own `[~]` flip). Drop to sequential only for items marked `parallel-safe: false`.
   - **On successful return:** flip `[~]` → `[x]`.
   - **On `failed:` return:**
     - `failed: contract gap on <X>` or `failed: contract too coarse` — re-invoke `task-decomposer` with the gap; it extends interfaces.md (and possibly decomposition.md), then re-dispatch.
     - `failed: context manifest insufficient — needed § <X>` — edit plan.todo to add `<X>` to the item's `Context:` line, then re-dispatch.
     - `failed: decomposition needs revision — <what>` — re-invoke `task-decomposer` with the discovery; it updates decomposition.md (revision-log entry), updates plan.todo, then re-dispatch affected items.
     - `failed: scope too large` — re-invoke `task-decomposer` to split the item.
     - For other failures: flip `[~]` → `[!]` and surface to the user.

   **Do NOT batch state edits.** The `.todo` card watches its file and re-renders on every save. Per-item edits become live UI progress.

   Markers: `[ ]` pending, `[~]` in progress, `[x]` done, `[!]` failed.

6. **Iterate** until `## Active` has no `[ ]` or `[~]` items. Update decomposition.md with revision-log entries any time the design shifted (seams moved, subcomponents added, scope changed). Future sessions inherit the current truth, not the original plan.

7. **Verify the contract held, then verify the artifact works.** Empty `## Active` is NOT success on its own — subagents reported `done` based on their own slot's view.

   **Stage 1 — contract verification.** Read each plan item's output and confirm it honors `interfaces.md`. For card classes:
   - For each named DOM ID in `interfaces.md § DOM contract`, grep card.html for the ID. Grep card.js for `getElementById('<id>')` and `querySelector('#<id>')` — every reference resolves to an ID the contract names AND that card.html defines.
   - Confirm card.css has rules for the IDs/classes the contract says it must style.
   - Confirm card.js's init function follows the contract's specified order.
   - Confirm cleanup contract: every `setInterval` / `addEventListener` / `ResizeObserver` / Leaflet `L.map(...)` has a tear-down inside `mica.onDestroy`.

   If any contract violation is found, the parent's response is **NOT** to fix it inline. Re-dispatch the divergent subagent with a corrective prompt naming the contract section and the violation. Contract violations are localizable — that's the property contracts buy you.

   **Stage 2 — integration verification.**
   - Card-class builds: `render_capture({ filename: "<canvas>/<instance>.<extension>" })`. Inspect the PNG. Did the card mount? Layout right? Red error banner? Also check `.mica/cards/<id>.json` for any errors emitted via `mica.reportError`.
   - Non-card builds: run the project's integration test (`npm test`, `pytest`) or, if none exists, verify artifacts compose (import + smoke entry point).

   If Stage 2 fails despite Stage 1 passing, the contract had a behavioral gap — refine `interfaces.md` to close it (contract debt the next build benefits from), then re-dispatch.

8. **Final summary** — when verification passes, summarize what shipped and ask if anything needs refinement. Do NOT include file contents — the user can scroll or open the cards.

## When the user explicitly opts out

If the user says "just do it directly" / "don't bother with subagents" / "this is small, just write the file" — respect that. Inline the work.

## Concurrency

Subagent concurrency is capped per-project (default 3 concurrent local, 4 OpenRouter). If you dispatch 5 `component-coder` calls at once, two will queue. That's fine — you'll see them complete in order.

## Failure modes

- **`task-decomposer` returns `failed: …`** — read the reason. Usually request is too ambiguous or out of scope. Surface to the user and ask for the missing detail.
- **A `component-coder` returns `failed: …`** — read the reason. Often a missing interface contract. Update `canvas/interfaces.md` (you can do this inline; it's text), then re-invoke that one component-coder.
- **A `component-coder` claims success but the file is broken** — its summary should mention verification. If verification was N/A, you may need to verify yourself (`npx tsc --noEmit`, `bash -n`, `python -m py_compile`). Re-dispatch on real failures.

## Verification per step

Once a `component-coder` returns successful, that component is presumed verified (the subagent's job spec requires verification before reporting success). Trust but spot-check critical-path components by `read_file`. Don't read every component or you'll re-leak context into your parent slot.
