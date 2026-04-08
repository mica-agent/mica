# Mica — Development Guide

## What Mica is

Cards all the way down. A card is a directory with an extension that determines its behavior. A card can contain child cards. A canvas is just a card whose class renders a layout surface. A project is a canvas card with infrastructure alongside it.

The infrastructure (server, React host, channels) is pipes, not policy. It routes messages, reads/writes files, and mounts HTML. It does not know what a terminal is, what a chat agent does, or how a canvas lays out cards. All behavior lives in the card class's `render.js`.

New capabilities = new card classes, not server modifications. The system is extended by addition, not modification.

## Before writing any code

Read these documents first:
- `ARCHITECTURE.md` — Core principles, design tenets, system overview
- `ARCHITECTURE-DETAILS.md` — Deep dives on subsystem design (ChannelManager, session lifecycle)
- `SPEC.md` — Product definition and card model
- `card-classes/AUTHORING_CARD_CLASSES.md` — Full reference for building card classes

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
- **NO** hardcoded seed content (`NEW_PROJECT_SEEDS`) — card class defines seeds via `_` (child cards) and `~` (flat files) prefixed files
- **NO** hardcoded card filenames (`"project.project"`) — read from config
- **NO** special-casing canvas vs non-canvas — any card can contain child cards

If you find yourself writing `if` statements that check card class names or extensions in server
or host code, **stop**. You are putting policy in the pipe. Instead, ask: "what infrastructure
does the card class need to do this itself?" Then add that infrastructure — a bridge method,
a config field, an event — so the card class can own the behavior. The goal is always to make
things possible in card classes, never to implement features in the server.

### The containment model

- A card is a directory. Its extension determines its card class.
- A card can contain child cards (subdirectories with card extensions).
- A canvas is just a card whose card class renders a layout surface.
- The project's canvas card is stored in `MicaConfig.canvasCard` — config, not convention.
- `getCanvasDir("_root")` reads this config — the server doesn't hardcode which card is the canvas.
- Seed files use two prefixes: `_` for child cards, `~` for flat files. One mechanism each — no special cases for canvas vs non-canvas.
- `spec.md` in each card class directory is the blueprint — source of truth for what the card type does.
- `brief.md` in each card instance is the assignment — what this specific card is for. Flat file, not a card.

### Common mistakes to avoid

- **Don't add card-class knowledge to the host.** CanvasCardRuntime is a thin mount point. It portals
  children into a container the card class provides. It doesn't know about layout, drag, toolbar, or card types.
- **Don't propose complex solutions when a universal mechanism exists.** If `_` prefixed files already
  handle seeding, don't add metadata flags or naming conventions for special cases. Extend the one mechanism.
- **Don't keep legacy code paths.** If containers are always used, remove the non-container fallback.
  If the card class owns the toolbar, remove toolbar state from React. Dead paths cause bugs.
- **Derive, don't hardcode.** Canvas card filename = project name + class extension (from config).
  Primary file = from card class metadata. Don't hardcode `"project.project"` or `"project.md"` anywhere.

## React host implementation notes

### CanvasCardRuntime and freeformEl

`CanvasCardRuntime` portals child cards into `#canvas-freeform`, a DOM element created by the canvas card class's inline script. Finding this element reliably requires understanding React's effect ordering:

- **Child effects run before parent effects.** `CardRuntime` (child) injects `innerHTML` in its `useEffect([html])` *before* `CanvasCardRuntime` (parent) runs its `useEffect([parentCard])`. For card classes with no async dependencies (like `simple-project`), `#canvas-freeform` is already in the DOM by the time the parent effect polls for it.
- **Poll with `isConnected` check.** Use a 50ms interval and check `el.isConnected` to reject stale references from previous renders. Do NOT check immediately without `isConnected` — the element may exist but be detached from a prior render cycle.
- **Reset freeformEl on parentCard change.** Always call `setFreeformEl(null)` at the start of the effect so a stale reference from a previous render doesn't remain active while CardRuntime re-injects HTML.
- **Do NOT use MutationObserver here.** It only fires for future mutations — if CardRuntime has already injected HTML before the observer is set up (which it has, since child effects run first), the mutation is missed. Polling handles both the "already done" and "still in progress" cases.

### StrictMode

The app runs with React StrictMode. StrictMode double-invokes effects (mount → unmount → remount) in development. Code must handle this correctly:

- **Use AbortController** for all fetch calls in effects. Pass `signal` to `fetch()` and check `signal.aborted` after `await` before calling any state setters — the fetch may complete before the abort fires.
- **Use functional state updates** (`setState(prev => ...)`) to preserve object identity when data is unchanged, preventing unnecessary effect re-runs.
- **`Promise.allSettled` over `Promise.all`** for independent fetches — one failure shouldn't prevent the other from setting state.

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
