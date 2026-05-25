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

### Worked decompositions — five tier-mix examples

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

**The frontmatter is the contract.** When you call `mica_create_class({ name: "pdf-rag" })` — passing only the name — Mica reads the frontmatter and pulls badge, defaultTitle, dependencies, sidecar, handler, primaryFile from there. You only need to pass extra args explicitly when overriding what the spec said. **Write the structured part once in the spec; don't re-derive it for the tool call.** This eliminates the most common build-time bug — spec records one version and format, the tool call passes a different version or format, because the translation step is where divergence sneaks in.

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
  name: "<class-name>",
  card_html: "<div class=\"card-<class-name>\">...</div>",
  card_js:   "/* see CANONICAL CARD.JS pattern below */",
  card_css:  ".card-<class-name> { ... }",  // optional
})
// metadata.json fields read from canvas/<class-name>-spec.md frontmatter
```

**Without spec frontmatter (legacy / overrides):** any explicit arg wins over the spec. Pass badge, defaultTitle, scripts, styles, handler, sidecar, primaryFile inline when you need to override the spec OR when the spec has no frontmatter block. Pull verified `scripts` / `styles` URLs from the canvas decision that `discover-dependency` wrote — don't write CDN URLs from memory.

```
mica_create_class({
  name: "<class-name>",                 // dir name; lowercase + dashes only, no dots
  badge: "<1-4 chars>",
  defaultTitle: "<Display Name>",
  scripts: ["https://cdn.jsdelivr.net/npm/<pkg>@<version>/<umd-path>.js"],
  styles:  ["https://cdn.jsdelivr.net/npm/<pkg>@<version>/<css-path>.css"],
  card_html: "<div class=\"card-<class-name>\">...</div>",
  card_js:   "/* see CANONICAL CARD.JS pattern below */",
  card_css:  ".card-<class-name> { ... }",  // optional
})
```

Returns `{ ok: true, dir: ".mica/card-classes/<class-name>/", paths: { ... } }`.

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
- `mica_edit_class_file({ class, file: "card.js"|"card.html"|"card.css", content?, old_string?, new_string? })` — edit a class file with PRE-WRITE lint. For card.js, the lint that catches top-level redeclaration of the injected globals (`mica`, `container`), ESM `import`/`export`, and other common mistakes runs BEFORE the write. Lint failures come back as a same-turn tool error so you can fix and retry without burning a card-error broadcast cycle. Use this INSTEAD of `write_file`/`edit` when modifying class files.
- `mica_create_card_instance({ class_extension, filename })` — creates an
  instance on the canvas at the right path.
- `mica_delete_card_instance({ filename })`
- `mica_delete_class({ name, force? })`
- `mica_list_classes()` — see what's registered before creating.

## CANONICAL CARD.JS — copy this shape

Every `card.js` you write should look like the counter below. Six lines do
six things; the names of those six things are the structure of the file.

```js
// 1. Query into the injected `container`. It's a wrapper-provided global pointing
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

**Every card.js you write keeps this shape.** Whatever the card class does — counter, viewer, editor, visualization — only the body of `render()` and the contents of step 5 change. The skeleton is the same. When the body grows, split `render()` into smaller functions; the six-step skeleton still wraps them.

Cards that load a library layer two extra patterns inside the same skeleton:

- **Library init goes BETWEEN steps 1 and 2** — once-only setup like creating a renderer instance and appending its element to `container`. Then your script-scoped state in step 2 references it.
- **Library teardown goes IN step 5** — `mica.onDestroy(() => { /* dispose renderer + any textures, geometries, controls */ });`. Without this, the canvas leaks GPU/CPU memory across remounts.

When `discover-dependency` selects a third-party library, run
`mica_install_skills` for it (see `discover-dependency/SKILL.md` step 4). The
installed library skill describes its disposers, init-order quirks, and
version-specific gotchas — read that skill BEFORE filling in the body, so
the body lands right the first time.

