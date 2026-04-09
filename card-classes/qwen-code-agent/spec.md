# Card Class: qwen-code-agent

Interactive coding agent powered by the [qwen-code CLI](https://github.com/QwenLM/qwen-code), connected to the local llama-server (port 8012).

## Rendering
Dark-themed chat UI with a purple accent. Shows a live streaming output panel while qwen is running, then collapses it to display the final response in the message area. Code blocks are syntax-highlighted with a monospace font. A "■ Stop" button appears while the agent is working.

## Interactions
- Type a message and press Enter or click Send to invoke Qwen Code.
- Supports multi-line input (Shift+Enter for newlines).
- A live output pane streams qwen's tool use and progress in real time.
- Click "■ Stop" to interrupt the current run.
- Reactive: subscribes to `file-changed` events on sibling cards. When `todo.todo` changes, it auto-checks for `@agent` tasks.

## Server Side
- `onConnect`: loads conversation history, subscribes to file-changed events.
- `onMessage`: queues messages if busy; spawns the `qwen` CLI as a subprocess with:
  - `--approval-mode yolo` (auto-approve all tool actions)
  - `--auth-type openai` with `OPENAI_API_KEY=dummy`
  - `--openai-base-url http://{host}:8012/v1` (llama-server endpoint)
  - `--model local`
  - `--session-id {stable-card-id}` + `--chat-recording` for session continuity
- Streams stdout/stderr (ANSI-stripped) back to the browser via WebSocket.
- Persists conversation summaries to `conversation.json`.

## Data Format
Primary file: `conversation.json` — JSON array of `{ role, content, agent }` message objects.

## Dependencies
- `qwen` CLI (`@qwen-code/qwen-code` npm package, installed globally at `/home/sandbox/.npm-global/bin/qwen`)
- llama-server running on host port 8012 (OpenAI-compatible API)
