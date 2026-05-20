---
name: card-class-handbook
description: Knowledge reference for authoring Mica card classes — the CANONICAL CARD.JS shape, CARD_SHIM contract (`container` and `mica` are injected globals — DO NOT redeclare), metadata.json schema, mica.* API, channel handlers, and pitfalls. Load this BEFORE calling `mica_create_class` or `mica_edit_class_file`. The handbook is the contract those tools enforce; without it in working memory, common violations (top-level CARD_SHIM-global redeclaration, IIFE wrapping, `document.getElementById` instead of `container.querySelector`) recur and burn iteration cycles fixing post-write lint errors. Dispatched from `develop` step 4a.
---

# Card-Class Handbook

A **card class** defines a UI component. An **instance** is a file the class renders.

A card class is four files at `.mica/card-classes/<ext>/`:
`metadata.json`, `card.html`, `card.js`, `card.css`. Authored via
the `mica_create_class` tool (NOT raw `write_file`). Verified with
`render_capture`.

This handbook is the knowledge object you load before calling
`mica_create_class` or `mica_edit_class_file` — it teaches the
CANONICAL CARD.JS shape and CARD_SHIM contract those tools enforce.
The verb "card-class-handbook" in the dispatch language refers to
loading this handbook into context, not to a separate action: the
*action* is `mica_create_class`; this handbook is the *rules*.

Loaded from `develop` step 4a *after* spec + approval land. The
universal build flow — research → spec → approval → plan — lives in
`develop/SKILL.md`; don't restate it here. For cross-skill discipline
(reading, library reuse, API discipline, decomposition gates,
approval flow, naming) see `.qwen/skills/_conventions.md`. Tenet
numbers below refer to ARCHITECTURE.md / CLAUDE.md.

## Before creating: check the registry

