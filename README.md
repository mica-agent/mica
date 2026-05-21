# Mica

**An agent-first builder.** Mica is a workspace where you work
with one or more AI agents — to write code, plan a project, build a
dashboard, research a problem — and everything the agent does (and
everything you've told it) lives as readable, editable files you
both see.

The interaction is the product. Mica is the substrate that makes it
good: a canvas of cards that holds the briefs, decisions,
conversations, diagrams, and code that accumulate as you work.
Cards are plain files. The canvas is a view. Nothing is hidden
inside agent memory.

## What "working with an agent" looks like here

Two postures, same primitives, no mode switch.

- **The agent does the work, you shape what it knows.** You compose
  a canvas of briefs, decisions, and diagrams. Your coding agent
  (the `.qwen`, `.claude`, or `.opencode` card you place on the
  canvas) reads it, edits files, takes screenshots, comes back with
  results. The canvas is the briefing.
- **You and the agent build something together, card by card.** A
  financial planner, a research workspace, a campaign dashboard, an
  HP-12C calculator, a world clock — built from a conversation that
  ships card classes the agent writes as it goes. The canvas is the
  product.

Most projects drift between the two over time.

Why this matters: today the agent's context lives in its conversation
buffer and memory file. You can see what it says; you can't see what
it knows. Next session, it's gone. Mica puts the context on the
canvas instead. Any agent that shows up later reads the same files.
The work survives the thread.

## Run it

The full guide is in [QUICKSTART.md](QUICKSTART.md). Shortest paths:

- **Recommended (vLLM, 2 containers)** — Qwen3.6 NVFP4 in a sibling
  vLLM container, voice + chat share the model with continuous
  batching.
  ```
  git clone https://github.com/<org>/mica.git && cd mica
  ./scripts/mica-compose.sh up
  ```
  First run takes 5–15 minutes — vLLM downloads ~30 GB of weights
  and then takes ~30–90 s to load the model. The terminal will sit
  during both stages; `docker compose logs -f mica-vllm` shows
  progress. Subsequent starts are seconds.
- **Smaller (llama, 1 container)** — llama-server inside the mica
  container, Q4 GGUF. Slower but simpler.
  ```
  ./scripts/mica-compose.sh up --llama
  ```
- **Developing Mica itself** — open the repo in VS Code with the
  Dev Containers extension, then `bash scripts/start.sh` from the
  devcontainer terminal.

Prereqs: Docker + [NVIDIA Container
Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html).
Open http://localhost:5173 once it's up.

## Trust model

Mica is a **single-user tool**. There is no API authentication.
Anyone who can reach the Mica port has full read/write to your
workspace — projects, chat history, stored credentials. Expected
deployment: localhost, a VS Code SSH tunnel, or a Tailscale
tailnet. **Do not bind a public IP without a firewall.**

Card classes installed in a project are trusted code: they run
inline, can spawn subprocesses, and can read process environment
variables. Treat installing a card class the way you'd treat
installing a small Node script. Don't share Mica access with
anyone you wouldn't hand your project directory to.

## Documentation

| Doc | For |
|---|---|
| [QUICKSTART.md](QUICKSTART.md) | Installing + running Mica on a GPU host |
| [FEATURES.md](FEATURES.md) | What you can do with Mica once it's running |
| [SPEC.md](SPEC.md) | The design contract — how card classes, agents, and the canvas fit together |
| [ARCHITECTURE.md](ARCHITECTURE.md) | The implementation reference — server files, channel handlers, full `mica.*` API |
| [CLAUDE.md](CLAUDE.md) | Development guide for Claude Code (and anyone) working on the Mica codebase |

For card-class authoring, the canonical reference is the
`card-class-handbook` skill that ships with each project template
under `templates/<name>/.qwen/skills/card-class-handbook/SKILL.md`.
