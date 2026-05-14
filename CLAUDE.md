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

Sixteen engineering convictions shape every decision in the Mica
codebase. This file is the canonical home; ARCHITECTURE.md cites
them by number, doesn't repeat them.

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
10. **Don't rebuild agent internals.** Mica is an augmentation
    layer on coding agents (Qwen Code, Claude Code, OpenRouter
    variants), not a replacement. We shape what goes into the
    prompt; the agent handles how it processes. Token-aware
    chat-history trimming, silent summarization, prompt-cache
    management, and reimplementations of `/compress` all live on
    the agent's side of the line — we don't build them. See
    ARCHITECTURE.md § Decisions §"Augmentation-layer boundary" for the
    full table and the reasoning.
11. **Plan before building.** Cost of fixing wrong code is far
    greater than the cost of correct planning. Specs, contracts,
    and interface boundaries are decided and approved *before*
    any code is written. This is the parent rationale for
    tenets 8 and 9, and the justification for every gate we
    ship. Skipping the plan to "just try something" inverts the
    cost asymmetry.
12. **Divide only when architecture and model both demand it.**
    Decompose work into subagent dispatches only when (a) seams
    are architecturally real — named integration boundaries,
    distinct contracts another agent could implement without
    reading the others' code — AND (b) the integrated whole
    exceeds the model's reliable working set. If either gate
    fails, work inline. Reusable design memory, narrative
    cleanliness, and future flexibility are not gates.
13. **Context is the budget.** Every line of skill prose, every
    file read, every dispatch payload consumes the model's
    working set. The skill suite itself is part of the model's
    permanent system prompt — duplicating "read before writing"
    across five skills directly burns the budget on which
    adherence depends. Cut before adding. Curate at every
    level: skill prose, dispatch context, file reads. The
    dynamic counterpart to tenet 1's static design discipline.
14. **Approval gates are user-driven, not file-driven.** A spec
    save is not a build trigger. Humans control the moment a
    build starts. File-watcher events propagate state; they
    don't authorize action. Drives fresh-thread semantics,
    decompose-task gating, and per-turn discipline.
15. **Reuse before reinventing.** Before writing custom code,
    check whether `mica.*` APIs, the agent SDK, or an
    established library already does the job. If unsure between
    "use the API" and "write our own", surface the option to the
    user — don't silently roll your own. Tenet 10 is the
    strongest specific case; the same discipline applies to
    `mica.*` (host API) and to 3rd-party libraries.
16. **Follow APIs as authored; validate before relying.** Once
    an API is chosen, use signatures and shapes verbatim — don't
    improvise method names that "look right" (`mica.read()` is
    not a method; `mica.getContent()` is). For 3rd-party
    endpoints — URLs, services, library entry points — verify
    they exist and return the shape your code parses *before*
    committing to the integration. Distinct from tenet 8: that
    verifies the agent's *output*; this verifies the agent's
    *inputs*.

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
- **Don't reach across the augmentation-layer boundary.** If
  you're about to add token-aware trimming, prompt-cache
  handling, chat-history summarization, or any logic that
  mirrors what the coding agent's SDK already does inside its
  own turn, stop. The agent owns that. Mica shapes the input
  (canvas baseline, task decomposition, thread lifecycle),
  not the agent's internals. ARCHITECTURE.md § Decisions has the
  table.
- **Archived chat threads never enter the baseline.** When a
  user hits "fresh thread," the old transcript lives on disk
  under `.mica/chats/archived/` — readable by the agent on
  explicit demand, never as ambient context. Baseline carries
  the current thread only. See ARCHITECTURE.md § Decisions §"Canvas
  is memory; threads are working memory."
- **File-write decision rule.** Four paths in a Mica project
  have structured tools that own their schema and lint; the
  agent prelude tells agents to use them. Internal code that
  writes these paths follows the same rule:
  - `.mica/card-classes/<name>/card.{js,html,css}` →
    `mica_edit_class_file` (pre-write lint, partial-edit
    safety)
  - `.mica/card-classes/<name>/metadata.json` →
    `mica_create_class` (typed inputs serialized, schema
    enforced)
  - new card instance under canvas-root →
    `mica_create_card_instance` (idempotent, verifies class)
  - `.mica/layout.json` → don't write (runtime state owned by
    the canvas card class)
  Everything else — markdown docs, free-form content,
  generated data — `write_file` is right. The four protected
  paths are the closed list of Mica-owned schemas.
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
  authoritative `mica.*` API; includes `## Channel handler details`
  (deep-dive subsystem reference) and `## Decisions` (rationale log)
- `internal/VISION.md` — design intent for things not yet built

For card class authoring, the canonical reference is the
`card-class-handbook` skill that ships with each project
template:

- `templates/dgx-spark-local/.qwen/skills/card-class-handbook/SKILL.md`
  (local-model projects)

The cloud-Claude template was deleted 2026-05-11 and will be
rebuilt; until then, `dgx-spark-local` is the only template.

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

1. Tell the subagent to read ARCHITECTURE.md first (including
   the `## Channel handler details` and `## Decisions` sections
   if relevant to the task).
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

- `scripts/start.sh` — Boots the full Mica stack: frontend
  (port 5173) + backend (port 3002) + chat vLLM container
  (`mica-chat`, port 8012, `RedHatAI/Qwen3.6-35B-A3B-NVFP4` on
  `vllm/vllm-openai:cu130-nightly`). Sidecars (Parakeet STT,
  Kokoro TTS) auto-spawn on first voice request. Sets
  `MICA_DISABLE_LLAMA=1` so the backend doesn't also try to start
  the legacy llama-server. Set `MICA_DISABLE_CHAT_VLLM=1` to skip
  the chat container (e.g. when iterating frontend-only).
