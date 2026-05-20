# Mica — Specification

## What Mica is

**A canvas where humans and agents compose context together. The
context they compose is either the means to an end, or the end
itself.**

Both halves matter.

Humans and agents compose context together. Together, on the same
surface, both are able to iteratively create, edit, and refine
what the other has made.

The canvas serves either use without a mode switch. Either you
compose a brief for your coding agent (Claude Code, Cline, Cursor)
and the canvas becomes the briefing, or the canvas itself is the
product — a financial planner, a research workspace, a campaign
dashboard built card by card. Same primitive, same cards,
different posture. Most projects drift between the two over time.

## Why this matters

Today the agent is where context lives. The context sits inside
its conversation buffer, its memory file, and its tool results.
The user can see what the agent says but cannot see what the
agent knows. When the next session starts, all of that is gone.

Mica puts the context on the canvas instead of inside the agent.
Anything on the canvas can be read by any agent that shows up
later. The context is no longer private to one agent or to one
session.

This has a concrete implication for how chat threads relate to
durable memory. A thread is not a record. The canvas is. A live
thread is working memory for one arc of work. When that arc ends,
the findings should be on canvas cards, and the thread can be
archived (browsable by humans, readable by agents only on
explicit demand). A thread that has grown too large is a signal
that findings should be promoted to the canvas and a fresh thread
started — not a failure to be worked around by summarizing or
compacting the chat. The canvas is what outlives threads.

## Emacs, not Notion

The lineage is architectural, not aesthetic. Emacs is a small set
of orthogonal mechanisms (buffers, modes, keymaps, hooks) that
compose into whatever workflow you need, and the environment
itself is modifiable from inside the environment. Notion is a
closed set of predefined block types.

Mica takes the Emacs posture. The `mica.*` API is small and
orthogonal. Card classes are user-writable, runtime-loadable, and
promotable from project scope to built-in. The generality of Mica
is the shape of the system, not a feature on a checklist.

## Designed for AI authorship

Mica's architecture is shaped so that an LLM can generate new
card classes, briefs, diagrams, and other project content from a
natural-language request. This is not an afterthought and not a
nice-to-have. It is a constraint that is applied to every
architectural decision.

Card classes are `card.html` + `card.js` + `card.css` +
`metadata.json` because that is a format LLMs produce cleanly in
one pass. A React component model, a custom DSL, or a bytecode
format would all fail this test.

The `mica.*` API is small and orthogonal because large surfaces
confuse generators. Every method that gets added widens the space
of things an agent can hallucinate wrong.

Plain files over databases, because agents introspect by listing
and reading files. An `ls .mica/` is a valid way for an agent to
understand a project. A database schema would not be.

Vanilla JS without a build step, because LLMs produce vanilla JS
one-shot.

None of these choices are human aesthetic preferences. A design
that is nicer for humans but harder for agents to generate is
wrong for Mica, and the choice gets reversed. Architecture serves
the generator, not the other way around.

## Transparency and low friction

Two more convictions at the same level as the ones above.

**Transparency.** Nothing about Mica is hidden. Any card can be
flipped to show the class that defines it. The `.mica/` directory
can be opened and read to see the layout, the chat history, and
the AI context files. There is no opaque memory and no hidden
prompt. If Mica knows something, the user can see it.

**Low friction.** Mica adapts to the user, not the other way
around. You point Mica at a directory and keep whatever file
structure you already have. If you delete `.mica/`, you are back
to plain files. Trying Mica costs almost nothing, and leaving
costs nothing.

## Consequences

The convictions above show up as concrete choices the rest of this
spec treats as given.

- **Files are files.** Context must be readable by any tool, not
  just Mica. Work files sit at the project root. `.mica/` holds
  operational metadata only.
- **Mica is a lens.** The file is the source of truth. The canvas
  is a view over it. Remove Mica and the work remains.
- **`mica.*` is pipes, not policy.** The runtime does not know
  what any card is. Policy lives in the card class.
- **AI generates the UI.** A card class is a `card.html`, a
  `card.js`, and a `card.css` file plus `metadata.json`. Promotion
  from project scope to built-in is moving a directory.
- **Two sides of a card.** The front of the card is the instance.
  The back is the class definition and the AI context.
- **Local-first, cohabitating.** Mica runs on-device via
  llama-server. It sits alongside your coding agent rather than
  replacing it.