If you're about to write `const container = ...`, `import {...}`, `export
const`, or `(function(){ ... })()`, you've left the canonical shape. Stop
and rewrite the section to match.

**Note on naming — `CARD_SHIM` is the framework's internal name, NOT a
runtime symbol.** Mica wraps each card.js file in an async function
(internally called the CARD_SHIM template) that injects `container`
and `mica` as locally-scoped globals. The wrapper is invisible to your
card.js code. **You cannot reference `CARD_SHIM` from card.js — it's
not a variable, not a namespace, not anything you can import.** Your
card.js code uses `container` and `mica` directly; the wrapper makes
those available. If you find yourself writing `CARD_SHIM` anywhere in
card.js, delete it — the browser will throw `ReferenceError: Can't
find variable: CARD_SHIM`. The mention of "CARD_SHIM" in this handbook
(and in diagnostic error messages like "redeclared CARD_SHIM global")
is shorthand for "the wrapper" — descriptions of the mechanism, never
references to a symbol you can use.

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

**Dependencies — invoke `discover-dependency` FIRST.** If your card needs ANY external library, your next action is to invoke the `discover-dependency` skill BEFORE writing card.js or metadata.json. The skill does the curl-verification, picks a working CDN URL, and records the decision on canvas. CDN URLs written from memory is how stale versions, ESM-only URLs that don't load in card.js's classic-script context, and hallucinated paths sneak in. One curl-verified UMD URL beats several rounds of "Failed to load dependency" debugging.

#### UMD vs ESM — two loading patterns

Mica cards support two CDN-loading patterns. **Always run `mica_inspect_url` first** to learn which one the library needs (the `format` field is `'UMD' | 'ESM' | 'CommonJS' | 'data' | 'unknown'`).

**Pattern A — UMD (`metadata.scripts` + global).** The default. `<script>` tag in card.html loads the library; access via a global namespace from card.js.

```json
// metadata.json
{ "dependencies": { "scripts": ["https://cdn.jsdelivr.net/npm/<pkg>@<version>/<umd-path>.js"], "styles": [] } }
```

```js
// card.js
const obj = new <Global>.Thing();  // <Global> is the namespace the UMD bundle exposes on window
```

Use Pattern A whenever `mica_inspect_url` reports `format: 'UMD'`. This is most older libraries and stable versions of modern ones.

**Pattern B — Dynamic ES module import (`await import` in card.js, nothing in metadata.scripts).** For libraries that ship ESM only. The runtime wrapper runs card.js inside an async function, so top-level `await` works natively.

```json
// metadata.json — note empty scripts array
{ "dependencies": { "scripts": [], "styles": [] } }
```

```js
// card.js — top of file
const NS = await import("https://cdn.jsdelivr.net/npm/<pkg>@<version>/<esm-path>");
const obj = new NS.Thing();
```

Use Pattern B whenever `mica_inspect_url` reports `format: 'ESM'`. The dynamic-import URL is the same ESM URL — you just load it inside card.js instead of via metadata.scripts. The library is accessed via the namespace object returned from `await import(...)`, not via a global.

**Pattern B — addons / sub-modules.** Many modern ESM libraries split their surface across multiple sub-paths. The main namespace import gives you the core; addons live at sibling URLs under the same version. **Each addon is its own dynamic import.**

```js
// core + addon pattern
const NS = await import("https://cdn.jsdelivr.net/npm/<pkg>@<version>/<core-esm-path>");
const { Addon } = await import("https://cdn.jsdelivr.net/npm/<pkg>@<version>/<addon-esm-path>");

// Now use them alongside the core namespace
const a = new Addon(...);
```

**Mixed-format cards are normal — Pattern A core + Pattern B addons is the common shape.** When a library's core ships UMD and its addons ship ESM-only (a frequent pattern for popular UI libraries with addon ecosystems), use BOTH patterns in the same card. There is no "one pattern per card" rule.

A complete mixed-format integration:

`metadata.json` — only the core's UMD URL goes here. The addon URLs do NOT:

```json
{
  "dependencies": {
    "scripts": ["https://cdn.jsdelivr.net/npm/<pkg>@<version>/<umd-core-path>.js"],
    "styles": []
  }
}
```

`card.js` — the core's UMD `<script>` tag fires before card.js runs, so the core's global is already on `window`. Addons load inline via `await import()`:

```js
// card.js — core is already on window (loaded via metadata.scripts above)
const { Addon1 } = await import("https://cdn.jsdelivr.net/npm/<pkg>@<version>/<addon1-esm-path>");
const { Addon2 } = await import("https://cdn.jsdelivr.net/npm/<pkg>@<version>/<addon2-esm-path>");