`mica_list_classes()` returns the project-scoped + built-in classes
already available. If a listed class matches your intent, use it.
Do **not** create a project-scoped copy of a built-in (it just
shadows the built-in for this project with no benefit). If a class
might fit but you're not sure, `read_file
.mica/card-classes/<name>/metadata.json` (or the upstream
`card-classes/<name>/metadata.json` for built-ins) before deciding.

## Card architecture: decompose into the cheapest viable tier

A non-trivial card decomposes into subtasks. **For each subtask,
pick the cheapest viable tier from the four below.** Cards
routinely mix tiers — UI in card.js, an LLM stream from the
`llm-direct` handler, a CLI wrap from the `process` handler, plus a
sidecar for the residue that genuinely needs warm state. The
architecture lives in this decomposition; the rest of the handbook
tells you how to author each piece.

Walk the tiers in order. Stop at the cheapest tier that fits each
subtask. Anything you can do at Tier 1 you should not do at Tier 4.

### Tier 1 — `card.js` + browser APIs (+ optional CDN libraries)

The default. Rendering, interaction, animation, DOM, WebGL, Canvas,
Web Audio, IndexedDB, WebSockets. Plus any CDN library loaded via
`<script>` tag (Three.js, D3, transformers.js, pdf.js, Chart.js,
papaparse, ...). External HTTPS via `mica.fetch` (SSRF-guarded
proxy). Add libraries via `discover-dependency` +
`mica_install_skills` for canonical CDN URLs.

**Use when:** the subtask is achievable entirely in the browser.
Most data viz, most interactive UI, "show me something pretty,"
CRUD on the card's own file, calls to a public HTTPS API.

### Tier 2 — `mica.openChannel('turn', ...)` against the `llm-direct` handler

LLM streaming chat with a configured persona and model. The card
declares `metadata.handler = "llm-direct"` (or passes
`systemPrompt`/`model` per openChannel call). Mica owns the LLM
connection, streams tokens to card.js, and handles the vLLM
`enable_thinking` trap. **Zero server-side code.**

**Use when:** the subtask is "LLM in / LLM out" with no
server-side preprocessing. Examples: persona chat, "rewrite this
paragraph in a different tone," "explain like I'm five," code
review of pasted code, summarize-pasted-text. See § Server-side
channel handlers (or `curl /api/handlers`) for exact
`sendShapes` / `recvShapes`.

**The handler's working card.js skeleton is in your baseline.**
Once your spec declares `handler: <name>` (or `metadata.handler` is
set on the materialized class), every turn's canvas baseline
includes a `## Channel handler contracts in this project` section
with that handler's example skeleton — the canonical
`mica.openChannel(...)`, `channel.send({...})`, and
`channel.onData(evt => ...)` shapes plus per-model constraints.
**Copy from that section verbatim** when writing card.js — do NOT
invent the channel API from prior assumptions. Common hallucination
shapes that the manifest example refutes: `channel.on('token', cb)`
(does not exist — use `channel.onData(evt => { if (evt.type ===
'delta') ... })`), `mica.openChannel({handler, args})` (wrong shape
— first arg is the channel name string like `'turn'`, second arg
is the args object), `channel.send({role, content})` with OpenAI-
style chat shape (the handler's `sendShapes` is its own contract;
don't assume OpenAI-compat). If you don't see the section in your
baseline, your spec's `handler:` field isn't set — fix the spec,
the section appears next turn.

### Tier 3 — `mica.openChannel('session')` against the `process` handler

Spawn a CLI tool; bidirectional stdin/stdout/stderr. Card sends
`{ type: "start", command, args, ... }` to invoke; tool stdout
streams back as `stdout` events. Mica owns the lifecycle (no
sidecar boilerplate, no FastAPI, no port). **Zero server-side
code.** Worked example: `hello-process` in the catalog below.

**Use when:** the subtask is a one-shot wrap of an existing CLI
tool. The CLI ecosystem is enormous and many tasks have no good
Python/Node library equivalent — Tier 3 reaches all of it with one
line of card.js. **Evaluate Tier 3 BEFORE Tier 4 — many tasks
that look sidecar-shaped are actually process-shaped.**

| Task | Tier-3 invocation |
|---|---|
| OCR an image | `tesseract image.png - -l eng` |
| Extract PDF text | `pdftotext input.pdf -` |
| Transcode audio | `ffmpeg -i in.mp3 -ar 16000 out.wav` |
| Resize image | `convert in.jpg -resize 800x out.jpg` |
| Query JSON | `jq '.users[] \| .name' data.json` |
| Whisper.cpp transcribe | `whisper.cpp -f audio.wav -m model.bin` |
| Compress | `tar czf out.tar.gz dir/` |
| Code format | `prettier --write file.ts` |

Verify the CLI tool is on `$PATH` before committing to it — `which
<tool>` via `mica_shell` is enough.

### Tier 4 — sidecar (`server.py` or `server.ts` in `.mica/card-classes/<name>/`)

A long-running HTTP service wrapping libraries that need persistent
warm state, structured JSON I/O, or composition the cheaper tiers
can't deliver. The most expensive tier; reach for it last. Author
per § Card-class-private sidecars below.

**Use when:** none of tiers 1–3 cover the subtask. Specifically:

- Model weights loaded once, reused across requests
  (sentence-transformers, diffusers, transformers).
- In-memory indexes (FAISS, vector DB clients).
- Heavy library imports that take seconds to load (PyTorch, JAX).
- Multi-step composition with a structured JSON contract
  (retrieval that returns chunks + scores + sources together).
- File-system operations beyond what `mica.*` exposes.

**Language choice within Tier 4 — by ecosystem fit, not preference:**

| Task domain | Pick |
|---|---|
| ML inference / embedding / vector search | Python (sentence-transformers, FAISS, transformers, torch) |
| PDF / OCR / scientific data | Python (pymupdf, pandas, scipy) |
| Speech-to-text / image generation | Python (whisper, diffusers) |
| Time-series / forecasting | Python (prophet, statsmodels) |
| Async I/O heavy / scraping | TS (cheerio, axios) |
| JSON-shaped APIs / web stack | TS (native fit) |
| When in doubt | Python (broader ecosystem) |

**Verify each Python dependency BEFORE writing the spec.** For every package the sidecar will `import`, call `mica_inspect_python_package({ name: "<import-name>", python: "system" | "voice-venv" })`. The return is `{ installed, version, top_level_classes, top_level_functions, module_file, error? }`. Confirm `installed: true` AND record the version in the spec. If a package returns `installed: false` against `system`, retry against `voice-venv` (sentence-transformers, librosa, soundfile, fastapi are pre-installed there). If neither has it, the dep is unavailable in this environment — pick a different package OR change the architecture to avoid needing it. **Do NOT commit `import X` to server.py without this check** — the failure mode is the sidecar spawning, crashing at import time with a `ModuleNotFoundError`, and the agent burning turns to discover what `mica_inspect_python_package` would have reported in one call.

The spec for any sidecar-bearing card MUST include a **Verified dependencies** table — one row per import — alongside the Architecture Decomposition table. Same format as `inspect_url`'s output, persisted in the spec so future turns and human reviewers can audit what was checked against what interpreter:

```
## Verified dependencies (sidecar)

| Import | Interpreter | Version | Top-level surface used | Notes |
|---|---|---|---|---|
| sentence_transformers | voice-venv | 2.7.0 | SentenceTransformer (class) | tested via mica_inspect_python_package |
| fastapi | system | 0.115.0 | FastAPI (class), HTTPException | tested via mica_inspect_python_package |
| fitz | system | 1.24.10 | open, Page | (pymupdf — import name differs from PyPI name) |
```

This is the Tier 4 analog of "verify CDN URLs are reachable before committing them to the spec" (Tier 1) and "verify CLI tools are on PATH before committing" (Tier 3). Same discipline; different surface.

### Worked decompositions

Each subtask gets exactly one tier. The sidecar (if any) carries
ONLY the residue that can't live in cheaper tiers.

**PDF RAG card:**
- UI (upload, chat history, status) → Tier 1
- PDF text extraction → Tier 3 (`pdftotext`)
- Chunk + embed + index + search → Tier 4 sidecar (Python:
  sentence-transformers + FAISS)
- LLM answer generation, streamed → Tier 2 (`llm-direct`,
  retrieved chunks as systemPrompt)

The sidecar does ONLY retrieval — no LLM call in Python, no PDF
parsing in Python. A fraction of the surface area you'd write if
the sidecar swallowed every step.

**Speech-to-text + summary card:**
- UI → Tier 1
- Audio transcoding → Tier 3 (`ffmpeg`)
- Transcription → Tier 3 (`whisper.cpp`)
- Summary → Tier 2 (`llm-direct`)

Zero sidecar code.

**Web-scrape + summarize card:**
- UI → Tier 1
- HTML extraction → Tier 4 sidecar (TS: cheerio — Python ecosystem
  worse here)
- Summary → Tier 2

**Image-generation card:**
- UI → Tier 1
- SDXL inference → Tier 4 sidecar (Python: diffusers — model load
  is expensive, warm state required)
- No LLM step; output is an image.

**Currency converter card:**
- UI + external API fetch → Tier 1 (card.js + `mica.fetch`)
- No sidecar. No handler. No process.

### The decomposition belongs in the spec frontmatter

`canvas/<name>-spec.md` opens with a YAML frontmatter block that holds the structured part of the spec — the contract `mica_create_class` reads directly. Below it, the body is prose (intent, tradeoffs, open questions) for human review.

```markdown
---
card-class:
  name: pdf-rag                          # MUST match the spec filename stem
  badge: PRG
  default_title: PDF RAG
  handler: ~
  sidecar:
    entry: server.py
    ready_path: /health
    ready_timeout_ms: 30000
    python: voice-venv
  dependencies:
    umd_scripts: []                      # <script>-tag-loaded UMD URLs ONLY
    styles: []
    # ESM URLs do NOT go in umd_scripts. Load them inside card.js via
    # await import(url) and document them in the prose body for human review.
  subtasks:
    - {name: "render chat history", tier: 1, mechanism: "card.js + DOM", verify: "render_capture"}
    - {name: "extract PDF text", tier: 3, mechanism: "pdftotext via process handler", verify: "spawn from card.js, capture first stdout"}
    - {name: "vector index + search", tier: 4, mechanism: "Python sidecar: sentence-transformers + FAISS", verify: "end-to-end click"}
    - {name: "generate answer", tier: 2, mechanism: "llm-direct, retrieved chunks as systemPrompt", verify: "end-to-end click"}
  out_of_scope:
    - "multi-PDF corpora"
    - "OCR for image-only PDFs"
---

# PDF RAG Card

## Overview
A canvas card that ingests a PDF, indexes its text, and lets the user ask questions …
[1–3 paragraphs of intent, key tradeoffs, anything the user should review]
```

**The frontmatter is the contract.** When you call `mica_create_class({ name: "pdf-rag" })` — passing only the name — Mica reads the frontmatter and pulls badge, defaultTitle, dependencies, sidecar, handler, primaryFile from there. You only need to pass extra args explicitly when overriding what the spec said. **Write the structured part once in the spec; don't re-derive it for the tool call.** This eliminates the most common build-time bug (spec says `three@0.146 UMD`, tool call ends up passing `three@0.160 module` — the translation step is gone).

**The `subtasks` array is the decomposition forcing function.** Each entry asks for `{ name, tier, mechanism, verify? }` — the same thinking the older Markdown table forced, in the schema. **Don't skip it on Tier-1-only cards** (just write one row; that's still the discipline working). Skipping is the failure mode where every card silently grows a sidecar.

