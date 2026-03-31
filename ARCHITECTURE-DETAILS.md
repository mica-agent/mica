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

`ch.close()` = **detach** (soft). No-op for persistent channels — callbacks stay active, handle stays in registry, no message to server. This is safe because the channel persists across re-renders. The next `openChannel()` with the same key returns the existing channel with its live callbacks.

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

### ChannelHandler Interface

What card classes implement. Called by the ChannelManager on lifecycle events.

```typescript
interface ChannelHandler {
  /** Client attached — new tab, re-render reconnect, WS reconnect. */
  onAttach?(clientId: string, args: Record<string, unknown>): void;

  /** Client detached — tab closed, re-render, WS disconnect. */
  onDetach?(clientId: string): void;

  /** Data received from a client. */
  onData?(clientId: string, data: unknown): void;

  /** Session destroyed — card file deleted, server shutdown. Clean up everything. */
  onDestroy?(): void;
}
```

### SessionContext Interface

What the ChannelManager provides to handlers. This is how handlers communicate with clients without knowing about transport.

```typescript
interface SessionContext {
  /** Send data to all attached clients. */
  broadcast(data: unknown): void;

  /** Send data to a specific client. */
  sendTo(clientId: string, data: unknown): void;

  /** Number of currently attached clients. */
  clientCount(): number;

  /** Read the card file's content. */
  readContent(): Promise<string>;

  /** Read any file on the canvas. */
  readFile(filename: string): Promise<string>;

  /** Write a file on the canvas. */
  writeFile(filename: string, content: string): Promise<void>;

  /** Signal that the handler is pausing (zero clients, optional idle behavior). */
  idle(): void;

  /** Resume from idle. */
  resume(): void;

  /** Destroy this session programmatically (unrecoverable error, handler finished). */
  destroy(): void;
}
```

### Handler Examples

Each card type implements its backend semantics through the handler interface. The infrastructure doesn't know what "chat" or "terminal" means.

**Chat handler** (claude-chat, llama-chat):
```
onAttach:   replay conversation history to new client
onData:     receive message → call agent → broadcast response to all clients
onDetach:   nothing (session stays warm, history preserved)
onDestroy:  clean up agent session/SDK state
```

**Terminal handler** (.terminal):
```
onAttach:   if no PTY running, spawn one. Forward PTY output to client.
onData:     forward keyboard input to PTY. Handle resize events.
onDetach:   if zero clients, start 30s idle timer → kill PTY
onDestroy:  kill PTY immediately
```

**Agent handler** (.agent):
```
onAttach:   replay current task status and plan
onData:     handle "start task" or "respond to blocker" commands
onDetach:   nothing (task continues running)
onDestroy:  abort running task
```

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
| #6 Card class = extension point | New handler = new `render.js` with channel export, no framework changes |
| #7 Transport-agnostic | ChannelManager never imports WebSocket |
