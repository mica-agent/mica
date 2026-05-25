# Mica — Feature Highlights

A catalog of what you can do in Mica today, organized by what each
thing gives you.

## Projects

A project is a directory of files plus a `.mica/` metadata folder.
It's the unit of work in Mica — one project per task, codebase, or
experiment. Inside, every file is potentially a card; `.mica/` holds
config, layout, chat history, and project-scoped card classes (all
of which travel with the project in git).

- **Bring one up from a template, an empty directory, or by cloning
  a git repo.** Templates are copied **wholesale** into the new
  project — the agent skills (`.qwen/skills/`), MCP server config
  (`.qwen/settings.json`), seeded canvas cards, and the
  `.mica/canvas-back.md` standing context are all duplicated in.
  Edits after creation only affect this project; nothing about the
  builder workflow lives in Mica core. If the project was cloned
  from a git repo, the `.gitrepo` card lets you stage, commit, and
  push changes back without leaving Mica. Rename or delete from the
  same project list
  ([src/api/canvasFiles.ts](src/api/canvasFiles.ts)).
- **`.mica/canvas-back.md` is where you tune the project's brain.**
  The agent reads it every turn — it carries the project's framing
  (which agent, what model class, per-project conventions, routing
  preferences). Edit it via the `canvas-back` card on the canvas,
  or via the canvas gear ⚙️ → "Edit canvas back…".
- **Multiple devices, multiple tabs, simultaneously.** A project can
  be open from any device on your network (or tailnet) at the same
  time — phone, laptop, tablet, big screen — and edits sync within
  ~300 ms. See *Multi-device & remote access* for the layout details.
- **Background work survives closing tabs.** Agents keep their turn
  state and chat history when the last browser tab closes; the
  project keeps running server-side. Reopen from the project list
  and the in-progress work picks up where it left off.
- **Agent activity at a glance.** The project list shows a pulsing
  green dot next to any project whose agent is currently working,
  so long-running tasks can run in the background while you focus
  on another project.
- **Library projects.** Mark a project as a library (canvas gear ⚙️
  → 📚) and its `.mica/card-classes/` becomes available to every
  other project on the same machine. The lightweight way to share
  a card class across experiments without packaging it.



## Canvas

The canvas is the primary surface — a freeform layout where every
file in the *canvas-root* is a card you can arrange, edit, and
interact with.

The canvas-root is a directory *inside* the project (defaults to
`canvas/`, but you can pick another name via the canvas gear ⚙️ →
"Canvas-root path"). Only files in that directory become cards on
the canvas by default; everything else in the project is still
reachable via the file browser card and can be *pinned* onto the
canvas one file at a time. That distinction keeps a project free
to hold non-card assets (raw datasets, source repos, build
artifacts) without cluttering the canvas surface.

- **Freeform card layout** — drag, resize, and stack cards. Toolbar
  along the top creates new files, adds agents, and opens settings
  ([card-classes/canvas/](card-classes/canvas/)).
- **Three Tidy modes**:
  - **Tidy** — snap every card onto a clean grid.
  - **Alt+Tidy** — fit every card on screen at uniform size.
  - **Shift+Tidy** — resize each card to fit its current contents
    (good after a card has loaded data or expanded).
- **Card-header gestures** — double-click a card's header (banner)
  to cycle collapsed → normal → expanded → normal. Useful for
  triaging a busy canvas without manually resizing each card. The
  expand / collapse buttons in the header do the same thing one
  step at a time.

## Multi-device & remote access

Mica is designed for working across multiple devices and screens at once.

- **Use multiple devices on the same project simultaneously.**
  Phone, tablet, laptop, and big-screen display all stay live-synced.
  Edit on one, see the change on the others within ~300 ms.
- **Per-device layouts.** The same project keeps a separate card
  arrangement for each device class — phone (<768 px), tablet
  (<1200 px), desktop (<2560 px), and display (≥2560 px). Rearrange
  on your phone without disturbing your desktop layout. *Work in
  progress — still rough; expect occasional bugs.*
