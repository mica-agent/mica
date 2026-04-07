# Card Class: pi-chat

Interactive chat interface powered by the Pi coding agent framework with a local LLM (llama-server).

## Rendering
Dark-themed chat UI with a colored header ("Pi Chat"), scrollable message area, collapsible status bar with progress log, and a text input with Send button. Messages use bubble-style layout (user right-aligned, assistant left-aligned). Basic markdown rendering (bold, inline code, line breaks).

## Interactions
- Type a message and press Enter or click Send to chat with the Pi agent.
- Status bar shows thinking state with elapsed time, step count, and tool use descriptions. Click to expand/collapse the progress log.
- Opens a WebSocket channel (`chat_session`) for bidirectional streaming.
- Reactive: subscribes to `file-changed` events on sibling cards. When canvas files change (especially `todo.todo`), it automatically prompts the agent to check for tasks assigned to `@agent`.

## Server Side
- `onConnect`: loads conversation history, subscribes to file-changed events for reactive behavior.
- `onMessage`: queues messages if busy, otherwise sends to Pi agent session with built-in coding tools (read, write, edit, bash). Multi-turn agentic loop.
- Builds a system prompt with project context: agent brief (with `@file` expansion), goal/todo/brief cards, and canvas card listing.
- Persists conversation to `conversation.json` (max 100 messages).
- LLM backend: local llama-server (OpenAI-compatible API at port 8012).

## Data Format
Primary file: `conversation.json` -- JSON array of `{ role, content, agent }` message objects.

## Dependencies
- `@mariozechner/pi-coding-agent` (server-side, npm)
