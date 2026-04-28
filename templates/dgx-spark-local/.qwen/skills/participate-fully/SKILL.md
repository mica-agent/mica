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
