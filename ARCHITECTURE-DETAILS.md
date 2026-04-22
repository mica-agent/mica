# Mica Architecture Details

Deep dives on subsystem design. See [ARCHITECTURE.md](ARCHITECTURE.md) for the overview and design tenets.

---

## Unified Channel Manager

### Problem

Cards need persistent, bidirectional communication with server-side backends — chat agents, terminal PTYs, task runners, custom handlers. The original design used three separate managers (ChatChannelManager, TerminalChannelManager, AgentChannelManager) routed by file extension in a growing if/else chain. This violated tenets #2 (infrastructure provides pipes, not policy) and #5 (one mechanism, not per-type special cases).

Additionally, channels broke on card re-renders because the browser closed and reopened connections during React lifecycle events. The root cause was conflating transport state (connection count) with user intent (session lifecycle) — violating tenet #4.

### Three Layers

```
┌────────────────────────────────────────────────────────────────┐
│ TRANSPORT (index.ts)                                           │
│                                                                │
│ WebSocket adapter. Translates wire messages into               │
│ ChannelManager method calls. Tracks which transport            │
│ connection owns which client handle. Knows nothing about       │
│ sessions, handlers, or card types.                             │
│                                                                │
│ Could be replaced with SSE, HTTP long-poll, or any other       │
│ bidirectional transport without changing the layers below.      │
└────────────────────────────┬───────────────────────────────────┘
                             │
              open(clientId, key, callbacks)
              sendData(clientId, data)
              detach(clientId)
              destroySession(key)
                             │
┌────────────────────────────▼───────────────────────────────────┐
│ CHANNEL MANAGER (channelManager.ts)                            │
│                                                                │
│ Manages sessions keyed by card file identity.                  │
│ Attaches/detaches clients (opaque callback handles).           │
│ Starts/stops card handlers on lifecycle transitions.           │
│ Transport-agnostic — never imports WebSocket.                  │
└────────────────────────────┬───────────────────────────────────┘
                             │
              ChannelHandler interface
              (onAttach, onDetach, onData, onDestroy)
                             │
┌────────────────────────────▼───────────────────────────────────┐
│ CARD HANDLERS (per card type)                                  │
│                                                                │
│ Registered by card class name. Implement ChannelHandler.       │
│ Decide their own backend semantics: when to start processes,   │
│ what to do with zero clients, how to handle errors.            │
│                                                                │
│ Infrastructure doesn't know what a "chat" or "terminal" is.    │
│ That knowledge lives here.                                     │
└────────────────────────────────────────────────────────────────┘
```

### Session State Machine

A session is bound to a card file on disk. It starts when the file is created and ends when the file is deleted. These are explicit user events. Everything else — browser connections, backend processes, failures — happens within the session lifetime.

```
                    card file created on disk
                    (user clicks + Claude Chat, + Terminal, etc.)
                                   │
                                   ▼
                    ┌──────────────────────────────┐
                    │         REGISTERED            │
                    │                              │
                    │  Session exists in manager   │
                    │  handler: null               │
                    │  clients: 0                  │
                    └──────────┬───────────────────┘
                               │
                      first client attaches
                               │
                               ▼
                    ┌──────────────────────────────┐
              ┌────▶│          ACTIVE               │◀────┐
              │     │                              │     │
              │     │  handler: started            │     │
              │     │  clients: 1+                 │     │
              │     └──┬────────────┬──────────────┘     │
              │        │            │                     │
              │   last client   handler calls             │
              │   detaches      ctx.idle()                │
              │        │            │                     │
              │        ▼            ▼                     │
              │     ┌──────────────────────────────┐     │
              │     │           IDLE                │     │
              │     │                              │     │
              │     │  clients: 0                  │     │
              │     │  state: preserved            │     │
              │     │  handler decides behavior:   │     │
              │     │  • stay warm (chat)          │     │
              │     │  • timeout → stop (terminal) │     │
              │     └──┬───────────────────────────┘     │
              │        │                                  │
              │   client reattaches ──────────────────────┘
              │
              │
              ── ANY STATE ──
                    │
           card file deleted / server shutdown / ctx.destroy()
                    │
                    ▼
              ┌──────────────────────────────┐
              │         DESTROYED             │
              │                              │
              │  handler.onDestroy() called  │
              │  all clients notified        │
              │  session removed             │
              └──────────────────────────────┘
```

