# Mica — Specification

This document is the **design contract**: what Mica is, the rules a
card class must honor to participate, and the model agents and the
canvas operate under. For the elevator pitch and run instructions, see
[README.md](README.md). For engineering tenets, see
[CLAUDE.md § How we build](CLAUDE.md). For the implementation
reference (file inventory, channel handlers, full `mica.*` API
signatures), see [ARCHITECTURE.md](ARCHITECTURE.md). For the user-
facing capability catalog, see [FEATURES.md](FEATURES.md).

## What Mica is

**A canvas where humans and agents compose context together. The
context they compose is either the means to an end, or the end
itself.**

Both halves matter.

Humans and agents compose context together — on the same surface,
iteratively, each able to read and edit what the other has made.

The canvas serves either use without a mode switch. Either you
compose a brief for your coding agent and the canvas becomes the
briefing, or the canvas itself is the product — a financial planner,
a research workspace, a campaign dashboard built card by card. Same
primitive, same cards, different posture. Most projects drift
between the two over time.

## Canvas is memory; threads are working memory

Today the agent is where context lives. The context sits inside its
conversation buffer, its memory file, and its tool results. The user
can see what the agent says but cannot see what the agent knows.
When the next session starts, all of that is gone.

Mica puts the context on the canvas instead of inside the agent.
Anything on the canvas can be read by any agent that shows up later.
The context is no longer private to one agent or to one session.

This has a concrete implication for how chat threads relate to
durable memory. **A thread is not a record. The canvas is.** A live
thread is working memory for one arc of work. When that arc ends,
the findings should be on canvas cards, and the thread can be
archived (browsable by humans, readable by agents only on explicit
demand). A thread that has grown too large is a signal that findings
should be promoted to the canvas and a fresh thread started — not a
failure to be worked around by summarizing or compacting the chat.
The canvas is what outlives threads.

## The card class

A card class defines a kind of card. It is a directory containing
up to five files.

| File | Required | Purpose |
|---|---|---|
| `card.html` | yes | static markup for the card body |
| `card.js` | yes | client-side behavior, runs under CARD_SHIM |
| `metadata.json` | yes | extension, badge, title, dependencies, optional `handler` or `sidecar` |
| `card.css` | no | scoped styles |
| `context.md` | no | class-level AI context |

Card classes resolve at two scopes, project first:

```
.mica/card-classes/<name>/    project-scoped, travels with the project in git
card-classes/<name>/          built-in, ships with Mica
```

Promotion between scopes is copying a directory. No package manager,
no registry, no install step.

### Load-bearing invariants

- **Directory name equals extension without the dot.** A class at
  `.mica/card-classes/kanban/` handles `.kanban` files. A mismatch
  silently falls through to the text renderer.
- **The instance is a plain file at the project root**, not inside
  `.mica/`. A `.counter` file like `score.counter` is rendered by
  the `counter` class. The file's content is the card's state.
- **`mica.read`, `mica.write`, `mica.exec` are server-side only** —
  in the browser they return a structured error pointing at
  `mica.call()` to invoke a server export instead.

### metadata.json (runtime)

```json
{
  "extension": ".counter",
  "badge": "CTR",
  "defaultTitle": "Counter",
  "primaryFile": "counter.json",
  "dependencies": {
    "scripts": [],
    "styles": []
  },
  "handler": null,
  "sidecar": null
}
```

Field-by-field detail is in [ARCHITECTURE.md § Card class loading](ARCHITECTURE.md). The
two extension hooks worth highlighting here are:

- **`handler`** — points the card's channel at a reusable server-side
  handler (`llm-direct`, `llm-agent`, `process`) instead of needing
  a class-specific server file. This is how a new card class gets
  an LLM or sidecar without writing TypeScript.
- **`sidecar`** — declares a per-class long-lived subprocess (a
  Python server, a CLI tool, anything that needs to stay running).
  The runtime spawns it on first card open and tears it down on
  Mica shutdown.

`dependencies.scripts` lists CDN URLs that are `<script>`-tag
loaded — **UMD only**. ESM URLs are loaded inside `card.js` via
`await import(url)`; the CARD_SHIM wraps `card.js` in an async
function so top-level `await` works.

