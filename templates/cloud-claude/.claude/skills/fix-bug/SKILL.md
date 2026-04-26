---
name: fix-bug
description: Triggers on bug-shaped requests — "fix the X bug", "Y is broken", "Z doesn't work", "the … is wrong", "regression in …", "error in …", "this is producing the wrong …", "investigate why …". Tells the agent how to handle a bug fix: reproduce, find root cause (not symptom), apply the minimal change, verify, and update docs only if user-visible behavior changed. Includes a routing rule for inline vs delegating to a `bug-fixer` subagent based on scope, not model identity.
---

# Fix the bug — discipline before code

A bug fix is not a feature build. The orchestrator pattern (decompose → dispatch) works against you here: a single bug is one focused investigation, not a multi-component plan. Don't reach for `task-decomposer` — that's for new work. The playbook below is what fits a bug fix.

## The five-step playbook

### 1. Reproduce first

Before forming any theory about what's wrong, demonstrate the bug concretely. The reproduction is what tells you:

- What the user actually sees (not what they reported, which is summarized)
- The exact code path the failure travels
- Whether the bug is deterministic or intermittent

Concrete reproduction looks like:

- A `curl` that returns the wrong response body or status
- A browser action you can describe step-by-step ("hard refresh, click X, observe Y")
- A `bash -n`/`tsc --noEmit`/`python -m py_compile` that catches the error
- A small script in `test/<name>-test.mjs` that triggers the failing path

If you can't reproduce, **stop and ask**. A speculative fix is a guess. Either you're missing context (ask the user for more detail), or the bug is environmental (different browser, different state) and needs the user's collaboration to surface.

### 2. Diagnose root cause, not symptom

Trace from the user-visible failure backward. The question isn't "what edit makes the symptom go away?" — it's "what's the smallest change that prevents the wrong output from being produced in the first place?"

Anti-patterns to watch for in your own thinking:

- **Suppressing the symptom.** Wrapping the failing code in `try { ... } catch { /* ignore */ }` makes the error disappear without fixing why it happened. Almost always wrong.
- **Adding fallback layers.** "If X is null, default to Y" — fine when Y is the genuinely correct behavior, wrong when X being null is itself a bug upstream.
- **Patching at the wrong layer.** A render bug that's actually a data-shape bug should be fixed in the data layer, not by adding render-side null checks.

Read the code at the failure point AND its callers AND the data flowing in. The root cause is rarely at the line where the error fires.

### 3. Apply the minimal fix

Once you know the root cause, change only what's needed to fix it. Specifically:

- **No "while I'm at it" cleanup.** If you spot adjacent issues, list them in your reply but do not touch them. The user asked for one fix; doing five erodes their trust in your scope discipline.
- **No surrounding refactor.** A bug fix that introduces a new abstraction has higher review cost AND mixes "fix" with "design change," making rollback harder if the fix is wrong.
- **No new tests beyond the reproduction.** Add the reproduction case as a regression test if the project has a test suite. Don't write a comprehensive suite for the function — that's a separate task.

If the fix would naturally exceed ~50 lines of changes, stop and reconsider. Either the bug is bigger than reported, or you're fixing too much. Either case warrants a conversation with the user before continuing.

### 4. Verify the bug is gone AND check for regressions

Two distinct checks:

- **Reproduction now passes.** Re-run the exact thing from step 1. Show the output as evidence — don't just say "fixed."
- **Adjacent code that uses the same pattern.** Grep for the same anti-pattern (e.g. if you fixed an XSS via missing `escapeHtml`, search the file for other unescaped interpolations). Flag any matches in your reply, even if you don't fix them in this turn.

The `verify-then-continue` skill handles the type-check + restart + curl mechanics. Bug fixes always run those, plus the reproduction-now-passes check.

### 5. Update docs if user-visible behavior changed

A bug fix that changes what the user sees (a number rendered differently, a default flipped, an error message altered, an item appearing/disappearing in a list) requires a `spec.md` (or analogous doc) update in the same turn. The `doc-consistency` skill already says this — bug-fix turns are not exceptions.

If the bug fix only changes implementation (same observable behavior, just correct internally — e.g., a memory leak fixed without any user-visible difference), no doc update needed. State this in your summary so the user knows you considered it.

## Routing: inline vs delegate to `bug-fixer`

A single bug fix is typically inline work — the parent agent reproduces, diagnoses, and fixes in its own context. But for some bugs the investigation is large enough that the parent's slot can't safely hold it. Use these signals, in priority order, to decide:

**1. Number of distinct files needing investigation.**
- 1-2 files → **inline**
- 3+ files → **delegate** to `bug-fixer` (when the subagent is available)

**2. Largest single file's size.**
- Use `run_shell_command({ command: "wc -c <file>", ... })` to measure.
- If any file exceeds the **per-input cap** stated in your system prompt's `## Subagent context budget` block (or `## Your context budget` for the subagent's view), delegate. The cap scales with the runtime context size — don't hardcode a number; read it from the prompt.
- If all files are below the cap → inline.

**3. How much parent context you've already used this turn.**
- Check the chat card's capacity meter (visible in the UI status area) — if you're at ≥50% of the context window already, the next significant read pushes toward overflow. Delegate.
- Early in the turn (≤30%) → inline is fine.

**4. EXCEPTION — iterative debug where the user is steering.**
- "Why doesn't this work? Try X. Hmm, that didn't help, what about Y?" — this is collaborative investigation, not delegation work.
- ALWAYS inline, regardless of the above signals. A subagent runs in a fresh slot and loses the conversation thread the user is co-developing with you. Delegation here produces correct fixes for the wrong question.

**5. Multiple discrete bugs handed to you at once.**
- "Here are 5 bugs, fix them all" → dispatch each independent bug as a separate `bug-fixer` task, in parallel where possible.

If `bug-fixer` is not registered as a subagent in your project (`agents/bug-fixer.md` doesn't exist), inline is your only option — note that in your reply if a delegation would have helped, so the user can decide whether to install the subagent.

## What NOT to do

- **Do NOT call `task-decomposer`.** That subagent is for build/refactor work that produces multi-component plans. A bug fix doesn't need a plan; it needs a focused fix.
- **Do NOT batch bug fixes through `component-coder`.** That subagent is for implementing new components per spec. It will rewrite the file rather than do a minimal edit.
- **Do NOT add features adjacent to the fix.** "While I was here I noticed …" — record observations in your summary, don't act on them.
- **Do NOT silence the symptom without finding the cause.** Wrapping in try/catch, returning a default, adding a null check — all are tempting and almost always wrong.
- **Do NOT skip the reproduction step.** "I think I see the issue, let me just fix it" produces guess-fixes that ship new bugs. Reproduce first.

## Reporting back

At the end of an inline bug fix, your reply should include:

- **Root cause** in one sentence (what was wrong, where).
- **Change made** (file + lines, or a brief diff sketch).
- **Verification** — what you ran to confirm the fix.
- **Adjacent observations** — anything you spotted that wasn't this bug, with one-line descriptions, no fixes.
- **Doc update** — if user-visible behavior changed, what you updated. If not, "no doc update needed."

Keep this report tight; the user will read it. Trust the diff to speak for itself rather than restating what the code now does.
