# Mica — User-Visible Features

A catalog of what's implemented and visible to end users today, organized
by category. Aspirational items in `internal/VISION.md` are excluded.

## Canvas

The canvas is the primary surface — a freeform layout where every file in
the canvas-root is a card.

- **Freeform card layout** — drag, resize, and stack cards on an infinite
  surface ([card-classes/canvas/card.js](card-classes/canvas/card.js)).
- **Per-device layouts** — positions persist separately for phone, tablet,
  desktop, and display classes in [.mica/layout.json](.mica/layout.json).
- **Cross-window sync** — open the same project in two browser tabs and
  every layout, file, and content change replicates in real time.
- **Self-echo filter** — a card that writes its own file doesn't rebuild
  itself; remote-origin writes do trigger a rebuild.
- **Canvas toolbar** — create files, add agents, open settings overlay
  ([card-classes/canvas/](card-classes/canvas/)).
- **Multi-project** — one Mica instance hosts many projects; switch from
  the project list ([src/ProjectList.tsx](src/ProjectList.tsx)).
- **Project lifecycle** — create from template, clone, rename, delete
  ([src/api/canvasFiles.ts](src/api/canvasFiles.ts)).

## Card classes

A card's file extension selects its renderer. Built-in classes ship in
[card-classes/](card-classes/); per-project classes live in
`.mica/card-classes/`.

### Agents & chat

- **Qwen Code (`.qwen`)** — local Qwen3.6-35B (vLLM, NVFP4) with canvas
  awareness, tool use, and reactive turns on file edits
  ([card-classes/chat/](card-classes/chat/)).
- **Claude (`.claude`)** — Claude Opus via the Claude Agent SDK
  subprocess; full tool loop and vision
  ([card-classes/claude/](card-classes/claude/)).
- **OpenCode (`.opencode`)** — OpenCode SDK against local llama-server or
  cloud providers (OpenRouter)
  ([card-classes/opencode/](card-classes/opencode/)).
- **Voice (`.voice`)** — press-to-talk assistant; Parakeet STT + Kokoro
  TTS sidecars; canvas-aware tool use
  ([card-classes/voice/](card-classes/voice/)).
- **LLM chat (`.llm-chat`)** — direct streaming chat, no tools; model
  switcher; OpenAI-compatible
  ([card-classes/llm-chat/](card-classes/llm-chat/)).

### Editors & viewers

- **Markdown (`.md`)** — WYSIWYG (Toast UI) with embedded mermaid and
  diff viewer ([card-classes/md/](card-classes/md/)).
- **To-do (`.todo`)** — task-list manager backed by markdown
  ([card-classes/todo/](card-classes/todo/)).
- **Mermaid (`.mmd`)** — render and edit diagrams with pan/zoom
  ([card-classes/mmd/](card-classes/mmd/)).
- **CSV (`.csv`)** — tabular view/edit ([card-classes/csv/](card-classes/csv/)).
- **JSON / XML / YAML / YML (`.json`, `.xml`, `.yaml`, `.yml`)** — syntax
  highlighted editors.
- **Plain text (`.txt`)** — minimal editor.
- **HTML (`.html`)** — sandboxed iframe render (`allow-scripts`, no
  same-origin) ([card-classes/html/](card-classes/html/)).
- **Log (`.log`)** — read-only continuous-scroll viewer.

### Terminal & system

- **Terminal (`.terminal`)** — full PTY shell (xterm); survives card
  re-renders ([card-classes/terminal/](card-classes/terminal/)).
- **Git repo (`.gitrepo`)** — status, stage, commit, push, ff-only pull
  ([card-classes/gitrepo/](card-classes/gitrepo/)).

### Library & discovery

- **File browser (`.filebrowser`)** — browse the full project (not just
  canvas-root); preview on click; drag-drop upload; pin files to canvas
  ([card-classes/filebrowser/](card-classes/filebrowser/)).
- **Skills (`.skills`)** — browse, edit, create per-project skills under
  `.qwen/skills/` and `.claude/skills/`
  ([card-classes/skills/](card-classes/skills/)).
- **Canvas back (`.canvas-back`)** — view/edit `.mica/canvas-back.md`
  with propose-then-apply agent editing
  ([card-classes/canvas-back/](card-classes/canvas-back/)).
- **Shared library (`.shared-library`)** — browse workspace-shared docs
  in `/workspaces/shared/`; pin into the current canvas
  ([card-classes/shared-library/](card-classes/shared-library/)).

## Agent tools

Tools the agent can invoke. The user sees the side effects (files appear,
cards land on the canvas, sidecars restart). Defined in
[server/agentTools/registry.ts](server/agentTools/registry.ts).

- **`render_capture`** — screenshot a card and run vision over it.
- **`mica_create_class` / `mica_edit_class_file` / `mica_delete_class`** —
  author and edit card classes with pre/post-write validation.
- **`mica_create_card_instance` / `mica_delete_card_instance`** — place
  and remove files on the canvas.
- **`mica_list_classes` / `mica_list_handlers`** — discover available
  card types and server-side channel handlers.
- **`mica_install_skills` / `mica_list_skill_packages`** — install
  curated skill packages into the project.
