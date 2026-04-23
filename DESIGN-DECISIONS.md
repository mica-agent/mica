# Mica — Design Decisions

Working decisions that shape Mica-Lite. Each entry captures the
choice, why it was made, and what it displaces. This is not a
spec. For the present-tense reference, see ARCHITECTURE.md. For
design intent that has not yet shipped, see `internal/VISION.md`.

## Files are files, not directories

Mica-Lite does not use a card-as-directory model. A card is a
plain file at the project root. The file extension selects the
card class. The canvas arranges cards by layout, not by
directory hierarchy.

This is the biggest departure from earlier Mica drafts. Old
drafts had cards as directories (`project.project/`, `research/`)
with child cards as nested directories. The current model is
flat: files at the root, `.mica/` for operational metadata, no
containment in the file system.

Reasons for the change:

- Files LLMs already know how to produce (the "designed for AI
  authorship" tenet).
- Plain text editing works out of the box.
- Git behavior matches user expectations — no hidden moves when
  "reorganizing" cards.
- The canvas layout is separate state, and different canvas
  card classes can arrange the same files differently.

Card arrangement ("containment" in the old vocabulary) lives in
`.mica/layout.json`, keyed by device class. Different canvas
card classes read and write the same file, choosing how to
display the same set of files.

## Multi-project, single-host, per-request scoping

A single Mica instance serves multiple projects. There is no
per-project Mica process and no per-project container.

Requests identify their project via an `X-Mica-Project` header
(with `?project=` as a query fallback for URL contexts that
cannot set headers, such as `<img src>` or `window.open`). The
card runtime auto-injects the header on every `/api/*` fetch.
The server reads it via `getRequestProject(req)`.

No module-level globals hold the "current project." Every
request reads the header. Responses set `Vary: X-Mica-Project`
so browser cache does not mix project state.

Reason: no surprising tab-level bleeding. Two tabs on different
projects interact with different state at every request. No
context swap to track.

Per-project container isolation as a blast radius is under
consideration (see `internal/VISION.md`) but is not the current
reality.

## Augmentation-layer boundary: Mica shapes the input, the agent runs the turn

Mica-Lite runs on top of coding agents (Qwen Code, Claude Code,
and OpenRouter-routed variants). It augments them. It does not
replace them. This line is load-bearing: without it, Mica drifts
toward reimplementing concerns the SDK already owns, and ends up
competing with the tool it's built on.

**The rule.** Everything upstream of the SDK call is Mica's
problem. Everything after the SDK receives the payload is the
agent's problem.

| Mica-layer (shape the input) | Agent-layer (run the turn) |
|---|---|
| What lives in the canvas baseline | Prompt-cache / KV-cache management |
| How canvas files are presented (full vs summary) | In-session chat-history compaction (`/compress`) |
| Which cards are pinned to every turn vs on-demand | Tool-result compression inside a turn |
| Breaking big tasks into bounded subagent scopes (the analyze-repo skill) | Deciding what fits in the model's context |
| Storing chat history on disk canonically | Rolling its own truncation when exceeded |
| Surfacing the `mica.*` bridge and subagent defs | Using those tools to complete the user's ask |
| UX: fresh-thread action, context meter, overflow error card | Handling prompt rejection at the transport level |

**Things Mica does not build** (non-goals, explicit):

- Token-aware trimming of chat history before sending to the SDK.
- Silent summarization of old chat turns.
- Prompt-cache / KV-cache-aware prefix construction.
- Any reimplementation of the agent's `/compress` command.
- Parsing the model's response stream to detect context
  exhaustion and retry with smaller payload.

If the agent's compaction has bugs, those are upstream bugs to
file with the SDK. Our response is to make the canvas + fresh-
thread pattern strong enough that compaction is rarely needed.
We do not compensate for agent internals by reinventing them.

Reason: reimplementing the agent inside Mica is a losing trade.
We don't control prompt-cache state the way the SDK does (a
token-aware trim blows the KV cache every turn, costing real
latency), and we inherit all the bugs of the original feature
without the team around it to fix them. Shaping the prompt well
upstream is the leverage Mica has.

## Canvas is memory; threads are working memory

The product tenet "context lives on the canvas, not inside the
agent" has a direct implication for how chat threads relate to
durable memory. A thread is not a record; the canvas is.

**Live thread.** The in-progress chat session on one chat card.
Loaded into the agent's context each turn. Working memory for
this arc of work. Dies when the arc ends.