- **Work keeps its shape.** Context compounds across sessions,
  agents, and people.

## The card class

A card class defines a kind of card. It is a directory containing
up to five files.

| File | Required | Purpose |
|---|---|---|
| `card.html` | yes | static markup for the card body |
| `card.js` | yes | client-side behavior, runs under CARD_SHIM |
| `metadata.json` | yes | extension, badge, title, CDN dependencies |
| `card.css` | no | scoped styles |
| `context.md` | no | class-level AI context |

Card classes resolve at two scopes, project first:

```
.mica/card-classes/<name>/    project-scoped, travels with the project in git
card-classes/<name>/          built-in, ships with Mica
```

Promotion between scopes is copying a directory. No package
manager, no registry, no install step.

### metadata.json

```json
{
  "extension": ".counter",
  "badge": "CTR",
  "defaultTitle": "Counter",
  "primaryFile": "counter.json",
  "dependencies": { "scripts": [], "styles": [] }
}
```

One load-bearing rule: the directory name must equal the extension
without the dot. A class at `.mica/card-classes/kanban/` handles
`.kanban` files. A mismatch between the directory name and
`metadata.json`'s extension field silently falls through to the
text renderer.

### CARD_SHIM

`card.js` does not run in a plain browser context. It runs inside
CARD_SHIM, a wrapper that:

- Injects `container` (the card's own DOM element) and `mica` (the
  bridge object) as the only two globals the card needs.
- Scopes `document.querySelector` and `getElementById` to the
  card's container.
- Redirects `window.addEventListener('resize')` to a ResizeObserver
  on the container.
- Auto-cleans timers, intervals, requestAnimationFrame callbacks,
  and event listeners on card unmount.
- Auto-injects the `X-Mica-Project` header on outgoing `/api/*`
  fetches so the server knows which project's state to operate on.
- Reports uncaught errors from the card's script to the server.

The practical effect is that a card author writes top-level code
(no class wrapper, no `export`, no registration call) and it just
works. The shim handles the framework concerns.

### The primary file

A card's instance is a plain file at the project root, not inside
`.mica/`. A `.counter` file like `docs/score.counter` is rendered
by the `counter` class. The file's content is the card's state.
The `primaryFile` field in `metadata.json` is for classes that
keep their state in a specific file inside a directory instance
(rare — most classes use the instance file directly).

## The canvas is a card class

The canvas itself is a card class at `card-classes/canvas/`. It
owns:

- `#canvas-freeform`, the DOM container into which child cards are
  mounted.
- Drag and resize, via event delegation on the freeform container.
- Layout persistence to `.mica/layout.json`, keyed by device class
  (phone, tablet, desktop, display).
- The toolbar and the meta sidebar.
- Cross-window layout sync via `layout-changed` broadcasts filtered
  by `source`.

The React host (`CanvasCardRuntime`) is a thin mount point. It
renders the canvas card class's HTML and portals child cards into
`#canvas-freeform`. It does not own layout, drag, or toolbar.
Different canvas card classes can ship different layouts (kanban,
timeline, grid) using the same mechanism.

## AI context — three levels

Agents working on the canvas read context from three sources.

| Level | File | What it holds |
|---|---|---|
| Project | `.mica/canvas-back.md` | Global context for the whole project |
| Class | `card-classes/<name>/context.md` | How this class of card works and should be used |
| Instance | `.mica/cards/<card>.context.md` | What this specific card is for |

The agent reads all three when responding. This is the two-sides
tenet in operation. The front of a card is its content. The back
is the class definition plus the instance's AI context. Both are
inspectable.

## The mica.* API

`mica.*` is the bridge a card's `card.js` uses to talk to the
server, to other cards, and to the file system. This is the
overview. For full signatures, arguments, return shapes, and
failure modes, see [ARCHITECTURE.md](ARCHITECTURE.md).

**Identity**

| | |
|---|---|
| `mica.project` | Current project name |
| `mica.filename` | This card's instance filename |
| `mica.windowId` | Per-browser-tab ID (stable across renders) |
| `mica.cardId` | Per-card-instance UUID (stable across reloads) |

**Content**

| | |
|---|---|
| `mica.getContent()` | Read this card's instance file content |
| `mica.refresh()` | Re-fetch and re-render this card |

**Files**