Key: the transition from ACTIVE to IDLE is **not** a teardown signal. It's informational — the handler decides what to do. A chat handler stays warm. A terminal handler starts an idle timer. An agent handler ignores it (task keeps running). The session is only destroyed by explicit events: card deletion, server shutdown, or the handler itself calling `ctx.destroy()`.

### Client (Browser) State Machine

Clients are browser-side handles that attach to sessions. They're identified by `(project, canvas, filename, fn)` — the card file and the function being called. This is the **channel key**.

```
        openChannel(project, canvas, filename, fn, args)
                    │
          key exists in registry?
           YES ── swap callbacks, return same handle (no WS message)
           NO  ── create new handle, send channel_open
                    │
                    ▼
              ┌──────────────┐       ┌──────────────┐
              │  ATTACHED    │◀─────▶│  DETACHED    │
              │              │       │              │
              │  send works  │       │  in registry │
              │  receiving   │       │  callbacks   │
              │  data        │       │  nulled      │
              └──────┬───────┘       └──────┬───────┘
                     │                      │
              ch.destroy()           openChannel() again
              (card deleted)         (script re-run, reconnect)
                     │
                     ▼
              ┌──────────────┐
              │  DESTROYED   │  removed from registry
              │              │  channel_close sent to server
              └──────────────┘
```

`ch.close()` = **detach** (soft, client-side only). Nulls callbacks, but handle stays in registry. No message sent to server. This is safe for React cleanup — the channel persists across re-renders. The next `openChannel()` with the same key returns the existing handle and swaps in fresh callbacks.

`ch.destroy()` = **hard close**. Removes from registry. Sends `channel_close`. Server tears down session if appropriate.

This distinction is why card scripts "just work" across re-renders:
```javascript
const ch = mica.openChannel('chat_session', { provider: 'claude' });
// First run: creates channel, sends channel_open
// Subsequent runs: returns existing channel, swaps callbacks
// No close/reopen cycle. No race conditions.

mica.onDestroy(() => ch.close());
// close() = detach. Channel stays alive in registry.
// Next script execution gets it back via openChannel().
```

### Channel handlers

Each card class that uses a channel registers a handler at server
startup (in `server/index.ts`). Handlers implement the
`ChannelHandler` interface directly. Card `card.js` code does not
contain server-side handler code — there is no `render.js` and no
module-export model. The browser side and the server side are
separate files, wired together by `mica.openChannel(fn, args)` on
the browser and `channelManager.registerHandler(name, factory)`
on the server.

Registration at startup looks like this:

```typescript
channelManager.registerHandler("chat",       createAgentHandler(fileWatcher));   // .chat  → Qwen agent
channelManager.registerHandler("claude",     createClaudeAgentHandler(fileWatcher)); // .claude → Claude Code agent
channelManager.registerHandler("terminal",   createPtyHandler());                 // .terminal → PTY
channelManager.registerHandler("llm-chat",   createLlmChatHandler());             // .llm-chat → direct LLM chat
channelManager.registerHandler("skills",     createSkillComposeHandler());        // .skills → collaborative SKILL.md authoring
channelManager.registerHandler("canvas-back", createCanvasBackComposeHandler());  // .canvas-back → propose-then-apply editor
```

The key (`chat`, `claude`, `terminal`, etc.) is the card class
name. When the browser calls `mica.openChannel(fn, args)` from a
card of that class, ChannelManager routes the session to the
registered handler.

### ChannelHandler interface

