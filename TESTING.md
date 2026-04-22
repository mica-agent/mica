# TESTING

Mica-Lite has no automated end-to-end test suite today. Verification
is manual and happens in two passes: type-check for compilation,
then a runtime walkthrough in two browser windows.

## Type check

```bash
npx tsc --noEmit
```

Necessary but not sufficient. A clean type-check proves the code
compiles. It does not prove that a WebSocket channel survives a
React re-render or that a card's self-echo filter skips its own
writes. Do not ship on compile alone.

## Runtime walkthrough

Start both servers:

```bash
bash scripts/start.sh
```

Frontend on port 5173, backend on port 3002. The script kills
stale processes first and waits for both ports to be healthy.
`scripts/stop.sh` tears them down. `scripts/status.sh` shows the
running state. `scripts/restart.sh` does stop then start.

Open the app in two browser windows on the same project. Then
walk through:

1. **File watcher and cross-window sync.**
   Create a file from window A (e.g. add a card via the
   toolbar). Window B should see the new card without a reload.
   The `file-created` event carries `source = windowId-of-A`,
   so window A does not re-render its own creation as a remote
   change.
2. **Layout sync.**
   Drag or resize a card in window A. Window B should receive
   the `layout-changed` event and reposition. Window A's own
   `layout-changed` should be filtered out by source
   attribution.
3. **Self-echo filter.**
   Open the same card instance in both windows. Edit in
   window A so the card writes its file. Window B receives
   `file-changed` and updates. Window A receives its own echo
   but `mica.isSelfEcho(event)` filters it, so window A does
   not rebuild unnecessarily.
4. **Agent channels.**
   Create a `.chat` card. Verify the card opens a channel,
   the llama-server is started if not already running, and a
   message round-trips. Then create a `.claude` card and
   verify the same round-trip with the Claude Code subprocess
   handler.
5. **Terminal channel survives re-render.**
   Create a `.terminal` card. Type something in the PTY.
   Trigger a re-render of the card (edit the instance file,
   or force a parent re-render). The PTY session must remain
   alive; typing should continue in the same shell without a
   new prompt. This validates the ChannelManager's detach-vs-
   destroy distinction.
6. **Reactivity.**
   In a project that has a `.chat` or `.claude` card, edit a
   file inside the agent's canvas scope. After ~15 seconds of
   no further edits, the agent should receive a synthetic
   "user edited these files" turn. Continuous typing must not
   trigger — the idle gate re-arms on each new event.
   Agent-written files must not trigger (write-source
   tracking).

## When not to rely on compilation

Quoting CLAUDE.md: "Runtime tests are the bar. Compile is
necessary, not sufficient. Type checks prove code compiles;
they do not prove a channel survives a re-render."

Anything touching the following areas must be walked through
at runtime:

- ChannelManager sessions
- File watcher broadcasts and source attribution
- CARD_SHIM wrapping (timer cleanup, scoped DOM, scoped fetch)
- Agent tool loops and write tracking
- Cross-window coordination

## What is NOT covered

There is currently no automated coverage for:

- UI interaction (no Playwright / Cypress suite yet).
- Agent behavior under model-specific failures.
- Long-running PTY stability.
- Inotify scale beyond a typical-sized canvas scope.

Adding automation is a separate piece of work.
