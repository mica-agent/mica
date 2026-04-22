# Mica

**A canvas where humans and agents compose context together. The
context they compose is either the means to an end, or the end
itself.**

Today, when you work with an AI agent, the agent is where the
context lives. You can see what the agent says but you cannot
see what the agent knows. When the next session starts, all of
that is gone.

Mica puts the context on the canvas. Humans and agents compose
it together, iteratively, on the same surface. Any agent that
shows up later can read what is there. The context is no longer
private to one agent or to one session.

## What "means or end" looks like

The same canvas, the same cards, without a mode switch between
them.

- **Means to an end.** You compose a canvas of briefs,
  decisions, and diagrams. You point your coding agent (Claude
  Code, Cline, Cursor) at the project, and it executes against
  what is on the canvas. The canvas is the briefing. Mica holds
  the thinking. Your coding agent does the coding.
- **End in itself.** The canvas itself is the product. A
  financial planner, a research workspace, or a campaign
  dashboard built card by card, with agents writing the card
  classes that did not exist before. Nothing downstream consumes
  the canvas. The canvas is the thing.

Most projects drift between the two. A planning canvas grows
into a live dashboard. An end-in-itself canvas spawns a brief
for another agent. The primitive does not care which use you
are making of it.

## How it is built

Mica takes the Emacs posture, not the Notion one. Small
orthogonal mechanisms compose into whatever workflow you need.
The environment is modifiable from inside the environment. New
card classes are user-writable files, promoted from project
scope to built-in by copying a directory. There is no closed
set of block types and no registry between you and writing a
new card class.

Three convictions shape every design decision.

- **Designed for AI authorship.** The architecture is shaped so
  that an LLM can generate new card classes, briefs, diagrams,
  and project content from a natural-language request. Card
  classes are `card.html + card.js + card.css + metadata.json`
  because LLMs produce that cleanly in one pass. The `mica.*`
  API stays small because large surfaces confuse generators.
  Plain files over databases, because agents introspect by
  listing and reading files. A design that is nicer for humans
  but harder for agents to generate is wrong for Mica.
- **Transparency.** Nothing is hidden. Any card can be flipped
  to show the class that defines it. The `.mica/` directory
  can be opened and read to see the layout, the chat history,
  and the AI context files. No opaque memory, no hidden
  prompts.
- **Low friction.** Mica adapts to the user, not the other way
  around. Point Mica at a directory. Keep whatever file
  structure you already have. Delete `.mica/` and you are back
  to plain files. Trying Mica costs almost nothing, and
  leaving costs nothing.

## Quick start

```bash
npm install
npm run dev:all
```

Frontend runs on port 5173, backend on port 3002.

`scripts/start.sh`, `scripts/stop.sh`, `scripts/restart.sh`, and
`scripts/status.sh` manage the two processes together.

## Cohabiting with your coding agent

Mica sits alongside coding agents, not in place of them.
Claude Code, Cline, and Cursor keep doing what they do. Mica is
where the thinking that shapes their work lives: the briefs,
decisions, specs, diagrams, research, constraints. Point your
coding agent at the project and it sees the canvas in the
`.mica/` directory and in the project files themselves.

## Documentation

- [SPEC.md](SPEC.md) — what Mica is: the card model, the
  canvas, the `mica.*` overview, the design principles.
- [ARCHITECTURE.md](ARCHITECTURE.md) — how it is built:
  server, host, CARD_SHIM, ChannelManager, reactivity,
  authoritative `mica.*` API reference.
- [ARCHITECTURE-DETAILS.md](ARCHITECTURE-DETAILS.md) —
  ChannelManager state machines, channel handler contract.
- [DESIGN-DECISIONS.md](DESIGN-DECISIONS.md) — working
  decisions that shaped Mica-Lite and what they displaced.
- [TESTING.md](TESTING.md) — manual verification pass.
- [CLAUDE.md](CLAUDE.md) — development guide for Claude Code
  and other agents working on the Mica codebase itself.

For card-class authoring, the canonical reference is the
`create-card-class` skill that ships with each project template:

- `templates/cloud-claude/.claude/skills/create-card-class/SKILL.md`
  for Claude Code projects.
- `templates/cloud-claude/.qwen/skills/create-card-class/SKILL.md`
  for the Qwen variant of the same template.
- `templates/dgx-spark-local/.qwen/skills/create-card-class/SKILL.md`
  for local-model projects.

Sibling skills in the same directories cover related authoring
tasks (`grow-canvas`, `decompose-task`, `doc-consistency`, and
others).
