# Mica

Mica is an *agent-first builder*: a workspace where you
collaborate with one or more AI agents to define a task, compose
and review the *context* (the information relevant to solving
it), and build the small *ephemeral apps* needed to solve it. The
apps live on the same visual canvas as the context that drove
them, and are used in place — Mica is both where the work gets
planned and where the resulting tools get run.

The project was built to explore what is possible for agentic
tools running on local hardware against state-of-the-art coding
models. Mica ships preconfigured with Qwen3.6-35B (MoE) and three
coding agents — OpenCode, Qwen Code, and Claude Code — so you can
run the same task through each and compare. Other local models
drop in with a config change; an OpenRouter integration is
available for cloud models when you want them.

Mica fits well when the answer to a problem is a small focused
tool rather than a major application. Examples of categories appear are promising
so far: *interactive information visualizers* (dashboards over a API, CSV,
charts over a git history, interactive maps );
*knowledge extraction over private data* (chatting with your own
documents, notes, or chat history; answers and summaries that
never leave the machine); and *workflow automation* (short
scripts that batch-rename files, watch a directory, sync between
services, or chain a few CLI tools). In each case the agent leans
on existing libraries and CLIs rather than writing everything
from scratch — assembling them into a card you can use
immediately.

## How you interact

Mica is built around three concepts. A *project* is a directory
of files. A *canvas* is a 2D layout of those files. A *card* is
one file rendered as an interactive UI. Opening a project shows
its files as cards on the canvas, ready to drag, resize, and
layer. A core tenet is *transparency*: every piece of context
lives as a plain file on disk, visible to you, to the agents, and
to any ordinary tool — editor, grep, git.

Mica ships with a starter set of card classes. The coding-agent
chats (`.qwen`, `.claude`, `.opencode`) and the voice-enabled
orchestrator (`.voice`) — which dispatches spoken requests to
whichever coding agent fits — are the entry points for most work.
Alongside them are utility cards for Markdown notes, checklists,
a real terminal, and a git panel. Cards you build in a project
stay within that project, or can be promoted to a *library*
shared across every project on the same machine.

Each project defines its own agent behavior — skills, tools,
model choice — so a new project (or one started from an included
canvas template) is a clean sandbox for experimenting with
different skills or problem domains.

Mica itself runs inside a Docker container, isolating the host OS
from anything the agents do. `localhost:5173` is reachable as
soon as Mica is up; the included `scripts/https-on.sh` fronts the
workspace with Tailscale Serve for remote access from a laptop,
phone, or tablet on your tailnet — voice included, since
browsers require HTTPS for the microphone.

## How apps are built

Mica builds apps by composing four compute patterns, ordered from
cheapest to heaviest. The agent picks the cheapest one that fits
each subtask; a single card commonly mixes two or three.

| Pattern (tier) | Where the compute runs | Good for |
|---|---|---|
| **Browser-only** (T1) | `card.js` in the user's browser, plus optional CDN libs | Visualizers, calculators, dashboards, animations — anything purely client-side |
| **LLM-direct** (T2) | The local LLM (or cloud) streamed straight to the card via the `llm-direct` handler | Summarizers, classifiers, persona chats, free-form rewrites |
| **CLI wrap** (T3) | A one-shot subprocess with stdin/stdout (the `process` handler) | OCR (`tesseract`), PDF extract (`pdftotext`), audio convert (`ffmpeg`), local transcription (`whisper.cpp`) |
| **Sidecar** (T4) | A per-card Python or Node server with warm state | Vector search, embeddings index, custom model inference — anything needing RAM-resident state across calls |

See [FEATURES.md](FEATURES.md#how-apps-are-built) for worked examples and per-tier trade-offs.

## Examples

*Screenshots and short demo videos will live here.*

- **Information visualizer** — *TODO: screenshot + video*
- **Knowledge extraction over private data** — *TODO: screenshot + video*
- **Workflow automation** — *TODO: screenshot + video*
- **Fun** — *TODO: "Hotdog or Not Hotdog"*

## Run it

The recommended setup is the 2-container vLLM topology. From a
Linux GPU host with Docker and the [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html)
installed:

```
git clone https://github.com/<org>/mica.git && cd mica
./scripts/mica-compose.sh up
```

First run takes 5–15 minutes (vLLM downloads ~30 GB then warms up;
subsequent starts are seconds). Open http://localhost:5173 once
it's up.

Validated on a DGX Spark (128 GB unified memory) and against
several cloud models — Gemini, DeepSeek, Claude Sonnet — via
OpenRouter.

For the smaller llama (1-container) topology, the devcontainer
development workflow, multi-device remote access via Tailscale,
customization knobs, and troubleshooting, see [SETUP.md](SETUP.md).

## Trust model

Mica is a **single-user tool** with no API authentication:
anyone who can reach the Mica port has full read/write to your
workspace, including chat history and stored credentials. The
Docker container limits damage to the host OS, but does not
isolate users from each other. Expected deployment is localhost,
a VS Code SSH tunnel, or a Tailscale tailnet — **do not bind a
public IP without a firewall**.

Card classes installed in a project are trusted code: they run
inline, spawn subprocesses, and read process environment
variables. Treat installing one the way you'd treat installing a
small Node script.

That said, the runtime does keep some guardrails between cards and
the host. Card HTTP requests go through `mica.fetch`, a server-side
proxy that resolves DNS first and refuses private, loopback, and
cloud-metadata ranges (so a card can't probe your LAN or scrape
`169.254.169.254`), with per-project rate limits and response-size
caps. File reads and writes are project-scoped — every request
carries the project name, so one project's cards cannot reach
another project's files via the normal helpers. The card runtime
also tracks the timers and event listeners each card opens and
tears them down on close, so a leaky card can't quietly peg the
browser after you've moved on.

## Documentation

| Doc | For |
|---|---|
| [SETUP.md](SETUP.md) | Full setup reference — topologies, remote access, customization, troubleshooting |
| [FEATURES.md](FEATURES.md) | What you can do with Mica once it's running |
| [SPEC.md](SPEC.md) | The design contract — how card classes, agents, and the canvas fit together |
| [ARCHITECTURE.md](ARCHITECTURE.md) | The implementation reference — server files, channel handlers, full `mica.*` API |
| [CLAUDE.md](CLAUDE.md) | Development guide for Claude Code (and anyone) working on the Mica codebase |

For card-class authoring, the canonical reference is the
`card-class-handbook` skill that ships with each project template
under `templates/<name>/.qwen/skills/card-class-handbook/SKILL.md`.

## License

Apache License 2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).
