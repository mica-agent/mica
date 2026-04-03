/**
 * Terminal card class — xterm.js terminal with PTY.
 * PTY is managed by Node (server/terminalChannel.ts), not by this card class.
 * The channel is routed Node-side by checking .terminal extension.
 */

const XTERM_CSS = ".xterm{cursor:text;position:relative;user-select:none;-ms-user-select:none;-webkit-user-select:none}.xterm.focus,.xterm:focus{outline:0}.xterm .xterm-helpers{position:absolute;top:0;z-index:5}.xterm .xterm-helper-textarea{padding:0;border:0;margin:0;position:absolute;opacity:0;left:-9999em;top:0;width:0;height:0;z-index:-5;white-space:nowrap;overflow:hidden;resize:none}.xterm .composition-view{background:#000;color:#fff;display:none;position:absolute;white-space:nowrap;z-index:1}.xterm .composition-view.active{display:block}.xterm .xterm-viewport{background-color:#000;overflow-y:scroll;cursor:default;position:absolute;right:0;left:0;top:0;bottom:0}.xterm .xterm-screen{position:relative}.xterm .xterm-screen canvas{position:absolute;left:0;top:0}.xterm .xterm-scroll-area{visibility:hidden}.xterm-char-measure-element{display:inline-block;visibility:hidden;position:absolute;top:0;left:-9999em;line-height:normal}.xterm.enable-mouse-events{cursor:default}.xterm .xterm-cursor-pointer,.xterm.xterm-cursor-pointer{cursor:pointer}.xterm.column-select.focus{cursor:crosshair}.xterm .xterm-accessibility,.xterm .xterm-message{position:absolute;left:0;top:0;bottom:0;right:0;z-index:10;color:transparent;pointer-events:none}.xterm .live-region{position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden}.xterm-dim{opacity:1!important}.xterm-underline-1{text-decoration:underline}.xterm-underline-2{text-decoration:double underline}.xterm-underline-3{text-decoration:wavy underline}.xterm-underline-4{text-decoration:dotted underline}.xterm-underline-5{text-decoration:dashed underline}.xterm-overline{text-decoration:overline}.xterm-overline.xterm-underline-1{text-decoration:overline underline}.xterm-overline.xterm-underline-2{text-decoration:overline double underline}.xterm-overline.xterm-underline-3{text-decoration:overline wavy underline}.xterm-overline.xterm-underline-4{text-decoration:overline dotted underline}.xterm-overline.xterm-underline-5{text-decoration:overline dashed underline}.xterm-strikethrough{text-decoration:line-through}.xterm-screen .xterm-decoration-container .xterm-decoration{z-index:6;position:absolute}.xterm-screen .xterm-decoration-container .xterm-decoration.xterm-decoration-top-layer{z-index:7}.xterm-decoration-overview-ruler{z-index:8;position:absolute;top:0;right:0;pointer-events:none}.xterm-decoration-top{z-index:2;position:relative}";