**Archived thread.** A past thread, stored on disk under
`.mica/chats/archived/<timestamp>-<slug>.json`. Not in the
baseline. Browsable by humans. Readable by agents on specific
demand, never as ambient context.

**Canvas.** Outlives threads. Every durable finding belongs here.

An overflow is not a failure of memory — it is a signal that an
arc of work has produced enough volume that findings should be
promoted to canvas and a fresh thread started. "Fresh thread" is
a healthy reset, not failure recovery.

**Agent behavior policy.** Before reading an archived thread,
exhaust canvas sources: card contents, `decisions.md`, card
modifiedAt timestamps, `git log`. If the canvas cannot answer a
question the user treats as settled work, that is a gap — ask
for clarification, or offer to promote the missing information
to a card. Archived threads are one-off references. Never load a
full archived thread into context; extract what's needed and
summarize.

This mirrors the analyze-repo discipline: don't read a whole
large artifact into context; skim with intent.

## Storage model — work lives outside `.mica/`

```
my-project/
├── .mica/                      ← infrastructure only
│   ├── config.json             ← project config
│   ├── layout.json             ← canvas layout, keyed by device class
│   ├── canvas-back.md          ← project-level AI context
│   ├── chats/                  ← chat history per agent card
│   ├── cards/                  ← per-card state and AI context sidecars
│   └── card-classes/           ← project-scoped card class definitions
├── brief.md                    ← work files at project root
├── spec.md
├── tasks.todo
├── architecture.mmd
├── agent.claude                ← agent cards are just files too
├── .claude/skills/             ← skills copied from the template
├── .qwen/skills/               ← skills from the template
└── .git/
```

Cards are the work. `.mica/` is the machinery. Delete `.mica/`
and the project is back to plain files.

Card classes (the vocabulary) are infrastructure and stay in
`.mica/card-classes/` (project scope) or `card-classes/` (built-
in in the Mica repo).

## Card classes are project-wide

Card classes live at two scopes. The resolver checks project
first:

```
.mica/card-classes/<name>/    project-scoped
card-classes/<name>/          built-in
```

Project-scoped classes travel with the project in git. Built-in
classes ship with Mica. A workspace tier at
`~/.mica/card-classes/` is a horizon item (see VISION); it is
not implemented today.

## Agent architecture — two built-in classes, set will change

Today two agent card classes ship. `.chat` is backed by local
Qwen through llama-server. `.claude` is backed by the Claude
Code SDK via a spawned CLI subprocess. Both are regular card
classes whose `card.js` opens a `mica.openChannel` to a server
handler.

The set will change — new agents, different models, specialist
roles. What stays constant is the contract: an agent is a card
class that owns a brief, opens a channel to a server handler,
and reads the canvas for context. Multi-agent coordination via
direct agent-to-agent messaging is a horizon item.

Philosophically: multiple agent types will share plumbing
(status, plan steps, blocker UI, channel protocol) while
differing in rendering and backend behavior. The decision is
to accept duplication across card classes until patterns
emerge clearly. Extracting a shared library upfront tends to
be premature. When the pattern is clear, a maintenance pass
extracts primitives. Agents have the same maintenance problem
humans do (copies drift), but a different strength (they can
read an entire codebase instantly to apply a fix everywhere).

## Agent context — brief as identity, canvas as shared context

An agent's identity is its `brief.md`-equivalent content in the
agent card's instance file or directory. The brief defines
role, personality, constraints, and instructions. Part of the
brief is model-specific (tool format, SDK capabilities) and
comes from the card class. Part is role-specific and the user
customizes it.

The agent's context is the canvas itself. Agents read the same
files humans see: briefs, specs, todos, diagrams. There is no
separate "agent memory" and no hidden key-value store. The
canvas is the shared context.

## Card class as back of the card

A card has two sides. The **front** is the instance — the
user's file, its content, the accumulated state. The **back**
is the card class: `card.html`, `card.js`, `card.css`, and
`metadata.json`, plus the AI context (`context.md` at class
level and `<card>.context.md` at instance level).

The class is the machinery. The instance is the work. A
user-facing flip UI (see VISION) is the natural way to expose
this.

## Skeleton-copy-first for new card classes

New card classes are created by copying
`templates/_card-class-skeleton/` to
`.mica/card-classes/<name>/`, then editing the four files in
place. The skeleton has the correct shape for CARD_SHIM, the
`mica.*` bridge, and the metadata format.