The frontmatter is what the user approves. If they want a different tier assignment ("don't write a sidecar for that — use process"), they redirect HERE, not after the code is written.

**For sidecar-bearing cards**, the prose body should also include a `## Verified dependencies (sidecar)` section that records `mica_inspect_python_package` results for each Python import (import name, interpreter, version, top-level surface used) — that's human-skim material; the structured frontmatter doesn't capture it. Verify deps BEFORE locking the frontmatter; if any return `installed: false`, change the dep or the interpreter and re-verify.

## Author atomically with `mica_create_class`

Card classes are authored via the `mica_create_class` tool, NOT raw `write_file`.
The tool owns the directory location, name shape, and `metadata.json` schema —
the framework cannot place files at wrong paths or with wrong metadata when
you go through the tool. Raw `write_file` to `.mica/card-classes/...` is
reserved for *editing existing* class files; class creation is exclusively
through this tool.

**With spec frontmatter (recommended):** call the tool with just `{ name }` (plus optional `card_html` / `card_js` / `card_css` content). Mica reads `canvas/<name>-spec.md`'s frontmatter and pulls everything else (badge, defaultTitle, scripts, styles, handler, sidecar, primaryFile) from there. **Write the structured part once in the spec; don't re-derive it for the tool call** — that translation is where wrong-version / wrong-URL / wrong-shape bugs sneak in.

```
mica_create_class({
  name: "world-clock",
  card_html: "<div class=\"card-world-clock\">...</div>",
  card_js:   "/* see CANONICAL CARD.JS pattern below */",
  card_css:  ".card-world-clock { ... }",  // optional
})
// metadata.json fields read from canvas/world-clock-spec.md frontmatter
```

**Without spec frontmatter (legacy / overrides):** any explicit arg wins over the spec. Pass badge, defaultTitle, scripts, styles, handler, sidecar, primaryFile inline when you need to override the spec OR when the spec has no frontmatter block. Pull verified `scripts` / `styles` URLs from the canvas decision that `discover-dependency` wrote — don't write CDN URLs from memory.

```
mica_create_class({
  name: "world-clock",                  // dir name; lowercase + dashes only, no dots
  badge: "WCK",                         // 1-4 char abbreviation
  defaultTitle: "World Clock",
  scripts: ["https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.js"],
  styles:  ["https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.css"],
  card_html: "<div class=\"card-world-clock\">...</div>",
  card_js:   "/* see CANONICAL CARD.JS pattern below */",
  card_css:  ".card-world-clock { ... }",  // optional
})
```

Returns `{ ok: true, dir: ".mica/card-classes/world-clock/", paths: { ... } }`.

If you omit `card_js` entirely, the tool writes a working stub in the
canonical shape (below) — edit the body via `mica_edit_class_file`,
don't rewrite from scratch.

**Re-call to UPDATE metadata in place.** When you need to change a
dependency, badge, defaultTitle, scripts, styles, handler, or
primaryFile on an existing class, just call `mica_create_class` again
with the same `name` and same `extension`. The metadata.json updates;
card.html / card.js / card.css are preserved (only touched if you pass
explicit content). **DO NOT** delete-then-recreate to change metadata —
that wastes 5+ tool calls and forces you to rewrite card.html and
card.js from stubs. Only changing `extension` requires a delete (it's
a rename that would orphan existing instances).

Companion tools:
- `mica_edit_class_file({ class, file: "card.js"|"card.html"|"card.css", content?, old_string?, new_string? })` — edit a class file with PRE-WRITE lint. For card.js, the lint that catches top-level redeclaration of CARD_SHIM globals (`mica`, `container`), ESM `import`/`export`, and other common mistakes runs BEFORE the write. Lint failures come back as a same-turn tool error so you can fix and retry without burning a card-error broadcast cycle. Use this INSTEAD of `write_file`/`edit` when modifying class files.
- `mica_create_card_instance({ class_extension, filename })` — creates an
  instance on the canvas at the right path.
- `mica_delete_card_instance({ filename })`
- `mica_delete_class({ name, force? })`
- `mica_list_classes()` — see what's registered before creating.

## CANONICAL CARD.JS — copy this shape

Every `card.js` you write should look like the counter below. Six lines do
six things; the names of those six things are the structure of the file.

```js
// 1. Query into the injected `container`. It's a CARD_SHIM global pointing
//    at this card's DOM root — your code uses it directly.
const titleEl = container.querySelector('.title');
const btnEl   = container.querySelector('button');

// 2. Script-scoped state — any name except `container` or `mica`.
let count = 0;

// 3. Functions at script scope. The runtime wraps your file in a closure;
//    that's already your "module." Plain function declarations, no IIFE.
function render() {
  titleEl.textContent = String(count);
}

// 4. DOM events on `container` or its descendants. The shim auto-cleans
//    listeners on unmount, so you don't track them yourself.
btnEl.addEventListener('click', () => {
  count += 1;
  render();
});

// 5. Anything that needs explicit teardown (timers, intervals, fetch
//    abort controllers, websockets, library disposers) → `mica.onDestroy`.
const id = setInterval(render, 1000);
mica.onDestroy(() => clearInterval(id));

// 6. First render at the bottom of the file.
render();
```

**Every card.js you write keeps this shape.** Counter, world clock, Three.js
scene, Leaflet map — only the body of `render()` and the contents of step 5
change. The skeleton is the same. When the body grows, split `render()` into
smaller functions; the six-step skeleton still wraps them.

Cards that load a library (Three.js, Leaflet) layer two extra patterns inside
the same skeleton:

- **Library init goes BETWEEN steps 1 and 2** — once-only setup like
  `const renderer = new THREE.WebGLRenderer();` `container.appendChild(renderer.domElement);`. Then your script-scoped state in step 2 references it.
- **Library teardown goes IN step 5** — `mica.onDestroy(() => { renderer.dispose(); /* dispose textures, geometries, controls */ });`. Without this, the canvas leaks GPU memory across remounts.

When `discover-dependency` selects a third-party library, run
`mica_install_skills` for it (see `discover-dependency/SKILL.md` step 4). The
installed library skill describes its disposers, init-order quirks, and
version-specific gotchas — read that skill BEFORE filling in the body, so
the body lands right the first time.

