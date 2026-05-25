# Card-class worked examples

Reference content extracted from the primary `card-class-handbook/SKILL.md`. **Read on demand**, not by default — load this file when:

- You're building a **Tier 3** card (wrapping a CLI tool via the `process` handler). The `hello-process` example below shows the canonical shape; the chained-subprocess example shows multi-stage CLI invocations.
- You're building a **Tier 4** card (card-class-private sidecar with `server.py` / `server.ts`). The sidecar reference + five worked examples (hello-py, hello-llm, hello-embed, hello-faiss, hello-pdf) cover the canonical patterns.
- You need a **minimal Tier 1** reference. The counter card example at the bottom shows the simplest possible card.

Each example is a complete, working pattern — metadata.json + card.html + card.js + (sidecars only) server.py / server.ts. Copy and adapt.

For tier-decision logic, spec frontmatter schema, the canonical card.js skeleton, `mica.*` API reference, channel-handler decision rules, `render_capture` workflow, and pitfalls — see the primary `SKILL.md`.

---

### Chained subprocess calls — when one subtask spans two CLI tools in sequence

Some Tier-3 subtasks need two CLI tools where stage 1's output (a
file written to canvas-root, or buffered stdout) becomes stage 2's
input. Open the channel ONCE, then call `start` per stage. The
card class declares `metadata.handler = "process"` once; the
handler accepts sequential `start` messages on the same channel
(one running subprocess at a time).

```js
const ch = mica.openChannel("session");
let onExit = null;   // resolver for the currently-running stage
let stderr = "";

ch.onData((msg) => {
  if (msg.type === "stderr") stderr += msg.data;
  if (msg.type === "exit")   { onExit?.(msg.code); onExit = null; stderr = ""; }
  if (msg.type === "error")  { onExit?.(-1); onExit = null; }
});

async function run(label, command, args) {
  const code = await new Promise((resolve) => {
    onExit = resolve;
    ch.send({ type: "start", command, args });
  });
  if (code !== 0) throw new Error(`${label} failed (exit ${code}): ${stderr}`);
}

// stage 1: extract text from the uploaded PDF to an intermediate file
await run("extract", "pdftotext", [pdfPath, "extracted.txt"]);

// stage 2: count lines of the extracted text
await run("count", "wc", ["-l", "extracted.txt"]);

mica.onDestroy(() => { try { ch.close(); } catch {} });
```

**Why this idiom matters.** Without it, the most common drift is
substituting stage 1 with a client-side equivalent (Web Audio API
for audio, FileReader for parsing, browser-native HTML parsing,
etc.) because one `openChannel` plus a familiar browser call
*feels* simpler than two `openChannel` invocations. When the
decomposition table assigns BOTH stages to Tier 3, both stages
need a process call — substitution is spec drift (see `develop`
step 4a).

**Sequencing notes:**

- One subprocess per channel at a time. Stage 2's `start` only
  fires after stage 1's `exit` resolves the Promise.
- Stage 1's output usually goes to a file (canvas-relative path);
  stage 2 reads that file. If output is small, buffer `stdout` in
  the handler and pass it to stage 2 via `{ type: "input", data:
  ... }` messages (then `{ type: "close_stdin" }` to signal EOF).
- For >2 stages: extend the pattern. `await run(...)` per stage,
  in declaration order.

### Worked example — `hello-process` (Tier 3, zero sidecar code)

The minimal working `process`-handler card. Three files in
`.mica/card-classes/hello-process/` — no `server.py`, no port, no
`/health`, no `mica_restart_sidecar` cycle. Replace `echo` with
`tesseract`, `pdftotext`, `ffmpeg`, `whisper.cpp`, `jq`, or any CLI
and the rest is identical.

**`metadata.json`** — declares the process handler:

```json
{
  "extension": ".hello-process",
  "badge": "HPR",
  "defaultTitle": "Hello (Process)",
  "handler": "process",
  "dependencies": { "scripts": [], "styles": [] }
}
```

**`card.html`** — input + button + output pane:

