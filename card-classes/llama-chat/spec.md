# Card Class: llama-chat

Interactive chat interface connected to a local LLM via llama-server's OpenAI-compatible API.

## Rendering
Dark-themed chat UI with a green-accented header ("Llama Chat"), scrollable message area, collapsible status bar with progress log, and a text input with Send button. Visually similar to claude-chat but with green color scheme and llama icon.

## Interactions
- Type a message and press Enter or click Send to chat with the local LLM.
- Status bar shows thinking state, elapsed time, step count, and tool use progress.
- Opens a WebSocket channel (`chat_session`) with `provider: "local"`.
- Reactive: subscribes to `file-changed` events on sibling cards, auto-prompts the LLM when canvas files change (especially `todo.todo` for `@agent` tasks).

## Server Side
- `onConnect`: loads history, subscribes to file-changed events.
- `onMessage`: sends to llama-server at `/v1/chat/completions` with OpenAI-compatible function calling.
- Tools: `list_files`, `read_file`, `write_file`, `create_card`, `exec` (shell commands). Max 5 tool turns per query.
- Builds system prompt with project context (brief with `@file` expansion, goal/todo/brief cards, canvas listing).
- Auto-detects Docker container networking to resolve host IP for llama-server (default port 8012, configurable via `LLAMA_URL` env var).
- Persists conversation to `conversation.json` (max 100 messages).

## Data Format
Primary file: `conversation.json` -- JSON array of `{ role, content, agent, filesChanged }` message objects.

## Dependencies
- `llama-server` running on host at port 8012 (or `LLAMA_URL` env var)
