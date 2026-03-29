# Agent Card Class — Design

The `.agent` card class provides a spawnable subagent card that connects to
external coding agents (Claude Code, OpenClaw, Cline, etc.). It is distinct
from the sidebar chat agent (`_chat.chat`), which is a singleton project-level
assistant.

## Principles

1. **Everything is a file** — the `.agent` file stores JSON state (phase, plan,
   status, blocker). Any screen rendering the card sees the same state.
2. **High-level progress** — shows phases and plan steps (3-6 items), not
   individual file modifications.
3. **Blocking for human input** — when the agent needs user assistance, the card
   shows a prominent blocker with an input field. The channel blocks until the
   human responds.
4. **Provider-agnostic UI** — the card class renders a common progress UI
   regardless of which agent backend is running. Provider-specific logic is
   isolated in spawner modules.

## File Content Format

```json
{
  "provider": "claude-code",
  "status": "idle",
  "phase": "Ready",
  "plan": [
    {"step": "Create database schema", "status": "done"},
    {"step": "Build API endpoints", "status": "active"},
    {"step": "Add tests", "status": "pending"}
  ],
  "current_action": "Writing users table migration...",
  "blocker": null,
  "last_updated": "14:32:07"
}
```

Status values: `setup`, `idle`, `in_progress`, `blocked`, `done`, `error`

## Architecture

```
Browser                    Server (Node)              External Agent
  |                           |                           |
  | openChannel('run_session')| AgentChannelManager       |
  |-------------------------->| resolves provider         |
  |                           | spawns agent process ---->|
  |   { type: 'plan', ... }   |<--- progress events ------|
  |<--------------------------|                           |
  |   { type: 'blocked' }     |<--- needs input ---------|
  |<--------------------------|                           |
  |   { response: '...' }     |                           |
  |-------------------------->|--- human response ------->|
  |   { type: 'done' }        |<--- completion -----------|
  |<--------------------------|                           |
```

### Three Layers Per Provider

| Layer | Location | Purpose |
|-------|----------|---------|
| Setup | `card-classes/agent/setup/{provider}.py` | Provider-specific onboarding UI (e.g. configure CLAUDE.md) |
| Spawner | `server/agentProviders/{provider}.ts` | Node module: launches agent, translates output to standard protocol |
| UI | `card-classes/agent/render.py` | Common progress card, provider picker, setup delegation |

### Provider Registry

`card-classes/agent/providers.json` lists available providers:

```json
{
  "claude-code": {
    "name": "Claude Code",
    "description": "Anthropic's AI coding agent",
    "setup_steps": ["claude_md"]
  }
}
```

### Standard Channel Protocol

All spawners translate agent-specific events into these messages:

| Message Type | Fields | Direction |
|-------------|--------|-----------|
| `status` | `value: idle\|in_progress\|blocked\|done\|error` | Server -> Browser |
| `phase` | `text: string` | Server -> Browser |
| `plan` | `steps: [{step, status}]` | Server -> Browser |
| `step_update` | `index: number, status: string` | Server -> Browser |
| `action` | `text: string` | Server -> Browser |
| `blocked` | `question: string` | Server -> Browser |
| `unblocked` | | Server -> Browser |
| `done` | | Server -> Browser |
| `error` | `message: string` | Server -> Browser |
| (user input) | `response: string` | Browser -> Server |
| (start task) | `task: string` | Browser -> Server (initial) |

### Docker Integration

Claude Code subagents run inside Docker containers with:
- Project files mounted at `/workspace`
- Session state persisted across runs
- Network access for package installs
- The existing `createDockerSpawner()` infrastructure is reused

### Card Lifecycle

1. **Create** — `+ Agent` button creates `agent-{id}.agent` with `{"provider": null, "status": "setup"}`
2. **Pick provider** — Card renders provider list, user picks one
3. **Setup** — Provider-specific setup (e.g. Claude Code: configure CLAUDE.md)
4. **Ready** — Card shows task input + Run button
5. **Running** — Channel streams progress, plan steps update in real-time
6. **Blocked** — Agent needs input, card shows blocker UI, channel.receive() blocks
7. **Done** — Results shown, card returns to ready state for next task