```html
<div class="hello-card">
  <div class="hello-input-row">
    <input type="text" class="hello-name" placeholder="Your name…" value="World" />
    <button class="hello-greet">Greet</button>
  </div>
  <pre class="hello-output">click Greet to spawn echo</pre>
</div>
```

**`card.js`** — opens the channel, sends `start`, streams stdout:

```js
const nameEl = container.querySelector('.hello-name');
const btnEl  = container.querySelector('.hello-greet');
const outEl  = container.querySelector('.hello-output');

const ch = mica.openChannel("session");   // no args at open time
let buffer = "";

ch.onData((msg) => {
  if (msg.type === "started") { buffer = ""; outEl.textContent = "(running)"; }
  if (msg.type === "stdout")  { buffer += msg.data; outEl.textContent = buffer; }
  if (msg.type === "stderr")  { outEl.textContent += "\nstderr: " + msg.data; }
  if (msg.type === "exit")    { btnEl.disabled = false; }
  if (msg.type === "error")   { outEl.textContent = "spawn error: " + msg.message; btnEl.disabled = false; }
});

btnEl.addEventListener('click', () => {
  btnEl.disabled = true;
  ch.send({
    type: "start",
    command: "echo",
    args: [`Hello, ${nameEl.value.trim() || 'World'}!`],
  });
});

mica.onDestroy(() => { try { ch.close(); } catch {} });
```

**What to observe on first run:**

1. Click runs `echo`. `started` arrives, then `stdout` with the
   greeting, then `exit`. Total round trip ~50ms — no sidecar
   warmup tax because there is no sidecar.
2. Re-clicks reuse the same channel (Mica spawns a fresh subprocess
   per `start` message; the channel itself stays open).
3. Backend log shows nothing process-specific — the subprocess is
   not Mica-instrumented.

**This is the right shape any time you'd otherwise reach for a
sidecar just to shell out to a CLI tool.** Pair `process`-handler
subtasks with Tier 1 UI and Tier 2 LLM streams to build cards that
need no sidecar at all (e.g. speech-to-text + summary in §
Worked decompositions above).

## Card-class-private sidecars — `metadata.sidecar` + `server.py` / `server.ts`

The reusable handlers above are Mica-provided primitives (LLM stream, subprocess wrapper). When your card needs **its own server-side logic** — ML inference, vector search, RAG, file analysis, anything that needs persistent memory or runtime that doesn't fit a generic handler — declare a **sidecar**. Mica spawns a card-class-owned HTTP service on a port from its pool, manages lifecycle, and exposes it to your `card.js` via a stable URL scheme. The card class becomes self-contained: UI + server logic in one directory.

### When a sidecar is the right tier

Decide via the four-tier walkthrough in § Card architecture above —
sidecar is Tier 4, the most expensive tier, and it should carry only
the residue cheaper tiers can't deliver (warm model weights,
in-memory indexes, multi-step composition with structured JSON).
If a single `llm-direct` prompt or a `process`-wrapped CLI tool gets
the job done, that's the right tier; don't escalate to a sidecar to
wrap something cheaper. The rest of this section is the
how-to-author once you've already decided.

### Declaring the sidecar in `metadata.json`

```json
{
  "extension": ".my-card",
  "badge": "MYC",
  "defaultTitle": "My Card",
  "sidecar": {
    "entry": "server.py",
    "ready_path": "/health",
    "ready_timeout_ms": 30000
  }
}
```

