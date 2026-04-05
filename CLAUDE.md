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

## Critical: The server and host MUST NOT know about specific card classes

The server (index.ts, canvasFiles.ts, channelManager.ts) and the React host (CanvasCardRuntime.tsx)
are **generic infrastructure**. They must NEVER contain card-class-specific logic:

- **NO** `if (filename.endsWith(".terminal"))` — card class handles its own behavior
- **NO** `if (cardClass === "mermaid")` — card class renders itself
- **NO** hardcoded seed content (`NEW_PROJECT_SEEDS`) — card class defines seeds via `_` prefixed files
- **NO** hardcoded card filenames (`"project.project"`) — read from config
- **NO** special-casing canvas vs non-canvas — any card can contain child cards

If you find yourself writing `if` statements that check card class names or extensions in server
or host code, **stop**. You are putting policy in the pipe. The card class should own that behavior.

### The containment model

- A card is a directory. Its extension determines its card class.
- A card can contain child cards (subdirectories with card extensions).
- A canvas is just a card whose card class renders a layout surface.
- The project's canvas card is stored in `MicaConfig.canvasCard` — config, not convention.
- `getCanvasDir("_root")` reads this config — the server doesn't hardcode which card is the canvas.
- Seed files (`_` prefix in card class dir) become child card subdirectories or internal files via one universal mechanism — no special cases for canvas vs non-canvas.

### Common mistakes to avoid

- **Don't add card-class knowledge to the host.** CanvasCardRuntime is a thin mount point. It portals
  children into a container the card class provides. It doesn't know about layout, drag, toolbar, or card types.
- **Don't propose complex solutions when a universal mechanism exists.** If `_` prefixed files already
  handle seeding, don't add metadata flags or naming conventions for special cases. Extend the one mechanism.
- **Don't keep legacy code paths.** If containers are always used, remove the non-container fallback.
  If the card class owns the toolbar, remove toolbar state from React. Dead paths cause bugs.
- **Derive, don't hardcode.** Canvas card filename = project name + class extension (from config).
  Primary file = from card class metadata. Don't hardcode `"project.project"` or `"project.md"` anywhere.

## How we work

- **Reason from design, not symptoms.** When debugging, ask what the architecture says should happen. Don't pattern-match fixes — trace the lifecycle, read the docs.
- **Fix the environment, not the workaround.** If a tool is missing, install it (Dockerfile, devcontainer, package.json). Don't build clever hacks around missing capabilities.
- **Read before writing.** Read the existing code you're changing, not just type signatures. Understand what's there before proposing what should be.
- **Runtime tests are the bar.** TypeScript compilation is necessary but not sufficient. Test WebSocket channels, API calls, and end-to-end behavior before considering something done.
- **Subagents get the architecture docs.** When delegating to subagents, the architecture docs are the primary input. Don't restate them — point the subagent at the files.
- **Ask "does the server need to know this?"** Before adding any logic to index.ts or the React host, ask if this is card-class behavior. If yes, it belongs in render.js, not the infrastructure.

## Scripts

- `scripts/start.sh` — Start frontend + backend (kills stale processes first)
- `scripts/stop.sh` — Stop both servers
- `scripts/restart.sh` — Stop then start
- `scripts/status.sh` — Show running state and port status