| | |
|---|---|
| `mica.files.list()` | List project files and directories |
| `mica.files.read(path)` | Read a text file |
| `mica.files.readBinary(path)` | Read a binary file |
| `mica.files.write(path, content)` | Write a text or binary file (source and cardSource auto-injected) |
| `mica.files.delete(path)` | Delete a file |
| `mica.files.url(path)` | URL for inline `<img>`, `<embed>`, and download links |

**Cards**

| | |
|---|---|
| `mica.cardClasses.list()` | List installed card classes (built-in plus project-scoped) |
| `mica.isSelfEcho(event)` | True if this event was caused by this card's own write |

**Events**

| | |
|---|---|
| `mica.on(event, cb)` | Subscribe to events (`file-changed`, `file-created`, `file-deleted`, `layout-changed`) |
| `mica.onDestroy(cb)` | Cleanup on card unmount |
| `mica.broadcast(event, data)` | Browser-side, cross-card ephemeral signal |

**Server**

| | |
|---|---|
| `mica.call(fn, args)` | Request/response to a server-side export |
| `mica.send(fn, args)` | Fire-and-forget |
| `mica.openChannel(fn, args)` | Bidirectional stream (used by terminal, chat, and agent cards) |
| `mica.fetch(url, opts)` | Server-proxied HTTP with SSRF guard, rate limit, and size cap |

### Not in the browser

`mica.read`, `mica.write`, and `mica.exec` exist as names but are
server-side methods used by export handlers. In the browser they
return a structured error pointing the author at `mica.call()` to
invoke a server export instead.

## Agents as cards

Agents in Mica are card classes, not a framework feature. An agent
card opens a bidirectional channel to a server handler via
`mica.openChannel`. The handler wraps a model (the Claude Code
SDK, the qwen-code SDK against local llama-server, or the
opencode SDK against opencode-serve) and manages conversation
state, tool use, and file writes.

Today three agent card classes ship with Mica: `.qwen` (qwen-code
SDK + local llama-server), `.claude` (Claude Code subprocess),
and `.opencode` (opencode-serve, supports both local llama-server
and cloud providers). All three see the same internal tool
surface (`mica-builtins` MCP — render_capture, card-class CRUD,
skills installation) so functionality added at the framework
level is available across backends without per-backend wiring.
The set will change. What stays constant is the contract: an
agent is a card that owns a brief, opens a channel, and reads
the canvas for context.

Reactivity is built in. The agent watches the file watcher and
triages changes within its canvas scope after a short idle window,
so editing a brief or a diagram can prompt the agent without an
explicit message. Agent-initiated writes are tracked and skipped
so the agent does not react to its own output. Per-session busy
locks prevent overlapping turns. See ARCHITECTURE.md for the
implementation.

## Project layout

```
myproject/
  brief.md                      work files at project root, flat, user-named
  spec.md
  tasks.todo
  architecture.mmd
  agent.claude                  agent cards are just files too
  .mica/
    config.json                 project config
    layout.json                 canvas layout keyed by device class
    canvas-back.md              project-level AI context
    chats/                      chat histories per agent card
    cards/                      per-card state and AI context
    card-classes/               project-scoped card class definitions
  .claude/skills/               skills copied from the template
  .qwen/skills/                 skills copied from the template
  .git/
```

Card files are first-class citizens of the project. They live at
the root, not hidden in `.mica/`. `.mica/` holds only the
infrastructure that supports rendering them.

## Deployment

Today Mica runs as a Node + Vite pair on the host. A single Mica
instance serves multiple projects, scoped per request by an
`X-Mica-Project` header that the card runtime threads through
every `/api/*` fetch. The only Docker presence is the Claude Code
agent subprocess. Mica itself is not containerized in development.

Packaging Mica as a container, distribution for specific hardware
targets (NVIDIA DGX Spark being the first), and per-project
container isolation are on the horizon but not current.

## Authoring

For building new card classes, the canonical reference is the
`card-class-handbook` skill that ships with each project template:

- `templates/dgx-spark-local/.qwen/skills/card-class-handbook/SKILL.md`
  for local-model projects.

The cloud-Claude template was deleted 2026-05-11 and will be
rebuilt; until then, `dgx-spark-local` is the only template.

The skill is written for the agent that will generate the card.
This spec covers the contract. The skill covers the procedure.

Sibling skills (`grow-canvas`, `decompose-task`, `doc-consistency`,
and others) cover related authoring tasks. The full set lives in
the same template directories and is copied into each new project
on creation.