### Spec frontmatter vs metadata.json

There's a deliberate name asymmetry. The **runtime** `metadata.json`
field is `scripts` (read by the React host at card-render time).
The **spec frontmatter** field — the YAML block at the top of
`canvas/<name>-spec.md` that `mica_create_class` reads — is
`umd_scripts`, named for the format constraint it enforces. The
tool translates `umd_scripts` from frontmatter → `scripts` in
metadata.json. Agents write `umd_scripts:` in the spec; the runtime
sees `scripts:` in the file. ESM URLs have no frontmatter slot at
all (rejected in commit `6efbdb1` as silent-failure-prone); they're
inlined in `card.js`. See ARCHITECTURE for the full loading-pattern
contract.

### CARD_SHIM

`card.js` runs inside CARD_SHIM, a wrapper that injects `container`
(the card's DOM element) and `mica` (the bridge object) as globals,
scopes DOM and timer APIs to the card, and auto-cleans on unmount.
A card author writes top-level code (no class wrapper, no `export`,
no registration call) and it just works.

Full shim behavior is in [ARCHITECTURE.md § CardRuntime and CARD_SHIM](ARCHITECTURE.md).

## The canvas is a card class

The canvas itself is a card class at `card-classes/canvas/`. It owns
`#canvas-freeform` (where child cards mount), drag and resize,
layout persistence to `.mica/layout.json` (keyed by device class:
phone, tablet, desktop, display), the toolbar, the meta sidebar, and
cross-window layout sync.

The React host (`CanvasCardRuntime`) is a thin mount point. It
renders the canvas card class's HTML and portals child cards into
`#canvas-freeform`. It does not own layout, drag, or toolbar.
Different canvas card classes can ship different layouts (kanban,
timeline, grid) using the same mechanism.

## Two sides of a card

A card has two sides.

- **Front: the instance.** The user's file, its content, the
  accumulated state. What you see when looking at the card on the
  canvas.
- **Back: the class definition plus the per-instance AI context.**
  The four files that make the class (`card.html`, `card.js`,
  `card.css`, `metadata.json`), the class's `context.md`, and the
  instance's `.mica/cards/<card>.context.md`. What an agent reads
  when reasoning about the card.

The front is the work. The back is the machinery and the meaning.
Both are inspectable; nothing is hidden.

## AI context — three levels

Agents working on the canvas read context from three sources.

| Level | File | What it holds |
|---|---|---|
| Project | `.mica/canvas-back.md` | Global context for the whole project: agent posture, routing preferences, per-turn rules. Seeded by the template. |
| Class | `card-classes/<name>/context.md` (or project-scoped) | How this class of card works and should be used. |
| Instance | `.mica/cards/<card>.context.md` | What this specific card is for. |

The agent reads all three when responding. This is the two-sides
tenet in operation: the front of a card is its content; the back is
the class definition plus the instance's AI context.

## The `mica.*` API

`mica.*` is the bridge `card.js` uses to talk to the server, to
other cards, and to the file system. The API surface is small and
orthogonal by design: large surfaces confuse LLM generators.

The authoritative reference — full method signatures, return shapes,
failure modes — is [ARCHITECTURE.md § The mica.* API](ARCHITECTURE.md).
Capability shape, at the level of *what kinds of things a card can
do*:

- **File I/O** scoped to the project (`mica.files.*`).
- **Identity** of this card / this window / this project / this card
  instance.
- **Card content** (read this card's own file, request a re-render).
- **Card-class discovery** (list installed classes, filter
  self-echoes).
- **Events** (subscribe to file/layout changes, broadcast to other
  cards in the same tab).
- **Server calls** — one-shot (`call`/`send`), bidirectional
  channels (`openChannel`), proxied HTTP with SSRF guard (`fetch`).
- **Voice** (`speak` synthesizes audio; `listen` captures and
  transcribes).
- **Error reporting** (`reportError` surfaces errors to chat
  agents).

`mica.read` / `mica.write` / `mica.exec` exist as names but are
server-side methods used by export handlers — see the invariant
above.

## Agents as cards

Agents in Mica are card classes, not a framework feature. An agent
card opens a bidirectional channel to a server handler via
`mica.openChannel`. The handler wraps a model and manages
conversation state, tool use, and file writes.

**Four agent card classes ship today:**

- **`.qwen`** — Qwen Code SDK against the bundled local vLLM (or
  llama-server as a rollback path). Per-card provider selection
  also covers OpenRouter and OpenAI-compatible endpoints.
- **`.claude`** — Claude Code subprocess via the Claude Agent SDK.
- **`.opencode`** — opencode-serve daemon; per-card provider routing
  to local vLLM, OpenRouter, or any OpenAI-compatible endpoint.
- **`.voice`** — peer agent (not a feature on top of chat). Local
  Parakeet STT + Kokoro TTS sidecars; its distinguishing capability
  is **dispatching** user intent to other chat cards on the canvas
  via `send_to_card`, rather than performing coding work itself.

All four see the same internal tool surface (`mica-builtins` MCP —
render_capture, card-class CRUD, skills installation, sidecar
control, shared-doc pinning, etc.), so capabilities added at the
framework level are available across backends without per-backend
wiring. **The set will change.** What stays constant is the contract:
an agent is a card that owns a brief, opens a channel, and reads the
canvas for context.

### Session and reactivity contract

- **Sessions are per-card-instance.** Bound to the file on disk.
  Created on file create, destroyed on file delete. Transport
  connections attach and detach during the session's life without
  destroying the session.
- **Reactivity is built in.** The agent watches the file watcher and
  triages changes within its canvas scope after a short idle window,
  so editing a brief or a diagram can prompt the agent without an
  explicit message.
- **Agent-initiated writes are tracked and skipped** so the agent
  does not react to its own output.
- **Per-session busy locks** prevent overlapping turns; concurrent
  opencode sessions are kept isolated via a session-id stamped onto
  each tool call (see [ARCHITECTURE.md § Decisions](ARCHITECTURE.md)).

## Project layout

The project's filesystem shape — what's at the root, what `.mica/`
holds — is enumerated in [FEATURES.md § Project configuration](FEATURES.md). The
load-bearing contract:

- **Work files at the project root** (flat, user-named).
- **`.mica/` holds operational metadata only** — config, layout,
  chats, per-card state, project-scoped card-class definitions.
  Delete `.mica/` and the project is back to plain files.
- **Agent skills live at `.qwen/skills/` and `.claude/skills/`**,
  not in `.mica/`. They travel with the project in git as the
  builder workflow's source of truth.

## Deployment

Mica ships as a Docker image and runs as a Node + Vite pair (the
devcontainer path during development). A single Mica instance serves
multiple projects, scoped per request by an `X-Mica-Project` header
that the card runtime threads through every `/api/*` fetch.

Two inference topologies share the same image:

- **vLLM** (default) — two containers, `mica` + `mica-vllm` sibling.
  Continuous batching, NVFP4, voice + chat share the served model.
- **llama** — one container, `llama-server` spawned inside `mica`
  on first chat request.

For install instructions, see [SETUP.md](SETUP.md). For the
runtime topology and inference paths, see [ARCHITECTURE.md §
Inference backends](ARCHITECTURE.md).

## Authoring

For building new card classes, the canonical reference is the
`card-class-handbook` skill that ships with each project template.
Two templates ship today:

- `templates/dgx-spark-local/` — local-first workflow centered on
  the `.qwen` agent.
- `templates/opencode-builder/` — hybrid local-or-cloud workflow
  centered on the `.opencode` agent.

Both ship the same `.qwen/skills/` set, including
`card-class-handbook`. The skill is written for the agent that will
generate the card. **This spec covers the contract; the skill covers
the procedure.**

Sibling skills (`grow-canvas`, `decompose-task`, `discover-dependency`,
`doc-consistency`, and others) cover related authoring tasks. See
[FEATURES.md § Templates & the builder workflow](FEATURES.md) for
the user-facing summary and how to tweak the workflow per-project.
