/**
 * Mica SDK — JavaScript module for card class authors.
 *
 * Loaded into V8 isolates. The `__mica_rpc` callback is injected by the
 * isolate host (isolatePool.ts) as the sole bridge to the outside world.
 *
 * RPC calls return Promises. Export functions should use `await`:
 *
 *   export async function toggle(content, args, mica) {
 *     await mica.write("updated content");
 *     return { ok: true };
 *   }
 */

// Injected by the isolate host. This is the ONLY way to talk to the outside world.
/* global __mica_rpc */

const mica = {
  /** Write content back to this card's data file. */
  write(content) {
    return __mica_rpc("write", { content });
  },

  /** Write to another file in the current canvas. */
  writeFile(filename, content) {
    return __mica_rpc("write_file", { filename, content });
  },

  /** Read a file from the current canvas. Returns content string or null. */
  readFile(filename) {
    return __mica_rpc("read_file", { filename });
  },

  /** Append a message to the canvas's _log.log. */
  log(message) {
    return __mica_rpc("log", { message });
  },

  /** Broadcast an event to all connected browser widgets. */
  emit(event, data) {
    return __mica_rpc("emit", { event, data });
  },

  /**
   * Fetch a URL via server proxy. Only available for cards with `network: true` in manifest.
   * Returns { status, statusText, headers, body } or throws if network not permitted.
   */
  fetch(url, options) {
    return __mica_rpc("fetch", { url, options: options || {} });
  },

  /**
   * Run a shell command on the host. Returns { stdout, stderr, exitCode }.
   * cwd defaults to project root. timeout defaults to 30s (max 300s).
   */
  exec(command, options) {
    return __mica_rpc("exec", { command, cwd: (options && options.cwd) || "", timeout: (options && options.timeout) || 30000 });
  },

  /** Bridge to the canvas's AI agent. */
  agent: {
    /** Send a message to the canvas's AI agent. Returns response dict. */
    chat(message) {
      return __mica_rpc("agent.chat", { message });
    },
  },
};