Reason: writing `card.js` from an empty page repeatedly invites
class-wrappers, ES-module syntax, and invented base-class APIs
that CARD_SHIM does not support. Starting from the skeleton
keeps the generated code on the correct shape. The
`create-card-class` skill leads with this rule.

## Self-describing card classes — metadata.json

Each card class declares its own metadata in `metadata.json`:

```json
{
  "extension": ".todo",
  "badge": "TODO",
  "defaultTitle": "To Do",
  "primaryFile": "tasks.md",
  "dependencies": { "scripts": [], "styles": [] }
}
```

The system reads `metadata.json` from each card class directory
on startup. No central registry, no manifest file outside the
class itself.

Load-bearing constraint: the directory name must equal the
extension without the dot. A class at
`.mica/card-classes/kanban/` handles `.kanban` files. The
`extension` field in `metadata.json` is documentation. The
directory name is the actual lookup key. A mismatch silently
falls through to the text renderer.

## Event source attribution — source and cardSource

Cross-window and cross-card coordination needs a way to skip
self-echoes. Early drafts tried timing hacks (debounce,
ignore-next-event flags). Fragile.

**Decision:** broadcasts include a `source` field identifying
the origin. `source` is either a `windowId` (per browser tab),
`"agent"` (a server-side agent handler wrote it), or
`"external"` (no source was marked — git pull, manual edit,
process outside Mica).

File writes through `mica.files.write()` additionally carry a
`cardSource` field containing the writing card's `cardId`
(per-card-instance UUID). This lets sibling cards in the same
tab tell each other's writes apart.

Cards use `mica.isSelfEcho(event)` to filter. This is the
general pattern — any cross-card broadcast should include
these fields so originators can skip their own echoes.

## Layout is canvas card state

Layout positions live in `.mica/layout.json`, keyed by device
class (phone, tablet, desktop, display). The canvas card class
reads and writes this file. Different canvas card classes can
persist layout under different keys or formats.

Earlier drafts placed layout at `project.project/layout.json`
inside the canvas card's directory, following a
"layout-belongs-to-the-card" principle. That placement is
superseded by the files-are-files decision above: the canvas
is a card file, not a directory, so layout moved to
`.mica/layout.json`.

Cross-window sync uses `layout-changed` broadcasts with
`source` attribution (see above).

## Cards as tools (not implemented)

Earlier design sketches proposed `mica.callCard(cardName, fn,
args)` so any card with named server-side exports could be
called by other cards. An orchestrator agent delegates to a
specialist agent card; a dashboard pulls from data cards.

**Status: not implemented.** The runtime bridge does not expose
`mica.callCard`. This is an internal-VISION item, not a
present-tense design decision. Documenting it here to prevent
agents or humans from assuming it works.

## Implemented (formerly deferred)

The following items appeared as "Deferred" in earlier versions
of this doc and are now built:

- **Canvas card owns the toolbar.** The canvas card class
  renders the toolbar. `CanvasCardRuntime` does not own it.
- **Canvas card owns layout and arrangement.** The canvas card
  decides how children are mounted inside `#canvas-freeform`.
- **`CanvasCardRuntime` is a thin host.** It renders the canvas
  card's HTML and portals child cards into `#canvas-freeform`.
  It does not own layout, drag, or toolbar.
- **Reactivity.** The agent watches the file watcher, filters
  events to its canvas scope, coalesces with a 15-second idle
  gate, skips its own writes via write-source tracking, and
  delivers coalesced events as a synthetic turn.

## Deferred

- **"Flip the card" UI.** A button on the card header that
  shows the card class definition (`card.html`, `card.js`,
  `card.css`, `metadata.json`) and the AI context files
  instead of the instance content. A "Customize" action
  copies a built-in class to `.mica/card-classes/` for local
  editing. Purely frontend. No backend changes needed. The
  data model is in place; the UI layer is pending.

## Open questions

- Workspace-tier card classes at `~/.mica/card-classes/`:
  when, and with what cross-project promotion UX.
- Card class versioning and breaking changes as the surface
  evolves.
- Per-project container isolation as a blast radius: whether
  Mica needs it in addition to what the agent systems already
  provide.
- Card class system-dependency declaration
  (`systemDeps` in metadata) for classes that need
  non-JavaScript binaries available on the host.
