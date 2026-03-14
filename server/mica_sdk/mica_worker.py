"""
Mica Worker — Long-lived Python process that handles render and export requests.

Communicates with the Node.js server via JSON lines on stdin/stdout.

Protocol:
  Server → Worker (stdin):
    {"type": "render", "id": "...", "class_name": "...", "class_path": "...", "content": "...", "config": {...}}
    {"type": "export_call", "id": "...", "class_name": "...", "class_path": "...", "function": "...", "content": "...", "args": {...}}
    {"type": "invalidate_class", "class_name": "..."}
    {"type": "rpc_response", "request_id": "...", "result": ..., "error": ...}

  Worker → Server (stdout):
    {"type": "render_result", "id": "...", "html": "..."}
    {"type": "export_result", "id": "...", "result": {...}}
    {"type": "error", "id": "...", "error": "..."}
    {"type": "rpc", "request_id": "...", "method": "...", "args": {...}}
    {"type": "ready"}
"""

import sys
import json
import os
import importlib.util
import traceback
import threading

# Add the SDK directory to path so card classes can `import mica`
sdk_dir = os.path.dirname(os.path.abspath(__file__))
if sdk_dir not in sys.path:
    sys.path.insert(0, sdk_dir)

# ── Restricted builtins ─────────────────────────────────────

# Modules that card class code may explicitly import
ALLOWED_MODULES = {
    "json", "re", "math", "datetime", "collections",
    "itertools", "functools", "textwrap", "html",
    "hashlib", "base64", "urllib.parse", "string",
    "copy", "enum", "dataclasses", "typing",
    "markdown",  # for markdown card class
    "mica",      # our SDK
}

# Blocked dangerous modules — everything else (including stdlib internals) is allowed
# so that allowed modules' transitive dependencies work.
BLOCKED_MODULES = {
    "subprocess", "shutil", "socket",
    "urllib.request", "ftplib", "smtplib", "telnetlib",
    "ctypes", "multiprocessing",
    "code", "codeop", "compileall", "py_compile",
    "runpy", "webbrowser", "antigravity",
    "tkinter", "turtle", "idlelib",
}

_original_import = __builtins__.__import__ if hasattr(__builtins__, '__import__') else __import__


def _restricted_import(name, *args, **kwargs):
    """Block dangerous modules; allow stdlib internals for transitive deps."""
    top_level = name.split(".")[0]
    if name in BLOCKED_MODULES or top_level in BLOCKED_MODULES:
        raise ImportError(
            f"Module '{name}' is blocked in mica card classes for security."
        )
    return _original_import(name, *args, **kwargs)


# ── Class loading ───────────────────────────────────────────

loaded_classes = {}  # class_name → { render_fn, exports, module }


def load_class(class_name, class_path):
    """Load a card class from its render.py file. Cached per class_name."""
    if class_name in loaded_classes:
        return loaded_classes[class_name]

    if not os.path.isfile(class_path):
        raise FileNotFoundError(f"Card class not found: {class_path}")

    # Reset mica SDK state before loading
    import mica
    mica._render_fn = None
    mica._exports = {}

    # Load the module
    spec = importlib.util.spec_from_file_location(f"card_class_{class_name}", class_path)
    module = importlib.util.module_from_spec(spec)

    # Apply import restriction for the class module
    old_import = __builtins__["__import__"] if isinstance(__builtins__, dict) else __builtins__.__import__
    try:
        if isinstance(__builtins__, dict):
            __builtins__["__import__"] = _restricted_import
        else:
            __builtins__.__import__ = _restricted_import
        spec.loader.exec_module(module)
    finally:
        if isinstance(__builtins__, dict):
            __builtins__["__import__"] = old_import
        else:
            __builtins__.__import__ = old_import

    # Extract render function and exports
    render_fn = mica._get_render_fn()
    exports = mica._get_exports()

    if render_fn is None:
        raise ValueError(f"Card class '{class_name}' has no @mica.render function")

    entry = {
        "render_fn": render_fn,
        "exports": exports,
        "module": module,
    }
    loaded_classes[class_name] = entry
    return entry