- `scripts/stop.sh` — Stops backend, frontend, voice sidecars,
  and any leftover llama-server. **Leaves the chat vLLM container
  warm by default** so restarts are seconds, not minutes (vLLM
  cold-boot is 30-90s). Use `scripts/stop.sh --full` to also stop
  the chat container (e.g. for a clean host reboot).
- `scripts/restart.sh` — Stop, then start. Same `--full` flag
  passes through; default keeps vLLM warm across restarts.
- `scripts/status.sh` — Show running state and port status.
- `scripts/lib/vllm-container.sh` — Internal helper sourced by
  `start.sh` for the chat vLLM container. Common docker-run
  lifecycle (idempotency, pull-vs-local, log streaming,
  health-poll). Don't invoke directly.

### Architecture decision (2026-05): vLLM consolidation

Chat agent inference moved from llama-server (Q4 GGUF) to vLLM
(`Qwen3.6-35B-A3B-NVFP4` on `cu130-nightly`). Reasons: ~30-40%
faster on long outputs (NVFP4 + MTP-1 spec decode), single
inference stack, vLLM continuous batching lets voice and chat
share one model with near-zero overhead.

The backend's `ensureLlamaServer()` path
(`server/llamaServer.ts`) stays in the tree as a rollback option;
set `MICA_DISABLE_CHAT_VLLM=1` and unset `MICA_DISABLE_LLAMA` to
fall back to llama-server.

### Where to run scripts (devcontainer vs host)

Devcontainer uses **docker-outside-of-docker** — a single docker
daemon (host's) reachable from both host shell and devcontainer
terminal via the mounted `/var/run/docker.sock`. So:

- **Run lifecycle scripts from inside the devcontainer terminal.**
  That's where sidecars (Parakeet/Kokoro) and the backend live in
  the PID namespace, so `stop.sh` can kill them. Container ops
  (`docker stop mica-chat`) work too because the socket is shared.
- Running from the host shell works for container-only ops
  (`docker stop mica-chat`, etc.) but won't see/kill sidecar
  processes inside the devcontainer.

---

## Testing

*Mica-Lite has no automated end-to-end test suite today. Verification is manual and happens in two passes: type-check for compilation, then a runtime walkthrough.*


### Type check

```bash
npx tsc --noEmit
```

Necessary but not sufficient. A clean type-check proves the code
compiles. It does not prove that a WebSocket channel survives a
React re-render or that a card's self-echo filter skips its own
writes. Do not ship on compile alone.

### Runtime walkthrough

Start both servers:

```bash
bash scripts/start.sh
```

Frontend on port 5173, backend on port 3002. The script kills
stale processes first and waits for both ports to be healthy.
`scripts/stop.sh` tears them down. `scripts/status.sh` shows the
running state. `scripts/restart.sh` does stop then start.

Open the app in two browser windows on the same project. Then
walk through:

1. **File watcher and cross-window sync.**
   Create a file from window A (e.g. add a card via the
   toolbar). Window B should see the new card without a reload.
   The `file-created` event carries `source = windowId-of-A`,
   so window A does not re-render its own creation as a remote
   change.
2. **Layout sync.**
   Drag or resize a card in window A. Window B should receive
   the `layout-changed` event and reposition. Window A's own
   `layout-changed` should be filtered out by source
   attribution.
3. **Self-echo filter.**
   Open the same card instance in both windows. Edit in
   window A so the card writes its file. Window B receives
   `file-changed` and updates. Window A receives its own echo
   but `mica.isSelfEcho(event)` filters it, so window A does
   not rebuild unnecessarily.
4. **Agent channels.**
   Create a `.chat` card. Verify the card opens a channel,
   the llama-server is started if not already running, and a
   message round-trips. Then create a `.claude` card and
   verify the same round-trip with the Claude Code subprocess
   handler.
5. **Terminal channel survives re-render.**
   Create a `.terminal` card. Type something in the PTY.
   Trigger a re-render of the card (edit the instance file,
   or force a parent re-render). The PTY session must remain
   alive; typing should continue in the same shell without a
   new prompt. This validates the ChannelManager's detach-vs-
   destroy distinction.
6. **Reactivity.**
   In a project that has a `.chat` or `.claude` card, edit a
   file inside the agent's canvas scope. After ~15 seconds of
   no further edits, the agent should receive a synthetic
   "user edited these files" turn. Continuous typing must not
   trigger — the idle gate re-arms on each new event.
   Agent-written files must not trigger (write-source
   tracking).

### When not to rely on compilation

Quoting CLAUDE.md: "Runtime tests are the bar. Compile is
necessary, not sufficient. Type checks prove code compiles;
they do not prove a channel survives a re-render."

Anything touching the following areas must be walked through
at runtime:

- ChannelManager sessions
- File watcher broadcasts and source attribution
- CARD_SHIM wrapping (timer cleanup, scoped DOM, scoped fetch)
- Agent tool loops and write tracking
- Cross-window coordination

### What is NOT covered

There is currently no automated coverage for:

- UI interaction (no Playwright / Cypress suite yet).
- Agent behavior under model-specific failures.
- Long-running PTY stability.
- Inotify scale beyond a typical-sized canvas scope.

Adding automation is a separate piece of work.