Fields:
- `entry` — relative path inside the card-class directory. Extension picks the runtime: `.py` → Python, `.ts` / `.tsx` → tsx (Mica's TypeScript runner), `.mjs` / `.cjs` / `.js` → node, otherwise treated as directly executable (must have shebang).
- `ready_path` — endpoint Mica probes for readiness. Default `/health`. MUST return HTTP 200 once the sidecar is willing to serve real traffic (after model loading completes, etc.).
- `ready_timeout_ms` — how long Mica waits for `/health` to first respond. Default 30000 (30s). Bump higher if your sidecar loads a large model at startup.
- `python` — optional, only for `.py` entries: `"system"` (default, `/usr/bin/python3`) | `"voice-venv"` (uses the Parakeet/Kokoro venv with sentence-transformers, librosa, FastAPI) | absolute path.
- `interpreter` — optional, absolute-path explicit override. Wins over extension auto-detect.

### Env vars Mica injects when spawning your sidecar

You usually don't read these directly — the `mica_sidecar` package surfaces the ones that matter as properties. Listed here so the contract is documented.

| Variable | Value | Use |
|---|---|---|
| `MICA_PORT` | port (8200-8299 from pool) | **READ THIS** — bind your server here; never hardcode a port |
| `MICA_PROJECT` | active project name | logging / context |
| `MICA_PROJECT_DIR` | absolute path to the project root | for off-canvas files (`.mica/`, `shared/`) |
| `MICA_CANVAS_DIR` | absolute path to the canvas-root subdir | **for files the card wrote via `mica.files.write` — its paths are canvas-root-relative** |
| `MICA_WORKSPACE_DIR` | absolute path to the projects root | rare; project resolution |
| `MICA_CARD_CLASS` | your card class name | mica.log uses this as the prefix |
| `MICA_CARD_CLASS_DIR` | absolute path to your card class directory | available as `mica.cardclass_dir` |
| `MICA_BACKEND_URL` | `http://127.0.0.1:<backend-port>` | used internally by `mica_sidecar` to call Mica's REST APIs |
| `MICA_SIDECAR_TOKEN` | per-startup random token | auth header for Mica's REST APIs; used internally by `mica_sidecar` |
| `PYTHONPATH` | includes Mica's `vendor/` | `import mica_sidecar` resolves Mica's bundled client |
| `NODE_PATH` | Mica's node_modules + vendor/ | TS sidecars `import` Mica deps + `mica-sidecar` |

Plus the parent backend's full env is forwarded — `TAVILY_API_KEY`, `OPENROUTER_API_KEY`, etc. available if set.

### `mica_sidecar` — Mica primitives for the things you can't reach directly

The `mica_sidecar` package is auto-importable inside every sidecar Mica spawns (Python via PYTHONPATH; TS via NODE_PATH). It's the *server-side* analog of the `mica` global in `card.js` — a tiny namespace for capabilities Mica owns. **Distinct package** from the client-side global; methods don't overlap.

```python
import mica_sidecar as mica   # template-provided alias

# LLM call — URL, model, auth, and vLLM's enable_thinking trap all owned by Mica.
resp = mica.llm.chat(messages=[
    {"role": "system", "content": "You are concise."},
    {"role": "user",   "content": query},
])
# resp.text → reply string
# resp.usage → {"prompt_tokens": ..., "completion_tokens": ..., "total_tokens": ...}

mica.log("processed chunk", chunk_id)   # → backend log, auto-prefixed
mica.project_dir                         # absolute path to active project (str)
mica.cardclass_dir                       # absolute path to this card class (str)
```

```typescript
import mica from "mica-sidecar";

const resp = await mica.llm.chat({
  messages: [
    { role: "user", content: query },
  ],
});
mica.log("got reply");
mica.projectDir;     // string
mica.cardclassDir;   // string
```

**What you call this for:** the local LLM, logging, the Mica-injected context (project / card-class paths). That's it.

**What you DON'T call this for:** embeddings, vector stores, PDF parsing, OCR, audio, image generation, or anything else you'd reach for a standard PyPI/npm package. Those use the library directly — `from sentence_transformers import SentenceTransformer`, `import faiss`, `import fitz`, etc. Mica doesn't wrap them because the library API IS the API; AI already knows it.

**Cross-surface confusion** — see Pitfalls below. `mica.fetch` and `mica.openChannel` are CLIENT-only (card.js). They don't exist server-side. If you reach for them in a sidecar, you'll get `AttributeError`.

### The `server.py` shape (FastAPI, recommended)

**Mica auto-starts FastAPI sidecars.** When `server.py` defines
`app = FastAPI()` and has NO `uvicorn.run` call, the spawn site runs
`python -m uvicorn server:app --host 127.0.0.1 --port $MICA_PORT`
directly. You write the app and routes; that's it. The `uvicorn.run`
line at the bottom of older examples is no longer needed (it still
works — Mica detects it and uses direct `python3 server.py` execution
instead — but it's not required).

```python
import os, traceback
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

PROJECT_DIR = os.environ["MICA_PROJECT_DIR"]
print(f"[my-card] starting", flush=True)  # logs go to backend.log

# Load expensive state ONCE at module scope. Mica keeps the process warm.
# (e.g. SentenceTransformer, json corpora, ML model weights)

app = FastAPI()

@app.exception_handler(Exception)               # REQUIRED — see "Debugging a 500" below
async def all_exceptions(request: Request, exc: Exception):
    print(traceback.format_exc(), flush=True)   # full stack → backend log
    return JSONResponse(status_code=500, content={"error": f"{type(exc).__name__}: {exc}"})

class AskRequest(BaseModel):
    query: str

@app.get("/health")                  # required — Mica probes this for ready
async def health():
    return {"ok": True}

@app.post("/search")
async def search(req: AskRequest):
    # ... your compute, returning JSON ...
    return {"results": [...]}

# No uvicorn.run — Mica's auto-bootstrap handles it.
```

### The `server.ts` shape (Node stdlib http, no extra deps)

```typescript
import { createServer } from "node:http";
import { URL } from "node:url";

const PORT = Number(process.env.MICA_PORT!);
const PROJECT_DIR = process.env.MICA_PROJECT_DIR!;
console.log(`[my-card] starting on :${PORT}`);

process.on("uncaughtException", (e) => console.error("[uncaught]", e.stack || e));
process.on("unhandledRejection", (e) => console.error("[unhandled]", e));

const server = createServer((req, res) => {
  const url = new URL(req.url!, `http://127.0.0.1:${PORT}`);
  try {
    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (url.pathname === "/whatever" && req.method === "POST") {
      let body = ""; req.on("data", (c) => body += c);
      req.on("end", () => {
        try {
          const reqData = JSON.parse(body);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ /* response */ }));
        } catch (e: any) {
          console.error(e.stack || e);                            // → backend log
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: String(e?.message ?? e) }));
        }
      });
      return;
    }
    res.writeHead(404); res.end();
  } catch (e: any) {
    console.error(e.stack || e);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: String(e?.message ?? e) }));
  }
});
server.listen(PORT, "127.0.0.1");
```

### Calling the sidecar from `card.js`

Use `mica.fetch` with the `mica-internal://card-server/` scheme:

