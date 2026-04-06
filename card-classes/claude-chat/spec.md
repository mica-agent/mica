# Card Class: claude-chat

Interactive chat interface connected to Claude via the Claude Agent SDK.

## Rendering
Dark-themed chat UI with a colored header ("Claude Chat"), scrollable message area, collapsible status bar with progress log, and a text input with Send button. Messages use bubble-style layout (user right-aligned, assistant left-aligned). Basic markdown rendering (bold, inline code, line breaks).

## Interactions
- Type a message and press Enter or click Send to chat with Claude.
- Status bar shows thinking state with elapsed time, step count, and tool use descriptions. Click to expand/collapse the progress log.
- Opens a WebSocket channel (`chat_session`) for bidirectional streaming.
- Reactive: subscribes to `file-changed` events on sibling cards. When canvas files change (especially `todo.todo`), it automatically prompts Claude to check for tasks assigned to `@agent`.

## Server Side
- `onConnect`: loads conversation history, subscribes to file-changed events for reactive behavior.
- `onMessage`: queues messages if busy, otherwise sends to Claude Agent SDK with tools (Bash, Read, Write, Edit, Glob, Grep). Max 10 turns per query.
- Builds a system prompt with project context: agent brief (with `@file` expansion), goal/todo/brief cards, and canvas card listing.
- Persists conversation to `conversation.json` (max 100 messages).
- Model: `claude-sonnet-4-6`, with session resumption support.

## Data Format
Primary file: `conversation.json` -- JSON array of `{ role, content, agent }` message objects.

## Dependencies
- `@anthropic-ai/claude-agent-sdk` (server-side, npm)