// Use the core's global alongside the dynamically-imported addons
const obj = new <Core>.Thing();
const a = new Addon1(...);
```

**During discovery: inspect each URL separately.** Run `mica_inspect_url` against the core URL AND each addon URL you plan to use. The core may report UMD while addons report ESM — that's not a problem, it's the cue for the mixed-pattern integration above. The agent's natural reflex of "the core was UMD, the addons must be too" is wrong; verify per-URL.

**Two drift modes the mixed-pattern guidance prevents:**

- Putting an ESM addon URL into `metadata.scripts` because the core landed there. The `deps-reachable` validator catches this with a prescriptive error, but the right move is to leave the addon out of metadata.scripts entirely and load it via `await import()` inside card.js.
- Pinning the integration to an older UMD-only version of the library because one needed addon won't load as UMD. The newer version + mixed-pattern is almost always cleaner than the version-pin workaround.

**General principle for ESM libraries with sub-paths:** if a library's docs show `import { X } from "<pkg>/addons/<sub>/<path>.js"`, translate to `const { X } = await import("https://cdn.jsdelivr.net/npm/<pkg>@<version>/<corresponding-path>")`. The CDN path mirrors the package's internal layout — find it via `https://www.jsdelivr.com/package/npm/<pkg>` or `mica_inspect_url` on a candidate path.

**Reimplementing an addon inline is the wrong fix.** When a needed addon isn't on the main namespace, the answer is always a second `await import(...)` for the addon's URL — not a hand-rolled reimplementation in card.js. Library addon code has been debugged over many versions; an inline rewrite ships subtle bugs the library doesn't have.

**Wrong combinations fail loudly.** The `deps-reachable` validator at metadata-write time refuses ESM URLs in `dependencies.scripts` with a prescriptive error naming both fixes. If you see `\`dependencies.scripts\`: <url> — detected ES module`, switch to Pattern B (or pin to a UMD-compatible version of the library).

**Library family notes.** Some libraries drop their UMD bundles in major-version transitions — verify each candidate's format via `mica_inspect_url` and pin to a UMD-compatible version for Pattern A, or use Pattern B for any later release. Some library families are ESM-only by design; Pattern B is mandatory for those.

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

### Injected globals in `card.js`

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

**Instance files are normally empty.** Every card on the canvas is a file at the canvas root — e.g. `canvas/my-card.viewer`. Its extension routes to the card class; its body is most often empty (0 bytes) or a small JSON blob. **For ALL card classes (built-in or custom), an empty instance file is the normal default state.** It means "this card is placed on the canvas; no per-instance content has been authored" — not "the card is broken" or "the build failed."

If `render_capture` returns `MISMATCH` and shows text like the instance filename instead of the rendered card, the cause is NOT the empty instance file. Common real causes, in order of frequency:

- `WEBGL-OPAQUE` (WebGL cards): the capture pipeline can't read the back buffer. CARD_SHIM auto-preserves this for the common case; if the verdict still fires, see the "render_capture and WebGL — usually just works" section below.
- `card-error` broadcast in the chat: card.js threw at init. Read the broadcast for the syntax error or CARD_SHIM redeclaration; fix and re-render.
- Race: the canvas opened the file before the class was registered. A subsequent edit to card.js (or any no-op) triggers re-render via the file-watcher.

**Don't read the instance file to diagnose a rendering failure.** The file body is irrelevant to whether the class renders — the class definition is what's rendered. If you find yourself adding content to the instance file to "fix" a render issue, stop: the file content doesn't drive the render.

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

### Event listeners: attach to `container` for auto-cleanup

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
(upstream HTTP). Body is **always a string** — use `r.json()`
to parse, never `JSON.parse(r.body)` (works, but the bridge's
helper is the canonical idiom).

```js
const r = await mica.fetch('https://api.example.com/items', {
  method: 'POST',
  headers: { 'Authorization': 'Bearer ' + KEY },
  body: JSON.stringify({ name: 'foo' }),
  timeout: 15000,
});
if (r.errorCode) { /* our-side failure: r.error human-readable */ }
else if (r.status >= 400) { /* upstream HTTP error */ }
else { const data = r.json(); /* parses r.body; throws on bad JSON */ }
```