```js
const r = await mica.fetch('mica-internal://card-server/search', {
  method: 'POST',
  body: JSON.stringify({ query: queryEl.value }),
  timeout: 30000,
});
if (r.errorCode) { /* mica-side failure: r.error */ }
else if (r.status >= 400) { /* sidecar returned HTTP error */ }
else { const data = JSON.parse(r.body); /* use data */ }
```

The runtime injects your card's class name into the request so Mica routes to the correct sidecar — no class name needed in the URL.

### Lifecycle facts you must know

1. **Lazy spawn.** Sidecar starts on the first `mica.fetch` from your card. First-call latency = process start + model load + ready probe. Plan for 5-30s cold start; set the card UI to show "Loading…" appropriately.
2. **Warm thereafter.** Subsequent calls hit the running process — typically 10-200ms (the actual compute, no startup tax).
3. **Idle shutdown** after 10 minutes with no calls. Next call respawns (back to cold start).
4. **No file-change auto-restart.** Edit `server.py` → the running sidecar still runs the OLD code. To force respawn, call **`mica_restart_sidecar({ card_class: "<my-card>" })`** — it SIGTERMs the tracked PID server-side and clears state so the next `mica.fetch` from card.js spawns fresh. Do NOT use `mica_shell pkill ...` — the bash subprocess running pkill has the pattern in its OWN argv (pkill -f matches argv), so pkill kills itself and can cascade to killing the agent CLI process (whose argv contains the user's prompt mentioning the card class). The dedicated tool avoids both failure modes.
5. **One process per (project, card-class)** — multiple card instances in the same project share the sidecar. Different projects get separate sidecars.
6. **Orphan reaper** runs at backend startup, cleaning up sidecars from previous crashes that didn't get a clean SIGTERM.

### Common pitfalls

- **Forgot `/health`.** Mica probes it and times out. Your sidecar process is running but Mica never considers it ready. Always implement `/health` returning HTTP 200.
- **Hardcoded port.** `uvicorn.run(app, host="127.0.0.1", port=8000)` — Mica gives you `MICA_PORT`; ignoring it means the port pool gets confused. Always `port=int(os.environ["MICA_PORT"])`.
- **vLLM with thinking enabled consuming the answer budget — already handled by `mica.llm.chat`.** Thinking is OFF by default in `mica.llm.chat` (the trap is on the Mica side of the boundary). If you DO want thinking, pass `thinking=True` AND bump `max_tokens` to ≥2x what you'd budget without it. Only relevant if you bypass `mica.llm.chat` and call `{LLAMA_URL}/v1/chat/completions` directly — that path requires explicit `"chat_template_kwargs": {"enable_thinking": false}` to avoid losing the answer budget to the reasoning trace.
- **Cross-surface API confusion — `mica` is two distinct surfaces.** In `card.js`, `mica` is a global injected by Mica's CARD_SHIM; methods include `fetch`, `openChannel`, `on`, `getContent`. In `server.py`/`server.ts`, `mica` (aliased from `mica_sidecar` / `mica-sidecar`) is an imported package; methods include `llm.chat`, `log`, `project_dir`. The two surfaces do NOT overlap. `mica.fetch` does NOT exist server-side — sidecars use `httpx.post` / `fetch` directly (no SSRF surface to guard, no internal scheme to route). `mica.llm.chat` does NOT exist client-side — cards needing LLM streaming UX use `mica.openChannel('turn', { systemPrompt, model })` against the `llm-direct` handler. If you see `AttributeError: 'mica' has no attribute 'X'` on the sidecar, you're pattern-matching the wrong surface — check the table above.
- **Streaming responses.** `mica.fetch` is non-streaming today — your sidecar can emit SSE/chunked, but `mica.fetch` waits for the full body and returns it once. Card-side UI should show a "Working…" placeholder during the await, not try to render mid-stream tokens.
- **Heavy first import.** Loading a 100MB embedding model takes 3-5s. Put it at module scope (loaded once on spawn), NOT inside the request handler (would load per-request).
- **Print to stdout for logs.** Anything your sidecar `print`s goes to the backend log prefixed `[card-sidecar:<name>]`. Use `flush=True` (Python) for real-time visibility.
- **Tracebacks must reach stdout, not just the response body.** A 500 returned by `mica.fetch` surfaces only the short error message to the caller (and to the agent debugging the card). The full traceback — file path, line number, call stack — is what tells you what's actually wrong. Without an exception handler that calls `print(traceback.format_exc(), flush=True)`, that information is gone forever. The FastAPI template above includes one; copy it verbatim into every new sidecar.
- **Verify each external import via `mica_inspect_python_package` before committing it to server.py.** System Python ships a small set of pre-installed packages; voice-venv adds the speech-sidecar dependencies. TS/Node has whatever Mica's node_modules ships. Beyond those, the package needs to be vendored or installed (not supported in the prototype) — discover this at spec time, not at sidecar-spawn time.

### Debugging a 500 from your sidecar — workflow

When `mica.fetch` returns `status: 500` (or the card UI shows a sidecar error), follow this order — do NOT start guessing at code:

1. **Read the sidecar's recent log first — call `mica_sidecar_log`.**
   ```
   mica_sidecar_log({ card_class: "<your-card>" })
   ```
   Returns the last 50 lines of the sidecar's stdout/stderr (raise `lines` to ~150 for longer tracebacks). Look for `Traceback (most recent call last):` — the line number and exception type tell you exactly which line raised. **Do NOT edit code before reading this.** Pattern-matching the short error message you got from `mica.fetch` ("Upload failed (HTTP 500)", "slice indices must be integers...") will land you on the wrong line. The buffer survives the sidecar crashing — even if the process died, the log lines that crashed it are still here.
2. **If no traceback appears in the log, your sidecar is suppressing it.** Add the `@app.exception_handler(Exception)` block from the template (Python) or wrap handlers with try/catch + `console.error(e.stack)` (Node). Kill and respawn (see step 4) so the change takes effect, then re-trigger the error to capture the traceback this time.
3. **Read the actual line the traceback points at.** The bug is on *that* line, not a similar-looking line elsewhere. Sidecars have an upload path and a query path that share no code — an error during upload won't be in retrieval functions.
4. **After editing server.py / server.ts, force a respawn.** Running sidecar holds the OLD bytecode in memory (see Lifecycle fact #4). Call:
   ```
   mica_restart_sidecar({ card_class: "<your-card>" })
   ```
   Server-side SIGTERM via the tracked PID. Returns when the old process is gone; next `mica.fetch` from card.js triggers a clean spawn with the new code. **Do NOT use `mica_shell pkill ...`** — pkill matches the bash subprocess's own argv (which contains the pattern you pass) and can suicide-kill the agent CLI.
5. **Same error twice = stop iterating.** If your second fix attempt produces the same error message, your diagnosis is wrong, not your fix. Go back to step 1 — re-read the traceback, and check that you're editing the file the running sidecar is actually executing (right project, right card class). Three identical errors means stop, re-read the traceback line-by-line, and consider whether the running code is actually what you've been editing.

### Worked example — `hello-py` (complete, end-to-end)

The minimal working sidecar — copy this, change names, you have a new card class. Four files in `.mica/card-classes/hello-py/`:

**`metadata.json`** — declares the sidecar:

```json
{
  "extension": ".hello-py",
  "badge": "HPY",
  "defaultTitle": "Hello (Python)",
  "sidecar": {
    "entry": "server.py",
    "ready_path": "/health",
    "ready_timeout_ms": 10000
  },
  "dependencies": { "scripts": [], "styles": [] }
}
```

**`server.py`** — FastAPI server, module-scope state, reads `MICA_PORT`:

```python
import os, time, uvicorn
from fastapi import FastAPI
from pydantic import BaseModel

PORT = int(os.environ["MICA_PORT"])          # never hardcode
START_TIME = time.time()
call_count = 0                                # module-scope: persists across calls

print(f"[hello-py] starting on :{PORT}", flush=True)
app = FastAPI()

class GreetRequest(BaseModel):
    name: str = "World"

@app.get("/health")                           # required — Mica's ready probe
async def health():
    return {"ok": True}

@app.post("/greet")
async def greet(req: GreetRequest):
    global call_count
    call_count += 1
    return {
        "message": f"Hello, {req.name}!",
        "pid": os.getpid(),
        "uptime_s": round(time.time() - START_TIME, 2),
        "call_count": call_count,             # proves the process stays warm
    }

uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="warning")
```

**`card.html`** — input + button + output pane:

```html
<div class="hello-card">
  <div class="hello-input-row">
    <input type="text" class="hello-name" placeholder="Your name…" value="World" />
    <button class="hello-greet">Greet</button>
  </div>
  <pre class="hello-output">click Greet to call the sidecar</pre>
</div>
```

**`card.js`** — calls the sidecar via `mica.fetch`:

```js
const nameEl = container.querySelector('.hello-name');
const btnEl  = container.querySelector('.hello-greet');
const outEl  = container.querySelector('.hello-output');

async function greet() {
  btnEl.disabled = true;
  outEl.textContent = 'calling sidecar…';
  const r = await mica.fetch('mica-internal://card-server/greet', {
    method: 'POST',
    body: JSON.stringify({ name: nameEl.value.trim() || 'World' }),
    timeout: 15000,
  });
  if (r.errorCode)        outEl.textContent = `transport error: ${r.error}`;
  else if (r.status >= 400) outEl.textContent = `HTTP ${r.status}: ${r.body.slice(0, 200)}`;
  else                    outEl.textContent = JSON.stringify(JSON.parse(r.body), null, 2);
  btnEl.disabled = false;
}
btnEl.addEventListener('click', greet);
```

**What to observe on first run:**
1. First click: 1–3s wall clock (sidecar spawn + ready probe). Subsequent clicks: ~20–80ms warm.
2. `call_count` increments across clicks — proof the process is staying alive, not respawning per call.
3. Backend log shows `[card-sidecar:hello-py] starting on :8200` once, then nothing more on subsequent calls.
4. After 10 min idle, next click goes back to the cold-start latency (idle shutdown).

**Adapting this to real workloads — the library-wrapping catalog:**

The four examples below show the four common shapes a sidecar takes. **Same FastAPI skeleton, differing only in which library is wrapped.** Pick the matching example, copy it, replace 2–3 lines with the actual logic.

- **`hello-llm`** — use Mica's LLM (`mica.llm.chat`). For summarization, classification, extraction, chat-with-context.
- **`hello-embed`** — wrap `sentence-transformers`. For semantic search prep, similarity scoring.
- **`hello-faiss`** — wrap FAISS as a warm vector index. For retrieval at scale.
- **`hello-pdf`** — wrap `pymupdf`. For PDF text extraction.

Combine: a RAG card = `hello-pdf` (parse) + `hello-embed` (chunk → vectors) + `hello-faiss` (search) + `hello-llm` (answer). One sidecar, four imports, no new mechanism.

**Heavy state at module scope.** Anything expensive — `SentenceTransformer(...)`, `faiss.IndexFlatL2(...)`, loading a corpus from disk — goes next to `app = FastAPI()`, NOT inside the request handler. Cold start grows by the load time; warm calls stay cheap.

**Bigger ready timeout.** If you load a 100MB+ model at spawn, set `"ready_timeout_ms": 60000` in metadata so Mica waits long enough for `/health` to first respond.

**TypeScript flavor.** Change `entry` to `server.ts` and Mica uses tsx instead. Same env vars, same `mica-sidecar` package (`import mica from "mica-sidecar"`), same `mica.fetch` URL scheme.

### Worked example — `hello-llm` (uses Mica's LLM)

The same `metadata.json` shape as `hello-py` with `"sidecar": { "entry": "server.py" }`. The differences are all in `server.py`:

```python
import os, traceback, uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

import mica_sidecar as mica   # the one Mica primitive — LLM access

PORT = int(os.environ["MICA_PORT"])
mica.log("starting on :", PORT)

app = FastAPI()

@app.exception_handler(Exception)
async def all_exceptions(request: Request, exc: Exception):
    print(traceback.format_exc(), flush=True)
    return JSONResponse(status_code=500, content={"error": f"{type(exc).__name__}: {exc}"})

class AskRequest(BaseModel):
    text: str

@app.get("/health")
async def health(): return {"ok": True}

@app.post("/summarize")
async def summarize(req: AskRequest):
    resp = mica.llm.chat(messages=[
        {"role": "system", "content": "Summarize the user's text in one sentence."},
        {"role": "user",   "content": req.text},
    ], max_tokens=200)
    return {"summary": resp.text, "model": resp.model}

uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="warning")
```

No URL. No model name. No `enable_thinking`. No auth token. All owned by Mica.

### Worked example — `hello-embed` (wraps sentence-transformers)

```python
import os, traceback, uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from typing import List

from sentence_transformers import SentenceTransformer   # standard library — used directly

import mica_sidecar as mica

PORT = int(os.environ["MICA_PORT"])
mica.log("loading embedding model…")
model = SentenceTransformer("all-MiniLM-L6-v2")          # ~80MB; module scope = load once
mica.log("ready, embedding dim:", model.get_sentence_embedding_dimension())

app = FastAPI()

@app.exception_handler(Exception)
async def all_exceptions(request: Request, exc: Exception):
    print(traceback.format_exc(), flush=True)
    return JSONResponse(status_code=500, content={"error": f"{type(exc).__name__}: {exc}"})

class EncodeRequest(BaseModel):
    texts: List[str]

@app.get("/health")
async def health(): return {"ok": True}

@app.post("/encode")
async def encode(req: EncodeRequest):
    vectors = model.encode(req.texts, normalize_embeddings=True)
    return {"vectors": [v.tolist() for v in vectors]}

uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="warning")
```

No Mica wrapper around the embedding library. The `SentenceTransformer` API is the API.

### Worked example — `hello-faiss` (wraps FAISS as a warm vector index)

```python
import os, traceback, uvicorn
import numpy as np
import faiss                                              # standard library
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from typing import List

import mica_sidecar as mica

PORT = int(os.environ["MICA_PORT"])
DIM = 384                                                 # MiniLM-L6 embedding dim
index = faiss.IndexFlatIP(DIM)                            # inner product = cosine on normalized vectors
labels: list[str] = []                                    # parallel array — id per vector
mica.log("FAISS index ready, dim =", DIM)

app = FastAPI()

@app.exception_handler(Exception)
async def all_exceptions(request: Request, exc: Exception):
    print(traceback.format_exc(), flush=True)
    return JSONResponse(status_code=500, content={"error": f"{type(exc).__name__}: {exc}"})

class AddRequest(BaseModel):
    vectors: List[List[float]]
    ids: List[str]

class SearchRequest(BaseModel):
    vector: List[float]
    top_k: int = 5

@app.get("/health")
async def health(): return {"ok": True}

@app.post("/add")
async def add(req: AddRequest):
    arr = np.array(req.vectors, dtype="float32")
    index.add(arr)
    labels.extend(req.ids)
    return {"ntotal": index.ntotal}

@app.post("/search")
async def search(req: SearchRequest):
    q = np.array([req.vector], dtype="float32")
    sims, idxs = index.search(q, min(req.top_k, index.ntotal))
    return {"results": [
        {"id": labels[int(i)], "similarity": float(s)}
        for s, i in zip(sims[0], idxs[0]) if int(i) >= 0
    ]}

uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="warning")
```

FAISS' API used directly. No Mica abstraction around it.

### Worked example — `hello-pdf` (wraps pymupdf)

```python
import os, base64, traceback, uvicorn
import fitz                                               # pymupdf — standard library
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

import mica_sidecar as mica

PORT = int(os.environ["MICA_PORT"])
mica.log("starting pdf parser on :", PORT)

app = FastAPI()

@app.exception_handler(Exception)
async def all_exceptions(request: Request, exc: Exception):
    print(traceback.format_exc(), flush=True)
    return JSONResponse(status_code=500, content={"error": f"{type(exc).__name__}: {exc}"})

class ExtractRequest(BaseModel):
    pdf_base64: str

@app.get("/health")
async def health(): return {"ok": True}

@app.post("/extract")
async def extract(req: ExtractRequest):
    pdf_bytes = base64.b64decode(req.pdf_base64)
    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    pages = [{"page": i + 1, "text": p.get_text()} for i, p in enumerate(doc)]
    doc.close()
    return {"pages": pages, "n_pages": len(pages)}

uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="warning")
```

`fitz` API used directly. The card.js side sends `pdf_base64`; the sidecar returns structured text per page.

**A real RAG card composes all four** — `hello-pdf` to parse the upload, `hello-embed` to vectorize chunks, `hello-faiss` to index and search, `hello-llm` to generate the answer. One `server.py`, all four libraries imported alongside `mica_sidecar`. No new mechanism beyond what's shown here.

## Worked example — counter card

`.mica/card-classes/counter/metadata.json`:

```json
{
  "extension": ".counter",
  "badge": "CTR",
  "defaultTitle": "Counter",
  "dependencies": { "scripts": [], "styles": [] }
}
```

`.mica/card-classes/counter/card.html` (fragment, top-level
`<div>`):

```html
<div style="display:flex;flex-direction:column;gap:8px;padding:12px">
  <div id="display" style="font-size:32px;text-align:center">0</div>
  <button id="inc">+</button>
</div>
```

`.mica/card-classes/counter/card.js` (top-level code, no class,
no `export`):

```js
const displayEl = container.querySelector('#display');
const btn = container.querySelector('#inc');

let count = parseInt(await mica.getContent()) || 0;
displayEl.textContent = count;

btn.addEventListener('click', async () => {
  count++;
  displayEl.textContent = count;
  await mica.files.write(mica.filename, String(count));
});

const unsub = mica.on('file-changed', (e) => {
  if (e.filename === mica.filename && !mica.isSelfEcho(e)) {
    mica.refresh();
  }
});

mica.onDestroy(() => { unsub(); });
```

Instance: create `docs/my.counter` with content `0`. Card
appears on the canvas.
