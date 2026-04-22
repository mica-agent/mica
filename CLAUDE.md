# Mica — Development Guide

## What Mica is

A canvas where humans and agents compose context together. The
context they compose is either the means to an end (briefing for
another coding agent) or the end itself (a financial planner, a
research workspace, a campaign dashboard, built card by card).
Same primitive serves both uses. Files are files; `.mica/` is
operational metadata only; the canvas is a view. See SPEC.md for
the full framing.

Mica-Lite is the first app. The long arc is an operating substrate
for layered work. See `internal/VISION.md` for design intent that
is not yet built.

## How we build

Nine engineering convictions shape every decision. Mirrored
verbatim from ARCHITECTURE.md so the list lives in one canonical
phrasing.

1. **Optimize every choice for AI generation.** This is the
   product tenet "designed for AI authorship" applied to
   implementation. When we pick a file format, an API shape, a
   state location, or a folder convention, the test is: can an
   LLM produce correct code against this from a natural-language
   prompt? Card classes are `card.html + card.js + card.css +
   metadata.json` because LLMs write those one-shot. `mica.*`
   stays small because large APIs confuse generators. No custom
   DSL, no framework-in-framework, no bytecode. If a design is
   nicer for humans but harder for agents, the design is wrong
   and gets reversed.
2. **Plain files over databases.** Humans, agents, and git all
   read the same bytes. No ORM. No migrations. `.mica/` is a
   directory, not a schema.
3. **Pipes, not policy.** Server and host do not know what
   "chat" or "terminal" or "mermaid" is. `if (extension ===
   ".terminal")` in a pipe means we failed.
4. **One mechanism.** One ChannelManager for all bidirectional
   channels. One card-class contract for all cards. When we are
   forking, we extract a primitive instead.
5. **User intent, not transport.** Sessions start on file create
   and end on file delete. Not on WebSocket close, not on tab
   close. Transport is ephemeral; intent is durable.
6. **Small orthogonal primitives.** The Emacs instinct. Before
   adding a field to a central config or a method to a central
   API, check whether a smaller composition gets there.
7. **Root cause, not symptoms.** No bandaids. If the mental
   model is right, the fix is obvious. If it is not, stop and
   redraw.
8. **Runtime tests are the bar.** Compile is necessary, not
   sufficient. Type checks prove code compiles. They do not
   prove a channel survives a re-render.
9. **Read before writing.** Especially the card class you are
   about to change. Rewriting without reading drops details
   that were debugged in.

## The containment model (files are files)

A card is a file at the project root, not a directory. The file
extension selects the card class. Card classes live in
`.mica/card-classes/<name>/` (project-scoped) or `card-classes/
<name>/` (built-in). Resolution checks project scope first.

The canvas is a card whose class renders `#canvas-freeform` as
the mount point for child cards. Child cards are sibling files
in the project root. "Containment" is arrangement on the canvas
(layout in `.mica/layout.json`), not a directory tree. Do not
introduce a card-as-directory abstraction.

`.mica/` holds only infrastructure: config, layout, chat
histories, per-card AI context, project-scoped card classes.
Delete `.mica/` and the project is back to plain files.

Project templates seed cards by placing files at their literal
canvas-root path (`templates/foo/docs/...`).
`createProjectFromTemplate` is a verbatim `cp -r` — no
transformation, no naming convention.

## Critical: the server and host MUST NOT know about specific card classes

The server (`index.ts`, `files.ts`, `channelManager.ts`) and the
React host (`CardRuntime.tsx`, `CanvasCardRuntime.tsx`) are
generic infrastructure. They must NEVER contain card-class-
specific logic:

- **NO** `if (filename.endsWith(".terminal"))` — card class
  handles its own behavior.
- **NO** `if (cardClass === "mermaid")` — card class renders
  itself.
- **NO** hardcoded seed content — templates seed by placing
  files at their literal canvas-root path.
- **NO** hardcoded card filenames — read from config or
  metadata.
- **NO** special-casing canvas vs non-canvas — the canvas is
  a card like any other.

If you find yourself writing `if` statements that check card
class names or extensions in server or host code, stop. You are
putting policy in the pipe. Instead, ask: what infrastructure
does the card class need to do this itself? Then add that
infrastructure (a bridge method, a config field, an event) so
the card class can own the behavior. The goal is always to
make things possible in card classes, never to implement
features in the framework.

## Common mistakes to avoid

- **Don't add card-class knowledge to the host.**
  `CanvasCardRuntime` is a thin mount point. It portals
  children into `#canvas-freeform`, which the canvas card
  class provides. It does not know about layout, drag,
  toolbar, or card types.
- **Don't propose complex solutions when a universal mechanism
  exists.** Template-based seeding is verbatim `cp -r`.
  Do not add metadata flags or naming conventions for special
  cases. If a template needs to ship a different canvas
  layout or extra files, ship them at the literal path; the
  materialization code stays untouched.
- **Don't keep legacy code paths.** If containers are always
  used, remove the non-container fallback. If the card class
  owns the toolbar, remove toolbar state from React. Dead
  paths cause bugs.
- **Derive, don't hardcode.** Canvas card filename and primary
  file come from config and metadata. Don't hardcode specific
  filenames anywhere in infrastructure.