If you're about to write `const container = ...`, `import {...}`, `export
const`, or `(function(){ ... })()`, you've left the canonical shape. Stop
and rewrite the section to match.

## Reference: file roles and globals

### Required files

| File | Purpose |
|---|---|
| `metadata.json` | extension, badge, title, dependencies |
| `card.html` | static markup — IDs for anything `card.js` updates |
| `card.js` | behavior — runs as top-level code |
| `card.css` | scoped styles (optional) |
| `context.md` | class-level AI context (optional) |

`card.html` is a **fragment**, not a document. The server inlines
`card.js` and `card.css`; do not put `<script src="card.js">` or
`<link rel="stylesheet" href="card.css">` or `<!DOCTYPE>`/`<html>`
in `card.html`. External libraries go in
`metadata.json.dependencies.scripts`/`.styles`.

**Dependencies — invoke `discover-dependency` FIRST.** If your card needs ANY external library (Three.js, Chart.js, Leaflet, D3, anything), your next action is to invoke the `discover-dependency` skill BEFORE writing card.js or metadata.json. The skill does the curl-verification, picks a working CDN URL, and records the decision on canvas. Don't write CDN URLs from memory — it's how stale versions, ESM-only URLs that don't load in card.js's classic-script context, and hallucinated paths sneak in. One curl-verified UMD URL beats three rounds of "Failed to load dependency" debugging.

#### UMD vs ESM — two loading patterns

Mica cards support two CDN-loading patterns. **Always run `mica_inspect_url` first** to learn which one the library needs (the `format` field is `'UMD' | 'ESM' | 'CommonJS' | 'data' | 'unknown'`).

**Pattern A — UMD (`metadata.scripts` + global).** The default. `<script>` tag in card.html loads the library; access via a global namespace from card.js.

```json
// metadata.json
{ "dependencies": { "scripts": ["https://cdn.jsdelivr.net/npm/three@0.146.0/build/three.min.js"], "styles": [] } }
```

```js
// card.js
const scene = new THREE.Scene();  // THREE is the global from the UMD bundle
```

Use Pattern A whenever `mica_inspect_url` reports `format: 'UMD'`. This is most older libraries and stable versions of modern ones.

**Pattern B — Dynamic ES module import (`await import` in card.js, nothing in metadata.scripts).** For libraries that ship ESM only. CARD_SHIM wraps card.js in an async function, so top-level `await` works natively.

```json
// metadata.json — note empty scripts array
{ "dependencies": { "scripts": [], "styles": [] } }
```

```js
// card.js — top of file
const THREE = await import("https://cdn.jsdelivr.net/npm/three@0.169.0/build/three.module.min.js");
const scene = new THREE.Scene();
```

Use Pattern B whenever `mica_inspect_url` reports `format: 'ESM'`. The dynamic-import URL is the SAME ESM URL — you just load it inside card.js instead of via metadata.scripts. The library is accessed via the namespace object returned from `await import(...)`, not via a global.

**Pattern B — addons / sub-modules.** Many modern ESM libraries split their surface across multiple sub-paths. The main namespace import gives you the core; addons live at sibling URLs under the same version. **Each addon is its own dynamic import.** Examples:

```js
// Three.js — core + commonly-used addons
const THREE = await import("https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js");
const { OrbitControls }  = await import("https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/controls/OrbitControls.js");
const { GLTFLoader }     = await import("https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/loaders/GLTFLoader.js");
const { RGBELoader }     = await import("https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/loaders/RGBELoader.js");
const { EffectComposer } = await import("https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/postprocessing/EffectComposer.js");

// Now use them as if they were on THREE
const controls = new OrbitControls(camera, renderer.domElement);
```

**URL convention for Three.js addons:** `https://cdn.jsdelivr.net/npm/three@<ver>/examples/jsm/<category>/<Name>.js` — where `<category>` is `controls` / `loaders` / `postprocessing` / `helpers` / `lines` / `effects` / `objects` / `misc` / `nodes` etc., and `<Name>` is the exact class name. The destructured key in `const { Name } = await import(...)` IS the class name.

**General principle for ESM libraries with sub-paths:** if the threejs-skills (or any other skill pack) shows `import { X } from "package/addons/sub/path.js"` in its examples, translate to `const { X } = await import("https://cdn.jsdelivr.net/npm/package@<ver>/<corresponding-path>")`. The CDN path mirrors the package's internal layout — find it via `https://www.jsdelivr.com/package/npm/<package>` or `mica_inspect_url` on a guessed path.

**Anti-pattern: reimplementing addons inline.** When OrbitControls or similar isn't on the main namespace, DO NOT write your own `function OrbitControls(...) { ... }` in card.js. That's a 200-line reimplementation of debugged library code that will be subtly wrong. The correct fix is always a second `await import(...)` for the addon's URL.

**Wrong combinations fail loudly.** The `deps-reachable` validator at metadata-write time refuses ESM URLs in `dependencies.scripts` with a prescriptive error naming both fixes. If you see `\`dependencies.scripts\`: <url> — detected ES module`, switch to Pattern B (or pin to a UMD-compatible version of the library).

