// Terminal card — xterm.js with PTY channel
// container and mica are provided by CARD_SHIM

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

// Open PTY channel
const ch = mica.openChannel('pty_session', { cols: term.cols, rows: term.rows });

ch.onData(function(data) {
  if (data.type === 'output' && data.data) {
    term.write(data.data);
  } else if (data.type === 'exit') {
    term.write('\r\n\x1b[90m[session ended]\x1b[0m\r\n');
  }
});

ch.onClose(function() {
  term.write('\r\n\x1b[90m[disconnected]\x1b[0m\r\n');
});

// Forward input to PTY
term.onData(function(input) {
  if (ch) ch.send({ type: 'input', data: input });
});

// Forward resize to PTY
term.onResize(function(size) {
  if (ch) ch.send({ type: 'resize', cols: size.cols, rows: size.rows });
});

// Auto-fit on container resize
const ro = new ResizeObserver(function() { fitAddon.fit(); });
ro.observe(termEl);

mica.onDestroy(function() {
  if (ch) ch.close();
  ro.disconnect();
  term.dispose();
});