- **No `render.js`.** Card behavior is `card.html + card.js +
  card.css + metadata.json`. Server-side channel handlers live
  under `server/` (e.g. `server/claudeAgent.ts`,
  `server/plugins/pty.ts`), not inside card class directories.
- **Don't skip StrictMode correctness.** See below.

## React host implementation notes

### CanvasCardRuntime and freeformEl

`CanvasCardRuntime` portals child cards into `#canvas-freeform`,
a DOM element created by the canvas card class's inline script.
Finding this element reliably requires understanding React's
effect ordering:

- **Child effects run before parent effects.** `CardRuntime`
  (child) injects `innerHTML` in its `useEffect([html])`
  *before* `CanvasCardRuntime` (parent) runs its
  `useEffect([parentCard])`. For card classes with no async
  dependencies, `#canvas-freeform` is already in the DOM by
  the time the parent effect polls for it.
- **Poll with `isConnected` check.** Use a 50ms interval and
  check `el.isConnected` to reject stale references from
  previous renders. Do NOT check immediately without
  `isConnected` — the element may exist but be detached from
  a prior render cycle.
- **Reset freeformEl on parentCard change.** Always call
  `setFreeformEl(null)` at the start of the effect so a stale
  reference from a previous render does not remain active
  while CardRuntime re-injects HTML.
- **Do NOT use MutationObserver here.** It only fires for
  future mutations. If CardRuntime has already injected HTML
  before the observer is set up (which it has, since child
  effects run first), the mutation is missed. Polling handles
  both the "already done" and "still in progress" cases.

### StrictMode

The app runs with React StrictMode. StrictMode double-invokes
effects (mount → unmount → remount) in development. Code must
handle this correctly:

- **Use AbortController** for all fetch calls in effects. Pass
  `signal` to `fetch()` and check `signal.aborted` after
  `await` before calling any state setters. The fetch may
  complete before the abort fires.
- **Use functional state updates** (`setState(prev => ...)`)
  to preserve object identity when data is unchanged,
  preventing unnecessary effect re-runs.
- **`Promise.allSettled` over `Promise.all`** for independent
  fetches. One failure should not prevent the other from
  setting state.
- **Never defer synchronous work behind async in effects.**
  Cleanup runs before the deferred work fires, causing
  duplicates.

## Before writing any code

Read these first:

- `SPEC.md` — product definition, card model, `mica.*` overview
- `ARCHITECTURE.md` — present-tense implementation reference,
  authoritative `mica.*` API
- `ARCHITECTURE-DETAILS.md` — ChannelManager deep dive,
  channel handler contract
- `internal/VISION.md` — design intent for things not yet built

For card class authoring, the canonical reference is the
`create-card-class` skill that ships with each project
template:

- `templates/cloud-claude/.claude/skills/create-card-class/SKILL.md`
  (Claude Code projects)
- `templates/cloud-claude/.qwen/skills/create-card-class/SKILL.md`
  (Qwen variant)
- `templates/dgx-spark-local/.qwen/skills/create-card-class/SKILL.md`
  (local-model projects)

The skill is the agent-facing authoring reference. Authoring
lessons learned during a session fold back into the skill, not
into this file. If a rule you discover seems Layer-1-shaped
(new API fact, new invariant, new root-cause design reason),
promote it to ARCHITECTURE.md or SPEC.md first so the skill
can cite it instead of restating.

When working on the React host (`src/`), consult:

- [React docs — useEffect](https://react.dev/reference/react/useEffect)
  (effect ordering, cleanup, StrictMode behavior)
- [React docs — Synchronizing with Effects](https://react.dev/learn/synchronizing-with-effects)
  (when effects run, how cleanup works)
- [React docs — You Might Not Need an Effect](https://react.dev/learn/you-might-not-need-an-effect)
  (avoid fighting the framework)

## Before delegating to subagents

When spawning subagents for implementation work:

1. Tell the subagent to read ARCHITECTURE.md and
   ARCHITECTURE-DETAILS.md first.
2. The architecture docs are the primary input. The prompt
   adds specifics.
3. The subagent must read the existing code it is replacing,
   not just type signatures.

## Before committing

1. `npx tsc --noEmit` — type check (necessary but not
   sufficient).
2. Run end-to-end runtime tests (WebSocket channels, API
   calls, real card interactions across two browser windows).
3. Only commit after tests pass.
4. Never trust "compiles clean" as proof of correctness.

## How we work

- **Reason from design, not symptoms.** When debugging, ask
  what the architecture says should happen. Don't pattern-
  match fixes. Trace the lifecycle. Read the docs.
- **Fix the environment, not the workaround.** If a tool is
  missing, install it (Dockerfile, devcontainer, package.json).
  Don't build clever hacks around missing capabilities.
- **Ask "does the framework need to know this?"** Before adding
  any logic to `server/index.ts` or the React host, ask if
  this is card-class behavior. If yes, it belongs in a card
  class or a server channel handler, not in the infrastructure.

## Scripts

- `scripts/start.sh` — Start frontend (port 5173) + backend
  (port 3002). Kills stale processes first.
- `scripts/stop.sh` — Stop both servers.
- `scripts/restart.sh` — Stop, then start.
- `scripts/status.sh` — Show running state and port status.
- `scripts/start-vlm.sh` — Start vLLM server for VLM (Gemma 4);
  not integrated into main agent path.
