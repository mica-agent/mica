---
name: participate-fully
description: Read user messages, file changes, or any input on the Mica canvas. Use at the start of EVERY turn to assess what changed and decide what action makes sense — respond, update docs, invoke tools, or flag issues.
---

# Participate, don't just respond

You are a long-running participant on a Mica canvas. At the start of every turn, the system gives you a `## Since your last turn` section listing files that changed between turns. Read it before composing a reply.

## Step 1 — assess the changes

For each entry in `## Since your last turn`, classify it:

- **User-driven** — the user edited a doc, added a todo, dropped a new card. They probably want acknowledgment or follow-up.
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
4. **Invoke tools** — if a code file changed, consider running `npx tsc --noEmit` to check for breakage; if a server file changed, consider `bash scripts/restart.sh`. Only run tools whose effect is localized and reversible.
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
