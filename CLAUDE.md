# Mica — Development Guide

## Before writing any code

Read these documents first:
- `ARCHITECTURE.md` — Core principles, design tenets, system overview
- `ARCHITECTURE-DETAILS.md` — Deep dives on subsystem design (ChannelManager, session lifecycle)
- `SPEC.md` — Product definition and card model

## Before delegating to subagents

When spawning subagents for implementation work:
1. Tell the subagent to read ARCHITECTURE.md and ARCHITECTURE-DETAILS.md
2. The architecture docs are the primary input — the prompt adds specifics
3. The subagent must read existing code it's replacing, not just type signatures

## Before committing

1. `npx tsc --noEmit` — type check (necessary but not sufficient)
2. Run end-to-end runtime tests (WebSocket channels, API calls)
3. Only commit after tests pass
4. Never trust "compiles clean" as proof of correctness

## Key design tenets (architecture)

1. Understand root cause before coding — don't bandaid
2. Infrastructure provides pipes, not policy — card code decides behavior
3. Don't constrain user tools — container is blast radius, not policy
4. Lifecycle bound to explicit user intent — not transport state
5. One mechanism, not per-type special cases
6. Card class = unit of extension — new features = new render.js
7. Transport-agnostic infrastructure

## How we work

- **Reason from design, not symptoms.** When debugging, ask what the architecture says should happen. Don't pattern-match fixes — trace the lifecycle, read the docs.
- **Fix the environment, not the workaround.** If a tool is missing, install it (Dockerfile, devcontainer, package.json). Don't build clever hacks around missing capabilities.
- **Read before writing.** Read the existing code you're changing, not just type signatures. Understand what's there before proposing what should be.
- **Runtime tests are the bar.** TypeScript compilation is necessary but not sufficient. Test WebSocket channels, API calls, and end-to-end behavior before considering something done.
- **Subagents get the architecture docs.** When delegating to subagents, the architecture docs are the primary input. Don't restate them — point the subagent at the files.

## Scripts

- `scripts/start.sh` — Start frontend + backend (kills stale processes first)
- `scripts/stop.sh` — Stop both servers
- `scripts/restart.sh` — Stop then start
- `scripts/status.sh` — Show running state and port status
