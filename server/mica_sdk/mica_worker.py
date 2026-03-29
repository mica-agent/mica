"""
Mica Worker — Long-lived Python process that handles render and export requests.

Communicates with the Node.js server via JSON lines on stdin/stdout.

Protocol:
  Server → Worker (stdin):
    {"type": "render", "id": "...", "class_name": "...", "class_path": "...", "content": "...", "config": {...}}
    {"type": "export_call", "id": "...", "class_name": "...", "class_path": "...", "function": "...", "content": "...", "args": {...}}
    {"type": "channel_open", "id": "...", "class_name": "...", "class_path": "...", "function": "...", "content": "...", "args": {...}}
    {"type": "channel_data", "id": "...", "data": ...}
    {"type": "channel_close", "id": "..."}
    {"type": "invalidate_class", "class_name": "..."}
    {"type": "rpc_response", "request_id": "...", "result": ..., "error": ...}

  Worker → Server (stdout):
    {"type": "render_result", "id": "...", "html": "...", "exports": [...]}
    {"type": "export_result", "id": "...", "result": {...}}
    {"type": "channel_data", "id": "...", "data": ...}
    {"type": "channel_close", "id": "..."}
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

loaded_classes = {}  # class_name → { render_fn, exports, channels, module }


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
    mica._channels = {}

    # Load the module
    spec = importlib.util.spec_from_file_location(f"card_class_{class_name}", class_path)
    module = importlib.util.module_from_spec(spec)

    # Apply import restriction for built-in card classes only.
    # Project-scoped card classes (in .card-classes/) are user code and
    # get full module access. In PROD mode they run inside Docker anyway.
    is_project_class = ".card-classes" in class_path
    old_import = __builtins__["__import__"] if isinstance(__builtins__, dict) else __builtins__.__import__
    try:
        if not is_project_class:
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

    # Extract render function, exports, and channels
    render_fn = mica._get_render_fn()
    exports = mica._get_exports()
    channels = mica._get_channels()

    if render_fn is None:
        raise ValueError(f"Card class '{class_name}' has no @mica.render function")

    entry = {
        "render_fn": render_fn,
        "exports": exports,
        "channels": channels,
        "module": module,
    }
    loaded_classes[class_name] = entry
    return entry


# ── Communication ───────────────────────────────────────────

# Thread-safe stdout writing (channel threads also write to stdout)
_stdout_lock = threading.Lock()

_rpc_waiters = {}  # request_id → {"event": Event, "response": None}
_rpc_lock = threading.Lock()
_pending_requests = []  # requests that arrived while processing an RPC

# Active bidirectional channels
_active_channels = {}  # channel_id → mica.Channel


def send(msg):
    """Send a JSON message to the Node.js server (thread-safe)."""
    with _stdout_lock:
        sys.stdout.write(json.dumps(msg) + "\n")
        sys.stdout.flush()


def handle_rpc_in_channel(request_id, method, args):
    """Called from a channel thread — sends RPC and waits for the main loop to deliver the response."""
    event = threading.Event()
    waiter = {"event": event, "response": None}
    with _rpc_lock:
        _rpc_waiters[request_id] = waiter

    send({
        "type": "rpc",
        "request_id": request_id,
        "method": method,
        "args": args,
    })

    # Block until the main loop delivers our response
    event.wait()
    with _rpc_lock:
        _rpc_waiters.pop(request_id, None)
    return waiter["response"]


def handle_rpc_in_export(request_id, method, args):
    """Called from the main thread during an export — reads stdin directly since
    the main loop is blocked waiting for the export to finish."""
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


# Monkey-patch mica's functions to use our thread-safe handlers
import mica
_original_send_rpc = mica._send_rpc


_main_thread_id = threading.current_thread().ident


def _patched_send_rpc(method, args=None):
    """Override mica._send_rpc to work within the worker.
    Routes to the correct handler depending on whether we're on the main thread
    (export calls) or a channel thread."""
    request_id = mica._request_id
    if threading.current_thread().ident == _main_thread_id:
        response = handle_rpc_in_export(request_id, method, args)
    else:
        response = handle_rpc_in_channel(request_id, method, args)
    if response.get("error"):
        raise RuntimeError(f"mica.{method} failed: {response['error']}")
    return response.get("result")


def _patched_send_channel_data(channel_id, data):
    """Thread-safe channel data send."""
    send({"type": "channel_data", "id": channel_id, "data": data})


def _patched_send_channel_close(channel_id):
    """Thread-safe channel close send."""
    send({"type": "channel_close", "id": channel_id})


mica._send_rpc = _patched_send_rpc
mica._send_channel_data = _patched_send_channel_data
mica._send_channel_close = _patched_send_channel_close


# ── Channel thread runner ───────────────────────────────────

def _run_channel(fn, content, args, channel):
    """Run a @mica.channel handler in a thread."""
    try:
        fn(content, args, channel)
    except Exception as e:
        send({
            "type": "error",
            "id": channel.id,
            "error": f"{type(e).__name__}: {str(e)}",
            "traceback": traceback.format_exc(),
        })
    finally:
        if not channel._closed:
            channel.close()
        _active_channels.pop(channel.id, None)


# ── Main loop ───────────────────────────────────────────────

def _dispatch_rpc_response(msg):
    """Deliver an rpc_response to the waiting channel thread, if any."""
    rid = msg.get("request_id")
    with _rpc_lock:
        waiter = _rpc_waiters.get(rid)
    if waiter:
        waiter["response"] = msg
        waiter["event"].set()
        return True
    return False


def process_message(msg):
    """Process a single request message."""
    msg_type = msg.get("type")
    msg_id = msg.get("id", "unknown")

    # RPC responses go to waiting channel threads
    if msg_type == "rpc_response":
        _dispatch_rpc_response(msg)
        return

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

        elif msg_type == "channel_open":
            cls = load_class(msg["class_name"], msg["class_path"])
            fn_name = msg["function"]
            if fn_name not in cls.get("channels", {}):
                raise ValueError(f"Function '{fn_name}' is not a @mica.channel handler in class '{msg['class_name']}'")
            mica._set_request_id(msg_id)
            channel = mica.Channel(msg_id)
            _active_channels[msg_id] = channel
            t = threading.Thread(
                target=_run_channel,
                args=(cls["channels"][fn_name], msg.get("content", ""), msg.get("args", {}), channel),
                daemon=True,
            )
            t.start()

        elif msg_type == "channel_data":
            ch = _active_channels.get(msg_id)
            if ch:
                ch._enqueue(msg.get("data"))

        elif msg_type == "channel_close":
            ch = _active_channels.get(msg_id)
            if ch:
                ch._close_remote()
                _active_channels.pop(msg_id, None)

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
