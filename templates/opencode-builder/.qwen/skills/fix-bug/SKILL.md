---
name: fix-bug
description: Bug-shaped requests — "fix X", "Y is broken", "Z doesn't work", "wrong …", "regression in …", "investigate why …". Reproduce → root cause (not symptom) → minimal change → verify → update docs only if user-visible behavior changed.
---

# Fix the bug — discipline before code

A bug fix is not a feature build. The orchestrator pattern (decompose → dispatch) works against you here: a single bug is one focused investigation, not a multi-component plan. Don't reach for `task-decomposer` — that's for new work. The playbook below is what fits a bug fix.

For cross-skill discipline (reading, reuse, API discipline, decomposition gates, approval flow) see `.qwen/skills/_conventions.md`. Tenet numbers refer to ARCHITECTURE.md / CLAUDE.md.

## The five-step playbook

### 1. Reproduce first

Before forming any theory, demonstrate the bug concretely. The reproduction tells you:

- What the user actually sees (not what they reported, which is summarized).
- The exact code path the failure travels.
- Whether the bug is deterministic or intermittent.

Concrete reproduction looks like:

- A `curl` that returns the wrong response body or status.
- A browser action you can describe step-by-step.
- A `bash -n` / `tsc --noEmit` / `python -m py_compile` that catches the error.
- A small script in `test/<name>-test.mjs` that triggers the failing path.

If you can't reproduce, **stop and ask**. A speculative fix is a guess.

### 2. Diagnose root cause, not symptom (tenet 7)

**First — consult `canvas/decomposition.md` if it exists.** The `## Subcomponents` section is your routing table for "where does this bug live?". Each subcomponent's "owns" line tells you which one is responsible for the affected behavior; its "Honors" line tells you which contract sections constrain it. Routing to the right subcomponent saves diagnosis time AND ensures the fix lands in the part of the code that actually owns the behavior.

If decomposition.md doesn't exist, proceed with structural reading.

Trace from the user-visible failure backward. The question isn't "what edit makes the symptom go away?" — it's "what's the smallest change that prevents the wrong output from being produced in the first place?"

Anti-patterns to watch for in your own thinking:

- **Suppressing the symptom.** Wrapping the failing code in `try { ... } catch { /* ignore */ }` makes the error disappear without fixing why it happened. Almost always wrong.
- **Adding fallback layers.** "If X is null, default to Y" — fine when Y is the genuinely correct behavior, wrong when X being null is itself a bug upstream.
- **Patching at the wrong layer.** A render bug that's actually a data-shape bug should be fixed in the data layer, not by adding render-side null checks.

Read the code at the failure point AND its callers AND the data flowing in. The root cause is rarely at the line where the error fires.

### 3. Apply the minimal fix

Once you know the root cause, change only what's needed:

- **No "while I'm at it" cleanup.** If you spot adjacent issues, list them in your reply but don't touch them.
- **No surrounding refactor.** A bug fix that introduces a new abstraction has higher review cost AND mixes "fix" with "design change."
- **No new tests beyond the reproduction.** Add the reproduction case as a regression test if the project has a test suite. Don't write a comprehensive suite for the function — that's a separate task.

