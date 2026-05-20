# Mica — Feature Highlights

A catalog of what you can do in Mica today, organized by what each
thing gives you.

## Canvas

The canvas is the primary surface — a freeform layout where every
file in the canvas-root is a card you can arrange, edit, and
interact with.

- **Freeform card layout** — drag, resize, and stack cards. Toolbar
  along the top creates new files, adds agents, and opens settings
  ([card-classes/canvas/](card-classes/canvas/)).
- **Three Tidy modes**:
  - **Tidy** — snap every card onto a clean grid.
  - **Alt+Tidy** — fit every card on screen at uniform size.
  - **Shift+Tidy** — resize each card to fit its current contents
    (good after a card has loaded data or expanded).
- **Multi-project** — one Mica instance hosts many projects, all of
  which can be running at the same time. Switch from the project
  list ([src/ProjectList.tsx](src/ProjectList.tsx)); a pulsing
  green dot next to a project name means an agent there is
  actively working.
- **Project lifecycle** — create from template, git clone, rename,
  or delete ([src/api/canvasFiles.ts](src/api/canvasFiles.ts)).
- **Library projects** — open canvas settings (gear ⚙️), toggle 📚
  to mark a project as a library, and its card classes become
  available in your other projects.

## Multi-device & remote access

Mica is designed for working across multiple devices at once.

- **Use multiple devices on the same project simultaneously.**
  Phone, tablet, laptop, and big-screen display all stay live-synced.
  Edit on one, see the change on the others within ~300 ms.
- **Per-device layouts.** The same project keeps a separate card
  arrangement for each device class — phone (<768 px), tablet
  (<1200 px), desktop (<2560 px), and display (≥2560 px). Rearrange
  on your phone without disturbing your desktop layout.
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

Each agent card sees the same canvas your other cards live on, and
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
