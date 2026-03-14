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
"""

import sys
import json

# ── Internal state ──────────────────────────────────────────

_render_fn = None
_exports = {}
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


def _set_request_id(rid):
    global _request_id
    _request_id = rid