**Library-specific notes.** Three.js dropped UMD after r147 — pin to `three@0.146.0` for Pattern A, or use Pattern B for any later version. transformers.js / @xenova/* / lit / preact-signals are ESM-only — Pattern B mandatory.

### `metadata.json`

```json
{
  "extension": ".counter",
  "badge": "CTR",
  "defaultTitle": "Counter",
  "primaryFile": "counter.json",
  "dependencies": { "scripts": [], "styles": [] }
}
```

Required fields and their silent-failure modes if omitted:

| Field | Silent failure if omitted |
|---|---|
| `extension` | Auto-repaired from directory name with a warning. Always include. |
| `badge` | Card renders with a `???` placeholder on the canvas. |
| `defaultTitle` | Title falls back to raw filename; functional but ugly. |
| `dependencies` | No scripts/styles loaded. |

`primaryFile` is optional (only for classes that render a
specific filename inside a directory instance). Do **not** include
`name`, `description`, or `version` — those are package.json-shaped
fields the framework ignores.

### CARD_SHIM globals in `card.js`

Available without import:

| Global | Shape |
|---|---|
| `container` | this card's DOM element. `container.querySelector(...)` is scoped here |
| `mica.filename` | instance file name **canvas-relative** (e.g. `"my.counter"` — no `canvas/` prefix). Pinned files outside canvas surface with `../` (e.g. `"../docs/notes.md"`) |
| `mica.windowId` | stable id for this browser **tab** |
| `mica.cardId` | stable id for this card **instance** |
| `mica.isSelfEcho(event)` | `(event) => boolean` — true if event was caused by THIS card writing |
| `mica.getContent()` | `async () => string` — read the instance file |
| `mica.files.list()` | `async () => [{ path, isFile, isFolder, size, modifiedAt }]` — **canvas files only** (siblings + pinned) |
| `mica.files.listAll()` | same shape, **project-wide** — includes `.mica/`, `.qwen/`, etc. Use only for debug/inspector cards |
| `mica.files.read(path)` | `async (path) => string` — paths are **canvas-relative** (see Path addressing below) |
| `mica.files.readBinary(path)` | `async (path) => ArrayBuffer` — canvas-relative path |
| `mica.files.write(path, content)` | `async (path, content: string \| ArrayBuffer \| Uint8Array \| Blob \| File) => void` — canvas-relative path; auto-routes by type, parents auto-created |
| `mica.files.delete(path)` | `async (path) => void` — canvas-relative path |
| `mica.files.url(path)` | `(path) => string` — for `<img src>`, `<embed>`, downloads — canvas-relative path |
| `mica.cardClasses.list()` | `async () => [{ name, builtIn, format }]` |
| `mica.cardClasses.get(name)` | `async (name) => metadataObject` — parsed `metadata.json` (extension, badge, defaultTitle, dependencies) |
| `mica.layout()` | `async () => { cards: { [canvasRelPath]: {x,y,w,h} }, bounds?: {w,h} }` — current canvas layout for this device class (see § Canvas introspection) |
| `mica.fetch(url, opts?)` | server-proxied HTTP — see § External HTTP |
| `mica.on(event, cb)` | subscribe; events: `file-changed`, `file-created`, `file-deleted`, `layout-changed`, `card-error` |
| `mica.onDestroy(cb)` | cleanup on unmount |
| `mica.openChannel(label, args)` | bidirectional stream to a server plugin |
| `mica.refresh()` | reload the card |
| `mica.reportError(message)` | surface a red "Send to agent" bubble in chat cards |

The `mica.files.*` and `mica.cardClasses.*` namespaces are
Proxy-guarded — calling a method that doesn't exist throws
`TypeError: mica.files has no method 'X'. Known: ...`. To append:
read → concat → write.

### Path addressing

Cards live on the canvas. All `mica.files.*` paths and `mica.filename`
are **canvas-relative**, like a Unix shell with the canvas as `cwd`:

| You write | Resolves to |
|---|---|
| `"foo.bar"` (bare) | `<canvasRoot>/foo.bar` — sibling card on the canvas |
| `"sub/foo"` | `<canvasRoot>/sub/foo` — canvas subdirectory |
| `"../foo"` | one level above canvas — pinned files, project root |
| `"/foo"` | project-root absolute (rare; bypass canvas entirely) |
| `"../.mica/X"` | reach into Mica's internal state (use at your own risk; schema may change between Mica versions) |

Self-reference is prefix-free:
```js
const data = await mica.files.read(mica.filename);          // own instance file
await mica.files.write(mica.filename, JSON.stringify(state)); // round-trip
```

Sibling-card reference is a bare name — no `canvas/` prefix to remember
or hardcode. If a card's logic ever wants to construct a sibling path,
the bare name IS the path:
```js
const referenced = await mica.files.read("test-dsm.data-source-monitor");
```

Event payloads (`file-changed`, `file-created`, `file-deleted`,
`card-error`) carry `event.filename` already canvas-relative, so
`event.filename === mica.filename` works for own-file filtering.

`container` and `mica` are injected globals. **Do not redeclare
them** with top-level `const`/`let` — the runtime wraps your
script in a closure and the redeclaration produces a hard
`SyntaxError` at mount, with the card never starting. Read the
mica.* table and use exact signatures (tenet 16); when a method
isn't listed, it doesn't exist.

### Event listeners — prefer `container`, the shim handles cleanup

For DOM events, attach to `container` (or one of its descendants)
whenever possible, NOT `document` or `window`:

```js
container.addEventListener('keydown', onKey);   // ✓ scoped, auto-cleaned
container.querySelector('#btn').addEventListener('click', onClick);  // ✓
```

The shim auto-cleans listeners attached via `window.addEventListener`,
`document.addEventListener`, `setInterval`, `setTimeout`, and
`requestAnimationFrame` — they all unregister when the card unmounts.
If you must use `document` or `window` (e.g., a global keyboard
shortcut, or a non-bubbling event you can't catch from `container`),
just use them — the shim wraps them transparently.

What you should NOT do: attach via `_rd.addEventListener(...)` or
some other direct reference that bypasses the shim. Anything that
escapes the shim's wrap leaks across re-renders and accumulates a
stack of stale listeners over the page's lifetime — a real failure
mode that caused "weird keyboard behavior" until the shim was
extended to cover `document` listeners (2026-05-02). Don't get
clever; just use `document` / `window` / `container` directly.

If you have a callback you specifically need to clean up at a
different time than card unmount, use `mica.onDestroy(unsubFn)`
to register the cleanup, OR keep the unsubscribe handle and call
it explicitly when needed (e.g., the cleanup pattern at
[card.js:411](#L411) below).

## Canvas introspection — `mica.layout()` and `mica.cardClasses.get(name)`

For cards that reflect on the canvas itself — overview/minimap, navigation, layout linters — there are two introspection helpers:

```js
const layout = await mica.layout();
// {
//   cards: {
//     "canvas/foo.qwen": { x: 40, y: 40, w: 551, h: 766 },
//     "canvas/bar.todo": { x: 619, y: 40, w: 300, h: 200 },
//     ...
//   },
//   bounds: { w: 1920, h: 1080 }   // optional
// }
```

`mica.layout()` returns the current canvas layout for the device class the user is viewing. Pairs with the change event:

```js
const unsub = mica.on('layout-changed', async () => {
  const fresh = await mica.layout();
  render(fresh);
});
```

For card-class metadata (badge, defaultTitle, dependencies):

```js
const meta = await mica.cardClasses.get('qwen');
// { extension: '.qwen', badge: 'QWEN', defaultTitle: 'Qwen Agent', displayName: 'Qwen Code', dependencies: { ... } }
```

Use `mica.cardClasses.list()` first if you don't know the class name. Combine with `mica.files.list()` to build a full picture: file paths + extensions from `list()`, positions from `layout()`, badges/titles from `cardClasses.get(ext)`.

**Don't** reach into `../.mica/layout.json` or `../.mica/card-classes/*/metadata.json` directly via `mica.files.read('/.mica/...')`. Those paths exist (the `/foo` project-root-absolute escape works), but the schemas are internal and may change between Mica versions; the introspection helpers above are the stable interface. The `/foo` escape stays available for genuine internal reads (debug cards), not for routine canvas reflection.

## External HTTP via `mica.fetch(url, opts)`

Cards cannot hit most public APIs directly — CORS blocks them.
`mica.fetch` proxies through Mica's server. SSRF-protected
(blocks loopback / private / link-local / cloud-metadata IPs).
Rate-limited 120 req/60s per project. 10 MB cap, 60 s max
timeout.

The Promise **always resolves**. Check `errorCode` first
(our-side: SSRF, DNS, timeout, rate limit), then `status`
(upstream HTTP). Body is always a string.

```js
const r = await mica.fetch('https://api.example.com/items', {
  method: 'POST',
  headers: { 'Authorization': 'Bearer ' + KEY },
  body: JSON.stringify({ name: 'foo' }),
  timeout: 15000,
});
if (r.errorCode) { /* our-side failure: r.error human-readable */ }
else if (r.status >= 400) { /* upstream HTTP error */ }
else { const data = JSON.parse(r.body); /* ... */ }
```

`errorCode` values: `url_invalid`, `ssrf_blocked`, `dns_error`,
`connect_error`, `timeout`, `rate_limited`, `response_error`,
`internal_error`. `rate_limited` includes `retryAfterMs` —
respect it; don't fire-loop. For binaries (PDFs, images), use
`mica.files.url()` + `<img>`/`<embed>`, not `mica.fetch`.

For Mica's own `/api/*`, prefer `mica.files.*` helpers (auto
URL-encode, set `source`/`cardSource`). Raw `fetch('/api/...')`
works too — the runtime auto-injects `X-Mica-Project`.

## WebSocket events via `mica.on(event, cb)`

| Event | Payload |
|---|---|
| `file-changed` | `{ filename, source, cardSource? }` |
| `file-created` | `{ filename, source, cardSource? }` |
| `file-deleted` | `{ filename }` |
| `layout-changed` | `{ source, device }` |

`source` is the writer's `mica.windowId` (per tab), `"agent"`,
or `"external"` (git pull, manual edit). `cardSource` is the
writer's `mica.cardId`. To skip self-echoes use
`mica.isSelfEcho(e)` — **not** `e.source !== mica.windowId`
(windowId is per-tab, so it suppresses sibling cards in the same
tab).

## Server-side channel handlers

Some card classes need bidirectional duplex streams — terminal
PTYs, streaming LLM completions, agent loops. Existing
handlers wired to fixed extensions (no work to use them):

| Card class | Handler | What it does |
|---|---|---|
| `.qwen` | Qwen agent loop | Project-wide chat with skills + canvas baseline |
| `.claude` | Claude Code agent loop | Same shape, Claude SDK |
| `.terminal` | PTY (node-pty) | Terminal |
| `.llm-chat` | Streaming chat | Generic LLM chat |
| `.skills` | SKILL.md authoring | Propose / apply |
| `.canvas-back` | canvas-back.md | Propose / apply |

### Reusable handlers — **do NOT write a server plugin**

Mica ships **reusable parameterized handlers** that any card class
can opt into via `metadata.json`. Adding a new card class that
needs server-side capability requires zero server code in most
common cases.

**Two reusable handlers are most relevant for new card classes:**

| Handler | What it gives you | When to pick |
|---|---|---|
| `llm-direct` | Streaming chat against an LLM with a fixed system prompt + per-turn user message. Handler manages the streaming round-trip. | LLM-driven cards: single-purpose assistant, summarizer, persona-style chat. |
| `process` | Spawn a long-lived subprocess; bidirectional stdin/stdout/stderr; lifecycle-driven start/stop. | Wrapping CLI tools (nvidia-smi, ffmpeg, autoresearch), language servers, daemons, polling tasks. |

**The pattern (same for both):**

1. **Discover.** `curl http://localhost:3002/api/handlers` returns
   every reusable handler with its `name`, `description`,
   `whenToUse`, `argsSchema`, `sendShapes`, `recvShapes`. Read
   `whenToUse` to pick.
2. **Pick** by `whenToUse`. If nothing fits, flag this to the
   human — agents do not write server plugins.
3. **Wire.** In your card class `metadata.json` set
   `"handler": "<name>"`. In `card.js` call
   `mica.openChannel("session", args)` and send/receive
   per `sendShapes` / `recvShapes`.
4. **Trust the schema.** Bad args fail at the channel boundary
   with a structured error citing the failing path. Treat that
   error as ground truth — fix the args, don't argue with it.

**Critical reminder — `metadata.handler` is required when you use
a reusable handler.** Without the field, the framework auto-routes
to a handler matching the card class extension; if none exists,
channel_open fails with "No handler registered for: <ext>.
Available handlers: ..." (the error names the fix). The recurring
gotcha: `mica_create_class` accepts a `handler` parameter — pass
it explicitly when the card needs a reusable handler.

#### LLM-driven cards — `metadata.handler: "llm-direct"`

`llm-direct` is the simplest path for a card that streams a
single-prompt LLM exchange — `metadata.json` declares
`"handler": "llm-direct"`, `card.js` opens a channel and reads
streaming tokens. No server-side code on the card class side.
Read `/api/handlers` for the exact `sendShapes` / `recvShapes`
and the optional args (e.g., model override, system prompt
source). Treat that schema as the contract.

#### Long-running subprocess cards — `metadata.handler: "process"`

The `process` handler is **lifecycle-driven**: the subprocess is
NOT spawned at channel-open time. Card opens the channel first
(no required args), then sends a `start` message with the
command + args + cwd + env when it's ready. This lets the same
channel survive multiple start/stop cycles and lets the card
load per-instance config before invoking.

**Card.js shape (canonical):**

```js
const ch = mica.openChannel("session");  // no args at open time
let running = false;

ch.onData((msg) => {
  if (msg.type === "idle")     { /* nothing running yet — show Start UI */ }
  if (msg.type === "started")  { running = true;  /* show pid, set status running */ }
  if (msg.type === "stdout")   { /* append msg.data to log pane */ }
  if (msg.type === "stderr")   { /* append msg.data with stderr styling */ }
  if (msg.type === "exit")     { running = false; /* code, signal */ }
  if (msg.type === "error")    { /* spawn or runtime error — surface to user */ }
});

