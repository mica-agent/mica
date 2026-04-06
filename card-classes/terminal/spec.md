# Card Class: terminal

Full terminal emulator with PTY backend, using xterm.js in the browser and node-pty on the server.

## Rendering
Dark-themed terminal with macOS-style traffic light dots in the header, and a full xterm.js terminal below. Includes a reconnect banner overlay for session recovery.

## Interactions
- Full interactive terminal: keyboard input, resize, scrollback (1000 lines client-side).
- Opens a WebSocket channel (`pty_session`) with initial cols/rows.
- Heartbeat every 10s with 5s timeout for connection health monitoring.
- Reconnect button appears on disconnect or PTY exit, with progressive backoff retries.
- Auto-fits terminal to container via ResizeObserver + FitAddon.
- Cursor: blinking bar style. Font: Cascadia Code / Fira Code / JetBrains Mono.

## Server Side
- `onConnect`: Spawns a PTY process (default: `$SHELL --login` or `/usr/bin/bash`). Supports `spawnOverride` for custom shell/args/cwd.
- `onMessage`: Forwards keyboard input to PTY, handles resize, heartbeat pings, and scrollback replay on re-attach.
- `onDestroy`: Kills the PTY process.
- Maintains server-side scrollback buffer (4000 chars) for session replay.

## Data Format
Primary file: `transcript.log` (not actively used for rendering; PTY state is ephemeral).

## Dependencies
- `node-pty` (npm, server-side)
- xterm.js 5.3.0 (CDN): `https://cdn.jsdelivr.net/npm/xterm@5.3.0/lib/xterm.min.js`
- xterm-addon-fit 0.8.0 (CDN): `https://cdn.jsdelivr.net/npm/xterm-addon-fit@0.8.0/lib/xterm-addon-fit.min.js`
- xterm CSS is inlined in the render output.