- **Two windows on one device.** Open the same project in two tabs
  for side-by-side workflows (a canvas-heavy view in one, a
  terminal in the other) — writes from each window don't bounce
  back as ghost edits.
- **Remote access over Tailscale**
  ([scripts/https-on.sh](scripts/https-on.sh)). Access Mica from
  anywhere. Front your local Mica with Tailscale Serve and your
  tailnet gets an HTTPS URL that works from any signed-in device —
  iPhone Safari, laptop on the road, a secondary machine.
  Tailnet-internal only; not on the public internet. Stop with
  `scripts/https-off.sh`.

## Card classes

A card's file extension selects its renderer. Built-in classes ship
in [card-classes/](card-classes/); per-project classes live in
`.mica/card-classes/` (and travel with the project in git).

### Agents & chat

Within a project, each agent card sees the same canvas your other cards live on, and
ships with tools for creating cards, editing files, running shell
commands, browsing the project, fetching URLs, and taking
screenshots. Full tool catalog in
[server/agentTools/registry.ts](server/agentTools/registry.ts) and
[ARCHITECTURE.md](ARCHITECTURE.md).

- **Qwen Code (`.qwen`)** — Qwen Coder agent (recommended for Qwen
  models, but works with others too). Reads your canvas, edits
  files, runs commands, takes screenshots. Picks up file changes
  between turns so you can edit alongside it
  ([card-classes/qwen/](card-classes/qwen/)).
- **Claude (`.claude`)** — Claude Opus in the cloud, with vision
  and the same tool set as the local agent. Use it to get a second
  opinion. Requires a Claude subscription or API key
  ([card-classes/claude/](card-classes/claude/)).
- **OpenCode (`.opencode`)** — Agent backed by any OpenAI-compatible
  endpoint you point it at (OpenRouter, a local model, or your own
  server). Settings panel picks the model and provider
  ([card-classes/opencode/](card-classes/opencode/)).
- **Voice (`.voice`)** — Click-to-toggle voice assistant. Local
  Parakeet speech-to-text and Kokoro spoken replies — no audio
  leaves the machine. Can route requests to other chat cards on
  the canvas. Settings panel covers voice selection, ambient
  auto-read, default dispatch target, microphone sensitivity, and
  inter-sentence pacing. Supports barge-in — start talking mid-reply
  and Mica stops speaking and listens
  ([card-classes/voice/](card-classes/voice/)).
- **LLM chat (`.llm-chat`)** — Plain streaming chat with no tools.
  Use for quick conversational queries against a single model
  ([card-classes/llm-chat/](card-classes/llm-chat/)).

### Editors & viewers

- **Markdown (`.md`)** — Rich-text markdown editor with mermaid
  blocks and a diff view ([card-classes/md/](card-classes/md/)).
- **To-do (`.todo`)** — Task-list manager backed by markdown
  ([card-classes/todo/](card-classes/todo/)).
- **Mermaid (`.mmd`)** — Render and edit diagrams with pan/zoom
  ([card-classes/mmd/](card-classes/mmd/)).
- **CSV (`.csv`)** — Tabular view and edit
  ([card-classes/csv/](card-classes/csv/)).
- **Data files (`.json`, `.xml`, `.yaml`, `.yml`)** —
  syntax-highlighted editors.
- **Plain text (`.txt`)** — Minimal text editor.
- **HTML (`.html`)** — Sandboxed iframe render — scripts run, but
  isolated from the rest of Mica
  ([card-classes/html/](card-classes/html/)).
- **Log (`.log`)** — Read-only continuous-scroll log viewer.

### Terminal & system

- **Terminal (`.terminal`)** — Full PTY shell with xterm. Your
  session survives card re-renders, so a long-running process stays
  alive ([card-classes/terminal/](card-classes/terminal/)).
- **Git repo (`.gitrepo`)** — Status, stage, commit, push, and
  fast-forward pull from the card
  ([card-classes/gitrepo/](card-classes/gitrepo/)).