**Pick the right write tool for the path** (CLAUDE.md file-write decision rule applies on bug-fix turns too — it's not a new-build-only rule):

- `.mica/card-classes/<name>/card.{js,html,css}` → **`mica_edit_class_file`** (NOT raw `edit`). The structured tool runs pre-write lint and partial-edit safety checks that catch the failure modes raw `edit` doesn't. A bug fix that lands a syntax error via raw `edit` is still a bug.
- `.mica/card-classes/<name>/metadata.json` → **`mica_create_class`** (re-call with the same name + extension to update in place; do NOT delete-and-recreate to change a dependency).
- Everything else (free-form markdown, generated data, source files outside `.mica/card-classes/`) → `edit` or `write_file` as appropriate.

The handbook protected-path rule fires equally during fix-bug and during develop — the difference between "bug fix" and "new build" is in the *kind* of change, not in which tools own the file's schema. If you've been using raw `edit` on a card-class file successfully so far, that's been working around the lint, not avoiding it; switch back.

If the fix would naturally exceed ~50 lines, stop and reconsider. Either the bug is bigger than reported, or you're fixing too much.

If the fix would require >20 lines of new bespoke logic in an area where libraries exist (rendering, math, parsing, networking, dates, charts), invoke `discover-dependency` instead. See `_conventions.md` § Reuse before reinventing. A library-shaped fix replaces both the bug and the surrounding fragile code with a maintained dependency. Library decision goes in `spec.md § Subproblems and their solutions`.

### 4. Verify the bug is gone AND check for regressions

Two distinct checks:

- **Reproduction now passes.** Re-run the exact thing from step 1. Show the output as evidence — don't just say "fixed."
- **Adjacent code that uses the same pattern.** Grep for the same anti-pattern (e.g. if you fixed an XSS via missing `escapeHtml`, search for other unescaped interpolations). Flag any matches in your reply.

The `verify-then-continue` skill handles the type-check + restart + curl mechanics.

### 5. Update docs if user-visible behavior changed

A bug fix that changes what the user sees (a number rendered differently, a default flipped, an error message altered, an item appearing in a list) requires a `spec.md` (or analogous doc) update in the same turn. The `doc-consistency` skill says this — bug-fix turns are not exceptions.

**Also update `decomposition.md` if the bug exposed a structural issue** — wrong subcomponent ownership, missing contract section, undocumented dependency. Add a revision-log entry. The cost is one line of markdown; the value is the next bug-fix session knows the architecture has been refined. If the fix is purely local (within one subcomponent's accepted scope, no boundary issues), decomposition.md needs no update.

If the bug fix only changes implementation (same observable behavior, just correct internally — e.g., a memory leak fixed without any user-visible difference), no doc update needed. State this in your summary.

## Routing: inline vs delegate to `bug-fixer`

A single bug fix is typically inline. Some bugs need the investigation in a subagent's slot. Use these signals in priority order:

**1. Number of distinct files needing investigation.**
- 1-2 files → **inline**
- 3+ files → **delegate** to `bug-fixer` (when available)

**2. Largest single file's size.**
- Use `wc -c` to measure. If any file exceeds the **per-input cap** in your `## Subagent context budget` block (or `## Your context budget` for the subagent's view), delegate. Don't hardcode a number; read it from the prompt.

**3. How much parent context you've already used this turn.**
- Capacity meter ≥50% of context window → next significant read pushes toward overflow. Delegate.
- ≤30% → inline is fine.

**4. EXCEPTION — iterative debug where the user is steering.**
- "Why doesn't this work? Try X. Hmm, that didn't help, what about Y?" — this is collaborative investigation. ALWAYS inline, regardless of the above. A subagent runs in a fresh slot and loses the conversation thread.

**5. Multiple discrete bugs handed to you at once.**
- "Here are 5 bugs, fix them all" → dispatch each independent bug as a separate `bug-fixer` task, in parallel where possible.

If `bug-fixer` is not registered (`agents/bug-fixer.md` doesn't exist), inline is your only option — note it in your reply if delegation would have helped.

## Card runtime errors — "Failed to load dependency"

When the chat surfaces `[card-error] Failed to load dependency: Failed to load <url-or-name>`, the diagnostic order matters. The full debug procedure is in `card-class-handbook/SKILL.md` § Pitfalls. Quick form (tenet 16: validate inputs):

1. **Verify the URL.** `curl -sI -L "<exact URL from the error>" | head -1`. If 404, the URL is wrong — fix `metadata.json`, don't guess a replacement, look it up via npm registry or jsdelivr.
2. **If the URL is reachable but the card still fails:** the file loaded but doesn't match the card's assumption. Check global/namespace, version semantics, MIME type. Use `mica_inspect_url` on the URL — its `format` field tells you UMD/CJS/ESM, and the `methods` array surfaces the actual public API. For body inspection beyond what the tool returns, `curl -s <url> | head -c 4000` for plain text / small responses; `web_fetch` with a specific prompt for HTML doc pages where curl would dump 50KB+ of cruft.
3. **Only if both above pass** does the bug live in the card-class loading path — see `card-class-handbook/SKILL.md` for `card.html` rules.

**Runtime `X.method is not a function`**: don't guess another method name — use `mica_inspect_url` on the library's CDN URL and read the returned `methods` array for the actual public API.

**Anti-pattern:** re-reading `metadata.json` hoping for clarity. The URL it's failing on is exactly what's there; re-reading produces no new information. The model can loop on this until the SDK kills the process. Break out: do `curl` first.

**Time budget:** ONE round of `curl` + one fix. If a second attempt also fails, stop and ask the user — guessing a third URL is a bad use of context.

## What NOT to do

- Do NOT call `task-decomposer`. That subagent is for build/refactor work; a bug fix doesn't need a plan.
- Do NOT batch bug fixes through `component-coder`. That subagent is for implementing new components per spec; it will rewrite the file rather than do a minimal edit.
- Do NOT add features adjacent to the fix. Record observations in your summary; don't act on them.
- Do NOT silence the symptom without finding the cause (tenet 7). Wrapping in try/catch, returning a default, adding a null check are tempting and almost always wrong.
- Do NOT skip the reproduction step.

## Reporting back

At the end of an inline bug fix, your reply includes:

- **Root cause** in one sentence (what was wrong, where).
- **Change made** (file + lines, or a brief diff sketch).
- **Verification** — what you ran to confirm the fix.
- **Adjacent observations** — anything you spotted that wasn't this bug, with one-line descriptions, no fixes.
- **Doc update** — if user-visible behavior changed, what you updated. If not, "no doc update needed."

Keep this report tight. Trust the diff to speak for itself rather than restating what the code now does.