function start() {
  ch.send({
    type: "start",
    command: "nvidia-smi",
    args: ["--query-gpu=...", "-l", "1"],
    cwd: "/workspaces/.cache/<tool>",          // optional; defaults to project root
    env: { "MY_KEY": "${MY_KEY}" },             // optional; ${VAR} interpolated
  });
}

function stop() { ch.send({ type: "signal", signal: "SIGTERM" }); }

mica.onDestroy(() => { try { ch.close(); } catch {} });
```

**Common patterns:**

- **Tool data → chart.** Subprocess emits CSV/JSON to stdout; card parses each `stdout` event, appends to a chart's data series.
- **Persistent service.** `start` once, send periodic `input` messages with line-delimited commands; receive responses on `stdout`.
- **Restart on config change.** When the user changes the instance file, send `signal` + wait for `exit` event + send fresh `start` with new args.

**On attach (page reload, second tab opens the card):** the
handler emits `{type: "idle"}` if no subprocess is running, OR
replays scrollback (`stdout` data) + a fresh `started` event if
one is. Card UI just appends — no special-case "scrollback"
handling needed.

**Don't:**
- Don't spawn at openChannel time. The handler doesn't accept
  command/args/cwd in openChannel args. Use `start` messages.
- Don't send another `start` while the subprocess is running.
  Send `signal`, wait for `exit`, then `start` again. Two-stage
  restart.
- Don't use this for stateless tool calls the agent should
  invoke directly. Those go in `<project>/.mica/tools.json` for
  the cli-mcp adapter (see `add-third-party-tool` skill). The
  process handler is for stateful, persistent subprocesses
  driven by card UI.

**Failure mode to recognize:** if you see a card-error broadcast
of "No handler registered for: <your-extension>", the
`metadata.handler` field is missing. The error message tells you
the available handlers — pick the right one, set the field, save
metadata.json, retry.

The legacy `.llm-chat` / `.terminal` / `.qwen` / `.claude`
extensions stay routed by file extension as in the table above.
The `metadata.handler` mechanism is additive and only kicks in
when present.

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
| `MICA_PROJECT_DIR` | absolute path to the project | available as `mica.project_dir` |
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

```python
import os, traceback, uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