### Library & discovery

- **File browser (`.filebrowser`)** — Browse the whole project (not
  just canvas-root); preview on click; drag-drop upload; pin files
  to the canvas
  ([card-classes/filebrowser/](card-classes/filebrowser/)).
- **Skills (`.skills`)** — Browse, edit, and create per-project
  skills under `.qwen/skills/` and `.claude/skills/`
  ([card-classes/skills/](card-classes/skills/)).
- **Canvas back (`.canvas-back`)** — View and edit
  `.mica/canvas-back.md` (the project's global context for agents)
  with propose-then-apply agent editing
  ([card-classes/canvas-back/](card-classes/canvas-back/)).
- **Shared library (`.shared-library`)** — Browse pre-vetted
  reference docs living at `/workspaces/shared/` on the host. Click
  to pin one into the current project; the agent then sees it
  alongside canvas files. When the agent pins one itself, a toast
  tells you what landed
  ([card-classes/shared-library/](card-classes/shared-library/)).

## How apps are built

Card classes pick a compute pattern based on what each subtask
needs. Mica supports four, ordered from cheapest to heaviest. The
agent decomposes a request into subtasks and picks the cheapest
pattern that fits each one — a single card class commonly mixes
two or three.

| Pattern (tier) | Where the compute runs | Examples |
|---|---|---|
| **Browser-only** (T1) | `card.js` in the user's browser, optionally loading CDN libs (D3, Chart.js, Three.js, Leaflet, …) | Calculators, dashboards over local CSV, mermaid diagrams, 3D visualizers, world clocks, IndexedDB-backed notes |
| **LLM-direct** (T2) | The local LLM (or a cloud model via OpenRouter) streamed straight to the card by Mica's `llm-direct` handler — zero server-side code per card | Summarizers, classifiers, persona chats, "rewrite as bullet points", translation, sentiment tagging |
| **CLI wrap** (T3) | A one-shot subprocess: card.js opens a `process` channel, sends stdin, receives stdout/stderr | OCR (`tesseract`), PDF extract (`pdftotext`), audio convert (`ffmpeg`), local transcription (`whisper.cpp`), JSON munging (`jq`), image convert (`convert`) |
| **Sidecar** (T4) | A per-card Python or Node server (`server.py` / `server.ts` next to `card.js`) that Mica spawns on demand and keeps warm | Vector search over private docs, embeddings index, in-memory FAISS, custom local model inference, anything needing RAM-resident state across calls |

### Why "cheapest that fits"

Each tier has a different startup cost and a different ongoing
RAM cost. T1 is free — it runs in a tab the user already has open.
T2 is amortised against the local LLM that's already warm. T3
pays a fork-exec per call but releases all state between calls,
making it safe to ignore from a memory-pressure standpoint. T4
holds RAM for as long as the card stays "warm" (Mica auto-shuts
the sidecar down ~10 minutes after the last call), so reaching
for T4 when T1–T3 would have done the job is a real cost on a
GPU-constrained host.

A typical PDF-RAG card decomposes as **T1** (UI in `card.js`) +
**T3** (`pdftotext` for extract) + **T4** (sidecar that holds an
embedding index in memory) + **T2** (`llm-direct` for the
streamed answer). Four tiers in one card class; no single tier
on its own would do the job well.

### T4 sidecar lifecycle

You don't start or stop sidecars by hand — Mica manages the whole
lifecycle. What that looks like in practice:

- **First card open → first sidecar fetch starts it.** The sidecar
  process spawns lazily, on the first `mica.fetch` call from the
  card. A health probe waits until the sidecar's `ready_path`
  responds (~seconds for most workloads, longer if the sidecar has
  to load a model or build an index from disk). Subsequent fetches
  reuse the running process.
- **Stays warm while in use.** Each successful fetch into the
  sidecar resets an idle clock. As long as the card is being used,
  the sidecar holds its port + RAM and serves requests at warm
  speed (no model-load on each call).
- **Auto-shuts down after ~10 minutes idle.** If nothing has called
  the sidecar for 10 minutes, Mica SIGTERMs it (5-second grace,
  then SIGKILL). The next fetch will cold-spawn a fresh one. 10 min
  is generous on purpose — model-load cost dominates fresh-start
  cost, so erring on the warm side is cheaper than tight cycling.
- **Closing the tab doesn't kill the sidecar.** The sidecar lives
  on the server, not in your browser. Walking away from a card
  just stops the fetches; the 10-minute idle timer takes over from
  there. Open a new tab and re-engage the card before then and
  you'll see warm latency.
- **Deleting the project kills its sidecars immediately.** When you
  delete a project, Mica stops every sidecar belonging to it
  before removing the project's files — port and RAM freed in
  seconds rather than waiting on the idle timer.
- **Restarting / stopping Mica shuts everything down cleanly.**
  `scripts/stop.sh` / Ctrl+C the dev server triggers a SIGTERM →
  5 s → SIGKILL sweep over every running sidecar. On the next Mica
  start, an orphan-reap pass cleans up anything left over from a
  crash or hard kill of the previous run, so you don't accumulate
  zombie sidecars across restarts.
- **Agents can force-restart a sidecar.** When the agent edits a
  sidecar's `server.py` it can call the `mica_restart_sidecar`
  tool to kill the current process so the next fetch picks up the
  new code. (Sidecars don't auto-watch their own source files.)

### Where the pattern is declared

A card class picks its handler in [`metadata.json`](server/plugins/cardClassTools.ts):
`handler: "llm-direct"` enables T2, `handler: "process"` enables
T3, no handler (or `null`) leaves the card at T1. T4 is declared
separately by shipping `server.py` or `server.ts` alongside
`card.js`; Mica detects the file and treats the card as having a
sidecar regardless of `handler`.

Full schema, sidecar lifecycle, and worked decompositions live in
the `card-class-handbook` skill that ships with each project
template (`templates/<name>/.qwen/skills/card-class-handbook/SKILL.md`).

## Templates & the builder workflow

When you create a project, you pick a template. The template is
**copied wholesale into your new project** — canvas-back doc,
seeded cards, agent skills, settings. Once copied, everything lives
inside the project: `.mica/canvas-back.md`, `.qwen/skills/`,
`.qwen/settings.json`, the seeded card files. Nothing about the
builder workflow lives in Mica core. **This means the workflow is
per-project — you can edit any skill, change the canvas-back, or
swap the agent card class without touching Mica itself, and run
multiple projects side by side with different builder
philosophies.**

### Included templates

Both templates ship the **same skill set** (the builder workflow
described below). They differ in which agent and helpers get
seeded onto the day-1 canvas.

- **`dgx-spark-local`**
  ([templates/dgx-spark-local/](templates/dgx-spark-local/)) —
  Local-first workflow. Seeds `agent.qwen` (the Qwen Code CLI
  pointed at Mica's bundled local vLLM), `canvas-back.canvas-back`,
  `shared.shared-library`, and `skills.skills`. No API key required;
  no per-token cost. The canvas-back doc tells the agent it's
  running on a local model and to be lean with prompts and tool
  output.
- **`opencode-builder`**
  ([templates/opencode-builder/](templates/opencode-builder/)) —
  Hybrid local-or-cloud workflow. Seeds `agent.opencode` (the
  OpenCode card, which can dispatch to local vLLM, OpenRouter, or
  any OpenAI-compatible endpoint via its gear menu), plus
  `voice.voice` so you can narrate a build hands-free. The
  canvas-back doc explains routing tradeoffs — when to stay local,
  when to reach for OpenRouter's bigger context windows or stronger
  reasoning models.

### The builder workflow (shipped skills)

The skills the agent picks up automatically — located in each
template's `.qwen/skills/` directory — encode a single coherent
workflow centered on **plan-before-build** discipline.

When you say *"build / create / implement / make / ship"*, the
agent walks this loop:

1. **`develop`** is the top-level gate. It owns the whole flow:
   research → spec → approval gate → execute → verify → reconcile
   docs.
2. **`discover-dependency`** runs FIRST, before any spec. Every
   non-trivial subproblem (rendering, charts, parsing, geo math,
   audio…) gets a quick library search; verified CDN URLs land in
   the spec, so architecture is shaped around libraries instead of
   from-scratch reinvention.
3. **`card-class-handbook`** loads when the artifact is a card
   class. It's the canonical reference for the `mica.*` API,
   `CARD_SHIM` contract, and the `card.html + card.js + card.css +
   metadata.json` shape `mica_create_class` enforces.
4. **Spec on canvas.** The agent writes
   `canvas/<name>-spec.md` with a YAML frontmatter block that
   `mica_create_class` reads directly (the structured contract:
   name, badge, dependencies with verified URLs, subtask
   decomposition by tier, out-of-scope items).
5. **🛑 Approval gate.** The agent's turn ENDS after writing the
   spec. It cannot proceed to code until your *next* message
   approves the build. A file save is **not** a build trigger.
6. **`decompose-task`** orchestrates subagent dispatches when (a)
   the work has real architectural seams AND (b) the integrated
   whole exceeds one slot's working set. **Default is inline** —
   the orchestrator path is opt-in, not the default. When it does
   fire, a `task-decomposer` subagent writes `interfaces.md` +
   `decomposition.md` + `plan.todo`, and `component-coder`
   subagents implement each plan item per its named contract.
7. **`verify-then-continue`** runs after every code change —
   type-check, restart the right thing, hit the actual surface
   (curl an endpoint, render_capture a card), tail the log, report
   concrete pass/fail. "Untested code is unfinished code."
8. **`doc-consistency`** reconciles specs with what shipped. Code
   that contradicts a doc means the doc gets updated in the same
   turn.

Surrounding skills support that core loop:

- **`grow-canvas`** — propose new cards as the conversation
  reveals gaps (a todo list, a decisions doc, a flow diagram).
  One proposal per turn; wait for OK.
- **`fix-bug`** — bug-shaped requests get a separate playbook:
  reproduce → root cause → minimal change → verify. No
  decomposition (a bug fix is one investigation, not a build).
- **`add-third-party-tool`** — wiring new tools, CLIs, or
  sidecars into the project.
- **`analyze-repo`** — reading large repos without loading every
  file (named-section reads only).
- **`revise` / `single-file-edit`** — surgical edit workflows for
  changes scoped to one file or one section.
- **`participate-fully`** — runs every turn. Reads the
  "since your last turn" change manifest, decides what to react to.
- **`be-precise`** — write clear prompts, validate assumptions
  against the actual API or file before code depends on them.
- **`_conventions.md`** — canonical home for cross-skill patterns
  (reading discipline, library reuse, API discipline,
  decomposition gates, approval flow, file-naming hygiene).

### MCP tools the agent uses

The agent's tool surface is wired together over **MCP** (Model
Context Protocol), and splits into two servers:

**1. Mica's built-in tools.** An internal SDK-MCP server Mica spins
up per session, common to all three chat agents
([server/agentTools/sdkMcpBuilder.ts](server/agentTools/sdkMcpBuilder.ts)).
These are the tools that make Mica *Mica* — anything that touches
the canvas, the card-class system, the sidecar lifecycle, or the
host:

- `mica_create_class`, `mica_edit_class_file`,
  `mica_create_card_instance`, `mica_delete_card_instance`,
  `mica_delete_class`, `mica_list_classes` — card-class lifecycle.
  The only sanctioned path for writes under `.mica/card-classes/`
  (schema enforced, partial-edit safety, project-scope checks).
- `mica_list_handlers` — list the channel handlers a card class
  can pick (`llm-direct`, `process`, `agent_session`, …), so the
  agent reaches for the right tier when shaping a new card class.
- `mica_inspect_url`, `mica_inspect_python_package` — verify a
  3rd-party URL or Python package's API shape *before* code
  depends on it. Tenet 16 (validate before relying).
- `mica_list_shared_docs`, `mica_pin_shared_doc` — browse and pin
  pre-vetted reference docs from the shared library.
- `mica_list_skill_packages`, `mica_install_skills` — discover
  and install skill packages into the current project.
- `mica_shell` — run a shell command in the project's working
  directory with Mica-aware safety guards (refuses commands that
  would kill the backend, etc.). The agent's general-purpose
  exec path.
- `mica_sidecar_log`, `mica_restart_sidecar`,
  `mica_verify_sidecar` — T4 sidecar diagnostics.
- `render_capture` — take a screenshot of a card and reason over
  the result, giving the agent a visual feedback loop for "the
  chart didn't render" / "the button is in the wrong place."
- `propose_changes` — suggest cascading edits to OTHER docs (e.g.
  "the rename in spec.md should also apply to interfaces.md")
  without writing them directly. Each proposal renders as an
  Apply / Dismiss UI in the agent's chat card.

**2. External MCP servers, declared per-project.** A project's
`.qwen/settings.json` carries an `mcpServers` block that points
at any number of additional MCP servers — stdio binaries the SDK
launches and proxies. Mica's templates ship one entry:

- `tavily` — web search backed by Tavily's free tier
  (`TAVILY_API_KEY` in the project's `.env`).

### Adding more MCP servers

Edit the project's `.qwen/settings.json` and append to
`mcpServers`:

```json
"mcpServers": {
  "tavily": { "command": "npx", "args": ["-y", "tavily-mcp"] },
  "your-server": {
    "command": "npx",
    "args": ["-y", "<package-name>"],
    "env": { "YOUR_API_KEY": "${YOUR_API_KEY}" }
  }
}
```

Anything that speaks the MCP stdio protocol drops in: published
servers (the `@modelcontextprotocol/server-*` family,
3rd-party offerings on npm or PyPI), a locally-installed binary,
or a script you wrote yourself. Environment variables interpolate
from the project's `.env` and the host shell. The agent picks the
new server up on its next turn — no Mica restart needed.

Because `.qwen/settings.json` lives inside the project, each
project carries its own MCP server set: a research project might
have `tavily` + a Linear MCP; a coding project might have a
GitHub MCP + a search index over your private docs.

### Tweaking the workflow

Because everything lives inside the project, experimenting is
cheap:

- **Edit a skill** — open `.qwen/skills/<name>/SKILL.md` (the
  `skills` card class on the canvas browses these without leaving
  Mica). Then run `/memory refresh` so the agent picks up the new
  instructions without restarting the session.
- **Add a skill** — create `.qwen/skills/<your-name>/SKILL.md`
  with a YAML frontmatter (`name`, `description`). The agent
  picks it up the same way as shipped skills.
- **Change standing context** — edit `.mica/canvas-back.md` to
  rephrase the project's framing (model class, routing
  preferences, per-turn rules).
- **Flip thresholds** — `.qwen/settings.json` carries the
  runtime-aware budget defaults the skills read.
- **Try a different workflow philosophy entirely** — fork the
  template directory, drop or rewrite skills, and create projects
  from your fork.

Per the canvas-back docs, the agent doesn't paraphrase model
identity from these static template files — it reads a "Detected
runtime" banner the runtime injects each turn. So skill thresholds
scale to whichever model your project is actually using.

## Voice & multimodal

- **Voice card** — see Agents & chat above for the full feature.
- **Vision via screenshots** — any chat or voice agent can take a
  picture of a card and reason about what's on screen visually —
  useful for "the button looks wrong" or "the chart didn't render."

## Real-time sync

What you observe when more than one window or device is open:

- Layout, content, and file changes replicate to every connected
  tab and device within ~300 ms.
- Editing a card class reloads every open instance of that class
  live.
- After you finish editing files an agent is watching (and pause
  for ~15 s), the agent automatically takes a turn to react — no
  need to message it.

## Project configuration

State lives in `.mica/`. Delete `.mica/` and the project is back to
plain files.

- **`.mica/config.json`** — project settings (canvas-root path,
  model preferences).
- **`.mica/layout.json`** — per-device card positions.
- **`.mica/chats/`** — chat histories per card instance.
  `archived/` holds prior threads when you start fresh.
- **`.mica/cards/`** — per-card sidecar state and settings.
- **`.mica/card-classes/`** — project-scoped card classes (commit
  these to git alongside your code).

## Tools & connectors

- **Tavily Search** — agents can search the web. Bring your own API
  key.
- **OpenRouter** — point the Qwen and OpenCode agents at any
  OpenRouter-hosted cloud model to compare against your local
  agent. Bring your own OpenRouter API key.
- **Claude Code** — required for the Claude agent card. Bring your
  own Anthropic subscription or API key.
- **GitHub** — clone projects in and push them back out from the
  project lifecycle controls.


## Security model — blast radius and risk

**Heads-up:** Mica is currently for experimentation and should not
be used with sensitive information. There is a basic layer of
protection around the host system, but the strong recommendation
is to keep Mica reachable only over an internal network (your
LAN or your tailnet — see the Tailscale Serve note below).

The question this section answers: *what can a card touch, and if a
card or agent misbehaves, how far does the damage go?*

- **Container boundary is the primary limit.** Mica runs inside a
  devcontainer / Docker image. A card's `mica.fetch` calls and a
  shell tool's commands are bounded by the container's filesystem
  and network. The container is the floor of the blast radius.
- **Tailscale Serve only, not Funnel.** The shipped remote-access
  script uses Tailscale **Serve**, which keeps the URL reachable
  only from devices signed into *your* tailnet. It does NOT expose
  Mica to the public internet. If you switch to Tailscale Funnel
  manually, that's on you — Mica's trust model assumes the network
  port is reachable only by people you trust.
- **Project scoping.** A card in project A cannot read or write
  project B's files. Every API call carries the project tag and
  the server enforces it.
- **Card isolation.** Each card runs with a scoped DOM, scoped
  timers, and a scoped fetch. A card can't reach into other cards
  via the global document, and its timers / listeners auto-clean
  on unmount.
- **Outbound network guard.** `mica.fetch` blocks private/loopback
  IPs and cloud-metadata addresses (so a card can't probe your
  intranet or steal cloud credentials), and applies a rate limit
  and response-size cap.
- **Agent-tool gate.** Browser-side cards can't invoke agent tools
  directly — those tools require an internal auth header that
  never leaves the server side.
- **What is *not* sandboxed.** The shell tool and the terminal
  card give an agent or user a real shell inside the container —
  same blast radius as a local terminal. Don't open untrusted
  projects without trusting their authors.
- **Single-user trust model.** Mica assumes one trusted person is
  using it. There's no per-project login, no row-level
  permissions. The network port and the container are the
  security edge.

## Development & authoring

For people building card classes or extending Mica.

- **Card-class transparency** — every card class is `card.html +
  card.js + card.css + metadata.json`, plain files an agent or
  human can read and edit.
- **AI context layers** — global (`.mica/canvas-back.md`),
  class-level (`context.md`), and per-instance sidecars feed the
  agent's working context.
- **Templates** — `dgx-spark-local` and `opencode-builder` seed a
  fresh project with skills, canvas-back, and example cards
  ([templates/](templates/)).
- **`mica.*` API** — card-class authors program against the
  `mica.*` API documented in [ARCHITECTURE.md](ARCHITECTURE.md):
  `mica.files.*` for project file I/O, `mica.openChannel` for
  agent/handler streams, `mica.fetch` for proxied HTTP,
  `mica.speak` / `mica.listen` for voice, and the file/layout
  events you'd expect.
