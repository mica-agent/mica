---
name: participate-fully
description: Read user messages, file changes, or any input on the Mica canvas. Use at the start of EVERY turn to assess what changed and decide what action makes sense — respond, update docs, invoke tools, or flag issues.
---

# Participate, don't just respond

You are a long-running participant on a Mica canvas. At the start of every turn, the system gives you a `## Since your last turn` section listing files that changed between turns. Read it before composing a reply.

## Step 0 — load project design memory (once per session, before Step 1 on the first relevant turn)

If `canvas/decomposition.md` exists, read it before doing anything that touches code or architecture. It's the project's design memory: subcomponents, dependency graph, verification gates, revision log. A prior orchestrator session decided how this project is structured and recorded the rationale; you inherit that decision rather than re-deriving from scratch.

Skip this step on turns that don't touch code (purely conversational, planning, asking questions). When the turn DOES touch code or architecture, decomposition.md is your routing table:

- "Where does this bug live?" → `## Subcomponents` tells you which subcomponent owns the affected behavior.
- "Where do I add this feature?" → which subcomponent's scope does it fit, or do we need a new subcomponent (and a decomposition revision)?
- "Why is this split this way?" → `## Open seams I considered and rejected` gives you the prior planner's reasoning.

If decomposition.md doesn't exist, the project hasn't been decomposed (that's fine — it may not have needed it). Don't create one for trivial work.

## Step 1 — assess the changes

For each entry in `## Since your last turn`, classify it:

- **User-driven** — the user edited a doc, added a todo, dropped a new card. They probably want acknowledgment or follow-up. **If they edited `decomposition.md` specifically, the architecture has changed — re-read it before any code action; the design memory just shifted.**
- **External** — git pull, build artifact, log file. Usually noise; skip unless directly relevant.
- **Your own residue** — you wrote this last turn. Confirm it's still in the state you left it; if the user modified it since, treat as user-driven.

If the section is missing or empty, skip to Step 4.

## Step 2 — read what's relevant

Use `Read` on the changed files that look meaningful (a new spec, an edited todo card, an updated chat thread on another card). Use `tiny-context` rules — read only what you need.

For files YOU wrote last turn, re-read to see if the user edited them — your prior memory may be stale.

## Step 3 — decide on action

Possible actions in priority order:

1. **Answer the user's message** — always do this if they sent one.
2. **Reconcile contradictions** — if the user's message contradicts a recent file change (e.g. they ask "what should we do?" but their decisions card already answers it), surface the contradiction in your reply.
3. **Update dependent docs** — if a decision or spec changed, related docs (diagrams, plans, READMEs) are likely stale. Use the `doc-consistency` skill: grep for references, propagate mechanically, or ask when ambiguous. PROPOSE propagation; don't make sweeping edits without confirmation.
4. **Invoke tools** — if a code file changed, consider running `npx tsc --noEmit` to check for breakage. **Never run `scripts/restart.sh` or `scripts/stop.sh`** — you live inside the backend's process tree, so the script will SIGTERM you mid-tool-call and the restart will not complete. If a `server/*.ts` change genuinely needs a restart, ask the user inline ("I edited `server/foo.ts` — can you restart from your shell?"). Card classes and project files hot-reload via the file watcher; no restart needed for those. Only run tools whose effect is localized and reversible.
5. **Flag follow-ups** — if the change suggests work the user hasn't asked for ("you renamed X but the todo still references Y"), call it out in your reply rather than silently fixing.

## Step 3.5 — file-changed events are NOT build triggers (tenet 14)

A file save is not a build trigger. See `.qwen/skills/_conventions.md` § Approval flow for the full procedure. Quick form: when `## Since your last turn` lists `spec.md`, `interfaces.md`, or any other canvas-level design doc, the user is iterating. Until they send an explicit affirmative ("ok build it", "yes go", "ship it"), your only legitimate response is acknowledgment, refinement questions, or posting the explicit gate ("Spec looks firm to me — ok to build?"). Do not invoke `task-decomposer`, `card-class-handbook`, write card-class files, or dispatch `component-coder` from a file-change event.

## Step 3.6 — diagnose root cause, not symptom (tenet 7)

When fixing something the user reports broken, trace from the user-visible failure backward to the smallest change that prevents the wrong output from being produced. Suppressing the symptom (`try/catch { /* ignore */ }`), adding fallback layers ("if X is null, default to Y"), or patching at the wrong layer (render-side null checks for a data-shape bug) are tempting and almost always wrong. The `fix-bug` skill has the full playbook.

## Step 3.7 — don't rebuild agent internals (tenet 10)

Mica is an augmentation layer on coding agents. Token-aware chat-history trimming, silent summarization, prompt-cache management, retries, and `/compress`-equivalents all live on the agent's side of the line — don't shim them in card.js, in server channel handlers, or in skill prose. If you find yourself adding "context budget management" inside Mica, stop and check whether the agent SDK already does it. See `_conventions.md` § Reuse before reinventing.

## Step 3.8 — follow APIs as authored; validate 3rd-party endpoints (tenet 16)

Use signatures and shapes verbatim. `mica.read()` is hallucinated; `mica.getContent()` is real. ARCHITECTURE.md is the authority on `mica.*`; if a method isn't documented there, it doesn't exist. For 3rd-party endpoints (URLs, services, library entry points), verify they exist and return the shape your code parses *before* committing to the integration — one `curl` test before you write the parsing code is far cheaper than debugging a hallucinated URL after. See `_conventions.md` § API discipline.

## Step 3.9 — fan out for independent N-unit work (tenet 13)

Before iterating over a collection (rows in a table, files matched by glob, sources in a list, items in any "for each X, do Y" shape), estimate cumulative tool I/O: units × typical per-unit tool-result size. Compare against "Parent inline I/O budget after baseline" in the `## Detected runtime` banner.

If estimated cost > ~50% of that budget AND units are independent (each unit's work doesn't depend on another unit's result), DO NOT iterate inline. Fan out. The mechanism has three parts:

1. **Operation contract.** Write `canvas/<verb>-task.md` (e.g. `verify-task.md`, `audit-task.md`, `refactor-task.md`, `research-task.md`). Include: input-slice format, the per-unit operation, write-back target, scope fence (what NOT to touch), and formatting conventions. This is the iteration equivalent of `interfaces.md` — one shared operation governing every batch.

2. **Queue.** Write or extend `canvas/plan.todo` with one item per batch. Sizing: units × per-unit cost ≤ subagent total I/O ÷ 2 (from runtime banner). Each item names input file + explicit slice + "per `<verb>-task.md`".

3. **Dispatch.** For each batch, flip `[ ]` → `[~]` in plan.todo, then call `agent` with a short prompt: "Read `canvas/<verb>-task.md`. Apply to `<slice>`. Write findings per its write-back rules." The subagent reads the contract from canvas (cheap), works on its slice, edits canvas files in place. Flip `[~]` → `[x]` on success, `[~]` → `[!]` on failure. Dispatch strategy depends on the runtime banner's `Model:` field: when the model is **local** (llama-server-served), dispatch SEQUENTIALLY — concurrent batches share one GPU, so parallelism gives no latency win and the value of fan-out is purely context isolation. When the model is via **OpenRouter** (separate inference per request), default to PARALLEL dispatch — emit multiple `agent` calls in one message — for genuine latency wins.

This is Shape-B fan-out (orchestration, not synthesis). Distinct from Shape-A (`decompose-task` skill), which produces a contract-driven BUILD with `decomposition.md` + `interfaces.md` + `component-coder` items. Use Shape-A only when seams are architecturally real per tenet 12; use Shape-B for any independent N-unit work regardless of domain. `analyze-repo` is an existing specialized Shape-B skill for codebase analysis (its operation contract is hardcoded). For ad-hoc cases (table verification, multi-source research, bulk refactor, cross-reference audit, multi-variant generation, bulk test generation, translation, per-card visual audit), author the operation contract on canvas per the three-part mechanism above.

## Step 4 — stop conditions

- Do NOT make destructive changes (delete files, drop tables, kill processes) without confirming.
- Do NOT make sweeping edits ("I updated 12 files to match the new convention") without proposing first.
- Do NOT chain proactive actions across turns. One reply, then wait.

## Example

> `## Since your last turn:`
> - `docs/decisions.md` (modified)
> - `docs/todo.md` (modified)
>
> User: "OK looks good"

Read both files. The user added a new decision and checked off a related todo. "Looks good" probably means "the decision I just wrote is acceptable to act on." Reply with: 1) acknowledge the decision, 2) propose the next concrete step toward implementing it, 3) ask before starting work.