```typescript
interface ChannelHandler {
  onAttach?(clientId: string, args: Record<string, unknown>): void;
  onDetach?(clientId: string): void;
  onData?(clientId: string, data: unknown): void;
  onDestroy?(): void;
}
```

Lifecycle semantics:

- `onAttach` fires when a client (browser tab) attaches to the
  session. For reconnects, ChannelManager delivers a synthetic
  `{ type: "attached" }` as the first `onData` call so handlers
  can replay state (scrollback, history, current status).
- `onDetach` fires when a client disconnects. Other clients on
  the same session are unaffected.
- `onData` fires on every browser-originated message. Handlers
  read the message and decide what to push back via the
  ctx-provided send/reply helpers.
- `onDestroy` fires once, when the session ends (card file
  deleted, or server shutdown).

### Handler examples

Where each live channel handler lives today and what it does:

**Claude agent** (`server/claudeAgent.ts`):
```
onAttach:    load chat history, replay to attaching client
onData:      { type: "user_message", text } → spawn Claude Code CLI subprocess,
             stream tool calls and responses back, auto-commit agent writes.
             Handles tool-use loop, write-source tracking, busy lock.
onDetach:    no-op — session continues
onDestroy:   cancel any in-flight turn, close streams
```

**Qwen agent** (`server/micaAgent.ts`):
```
onAttach:    load chat history, replay to attaching client
onData:      { type: "user_message", text } → tool loop against llama-server
             at 127.0.0.1:8012. XML-fallback tool-call parsing.
             Canvas-scope file-watcher integration (reactive turns on user idle).
onDetach:    no-op — session continues
onDestroy:   abort in-flight turn
```

**Terminal** (`server/plugins/pty.ts`):
```
onAttach:    spawn node-pty, replay scrollback to attaching client
onData:      { input } → forward to PTY stdin
             { resize, cols, rows } → resize PTY
             { ping } → respond with pong + ptyAlive status
onDetach:    if last client, PTY continues running (handler policy)
onDestroy:   kill PTY
```

**LLM chat** (`server/plugins/llmChat.ts`):
```
onData:      { message } → direct prompt to local LLM, no tools, stream response
```

**Skill compose** (`server/plugins/skillCompose.ts`):
```
onData:      collaborative SKILL.md editing loop — agent proposes, user reviews,
             resulting file written to .claude/skills/<name>/ or .qwen/skills/<name>/
```

The ChannelManager itself does not know what any of these
handlers do. It only knows sessions, clients, and lifecycle. The
handler decides backend semantics — when to start a process,
what "idle" means for this card type, how to handle errors.

### Transport Adapter Pattern

The WebSocket handler in `index.ts` is a thin translation layer:

```
WS message: channel_open    →  channelManager.open(clientId, ...)
WS message: channel_data    →  channelManager.sendData(clientId, data)
WS message: channel_close   →  channelManager.detach(clientId)
WS event: connection closed  →  for each client: channelManager.detach(clientId)
File event: file deleted     →  channelManager.destroySession(project, canvas, filename)
Server event: shutdown       →  channelManager.destroyAll()
```

The adapter tracks which WebSocket connection owns which client IDs (`Map<WebSocket, Set<string>>`). This is transport-level bookkeeping that doesn't belong in the ChannelManager.

### Why This Design

| Tenet | How it applies |
|-------|---------------|
| #2 Infrastructure provides pipes, not policy | ChannelManager doesn't know chat/terminal/agent semantics |
| #4 Lifecycle bound to user intent | Session created on card file create, destroyed on card file delete |
| #5 One mechanism | Single ChannelManager replaces three separate managers |
| #6 Card class = extension point | New handler = a new file implementing ChannelHandler, registered in `server/index.ts`. Frontend side: a new card class opening `mica.openChannel()` in its `card.js`. No framework changes |
| #7 Transport-agnostic | ChannelManager never imports WebSocket |
