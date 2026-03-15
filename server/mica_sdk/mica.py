"""
Mica SDK — Python module for card class authors.

Provides decorators and server-bridge functions for building widget cards.

Usage in a card class:
    import mica

    @mica.render
    def render(content, config):
        return "<div>Hello</div>"

    @mica.export
    def do_something(content, args):
        mica.write("updated content")
        return {"ok": True}

    @mica.channel
    def my_stream(content, args, channel):
        while True:
            msg = channel.receive()
            if msg is None:
                break
            channel.send({"echo": msg})
"""

import sys
import json
import queue

# ── Internal state ──────────────────────────────────────────

_render_fn = None
_exports = {}
_channels = {}
_request_id = None  # Set by worker before calling handlers


# ── Decorators ──────────────────────────────────────────────

def render(fn):
    """Mark a function as the card's render function.

    The function receives (content: str, config: dict) and must return
    an HTML string.
    """
    global _render_fn
    _render_fn = fn
    return fn


def export(fn):
    """Mark a function as callable from the browser via mica.call().

    The function receives (content: str, args: dict) and should return
    a JSON-serializable dict.
    """
    _exports[fn.__name__] = fn
    return fn


def channel(fn):
    """Mark a function as a bidirectional channel handler.

    The function receives (content: str, args: dict, channel: Channel).
    Use channel.send(data) to push data to the browser,
    channel.receive() to block until data arrives, and
    channel.close() to end the channel.
    """
    _channels[fn.__name__] = fn
    return fn


# ── Channel class ────────────────────────────────────────────

class Channel:
    """Bidirectional channel between Python and browser widget."""

    def __init__(self, channel_id):
        self.id = channel_id
        self._closed = False
        self._queue = queue.Queue()

    def send(self, data):
        """Push data to the browser widget."""
        if self._closed:
            raise RuntimeError("Channel is closed")
        _send_channel_data(self.id, data)

    def receive(self):
        """Block until data arrives from the browser. Returns None if channel closed."""
        if self._closed:
            return None
        return self._queue.get()

    def close(self):
        """Close the channel from the Python side."""
        if not self._closed:
            self._closed = True
            _send_channel_close(self.id)

    def _enqueue(self, data):
        """Called by worker to deliver incoming data from browser."""
        self._queue.put(data)

    def _close_remote(self):
        """Called by worker when the browser closes the channel."""
        self._closed = True
        self._queue.put(None)  # Unblock any waiting receive()


# ── Channel I/O (monkey-patched by worker for thread safety) ─

def _send_channel_data(channel_id, data):
    """Send channel data to the server. Overridden by worker."""
    msg = {"type": "channel_data", "id": channel_id, "data": data}
    sys.stdout.write(json.dumps(msg) + "\n")
    sys.stdout.flush()


def _send_channel_close(channel_id):
    """Send channel close to the server. Overridden by worker."""
    msg = {"type": "channel_close", "id": channel_id}
    sys.stdout.write(json.dumps(msg) + "\n")
    sys.stdout.flush()


# ── Server bridge (RPC over stdin/stdout) ───────────────────

def _send_rpc(method, args=None):
    """Send an RPC request to the Node.js server and wait for response."""
    msg = {
        "type": "rpc",
        "request_id": _request_id,
        "method": method,
        "args": args or {},
    }
    sys.stdout.write(json.dumps(msg) + "\n")
    sys.stdout.flush()
    # Block waiting for RPC response
    line = sys.stdin.readline()
    if not line:
        raise RuntimeError("Lost connection to mica server")
    response = json.loads(line)
    if response.get("error"):
        raise RuntimeError(f"mica.{method} failed: {response['error']}")
    return response.get("result")


def write(content):
    """Write content back to this card's data file."""
    return _send_rpc("write", {"content": content})


def write_file(filename, content):
    """Write to another file in the current layer."""
    return _send_rpc("write_file", {"filename": filename, "content": content})


def read_file(filename):
    """Read a file from the current layer. Returns content string or None."""
    result = _send_rpc("read_file", {"filename": filename})
    return result


def log(message):
    """Append a message to the layer's _log.md."""
    return _send_rpc("log", {"message": message})


def emit(event, data=None):
    """Broadcast an event to all connected browser widgets.

    Other widgets can receive this with mica.on(event, callback) in JavaScript.
    """
    return _send_rpc("emit", {"event": event, "data": data})


class _AgentBridge:
    """Bridge to the layer's AI agent (Claude SDK)."""

    def chat(self, message):
        """Send a message to the layer's AI agent. Returns response dict."""
        return _send_rpc("agent.chat", {"message": message})


agent = _AgentBridge()


# ── Introspection (used by worker) ──────────────────────────

def _get_render_fn():
    return _render_fn


def _get_exports():
    return dict(_exports)


def _get_channels():
    return dict(_channels)


def _set_request_id(rid):
    global _request_id
    _request_id = rid