export default function render(content, config) {
  return `
<div style="display:flex;flex-direction:column;height:100%;min-height:260px;background:#0d1117;border-radius:6px;overflow:hidden;font-family:monospace;">
  <div style="display:flex;align-items:center;gap:6px;padding:8px 12px;background:#161b22;border-bottom:1px solid #30363d;flex-shrink:0;">
    <span style="width:12px;height:12px;border-radius:50%;background:#ff5f57;display:inline-block;"></span>
    <span style="width:12px;height:12px;border-radius:50%;background:#febc2e;display:inline-block;"></span>
    <span style="width:12px;height:12px;border-radius:50%;background:#28c840;display:inline-block;"></span>
    <span style="color:#8b949e;font-size:12px;margin-left:8px;">bash</span>
  </div>
  <div id="term" style="flex:1;min-height:0;padding:4px;position:relative;">
    <div id="reconnect-banner" style="
      display:none;position:absolute;inset:0;z-index:10;
      background:rgba(13,17,23,0.92);
      display:none;flex-direction:column;align-items:center;justify-content:center;gap:12px;
    ">
      <div style="color:#f87171;font-size:13px;font-weight:600;">Session disconnected</div>
      <button id="reconnect-btn" style="
        background:#238636;color:#fff;border:none;border-radius:6px;
        padding:6px 16px;font-size:12px;cursor:pointer;font-family:inherit;
      ">Reconnect</button>
    </div>
  </div>
</div>

<style>${XTERM_CSS}</style>

<script src="https://cdn.jsdelivr.net/npm/xterm@5.3.0/lib/xterm.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/xterm-addon-fit@0.8.0/lib/xterm-addon-fit.min.js"></script>

<script>
  const term = new Terminal({
    theme: {
      background: '#0d1117', foreground: '#e6edf3', cursor: '#58a6ff',
      selectionBackground: '#264f78',
      black: '#0d1117', red: '#ff7b72', green: '#3fb950', yellow: '#d29922',
      blue: '#58a6ff', magenta: '#bc8cff', cyan: '#39c5cf', white: '#b1bac4',
      brightBlack: '#6e7681', brightRed: '#ffa198', brightGreen: '#56d364',
      brightYellow: '#e3b341', brightBlue: '#79c0ff', brightMagenta: '#d2a8ff',
      brightCyan: '#56d4dd', brightWhite: '#f0f6fc',
    },
    fontFamily: '"Cascadia Code", "Fira Code", "JetBrains Mono", monospace',
    fontSize: 13, lineHeight: 1.4, cursorBlink: true, cursorStyle: 'bar',
    scrollback: 1000, convertEol: false,
  });

  const fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);

  const termEl = container.querySelector('#term');
  term.open(termEl);
  fitAddon.fit();

  const banner = container.querySelector('#reconnect-banner');
  const reconnectBtn = container.querySelector('#reconnect-btn');
  let ch = null;
  let heartbeatInterval = null;
  let heartbeatTimeout = null;
  let connected = false;
  let reconnecting = false;

  function showBanner() {
    banner.style.display = 'flex';
    connected = false;
  }

  function hideBanner() {
    banner.style.display = 'none';
  }

  function stopHeartbeat() {
    if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; }
    if (heartbeatTimeout) { clearTimeout(heartbeatTimeout); heartbeatTimeout = null; }
  }

  function startHeartbeat() {
    stopHeartbeat();
    heartbeatInterval = setInterval(() => {
      if (!ch || !connected) return;
      try {
        ch.send({ ping: true });
      } catch(e) {
        // WS disconnected — show banner immediately, stop pinging
        term.write('\\r\\n\\x1b[90m[connection lost]\\x1b[0m\\r\\n');
        showBanner();
        stopHeartbeat();
        return;
      }
      // If no pong within 5s, show banner
      heartbeatTimeout = setTimeout(() => {
        if (connected) {
          term.write('\\r\\n\\x1b[90m[connection lost]\\x1b[0m\\r\\n');
          showBanner();
          stopHeartbeat();
        }
      }, 5000);
    }, 10000); // ping every 10s
  }

  function openSession() {
    hideBanner();
    ch = mica.openChannel('pty_session', { cols: term.cols, rows: term.rows });
    connected = true;

    ch.onData((data) => {
      if (data.pong) {
        // Heartbeat response — clear the timeout
        if (heartbeatTimeout) { clearTimeout(heartbeatTimeout); heartbeatTimeout = null; }
        if (data.ptyAlive === false) {
          // Server is up but PTY is dead
          term.write('\\r\\n\\x1b[90m[session ended]\\x1b[0m\\r\\n');
          showBanner();
          stopHeartbeat();
        }
        return;
      }
      if (data.output !== undefined) term.write(data.output);
    });

    ch.onClose(() => {
      if (reconnecting) return;
      stopHeartbeat();
      if (connected) {
        term.write('\\r\\n\\x1b[90m[session disconnected]\\x1b[0m\\r\\n');
      }
      showBanner();
    });

    startHeartbeat();
  }

  let reconnectAttempt = 0;

  function attemptReconnect() {
    reconnecting = true;
    stopHeartbeat();
    if (ch) { ch.destroy(); ch = null; }
    reconnecting = false;
    term.clear();
    reconnectBtn.textContent = 'Connecting...';
    reconnectBtn.disabled = true;

    // Delay to let server process close and WS reconnect
    const delay = Math.min(1000 * (reconnectAttempt + 1), 5000);
    setTimeout(() => {
      openSession();
      // Check if it worked after a few seconds
      setTimeout(() => {
        if (!connected) {
          reconnectAttempt++;
          reconnectBtn.textContent = 'Retry';
          reconnectBtn.disabled = false;
          banner.style.display = 'flex';
        } else {
          reconnectAttempt = 0;
          reconnectBtn.textContent = 'Reconnect';
          reconnectBtn.disabled = false;
        }
      }, 3000);
    }, delay);
  }

  reconnectBtn.addEventListener('click', attemptReconnect);

  // Initial connection
  openSession();

  term.onData((input) => { if (ch) ch.send({ input }); });

  term.onResize((size) => {
    if (ch) ch.send({ resize: true, cols: size.cols, rows: size.rows });
  });

  const ro = new ResizeObserver(() => fitAddon.fit());
  ro.observe(termEl);

  mica.onDestroy(() => {
    stopHeartbeat();
    if (ch) ch.close();
    ro.disconnect();
    term.dispose();
  });
</script>
  `;
}