PORT = int(os.environ["MICA_PORT"])              # never hardcode
PROJECT_DIR = os.environ["MICA_PROJECT_DIR"]
print(f"[my-card] starting on :{PORT}", flush=True)  # logs go to backend.log

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

uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="warning")
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
- **Don't `import` external libs without verifying they're available.** System Python has sentence-transformers, numpy, FastAPI, httpx. TS/Node has whatever Mica's node_modules ships. Beyond that, you'd need to vendor or install (not supported in the prototype).

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

## Verify with `render_capture`

`render_capture({ filename, user_intent? })` — inspect
the PNG. JSON validity and `node -c` only prove syntax; only a
visual check proves the card mounted, the layout works, and no
error banner appears.

**Pass `user_intent` on every UX-correction follow-up turn.** The
parameter takes the user's most recent UX request in your own words
(e.g. `user_intent: "label should say 'Hot Dog' without the 🌭 emoji"`).
When supplied, the captioner COMPARES the screenshot against the
request and returns MATCHES / MISMATCH / UNVERIFIABLE instead of the
plain CLEAN. Omit `user_intent` only on initial build verification
where there's no specific UX claim to verify yet.

This solves the failure mode where the JS-error buffer is empty
(CLEAN verdict) but the visible UI is still wrong — so the agent
declares done, the user looks at the screen, the bug is still there,
they report it again, and the cycle repeats. With `user_intent`,
MISMATCH stops that loop at agent-time.

For every CDN script/style URL and every URL hardcoded in
card.js, `curl -sI -L <url> | head -1` to confirm reachability
before declaring done. Full tier table in `_conventions.md`
§ API discipline. Append a `## Smoke test results` row to
spec.md for each URL.

### When `render_capture` surfaces a runtime error — pivot to `fix-bug`

If the card-error buffer reports `X.method is not a function`,
`X.method is undefined`, or similar API-shape errors, your next move
is **`skill('fix-bug')`** — NOT another `mica_edit_class_file` guess.
Stay in the develop / iterate loop on layout, sizing, or content
issues; pivot to `fix-bug` for runtime API errors. The fix-bug skill
has the discovery procedure: `mica_inspect_url` on the library's CDN
URL → read the `methods` array → use the real public method name.
Guessing alternate method names is the failure mode that compounds
(world23: `marker.setOpacity` → guess `bindPopup` → `terminator.update`
→ delete-and-recreate spiral).

### After render_capture: follow the verdict tag

The tool's result starts with one of eight verdict tags. Each maps to a single next move:

- `[render_capture: CLEAN]` — initial build verified (no `user_intent` passed). Write your one-paragraph summary to the user and END THE TURN. Do not call render_capture again.
- `[render_capture: MATCHES]` — UX request verified against image (you passed `user_intent`, captioner confirmed match). Same terminal state as CLEAN — write the summary and end.
- `[render_capture: MISMATCH]` — captioner says the visible card does NOT satisfy the user's request. **Do NOT declare done.** Edit (`mica_edit_class_file`), then re-call render_capture with the same `user_intent`. The captioner's EVIDENCE line names what's wrong.
- `[render_capture: UNVERIFIABLE]` — user's request is about behavior, state, or interaction a still image can't show (animations, post-click state, dynamic updates). Three valid moves: (1) trigger the state change and re-capture, (2) end the turn with a clear summary describing expected behavior so the user can verify on their screen, (3) re-read the request — if it was actually about visible appearance, re-call without `UNVERIFIABLE`-friendly framing.
- `[render_capture: INTENT-UNPARSED]` — captioner didn't follow the VERDICT/EVIDENCE format. Read the caption manually, decide if the user's request is satisfied, and proceed accordingly.
- `[render_capture: ERRORS — N buffered]` — fix each listed error (`mica_edit_class_file`), then re-call render_capture once. ERRORS means the build is NOT complete regardless of how the screenshot looks.
- `[render_capture: WEBGL-OPAQUE]` — captioner sees black; apply the `mica.onCapture` hook or `preserveDrawingBuffer: true` (handbook § "render_capture screenshot is black for WebGL / Three.js cards"). Then re-capture once. Don't iterate on CSS/dependencies/scene composition — that's the phantom-chase failure mode.
- `[render_capture: CAP-REACHED]` — end the turn with a plain-text summary; the cap resets on the user's next message.

CLEAN and MATCHES are terminal states: the next thing the agent emits should be the user-visible summary, not another tool call. Don't relitigate "is this really done?" — the tag is the signal.

**MISMATCH is the most common new failure mode to attend to.** Before MATCHES existed, the agent's habit on a UX-correction turn was: edit → render_capture → CLEAN → "done!" → user re-reports the bug. With MISMATCH, the agent learns mid-turn that the edit didn't actually fix the visible problem and can iterate before the user is involved. **Always pass `user_intent` on UX-correction follow-up turns** so the loop short-circuits at agent-time instead of user-time.

### Card-error buffer can lag the file

