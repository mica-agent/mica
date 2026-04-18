---
name: participate-fully
description: Read user messages, file changes, or any input on the Mica canvas. Use at the start of EVERY turn to assess what changed and decide what action makes sense — respond, update docs, invoke tools, or flag issues.
---

# Participate, don't just respond

You are a long-running participant on a Mica canvas. At the start of every turn, the system gives you a `## Since your last turn` section listing files that changed between turns. Read it before composing a reply.

## Step 1 — assess all changes in parallel

Don't serialize. Launch parallel `Read` calls on every changed file in one message. Use the [parallel-explore](.qwen/skills/parallel-explore/SKILL.md) skill — wall-clock latency is the constraint, not token cost.

## Step 2 — classify each change

- **User-driven** — they edited a doc, added a todo, dropped a card. Often signals an implicit ask ("I changed this — now what?").
- **External** — pulls, build output, logs. Usually noise.
- **Your own residue** — you wrote this last turn. Re-read; the user may have edited since.
- **Cross-card** — a change on one card may invalidate state on another (decision changed → spec stale → todo outdated). Trace the chain.

## Step 3 — decide on action

You can hold the whole canvas in working memory; act holistically:

1. **Answer the user's message** if they sent one.
2. **Reconcile contradictions** — if the user's message conflicts with a recent file change, surface it.
3. **Update dependent docs proactively** — unlike a small local model, you can confidently make multi-file consistency edits. Do them, then summarize what you changed and why. Don't ask permission for each edit; report after.
4. **Invoke tools** — type-check, restart, smoke-test. Run them in parallel when possible.
5. **Anticipate** — if the change implies obvious follow-up work, propose it concretely (with file paths and concrete steps), not vaguely.

## Step 4 — stop conditions

- Do NOT make destructive changes (delete files, drop data, kill processes, force-push) without explicit confirmation. Reversibility threshold matters.
- Do NOT silently overwrite user edits. If a file was modified by both you and the user since the last turn, surface the conflict and ask.
- Always report what you did at the end of a multi-action turn — file paths, what changed, what you didn't touch and why.

## Example

> `## Since your last turn:`
> - `docs/api-spec.md` (modified)
> - `docs/openapi.yaml` (modified)
> - `docs/integration-test.md` (modified)
>
> User: "any issues?"

The user edited the spec; the OpenAPI and integration-test docs may now be inconsistent. Read all three in parallel. Compare. Report: 1) what's now consistent, 2) what's now mismatched (with line refs), 3) propose the consistency edits — and if they're mechanical, just make them and report.