# ── Communication ───────────────────────────────────────────

# RPC responses from the server come on stdin, interleaved with requests.
# We use a threading model: the main loop reads stdin; RPC responses are
# dispatched to waiting threads via a dict of Events.

_rpc_waiters = {}  # request_id → {"event": Event, "response": None}
_rpc_lock = threading.Lock()
_pending_requests = []  # requests that arrived while processing an RPC


def send(msg):
    """Send a JSON message to the Node.js server."""
    sys.stdout.write(json.dumps(msg) + "\n")
    sys.stdout.flush()


def handle_rpc_in_export(request_id, method, args):
    """Called by mica SDK when a card class calls mica.write() etc. during an export.

    Sends the RPC request and blocks until the server responds.
    """
    send({
        "type": "rpc",
        "request_id": request_id,
        "method": method,
        "args": args,
    })

    # Read from stdin until we get our RPC response
    # (other requests may arrive; we queue them)
    while True:
        line = sys.stdin.readline()
        if not line:
            raise RuntimeError("Lost connection to mica server")
        msg = json.loads(line)

        if msg.get("type") == "rpc_response" and msg.get("request_id") == request_id:
            return msg
        else:
            # Queue this for later processing
            _pending_requests.append(msg)


# Monkey-patch mica's _send_rpc to use our handler
import mica
_original_send_rpc = mica._send_rpc


def _patched_send_rpc(method, args=None):
    """Override mica._send_rpc to work within the worker."""
    request_id = mica._request_id
    response = handle_rpc_in_export(request_id, method, args)
    if response.get("error"):
        raise RuntimeError(f"mica.{method} failed: {response['error']}")
    return response.get("result")


mica._send_rpc = _patched_send_rpc


# ── Main loop ───────────────────────────────────────────────

def process_message(msg):
    """Process a single request message."""
    msg_type = msg.get("type")
    msg_id = msg.get("id", "unknown")

    try:
        if msg_type == "render":
            cls = load_class(msg["class_name"], msg["class_path"])
            mica._set_request_id(msg_id)
            html = cls["render_fn"](msg.get("content", ""), msg.get("config", {}))
            export_names = list(cls["exports"].keys())
            send({
                "type": "render_result",
                "id": msg_id,
                "html": html,
                "exports": export_names,
            })

        elif msg_type == "export_call":
            cls = load_class(msg["class_name"], msg["class_path"])
            fn_name = msg["function"]
            if fn_name not in cls["exports"]:
                raise ValueError(f"Function '{fn_name}' is not exported by class '{msg['class_name']}'")
            mica._set_request_id(msg_id)
            result = cls["exports"][fn_name](msg.get("content", ""), msg.get("args", {}))
            send({
                "type": "export_result",
                "id": msg_id,
                "result": result,
            })

        elif msg_type == "invalidate_class":
            class_name = msg.get("class_name")
            if class_name in loaded_classes:
                del loaded_classes[class_name]
                send({"type": "invalidated", "class_name": class_name})

        elif msg_type == "ping":
            send({"type": "pong"})

    except Exception as e:
        send({
            "type": "error",
            "id": msg_id,
            "error": f"{type(e).__name__}: {str(e)}",
            "traceback": traceback.format_exc(),
        })


def main():
    send({"type": "ready"})

    while True:
        # Process any queued requests first (from RPC interleaving)
        while _pending_requests:
            process_message(_pending_requests.pop(0))

        line = sys.stdin.readline()
        if not line:
            break  # stdin closed, server shutting down

        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            send({"type": "error", "id": "parse", "error": f"Invalid JSON: {line.strip()}"})
            continue

        process_message(msg)


if __name__ == "__main__":
    main()