The `card-error` event is emitted by the BROWSER when the card.js
throws at init. After you `mica_edit_class_file`, the browser has to
re-fetch and re-execute card.js before a fresh error can be reported
— and `render_capture` may capture before that cycle completes. So
**if the buffer shows an error you've already fixed in the file,
that's likely stale, NOT a cache problem in the card class.** Verify
with `read_file` that your edit landed; if it did, give the browser
a moment (or trigger an explicit refresh by `mica_edit_class_file` of
a no-op whitespace change). **Don't reach for `mica_delete_card_instance`
to "clear cache"** — that destroys layout state and is rarely the
right move; it should be a last resort, not a debugging step.

## Pitfalls

### Partial edit followed by full-file rewrite eats your own fix

The single most common iteration-cost amplifier across observed builds (rag2–rag6, hotdog, orbit2, orbit3). The shape:

1. **Turn N**: agent makes a small targeted edit via `mica_edit_class_file({ old_string, new_string })`. The fix is precise — replaces one line, e.g. `const clock = THREE.Clock;` → `const clock = new THREE.Clock();`.

2. **Turn N+1 or later**: agent reads the file, decides to "improve" something unrelated, and calls `mica_edit_class_file({ content: "<entire new card.js>" })` — full-file rewrite. The rewrite re-types card.js from scratch based on the agent's mental model, which may still reflect the PRE-fix state of the file (the agent's training-memory pattern is `const clock = THREE.Clock`, not the post-fix `new THREE.Clock()`).

3. **Result**: the previous turn's fix is silently reverted. The original bug is back. The card errors again. The agent doesn't notice because nothing tells it "you just undid your last fix."

**Why this happens:** the partial edit lives only in the file on disk; the agent's working memory of the file's contents is whatever it last *read* via `read_file`. If the agent edits without re-reading, its mental model of the file is stale. A subsequent full-file rewrite, generated from that stale model, eats the targeted fix.

**Rules to avoid this:**

1. **Prefer targeted edits over full rewrites whenever possible.** The `mica_edit_class_file({ old_string, new_string })` form preserves every line you didn't touch. The `mica_edit_class_file({ content: ... })` form replaces everything.

2. **If you MUST do a full rewrite, `read_file` immediately before** so your content includes the latest state — including any targeted fix from a prior turn. Stale-model rewrites are the bug; reading-before-writing is the prevention.

3. **After a full rewrite, re-verify with `render_capture`** (with `user_intent`) so a re-introduced bug surfaces in the same turn. If the captioner reports MISMATCH on a request you thought was already satisfied, that's the eat-your-own-fix signal.

4. **Multiple turns of `clock.getElapsedTime is not a function` across consecutive edits** is the canonical observable symptom — same error after each edit means the edit isn't actually changing the broken line. Stop editing; re-read the file; verify the broken line is what you think it is.

### Card class not appearing? Never restart.

The file watcher hot-reloads card-class directories on disk
change. The fix is never a server restart.

| Symptom | Real cause |
|---|---|
| `curl /api/card-classes` doesn't list it | The endpoint is project-scoped. Use `mica.cardClasses.list()` from inside a card, or pass `-H 'X-Mica-Project: <project>'`. |
| Instance renders as TXT badge | `extension` in `metadata.json` doesn't match the parent directory name. |
| Card mounts as a blank box | `card.html` rendered but `card.js` errored. Check chat for a `[card-error]` broadcast — usually a syntax error or a redeclared CARD_SHIM global. |
| Edit doesn't update | Click off and back, or make a no-op edit to the instance file to trigger a `file-changed` event. |

If you genuinely think a `server/*.ts` change needs a restart,
ask the user inline — don't run `scripts/restart.sh` yourself
(you live inside the backend's process tree).

### "Failed to load dependency: <url>" loop

When the chat surfaces this card-error, the URL itself is the
prime suspect. **Do not** re-read `metadata.json` looking for
clarity — the file contains exactly the URL that's failing.
Re-reading produces no new information; the loop runs until the
SDK kills it.

1. Verify with `curl -sI -L "<url>" | head -1`. If 404, the URL
   is hallucinated.
2. Find the real URL via npm registry
   (`curl -s https://registry.npmjs.org/<pkg>` for `dist-tags.latest`
   and `main`) or jsdelivr
   (`https://www.jsdelivr.com/package/npm/<pkg>` lists every
   tarball file).
3. Update `metadata.json`, ask the user to refresh.

Time budget: ONE round of curl + one metadata edit. If the
second URL also 404s, stop and ask the user.

### `render_capture` screenshot is black for WebGL / Three.js cards

`render_capture` defaults to `html2canvas`, which reads `<canvas>`
content via `canvas.toDataURL()`. WebGL contexts (Three.js, regl,
PixiJS in WebGL mode, Babylon, raw WebGL) return blank from
`toDataURL` because the GPU discards the back buffer after compositing
unless preserved. Result: captures come back transparent / black
even when the user sees the scene rendering correctly on screen.

**Preferred fix — register `mica.onCapture(cb)`.** The shim
exposes a snapshot hook that the screenshot pipeline calls *before*
falling back to `html2canvas`. Inside the callback, render
on-demand and return a dataURL. No `preserveDrawingBuffer` flag
needed; the pipeline accepts whatever you produce.

```js
mica.onCapture(() => {
  // Render once at capture time so the back buffer is current.
  renderer.render(scene, camera);
  return canvasEl.toDataURL("image/png");
});
```

The hook is per-card, automatically cleaned up on unmount, and
applies a 5-second timeout. If the callback throws or times out
the pipeline falls back to `html2canvas` and you get the blank-
canvas symptom anyway, so make the body fast and synchronous
(or at least quick to resolve). Works for any rendering tech —
OffscreenCanvas, regl, Babylon, video elements, anything that
can produce a dataURL.

**Fallback fix (if for some reason you don't register `onCapture`):**
construct the WebGL renderer with `preserveDrawingBuffer: true`.
This keeps the back buffer readable so html2canvas's toDataURL
returns the last frame.

```js
const renderer = new THREE.WebGLRenderer({
  canvas: canvasEl,
  antialias: true,
  preserveDrawingBuffer: true,  // fallback for non-hook capture
});
```

Symptom that points here: `render_capture` describes the canvas
as "completely black" / "blank" / "transparent" while the user
confirms they see content on screen. Don't add debug cubes /
backgrounds / wrappers chasing a phantom — register the hook (or
flip the flag) and re-capture.

## References

- `.qwen/skills/develop/SKILL.md` — universal build flow
  (research, spec, approval, plan-or-inline) that gates this
  skill.
- `.qwen/skills/_conventions.md` — reading, reuse, API
  discipline, dispatch, decomposition gates, approval flow,
  naming.
- `ARCHITECTURE.md` — authoritative `mica.*` API surface and
  framework internals.
- `card-classes/llm-chat/` + `server/plugins/llmChat.ts` —
  reference channel-handler pair.