- **`mica_list_shared_docs` / `mica_pin_shared_doc`** — discover and pin
  workspace-shared documents.
- **`mica_shell`** — run shell commands (`npm install`, `git log`, etc.).
- **`mica_inspect_url`** — fetch and analyze an HTTP(S) URL (SSRF
  guarded).
- **`mica_inspect_python_package`** — verify a Python package exists
  and inspect it.
- **`mica_restart_sidecar` / `mica_sidecar_log` / `mica_verify_sidecar`** —
  manage long-lived card-class sidecar processes.

## Skills

Shipped with the `dgx-spark-local` template at
[templates/dgx-spark-local/.qwen/skills/](templates/dgx-spark-local/.qwen/skills/).
Agents pick them up automatically.

- **`card-class-handbook`** — authoring reference for new card classes.
- **`grow-canvas`** — expand the canvas with new cards.
- **`decompose-task`** — break work into subagent scopes.
- **`analyze-repo`** — skim large repos without loading everything.
- **`develop`** — analyze → implement → test workflow.
- **`discover-dependency`** — find third-party libraries.
- **`fix-bug`** — structured debugging workflow.
- **`revise` / `single-file-edit`** — surgical edit workflows.
- **`verify-then-continue`** — test after edits before proceeding.
- **`doc-consistency`** — keep docs aligned across edits.
- **`participate-fully`** — encourage agents to use all tools, not just
  `write_file`.
- **`be-precise`** — write clear prompts and validate assumptions.

## Voice & multimodal

- **Press-to-talk** — hold to record, release to send
  ([card-classes/voice/](card-classes/voice/)).
- **Parakeet STT sidecar** — speech transcription, auto-spawned on first
  request.
- **Kokoro TTS sidecar** — agent responses spoken aloud.
- **Canvas-aware** — voice agent reads the same canvas context as chat
  agents.
- **Vision via `render_capture`** — any agent can screenshot a card and
  describe it.

## Real-time sync

Powered by file-watcher and ChannelManager
([server/fileWatcher.ts](server/fileWatcher.ts)).

- **`file-created`, `file-changed`, `file-deleted`** — fire across all
  browser tabs on the project in ~300ms.
- **`layout-changed`** — drag/resize in one window updates the other.
- **`card-class-changed`** — editing a class definition reloads every
  open instance.
- **Source attribution** — every event carries `source` (windowId,
  `"agent"`, or `"external"`) so cards skip their own writes.
- **Reactive agent turns** — after 15 s of idle following user edits in
  an agent's canvas scope, the agent receives a synthetic "user edited
  these files" turn.

## Project configuration

State lives in `.mica/`. Deleting `.mica/` leaves the project as plain
files.

- **`.mica/config.json`** — project settings (canvas-root path, model
  preferences).
- **`.mica/layout.json`** — per-device card positions.
- **`.mica/chats/`** — chat histories per card instance; `archived/`
  preserves prior threads.
- **`.mica/cards/`** — per-card AI context and state sidecars.
- **`.mica/card-classes/`** — project-scoped card classes (travel in
  git).
- **Library projects** — mark a project as a library so its card classes
  are visible in other projects, via
  `~/.mica/include-projects.json`.

## `mica.*` browser API

Card authors and agents use this; users see the effects.

- **`mica.files.*`** — read, write, delete, list files in the project.
- **`mica.on(event, cb)`** — subscribe to file and layout events.
- **`mica.openChannel(fn, args)`** — bidirectional stream to an agent,
  terminal, or chat handler.
- **`mica.call(fn, args)` / `mica.send(fn, args)`** — one-shot server
  calls.
- **`mica.broadcast(event, data)`** — ephemeral cross-card signals
  within the tab.
- **`mica.fetch(url, opts)`** — SSRF-guarded HTTP proxy with rate limit
  and response cap.
- **`mica.render.capture(filename)`** — screenshot a card and run vision.
- **`mica.cardClasses.list()`** — discover installed card types.
- **`mica.isSelfEcho(event)`** — filter the card's own writes.

## Security model

- **Project scoping** — every API call carries `X-Mica-Project`; no
  cross-project access.
- **CARD_SHIM isolation** — scoped DOM, timer cleanup, scoped fetch with
  auto-injected project header.
- **SSRF guard on `mica.fetch`** — DNS-resolved; rejects private,
  loopback, and cloud-metadata IPs.
- **Agent-tool auth** — internal `x-mica-agent-auth` header prevents
  browser cards from invoking agent tools.
- **Single-user trust** — no per-project authentication; the network
  boundary is the security edge.

## Development & authoring

- **Card-class transparency** — every card is `card.html + card.js +
  card.css + metadata.json` files an agent or human can read and edit.
- **AI context layers** — global (`.mica/canvas-back.md`), class-level
  (`context.md`), and per-instance context sidecars.
- **Pre- and post-write validators** — agents writing card.js or
  metadata.json hit lint and structural checks before the file lands.
- **Templates** — `dgx-spark-local` seeds a fresh project with skills,
  canvas-back, and example cards
  ([templates/dgx-spark-local/](templates/dgx-spark-local/)).