**Anti-pattern: defensive `typeof r.body === 'object'` checks.**
Body is contract-string. Cards that wrap JSON.parse in a type-check
end up calling `JSON.parse(someObject)` on a code-drift case, which
coerces to `"[object Object]"` and crashes with *"Unexpected
identifier 'object'"*. Just call `r.json()`.

`errorCode` values: `url_invalid`, `ssrf_blocked`, `dns_error`,
`connect_error`, `timeout`, `rate_limited`, `response_error`,
`internal_error`. `rate_limited` includes `retryAfterMs` —
respect it; don't fire-loop. For binaries (PDFs, images), use
`mica.files.url()` + `<img>`/`<embed>`, not `mica.fetch`.

For Mica's own `/api/*`, prefer `mica.files.*` helpers (auto
URL-encode, set `source`/`cardSource`). Raw `fetch('/api/...')`
works too — the runtime auto-injects `X-Mica-Project`.

## Surfacing card failures via `mica.reportError`

CARD_SHIM auto-reports only two error classes: (a) errors **thrown**
out of card.js init, event handlers, or `setInterval`/`setTimeout`
callbacks, and (b) **unhandled** Promise rejections. It deliberately
does NOT capture `console.error` / `console.warn` (too noisy — many
cards log warnings during normal operation), and it does NOT treat
HTTP non-2xx from `mica.fetch` as an error (status codes are part of
the contract; the card decides what's fatal).

That means a card that catches its own failures and only `console.error`s
them is **invisible to Mica**. The agent has no signal to fix or
escalate, even if every refresh is failing.

**The rule for every catch block:**

- **Real failure the user/agent should know about** (config error,
  upstream 5xx, persistent 4xx, parser blew up on an unexpected
  payload, our-side `errorCode` from `mica.fetch`): call
  `mica.reportError("<short context>: <message>")` *and* return.
- **Expected + handled** (e.g. a transient 429 with a 60s backoff,
  empty response from a poll, a "no data yet" branch): local
  `console.warn` is fine; don't report. Reporting every transient
  hit floods the agent and trains it to ignore real signals.
- **Persistent transient failure** (e.g. been 429 for 5+ minutes):
  track a streak counter; report **once** when the streak crosses a
  threshold (say 3 consecutive failures), not on every retry.

### Canonical `mica.fetch` failure shape

```js
const r = await mica.fetch(url, { timeout: 15000 });
if (r.errorCode) {
  // Our-side: SSRF / DNS / timeout / rate_limited / connect_error.
  // These are real and the agent needs to know.
  mica.reportError(`fetch ${url} failed (${r.errorCode}): ${r.error}`);
  return;
}
if (r.status === 429) {
  failStreak++;
  if (failStreak >= 3) mica.reportError(`stuck rate-limited on ${url} (${failStreak} consecutive 429s)`);
  scheduleRetry(60_000);
  return;
}
if (r.status >= 400) {
  // Other 4xx/5xx — usually config or server fault, report immediately.
  mica.reportError(`API ${url} returned ${r.status}: ${r.body.slice(0, 200)}`);
  return;
}
failStreak = 0;  // success — reset
```

### Anti-pattern: the silent swallow

```js
// BAD — agent has no idea the card has been broken for hours
catch (err) {
  console.error('[my-card] fetch error:', err);
  return;
}

// GOOD — one red bubble with the real cause; agent can investigate
catch (err) {
  mica.reportError(`my-card: fetch failed: ${err.message || err}`);
  return;
}
```

The reverse anti-pattern — calling `mica.reportError` on every
single transient failure (e.g. every 429 inside a backoff loop) —
is just as harmful. Streak gating is the discipline.

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

### Reusable handlers: `llm-direct` and `process`

Mica ships **reusable parameterized handlers** that any card class
can opt into via `metadata.json`. Adding a new card class that
needs server-side capability requires zero server code in most
common cases — pick a reusable handler before considering a new
server plugin (which is a human-only decision).

**Two reusable handlers are most relevant for new card classes:**

| Handler | What it gives you | When to pick |
|---|---|---|
| `llm-direct` | Streaming chat against an LLM with a fixed system prompt + per-turn user message. Handler manages the streaming round-trip. | LLM-driven cards: single-purpose assistant, summarizer, persona-style chat. |
| `process` | Spawn a long-lived subprocess; bidirectional stdin/stdout/stderr; lifecycle-driven start/stop. | Wrapping a CLI tool, a language server, a daemon, or a polling task. |

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

**Model resolution is forgiving — `model` is optional.** Both
`llm-direct` and `llm-agent` resolve the model name against the
endpoint's `/v1/models` list at runtime. The ladder is: requested
model if served → first known-good fallback if served (`qwen-vl`
or `qwen3-vl-local`) → first served model. If the requested name
isn't served (e.g. you wrote `qwen-coder` and vLLM serves only
`qwen-vl`), the handler picks a working substitute, logs it, and
sends an `{ type: "info", message: "model 'X' not served; using
'Y' instead" }` broadcast to the card so users/agents see the
resolution. Net effect: don't hardcode model names you're unsure
about in `metadata.args` — omit the field and the runtime picks
something served. Override only when a specific served name is
required (e.g. image-modality cards: `qwen3-vl-local`, satisfies
the qwen-code SDK's `/^qwen3-vl-/` regex).

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

**Common shape rules:**
- Spawn via a `start` message after the channel is open — the handler doesn't accept command/args/cwd in openChannel args.
- One subprocess per channel at a time. Send `signal`, wait for `exit`, then `start` again. Two-stage restart.
- For stateless tool calls the agent should invoke directly, use `<project>/.mica/tools.json` instead — those go in
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

## Worked examples (Tier 3, Tier 4, minimal Tier 1) — load on demand

The handbook keeps tier-decision logic, the canonical card.js
skeleton, the `mica.*` reference tables, and pitfalls. Worked
examples (with full metadata.json + card.html + card.js + sidecar
boilerplate) live in a sibling file to keep the per-turn context
load tighter:

**`read_file .qwen/skills/card-class-handbook/EXAMPLES.md`** when you need:

- **Tier 3 examples** — `hello-process` (canonical `process`
  handler card, echo a CLI tool to a chat-style UI), plus the
  chained-subprocess pattern (two CLI tools in sequence on one
  channel).
- **Tier 4 sidecar reference + 5 worked examples** — the full
  sidecar lifecycle (env vars, `mica_sidecar` package, FastAPI
  / Node.ts `server.{py,ts}` shapes, calling from card.js,
  lifecycle facts, common pitfalls, the debug-a-500 workflow)
  plus `hello-py`, `hello-llm`, `hello-embed`, `hello-faiss`,
  `hello-pdf` — each a complete copy-and-adapt template.
- **Minimal Tier 1 example** — the counter card. Smallest
  possible card: card.html + card.js + `mica.files.write` +
  `mica.on('file-changed')`. Use as a reference when you want
  to see the simplest concrete shape.

Read EXAMPLES.md only when you've decided what tier the card
needs (from § Card architecture above). Tier 1/2 builds typically
don't need it; Tier 3/4 builds usually do.

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
Guessing alternate method names is a compounding failure mode —
each guessed-and-failed method name burns an iteration, and the
end of the spiral is usually a delete-and-recreate.

### After render_capture: follow the verdict tag

The tool's result starts with one of eight verdict tags. Each maps to a single next move:

- `[render_capture: CLEAN]` — initial build verified (no `user_intent` passed). Write your one-paragraph summary to the user and END THE TURN. Do not call render_capture again.
- `[render_capture: MATCHES]` — UX request verified against image (you passed `user_intent`, captioner confirmed match). Same terminal state as CLEAN — write the summary and end.
- `[render_capture: MISMATCH]` — captioner says the visible card does NOT satisfy the user's request. **Do NOT declare done.** Edit (`mica_edit_class_file`), then re-call render_capture with the same `user_intent`. The captioner's EVIDENCE line names what's wrong.
- `[render_capture: UNVERIFIABLE]` — user's request is about behavior, state, or interaction a still image can't show (animations, post-click state, dynamic updates). Three valid moves: (1) trigger the state change and re-capture, (2) end the turn with a clear summary describing expected behavior so the user can verify on their screen, (3) re-read the request — if it was actually about visible appearance, re-call without `UNVERIFIABLE`-friendly framing.
- `[render_capture: INTENT-UNPARSED]` — captioner didn't follow the VERDICT/EVIDENCE format. Read the caption manually, decide if the user's request is satisfied, and proceed accordingly.
- `[render_capture: ERRORS — N buffered]` — fix each listed error (`mica_edit_class_file`), then re-call render_capture once. ERRORS means the build is NOT complete regardless of how the screenshot looks.
- `[render_capture: WEBGL-OPAQUE]` — captioner sees black. CARD_SHIM normally auto-preserves WebGL back buffers, so this verdict is rare. When it fires: the card uses OffscreenCanvas / WebGPU / a pre-created context (register `mica.onCapture(cb)`), or the library loaded before card.js executed, or the scene is genuinely blank. See handbook § "render_capture and WebGL — usually just works" for the decision tree. Iterating on CSS / dependencies before checking these causes is the phantom-chase failure mode.
- `[render_capture: CAP-REACHED]` — end the turn with a plain-text summary; the cap resets on the user's next message.

CLEAN and MATCHES are terminal states: the next thing the agent emits should be the user-visible summary, not another tool call. Don't relitigate "is this really done?" — the tag is the signal.

**Advisory findings do NOT reopen a terminal state.** A validator finding that is explicitly labeled `INFORMATIONAL` or `ADVISORY` (e.g. an upstream deprecation notice on a dependency that loaded successfully) is logged for awareness — not a build failure. If render_capture returned CLEAN or MATCHES and the only outstanding finding is an advisory on a dependency the card already uses successfully, you are done. Do not switch library versions, do not rewrite to a different load pattern, do not investigate alternatives. Write the summary and end. Treating advisories as required-to-fix turns a working card into a verify-loop on a non-problem.

**MISMATCH is the most common new failure mode to attend to.** Before MATCHES existed, the agent's habit on a UX-correction turn was: edit → render_capture → CLEAN → "done!" → user re-reports the bug. With MISMATCH, the agent learns mid-turn that the edit didn't actually fix the visible problem and can iterate before the user is involved. **Always pass `user_intent` on UX-correction follow-up turns** so the loop short-circuits at agent-time instead of user-time.

**When the user reports a symptom on a previously-built card, you're in the debug phase — not the build phase.** Your next move is `skill('fix-bug')`, BEFORE any `read_file` or `edit_class_file`. The build phase ended at the prior approval gate; debug has its own discipline (reproduce, root cause, minimal change, verify). Iterating CSS/DOM theories from training prior is the failure mode that traps the build — the discipline lives in the skill, not in your turn-to-turn memory.

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

A common iteration-cost amplifier. The shape:

1. **Turn N**: agent makes a small targeted edit via `mica_edit_class_file({ old_string, new_string })`. The fix is precise — replaces one line (e.g. fixing a misuse of a library API).

2. **Turn N+1 or later**: agent reads the file, decides to "improve" something unrelated, and calls `mica_edit_class_file({ content: "<entire new card.js>" })` — full-file rewrite. The rewrite re-types card.js from scratch based on the agent's mental model, which may still reflect the PRE-fix state of the file (the training-memory pattern is the original wrong line, not the post-fix corrected one).

3. **Result**: the previous turn's fix is silently reverted. The original bug is back. The card errors again. The agent doesn't notice because nothing tells it "you just undid your last fix."

**Why this happens:** the partial edit lives only in the file on disk; the agent's working memory of the file's contents is whatever it last *read* via `read_file`. If the agent edits without re-reading, its mental model of the file is stale. A subsequent full-file rewrite, generated from that stale model, eats the targeted fix.

**Rules to avoid this:**

1. **Prefer targeted edits over full rewrites whenever possible.** The `mica_edit_class_file({ old_string, new_string })` form preserves every line you didn't touch. The `mica_edit_class_file({ content: ... })` form replaces everything.

2. **If you MUST do a full rewrite, `read_file` immediately before** so your content includes the latest state — including any targeted fix from a prior turn. Stale-model rewrites are the bug; reading-before-writing is the prevention.

3. **After a full rewrite, re-verify with `render_capture`** (with `user_intent`) so a re-introduced bug surfaces in the same turn. If the captioner reports MISMATCH on a request you thought was already satisfied, that's the eat-your-own-fix signal.

4. **Same runtime error across consecutive edits** is the canonical observable symptom — the error message stays identical because the edit isn't actually changing the broken line. Stop editing; re-read the file; verify the broken line is what you think it is.

### Card class not appearing? Trust the file watcher

The file watcher hot-reloads card-class directories on disk
change. The fix is a re-fetch or a no-op edit, not a server
restart.

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
prime suspect. The file contains exactly the URL that's failing
— re-reading `metadata.json` produces no new information. Go
straight to verifying and replacing the URL.

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

### Error overlays render `err.message`, not a hardcoded label

When card.js wraps init in `init().catch((err) => { ... })`, the catch handler is the **only** place that knows what actually broke. The error overlay must surface `err.message` — not a static string baked into card.html.

**Anti-pattern (do NOT ship):**

```html
<div id="error-overlay" style="display:none;">
  <span class="error-text">Failed to load textures</span>
</div>
```

When ANYTHING throws — a dependency import that hits the bare-specifier trap, a typo in renderer setup, a missing DOM id — `init().catch` fires, sets the overlay visible, and the user (and any later debug-phase agent reading the screenshot caption) sees "Failed to load textures." That text is **a lie about what broke** — the original problem may have nothing to do with textures. Debug turns then spiral chasing the wrong cause.

**Correct shape:**

```html
<div id="error-overlay" style="display:none;">
  <span class="error-text"></span>  <!-- empty; populated by card.js -->
</div>
```

```js
init().catch((err) => {
  console.error('[<card-name>] init failed:', err);
  if (errorOverlay) {
    errorOverlay.style.display = 'flex';
    errorOverlay.querySelector('.error-text').textContent =
      'Error: ' + (err && err.message ? err.message : String(err));
  }
});
```

**Why this matters in the debug phase**: the captioner's read of the screenshot becomes ground truth for the next agent turn. If the overlay text describes the *real* error, the next debug turn lands on the right hypothesis. If it lies, the next debug turn iterates on a phantom.

The same rule applies to async error paths (texture-load `onError`, fetch failures, channel events): record the actual error message; don't substitute a domain-specific label that has to be right to be useful.

### Defined-but-uncalled functions = the bug

After authoring card.js, scan your file for every function name and confirm each is invoked from at least one call path. A common failure mode in async-heavy cards is to define helpers like `createScene()`, `hideLoading()`, `tryStart()`, etc. — but the load-completion callbacks never invoke them. The render loop ticks forever; the canvas stays empty; `render_capture` may even return MATCHES if the visible state looks "loading-ish."

**The check is one mental pass before declaring done**: list every `function foo(...)` and `const foo = (...) =>` definition in card.js, then search for `foo(` call sites. Every definition should have at least one call site somewhere in the file.

**If you find a function defined but not invoked anywhere**, that's almost certainly the bug. Wire it into the right callback — typically the loader's `onSuccess`, or `LoadingManager.onLoad` for Three.js batch-loaded textures, or whatever async-completion event the architecture uses. Re-author the call site, then re-verify with `render_capture`.

This pattern is library-agnostic — it applies to any card.js with multiple functions and async resources. It's the negative-counterpart to the positive "load N → create dependent objects → start render loop" pattern documented in library-specific skill packs (`threejs-loaders/SKILL.md` for Three.js, equivalent for other libraries).

### `render_capture` and WebGL — usually just works

CARD_SHIM auto-enables `preserveDrawingBuffer: true` on any WebGL context created within card scope. So when the capture pipeline's `html2canvas` fallback calls `canvas.toDataURL()`, the WebGL back buffer is readable and the screenshot returns the actual frame. **You don't need to do anything special** for WebGL cards — the common case (Three.js, regl, PixiJS, Babylon, raw WebGL) captures cleanly out of the box.

**When you DO need `mica.onCapture(cb)`** — the patch can't reach a few cases:

- **OffscreenCanvas** — separate prototype; the patch doesn't apply.
- **WebGPU** (`canvas.getContext('webgpu')`) — different mechanics; the patch only covers WebGL/WebGL2.
- **Pre-created contexts** passed via library config — if your library accepts an externally-created WebGL context, the patch missed the creation site.
- **Custom capture semantics** — you want to render at a different resolution for capture, or composite multiple sources into one image.

For those cases, register the hook:

```js
mica.onCapture(() => {
  // Render at capture time and return any dataURL.
  renderer.render(scene, camera);
  return canvasEl.toDataURL("image/png");
});
```

The hook fires BEFORE the html2canvas fallback. It's per-card, auto-cleaned on unmount, with a 5-second timeout. Works for any rendering tech that can produce a dataURL.

**If `[render_capture: WEBGL-OPAQUE]` still fires** — the patch should make this rare. When it does happen, common real causes:

- The card uses OffscreenCanvas or WebGPU (see above — register `onCapture`).
- The library was loaded BEFORE card.js executed (e.g., via a `<script>` tag that fires during HTML parse). In that case the prototype patch wasn't yet in place. Move library init into card.js.
- The captioner is genuinely seeing a blank scene (clear color, nothing drawn, camera pointing the wrong way). Investigate the scene composition.

## Responding to canvas signals

Mica may inject synthetic user turns based on canvas file activity. These are NOT real user messages — they're Mica reporting events. Two shapes, both prefixed so you can recognise them in the first line of your turn:

- **`[Draft revision]`** — A file you wrote earlier in this session was edited by the user. Carries a unified diff (` ```diff ` block) of what changed against your original draft. Cumulative across multiple user edits; the diff stays anchored to your last write.
- **`[File activity]`** — Files changed that you did NOT author in this session. Filenames + change type only, no diff.

Both fire after ~60s of user idle — never during continuous typing. The signal exists; what you do with it is the discipline below.

### `[Draft revision]` — engage with the diff and consider cascades

1. **Read the diff.** Acknowledge what changed in one or two plain sentences. Be specific: "you renamed the spec from `hotdog` to `photo-classifier` and dropped the `capture` subtask" — not "I see you made some changes." Specificity is the difference between Mica feeling alive and Mica feeling boilerplate.

2. **Consider cascades.** Walk the canvas listing (already in your baseline). For each sibling doc that *plausibly references the changed identifier* (renamed name, removed subtask, restructured frontmatter), open it with `read_file` and decide whether it needs an update to stay consistent. Examples that imply cascades:
   - Renamed `name:` in a card spec → sibling docs that mention the old name; layout entries; `.mica/card-classes/<old-name>/` directory
   - Dropped or renamed a subtask in `## Architecture decomposition` → implementation notes or plans that referenced it
   - Changed `handler:` or `dependencies:` in the spec → architecture / decisions docs that documented the old choice
   - Changed a public command, API endpoint, or env var name in a design doc → README / setup / runbook that mentions the old name

3. **Propose, don't write.** If you find cascade impact, emit a SINGLE `propose_changes` tool call with all affected files. The user sees Apply / Dismiss buttons in the chat card and decides. Do NOT call `write_file` or `edit` on sibling docs to propagate cascades — that bypasses approval and risks loops.

4. **Stop at the cascade.** One reactive turn produces at most one `propose_changes` call. If the cascade naturally spans more than ~5 files, don't propose all of them — summarise the breadth in chat and ask the user which threads to follow. Wide cascades usually mean the rename was bigger than you initially thought; the user's input keeps it bounded.

5. **No-impact case is also valid.** If the user's edits don't imply any sibling changes (typo fix, prose tightening, formatting), say so in one sentence and stop. Don't manufacture cascades to look thorough.

### `[File activity]` — default to acknowledge, no action

Files you didn't author changed. The user is working on the canvas; that's normal. Default: a one-sentence acknowledgement and stop. Take action only if the diff/event explicitly directs you — e.g. the changed file has your agent tag in the new lines (`@qwen do X`), or it's a file you were already mid-task on and the user is unblocking you with new info.

When in doubt, treat `[File activity]` as informational, not actionable. The user can always send a direct message if they want action.

### Cascade safety — the loop is closed by the apply step

When the user clicks Apply on a `propose_changes` proposal, Mica writes the sibling files with a `user-approved-cascade` tag that the file watcher recognises — those writes don't fire another `[Draft revision]` turn. So a single edit by the user produces at most one cascade pass, with the user's click in the middle. No autonomous propagation.

This means: if you've proposed cascade edits and the user applies them, you'll get a `propose_changes_applied` confirmation in your turn — NOT a fresh `[Draft revision]`. Don't expect to "see" the cascade writes via the reactive channel; expect them via apply confirmation.

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
