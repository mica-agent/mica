---
name: create-card-class
description: Build, create, make, or implement a card, widget, visualization, chart, dashboard, calculator, viewer, browser, editor, game, or any interactive UI that appears on the Mica canvas. Use whenever the user asks for something visual or interactive, even if they don't say "card".
---

# Create a Card Class

A **card class** defines a UI component. An **instance** is a file the class renders.

## STEP 0 — Check what already handles this (do this FIRST)

Before writing a new card class, introspect the registry. The server is the source of truth for what's installed — never guess, never cache, never hardcode.

```javascript
// In card.js (or from the chat agent via a shell call to the API):
const classes = await mica.cardClasses.list();
// → [{ name: "mmd", builtIn: true, format: "html" }, { name: "md", ... }, ...]
```

Or raw:

```
GET /api/card-classes
→ { mmd: { builtIn: true, format: "html" }, md: {...}, ... }
```

If any listed class matches your intent, **use it** — do NOT create another class, and especially do NOT create a project-scoped copy of a built-in (that just shadows the built-in for this project with no benefit).

If a listed class *might* fit but you're not sure, read its metadata or spec before deciding:

```
GET /api/card-classes/{name}/metadata.json   # declared extension, badge, defaultTitle
GET /api/card-classes/{name}/spec.md         # prose description, if the class ships one
```

Only proceed past this step when you have confirmed that no existing class handles the intent.

## STEP 0.5 — Search for libraries before designing custom (recursively, per subproblem)

Before designing any non-trivial subcomponent — mapping, charting, drag-and-drop, code editing, calendaring, geospatial math, syntax highlighting, animation, math typesetting, terminal emulation, anything you'd write more than ~30 lines for — confirm whether an established library already solves it. **One `WebSearch` + one `WebFetch` per subproblem is the budget.**

```
WebSearch "<problem> javascript library"   # e.g. "leaflet day night terminator overlay"
# Pick the top maintained candidate; WebFetch its README or npm page.
# Decision: "use <library@version>" OR "no library fits because <reason>".
```

**This applies recursively to every subproblem, not just the top-level domain.** Picking Leaflet as the map library does NOT discharge the search for sub-features built on top of it: a day/night terminator overlay is its own search target (`leaflet day night terminator plugin` → `Leaflet.Terminator`); a heatmap layer is its own (`leaflet.heat`); a marker-clustering layer is its own (`leaflet.markercluster`); a routing layer is its own (`leaflet-routing-machine`). After you choose a primary library, **list the sub-features the user asked for and run a separate search per sub-feature**. The most expensive failure mode the system has produced is exactly this: agent picks Leaflet, then writes 80 lines of custom great-circle solar geometry for the terminator instead of one `L.terminator()` call. The library was found; the subproblem was not searched.

If you pick a library, **verify its CDN URL is reachable before writing it into `metadata.json`** — see the Pre-completion smoke test section below for the recipe. Tier 1 (URL returns 200) and Tier 2 (loaded library exposes the global the card calls) are mandatory before you commit `metadata.json`.

Acceptable "no library fits" outcomes — record the reason inline so reviewers don't re-litigate:
- "Solar elevation math is 8 lines and reuses values the card already computes; pulling a 40KB library to save 8 lines is a loss."
- "The thing the user wants is a 3-input form with a sum at the bottom; no library."

The most expensive failure mode is silently writing 80 lines of from-scratch geometry/parsing/protocol code when a 1-line library call would suffice. Rule 4 below says "Don't reinvent" as a principle — this step is the procedure that enforces it.

## STEP 0.75 — Draft spec.md and get approval BEFORE writing any card-class code

Before any `cp -r` of the skeleton or any `Write` to a card-class file, draft `canvas/spec.md` with the structured design and post a short approval gate in chat. Implementation starts AFTER the user replies — not before.

**Why this gate exists.** Single-card-class builds skip the orchestrator pattern (decomposer → spec.md → interfaces.md → plan.todo) because the contract is trivially small. But "trivially small contract" doesn't mean "no spec." Without a spec the user can't course-correct on:

- The library choices (was Leaflet.Terminator searched for the day/night overlay? Chart.js vs Plotly?).
- The behavior boundaries (9 fixed cities or user-editable? day/night with twilight band or hard boundary? click-to-add-city?).
- The visual approach (light or dark basemap? legend placement? labels on-map or sidebar?).

If the user only sees the card AFTER it's built, every disagreement is a rebuild. If they see the spec FIRST, disagreements are one-line spec edits.

**Sensing a thin spec — ask before fleshing it out.** If `canvas/spec.md` already exists but is brief (one paragraph, missing the required sections below), the gate is **not satisfied** — a one-line spec gives the user nothing to course-correct on. Don't autonomously rewrite it; **ask first**:

> *"Existing `spec.md` is a one-liner. Per STEP 0.75 I'd flesh it out with the structured sections (Files / Dependencies / Subproblems / Behavior / Out of scope / Smoke test results / Assumptions) before building. Should I draft that now?"*

Wait for yes. Then draft the structured version IN PLACE — preserve the original sentence(s) as the elevator pitch under the H1; expand around it. Post the standard approval gate per below. If the user says "no, just build it as-is," respect that — they've explicitly opted out of the structured spec, and the gate becomes a "ok to build?" confirmation against the thin spec.

This is the same "ask on inkling" pattern the doc-consistency skill uses for sibling-doc updates. You don't unilaterally rewrite specs any more than you unilaterally rewrite siblings — defer to the user. Without this, the gate fails silently on existing thin specs: agent reads `spec.md`, sees content, marks gate satisfied, builds against an inadequate brief.

**Required spec.md sections** — strip any that genuinely don't apply, but most do for any non-trivial card:

- `# <Card name>` + a one-paragraph elevator pitch.
- `## What it does` — user-visible behavior. Bullet points; the user reads this top-down.
- `## Files` — the four card-class files (metadata.json, card.html, card.css, card.js) with one-line descriptions of what each owns.
- `## Dependencies` — every external library (Tier-1 verified URLs per the Pre-completion smoke test) plus a one-line "why this library" justification.
- `## Subproblems and their solutions` — for each recognizable subproblem (e.g. "day/night terminator overlay"), name the chosen library OR explicitly record "no library fits because <reason>." This is the explicit output of STEP 0.5.
- `## Behavior` — interactions, tick rates, persistence, edge cases.
- `## Out of scope for v1` — what you're NOT building. Forces the user to confirm scope before code is written.
- `## Smoke test results` — empty at draft time; filled in after build per the Pre-completion smoke test section.
- `## Assumptions` — Tier-3 documented assumptions per the Pre-completion smoke test section.

**The approval gate.** Post a chat reply that's a one-liner: *"Drafted in `canvas/spec.md` — review and OK to build?"* — NOT a paste of the spec content. The user opens spec.md on the canvas to read; chat carries only the gate. Wait for an explicit affirmative ("ok," "yes," "go ahead," "ship it") before any further tool call. If the user pushes back ("no, smaller scope" / "use Chart.js not Plotly"), edit spec.md to reflect the change and re-post the gate.

**When to skip this gate.** If the request is genuinely a one-liner ("add a counter card with a + button") — the drafting overhead exceeds the iteration win AND the user can't meaningfully course-correct on something this small. Heuristic: if you'd write fewer than ~50 lines total across all four card-class files, skip the gate and build directly. Otherwise, gate.

**Why this matters for the inline path specifically.** Going from "ok build it" directly to a fully-built card is what produces iteration churn — every disagreement becomes a code rewrite instead of a spec edit. The spec-first gate keeps iteration cheap by moving disagreements upstream of code. The orchestrator path enforces this implicitly (the decomposer ships spec.md as artifact 1); the inline path needs it explicitly.

## Extension conventions — use community-standard short forms

Extensions follow external conventions, not invention. Always use the canonical short form — the registered class will match it.

- Mermaid diagrams → `.mmd` (NOT `.mermaid`)
- Markdown → `.md` (NOT `.markdown`)
- TypeScript → `.ts`, YAML → `.yml`/`.yaml`, etc.

Your new class's extension should also follow this pattern: short, lowercase, matches the community name for the format.

## Where files go

- **Card class**: `.mica/card-classes/{name}/` — project-scoped. Built-in classes live in the Mica repo's `card-classes/` and are NOT the place to add new ones.
- **Instance**: a plain file in the canvas root (usually `docs/`), e.g. `docs/my-board.kanban`. NEVER in `.mica/`.

## ⚠️ NAMING RULE — directory name MUST equal the extension (no dot)

The Mica resolver maps an instance file's extension directly to a directory name. If your extension is `.kanban`, the directory MUST be `kanban/`. If your extension is `.solar`, the directory MUST be `solar/`. **NOT** `solar-system/`, **NOT** `solarSystem/`, **NOT** anything else.

`metadata.json`'s `extension` field is documentation — the **directory name is the actual lookup key**. A mismatch silently fails: `.solar` files in `docs/` will fall through to plain text rendering with a "TXT" badge, even though `metadata.json` declares the extension correctly. There is NO error message; the symptom is just "my custom card renders as text."

| Extension | Directory | Instance filename |
|---|---|---|
| `.counter` | `.mica/card-classes/counter/` | `docs/score.counter` |
| `.solar` | `.mica/card-classes/solar/` | `docs/solar-system.solar` |
| `.kanban` | `.mica/card-classes/kanban/` | `docs/sprint-12.kanban` |

If the user asks for "a solar system card," your extension is `.solar` and your directory is `solar/` — the instance filename can be anything (`solar-system.solar`, `our-system.solar`, etc.).

## Required files in `.mica/card-classes/{name}/`

| File | Required | Purpose |
|---|---|---|
| `metadata.json` | yes | extension, badge, title, dependencies |
| `card.html` | yes | static markup — use IDs for anything the script updates |
| `card.js` | yes | behavior — see globals below |
| `card.css` | no | scoped styles |
| `context.md` | no | class-level AI context |

## `metadata.json`

```json
{
  "extension": ".counter",
  "badge": "CTR",
  "defaultTitle": "Counter",
  "primaryFile": "counter.json",
  "dependencies": { "scripts": [], "styles": [] }
}
```

**Required fields — every `metadata.json` MUST include all of these:**

| Field | Silent failure if omitted |
|---|---|
| `extension` | Framework auto-repairs from the directory name and logs a warning. Always include to avoid the roundtrip. |
| `badge` | Card renders with a `???` placeholder on the canvas — a visible regression, not caught by `JSON.parse` verification. |
| `defaultTitle` | Card title falls back to the raw instance filename; functional but ugly. |
| `dependencies` | No scripts/styles loaded — fine if you need none, silent breakage of your card's libraries otherwise. |

`primaryFile` is optional — only for classes that render a specific filename inside a directory instance.

**Do NOT include `name`, `description`, or `version`.** Those are not Mica fields and get ignored; they're a package.json-shaped leak from LLM priors. The fields above are the only ones the framework reads.

## CARD_SHIM globals in `card.js`

Available without import:

| Global | Shape |
|---|---|
| `container` | this card's DOM element. `container.querySelector(...)` is scoped here |
| `mica.filename` | the instance file path (e.g. `"docs/my.counter"`) |
| `mica.windowId` | stable id for this browser **tab** (per-tab, NOT per-card) |
| `mica.cardId` | stable id for this card **instance** (the per-file UUID) |
| `mica.isSelfEcho(event)` | `(event) => boolean` — true if `event` was caused by THIS card writing. Use this instead of `event.source !== mica.windowId` (windowId is per-tab, so the windowId check also suppresses sibling cards in the same tab). |
| `mica.getContent()` | `async () => string` — read the instance file content |
| `mica.files.list()` | `async () => [{ path, isFile, isFolder, size, modifiedAt }]` — list project files AND directories. `isFile` and `isFolder` are opposites; use whichever reads natural. |
| `mica.files.read(path)` | `async (path) => string` — read a text file |
| `mica.files.readBinary(path)` | `async (path) => ArrayBuffer` — read a binary file |
| `mica.files.write(path, content)` | `async (path, content: string \| ArrayBuffer \| Uint8Array \| Blob \| File) => void` — pass a string for text files, an ArrayBuffer/Blob for binary. Helper auto-routes; `source` auto-injected, parents auto-created, binary streams to disk with no size limit. |
| `mica.files.delete(path)` | `async (path) => void` |
| `mica.files.url(path)` | `(path) => string` — URL for `<img src>` / `<embed>` / download links |
| `mica.cardClasses.list()` | `async () => [{ name, builtIn, format }]` |
| `mica.fetch(url, opts?)` | `async (url, { method?, headers?, body?, timeout? }) => { status, headers, body, durationMs, error?, errorCode?, truncated? }` — server-proxied HTTP (bypasses CORS). SSRF-protected (blocks private/loopback IPs). Rate-limited 120 req/60s per project. 10MB response cap, 60s max timeout. **Always resolves**; check `errorCode` then `status`. See "External HTTP" section below. |
| `mica.on(event, cb)` | subscribe; returns unsub fn. Events: `file-changed`, `file-created`, `file-deleted`, `layout-changed`, `card-error` |
| `mica.onDestroy(cb)` | cleanup on unmount |
| `mica.openChannel(fn, args)` | bidirectional stream to a server plugin |
| `mica.refresh()` | reload the card (e.g. after external file change) |
| `mica.reportError(message)` | fire-and-forget; surfaces `message` as a red "Send to agent" bubble in chat cards across the project. Use inside a catch block when your card also shows its own toast but you want the agent to know. |

**The above table is exhaustive for `mica.files.*` and `mica.cardClasses.*`.** These namespaces are Proxy-guarded — calling a method that doesn't exist (e.g. `mica.files.append`, `mica.files.exists`, `mica.files.move`) throws `TypeError: mica.files has no method 'X'. Known: list, read, readBinary, write, delete, url.` AND auto-reports to chat. If you need to append to a file, the pattern is **read → concat → write**:

```js
const existing = await mica.files.read('docs/log.md').catch(() => '');
await mica.files.write('docs/log.md', existing + '\n' + newLine);
```

**Prefer `mica.files.*` over raw `fetch('/api/files/...')`.** The helpers handle URL encoding, the `source` field for writes, and field-name normalization — you can't hallucinate endpoint paths or response shapes if you use them.

**If you do use raw `fetch()` for `/api/*`**, the card runtime auto-injects the `X-Mica-Project` header so the server can tell which project's state to read/write. This works for fetches in your top-level card.js code. For belt-and-suspenders reliability (e.g. fetches inside dynamically-generated strings or edge-case code paths), pass `{ headers: { 'X-Mica-Project': mica.project } }` explicitly — the auto-inject skips headers you already set.

## External HTTP via `mica.fetch(url, opts)`

Cards cannot hit most public APIs directly from the browser — CORS blocks them. `mica.fetch` proxies the request through the Mica server, which strips CORS. The server enforces SSRF protection (blocks loopback / private / link-local / cloud-metadata IPs), a per-project rate limit (120 req / 60s rolling window), a 10 MB response cap, and a 60s max timeout.

**The Promise always resolves.** Check `errorCode` first (our-side failures: SSRF, DNS, timeout, rate limit, bad URL), then `status` (upstream HTTP code). Body is always a string — call `JSON.parse()` yourself when needed.

### Usage

```js
// Simple GET
const r = await mica.fetch('https://api.openweathermap.org/data/2.5/weather?q=NYC&appid=' + KEY);
if (r.errorCode) {
  // Our-side failure: r.error is human-readable, r.errorCode is stable
  statusEl.textContent = 'Fetch failed: ' + r.error;
  return;
}
if (r.status >= 400) {
  // Upstream HTTP error
  statusEl.textContent = 'API returned ' + r.status;
  return;
}
const data = JSON.parse(r.body);
// ... use data

// POST with JSON body
const r2 = await mica.fetch('https://api.example.com/v1/items', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + KEY },
  body: JSON.stringify({ name: 'foo' }),
  timeout: 15000,  // ms; clamped to [1, 60000]
});
```

### What you get back

```js
{
  status: 200,            // upstream HTTP status; 0 when our-side failure prevented completion
  headers: { ... },       // lowercased upstream response headers; empty when status === 0
  body: '{"..."}',        // response body as a string (JSON.parse yourself); empty when status === 0
  durationMs: 142,        // total time including DNS + connect + read
  truncated: true,        // only present if body hit the 10 MB cap (the fetch succeeded otherwise)
  error: 'human msg',     // only present on our-side failure
  errorCode: 'timeout',   // only present on our-side failure; one of:
                          //   url_invalid | ssrf_blocked | dns_error | connect_error
                          //   timeout | rate_limited | response_error | internal_error
  retryAfterMs: 12340,    // only on errorCode='rate_limited' — wait this long before retrying
}
```

### Rules

1. **Don't retry indefinitely on rate_limited.** Use `retryAfterMs` or show a user message. Fire-looping will keep you throttled.
2. **API keys live in your card code.** The card author/user provides them — Mica doesn't vault them. If you don't want them in card source, read them from a project file (`mica.files.read('docs/secrets.json')`) or from the instance file's content (`mica.getContent()`).
3. **Don't try to reach localhost or private IPs through `mica.fetch`** — SSRF protection will reject them. For calls to Mica's own `/api/*`, use the appropriate `mica.*` helper or raw `fetch('/api/...')` (which auto-scopes to the project).
4. **Binary responses are returned as UTF-8 strings** (may contain replacement chars). For PDFs, images, etc. use `mica.files.url()` + `<img>`/`<embed>` tags or proxy through `mica.files.write()` + `mica.files.readBinary()` — don't go via `mica.fetch` for binaries.

## WebSocket events via `mica.on(event, cb)`

| Event | Payload shape |
|---|---|
| `file-changed` | `{ type: "file-changed", filename: string, source: string, cardSource?: string }` |
| `file-created` | `{ type: "file-created", filename: string, source: string, cardSource?: string }` |
| `file-deleted` | `{ type: "file-deleted", filename: string }` |
| `layout-changed` | `{ type: "layout-changed", source: string, device: string }` |

`source` is the writer's `mica.windowId` (per browser tab), or `"agent"` (the chat agent wrote it), or `"external"` (an outside process — git pull, manual edit). `cardSource` is the writer's `mica.cardId` (per-card-instance UUID), set when the write went through `mica.files.write()`.

To skip self-echoes use `mica.isSelfEcho(e)` — NOT `e.source !== mica.windowId`. windowId is per-tab, so the windowId check also suppresses writes from sibling cards in the same tab. `mica.isSelfEcho()` checks `cardSource` against this card's UUID.

## Server-side channel handlers via `mica.openChannel(label, args?)`

Some card classes need bidirectional duplex streams to the server — terminal PTYs, streaming LLM completions, long-running agent loops, collaborative editing protocols. For those, the card opens a channel; the server runs a handler in a per-file session and exchanges messages.

### Existing channel-handler card classes (no work to use them)

These already have server handlers registered in `server/index.ts`. Drop the corresponding card on the canvas and the channel is wired:

| Card class | Server handler | What it does |
|---|---|---|
| `.chat` | `createAgentHandler` (Qwen SDK) | Full agent loop with subagent dispatch + tools |
| `.claude` | `createClaudeAgentHandler` | Same shape, Claude Code SDK |
| `.terminal` | `createPtyHandler` | Terminal PTY (node-pty) |
| `.llm-chat` | `createLlmChatHandler` | OpenAI-compatible streaming chat with model switcher; no tools, no system-prompt customization. Reference impl for "I just want to talk to an LLM." |
| `.skills` | `createSkillComposeHandler` | Collaborative SKILL.md authoring (propose / apply) |
| `.canvas-back` | `createCanvasBackComposeHandler` | Propose-then-apply edits to canvas-back.md |

If your card's job overlaps with one of these, REUSE that card class instead of writing a new one. E.g., for "let me chat with an LLM," instantiate a `.llm-chat` card; don't build a custom one.

### Routing rule

When the card runs `mica.openChannel('whatever', args)`, the server routes by **the card's file extension**, NOT the string argument. The argument is decorative — it's passed to the factory's `_args` parameter and most handlers ignore it. So `mica.openChannel('hello')` and `mica.openChannel('llm_session')` from a `.chat` card both land in the same `chat` handler.

This means: **a custom card class without a registered handler will fail with `Error: No handler registered for: <classname>`** when it tries `mica.openChannel`. You must register one.

### Building a custom card class with a server handler

Two file additions on top of the standard card class:

**(1) `server/plugins/<name>.ts`** — exports a factory:

```ts
import type { ChannelHandler, SessionContext } from "../channelManager.js";

export function create<Name>Handler() {
  return async function factory(
    _content: string,                      // initial card-file content (often unused)
    _args: Record<string, unknown>,        // the args from openChannel(label, args)
    ctx: SessionContext,                   // sendTo / broadcast / sessionId etc.
  ): Promise<ChannelHandler> {
    // Per-session state lives in this closure
    const history: Message[] = [];

    return {
      onAttach(clientId) {
        // Replay state to a (re)connecting client
        ctx.sendTo(clientId, { type: "history", messages: history });
      },

      async onData(_clientId, data) {
        // Handle inbound messages from card.js's ch.send()
        // Stream responses via ctx.broadcast({ type: "delta", content })
      },

      onDestroy() {
        // Cleanup when the card-file is deleted (session ends)
      },
    };
  };
}
```

**(2) Register it in `server/index.ts`** alongside the existing handlers:

```ts
channelManager.registerHandler("<class-name>", create<Name>Handler());
```

`<class-name>` = the file extension without the leading dot. So `.taxomatic` files use `channelManager.registerHandler("taxomatic", ...)`.

### When to add a custom handler vs. reuse `.llm-chat`

| Need | Use | Reason |
|---|---|---|
| Custom UI but generic LLM streaming | `.llm-chat` card class doesn't fit (its UI is fixed); build custom handler | UI ≠ contract; different concerns |
| Off-the-shelf chat with no domain logic | `.llm-chat` directly | Already does what you need |
| Custom system prompt | Custom handler (the existing `llm-chat` handler doesn't accept system prompts from the card) | Could PR to `llmChat.ts` to accept a prompt; or fork |
| Structured response parsing (JSON deltas, tool-call extraction) | Custom handler — the parser belongs server-side | Card shouldn't own LLM-output parsing logic |
| Multi-step pipeline (chat → research → synthesize → respond) | Custom handler | Orchestration is server-side concern |
| Streaming with backpressure or fan-out | Custom handler | Channel is the natural primitive |

### Reference: `card-classes/llm-chat/card.js` and `server/plugins/llmChat.ts`

The cleanest small example. ~140 lines on each side. Read both before building a custom handler — they show the canonical send/onData/history shape, abort handling, and SSE-stream parsing.

### Anti-patterns

- ❌ `card.js` calls `fetch('http://localhost:8012/v1/chat/completions')` directly — bypasses Mica entirely; loses provider abstraction, rate limit, abort, history.
- ❌ `card.js` calls `mica.fetch` to the LLM — works for cloud LLMs but blocked by SSRF for local llama-server (loopback IPs are blocked).
- ❌ Building a custom handler for a need that `.llm-chat` already covers.
- ❌ Putting LLM-response parsing in the card — when the LLM contract changes (different provider, structured output schema), every card needs editing.

## Raw HTTP endpoints (fallback only)

You should almost never need these — `mica.files.*` and `mica.cardClasses.list()` cover the common cases. Documented here in case you need something they don't expose.

- `GET /api/files` — `[{ name, type: "file"|"directory", size, modifiedAt }]` (field is `name`, NOT `path`)
- `GET /api/files/{encodedPath}` — raw bytes; use `.text()` or `.arrayBuffer()`, NEVER `.json()`
- `PUT /api/files/{encodedPath}` — body `{ content, source: mica.windowId, cardSource: mica.cardId }`
- `DELETE /api/files/{encodedPath}`
- `GET /api/card-classes` — `{ [name]: { builtIn, format } }`

Do NOT invent endpoints or query params (`?path=`, `/api/directory`, `/api/tree`, `/api/filesystem` — none exist).

## Verify API shapes if you suspect drift

If you're using `mica.files.*` and something seems wrong, the helper may be stale relative to the server. Quick check:

```bash
curl -s http://127.0.0.1:3002/api/files | head -5
```

Compare against what the helper returns. Common hallucinated fields that don't exist anywhere: `file.path` (on the raw response), `file.isDirectory` (on the raw response — `type === "directory"` is the real check), `file.mtime` (never exists — use `modifiedAt`).

## Rules

1. **Dark theme only.** Backgrounds transparent or `rgba(255,255,255,0.03-0.06)`. Text `#ccc`/`#ddd`/`#e6edf3`. Borders `rgba(255,255,255,0.06-0.1)`. No `#fff`, no `#f0f0f0`.
2. **Use IDs for dynamic elements** — never `:nth-child`, never positional selectors.
3. **Prefer `mica.files.write()`** — auto-injects both `source` and `cardSource` so self-echoes can be filtered with `mica.isSelfEcho(e)`. Raw `fetch()` writes need both fields by hand.
4. **Prefer CDN libraries** via `metadata.json.dependencies.scripts` over hand-coding: Chart.js, FullCalendar, Sortable.js, CodeMirror, Leaflet, Marked, Mermaid. Don't reinvent.

   **VERIFY EVERY CDN URL before writing it to metadata.json.** Both unpkg and jsdelivr return 404 for hallucinated paths (wrong version, wrong file, wrong scope), and you cannot tell from training data alone. Run a HEAD check:
   ```bash
   curl -sI -L <url> | head -1   # expect: HTTP/2 200 (302 chains are fine if final is 200)
   ```
   Common hallucination patterns to watch for:
   - **Missing `@scope/` prefix** for scoped packages (e.g. `unpkg.com/leaflet-terminator/...` is WRONG; the real package is `@joergdietrich/leaflet.terminator`).
   - **Version that never published** (e.g. `@1.0.0` when the latest is `0.1.0` — your prior is biased toward round numbers).
   - **Wrong subpath inside the package** (`/L.Terminator.js` vs `/index.js` vs `/dist/leaflet-terminator.js` — README filenames don't always match the npm-published layout).

   If a HEAD check 404s, fall back to the package's npm registry listing (`https://registry.npmjs.org/<pkg>`) to find the actual `main` field and the latest version, OR use `https://www.jsdelivr.com/package/npm/<pkg>` which lists all files in the published tarball.
5. **Never block the UI** during async work — update DOM progressively.
6. **Instance files go in the canvas root** (usually `docs/`), not in `.mica/`.
7. **Verify API shapes with `curl` before writing code that depends on them** (see above).

## Pre-completion smoke test — verify EVERY external dependency before declaring done

The most expensive class of card-build failures comes from coding against assumptions about external state without verifying them. CDN URLs that 404, REST endpoints that return a different shape than imagined, tile servers with wrong template patterns, npm versions that never published — all silent in the build, visible only at runtime. **Verification at build time is cheaper than a debug round-trip with the user.**

Before declaring a card class complete, enumerate every external resource it touches at runtime, run the appropriate smoke test, and record the result. Three tiers, by what verification is possible:

### Tier 1 — Reachability (mandatory)

For every URL the card depends on at load or runtime:

| Target | Where it lives | Check |
|---|---|---|
| Script CDN URLs | `metadata.json.dependencies.scripts` | `curl -sI -L <url> \| head -1` → expect `HTTP/2 200` (302 chains fine if final is 200) |
| Stylesheet CDN URLs | `metadata.json.dependencies.styles` | same |
| Tile-server pattern | hardcoded in `card.js` (e.g. `'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png'`) | substitute one sample (e.g. `s=a, z=2, x=2, y=2`), curl, expect 200 |
| Font URLs | `metadata.json.dependencies.styles` or `@font-face` in card.css | curl, expect 200 |
| GeoJSON / data URLs | hardcoded in `card.js` | curl, expect 200 |

Tier-1 failures are usually one of three patterns: missing `@scope/` prefix, version that never published, wrong subpath inside the package. The "Rule 4 — Prefer CDN libraries" section above has the recovery recipe.

### Tier 2 — Shape (mandatory for any REST/WS endpoint)

For every external API the card calls:

| Target | Check |
|---|---|
| REST endpoint (`mica.fetch` or direct CDN data) | call once with sample params, `JSON.parse`, assert the fields the card expects exist (`data[0].lat`, `data[0].lng`, etc.) |
| WebSocket message contract | open the channel, send a ping, log the first response payload shape |
| npm package version | `curl -s https://registry.npmjs.org/<pkg>` → confirm `dist-tags.latest` matches what `metadata.json` pins |
| Library global / namespace | confirm the loaded library exposes the global the card calls (`L.terminator` vs `L.Terminator`, `Chart` vs `Chart.js`, `mermaid.run` vs `mermaid.init`) — read the library's README or run a tiny page that loads the script and `console.log(window.<global>)` |

Tier-2 catches the most insidious failures: a 200 response doesn't mean the resource matches your assumption. A library can load fine and expose a different surface than the agent imagined from training data.

### Tier 3 — Documented assumption (mandatory for everything you can't verify)

Some failure modes only appear at runtime in a real browser, with real auth, real CORS, real rate limits. The build agent can't simulate all of them. Instead, **write the assumption down** so the failure mode becomes "documented assumption was wrong" instead of "we never thought about it":

| Assumption | Where to record |
|---|---|
| Auth model — no key required, key in env, OAuth flow, etc. | `spec.md` § Assumptions |
| CORS posture — does the server send `Access-Control-Allow-Origin: *`? Did you verify with a browser-side test? | `spec.md` § Assumptions |
| Rate limits — calls per minute, response if exceeded | `spec.md` § Assumptions |
| Regional / geo restrictions | `spec.md` § Assumptions |
| Required headers — `User-Agent`, `Origin`, `Referer` | `spec.md` § Assumptions |
| API stability — is this a versioned endpoint or a hostname that may move? | `spec.md` § Assumptions |

A card class with no `## Assumptions` block in spec.md is incomplete — at minimum, write "no external APIs called" or "all dependencies are public CDNs with no auth."

### Recording the smoke test

Append a `## Smoke test results` section to `spec.md` (or the card class's `context.md` if you prefer class-scoped) listing every URL/endpoint with status + shape. Future runs can compare against this ledger; it doubles as documentation for whoever debugs the card next.

Example:

```markdown
## Smoke test results

| Resource | Tier | Status | Notes |
|---|---|---|---|
| `unpkg.com/leaflet@1.9.4/dist/leaflet.js` | 1 | 200 | exposes `window.L` |
| `unpkg.com/@joergdietrich/leaflet.terminator@1.3.0/L.Terminator.js` | 1+2 | 200 | exposes `L.terminator` (lowercase t) |
| `basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png` | 1 | 200 (sample tile) | no auth, free tier |

## Assumptions

- CartoDB Dark Matter tiles: no auth, no rate limit specified for low-volume use; assume <100 cards × 256 tiles each per session is fine.
- Leaflet.Terminator: assumed CORS-friendly (script load, not fetch).
- No browser-side geolocation API used.
```

The smoke test is a precondition for "card class is ready to ship," not an optional step. Skipping it produces the build → break → debug round-trip we're trying to eliminate.

## ❌ FORBIDDEN in `card.html` — the server inlines card.js and card.css

`card.html` is a fragment, not a document. The Mica server reads `card.html`, `card.css`, and `card.js` from the class directory and assembles the runtime HTML by concatenating: `cardHtml + <style>${cardCss}</style> + <script>${cardJs}</script>`. The card.js and card.css are **already inlined** by the time the browser sees the markup.

Therefore, **never** put any of these in `card.html`:

```html
<!-- WRONG — server inlines card.js. This script tag fetches `card.js` as
     a relative URL against the host page (the React app), gets 404 or HTML
     back, and surfaces as "Failed to load dependency: Failed to load card.js". -->
<script src="card.js"></script>

<!-- WRONG — same reason. Server inlines card.css. -->
<link rel="stylesheet" href="card.css">

<!-- WRONG — card.html is a fragment, not a document. The server assembles
     the document; your <!DOCTYPE>/<html>/<head>/<body> are at best wasted
     bytes and at worst an attractive nuisance for "let me put a script tag
     in head" mistakes. -->
<!DOCTYPE html>
<html lang="en">
<head>...</head>
<body>...</body>
</html>
```

```html
<!-- CORRECT — fragment only. Use IDs for anything card.js will update. -->
<div class="my-card">
  <div id="header">...</div>
  <div id="body"></div>
</div>
```

For reference shape, read any of the built-in card classes (`.../card-classes/canvas/card.html`, `.../card-classes/llm-chat/card.html`) — they all start with a top-level `<div>`, never with `<!DOCTYPE>`.

Library scripts and styles ARE legitimate external dependencies — they go in `metadata.json.dependencies.scripts` / `.styles`, NOT in `<script src=...>` tags inside card.html. The runtime loads metadata.json's deps before assembling the card; that's the supported path.

## ❌ FORBIDDEN — never write `card.js` like this

```js
// WRONG — Mica has NO class-registration model. This class is never instantiated.
class MyCard {
  constructor(context) { this.context = context; }
  async render(container) { ... }
  destroy() { ... }
}
if (typeof Mica !== 'undefined' && Mica.registerCardClass) {
  Mica.registerCardClass('mycard', MyCard);  // Mica.registerCardClass DOES NOT EXIST
}
```

Also forbidden: `this.context.api.listFiles(...)`, `this.context.api.getFile(...)`, `context.template`, `export default class` — these are all invented APIs. If you write any of them, the card will silently not start.

### ❌ ALSO FORBIDDEN — never redeclare CARD_SHIM globals

`container`, `mica`, and a few helpers are injected as globals before your script runs. The runtime wraps your card.js inside a closure, so any top-level `const`/`let` with the same name produces a hard `SyntaxError: Cannot declare a const variable twice: 'container'` at mount time and the card never starts.

```js
// WRONG — `container` is already a const in this scope.
const container = document.getElementById('map-container');
const mica = window.mica;     // also wrong, also fatal
```

```js
// CORRECT — `container` is THIS card's DOM frame. Reach inside it via
// querySelector to grab elements from your own card.html.
const mapEl = container.querySelector('#map-container');
const button = container.querySelector('#go');
```

Names reserved by CARD_SHIM that you must NOT redeclare: `container`, `mica`. Any other variable name is yours to use.

## ✅ CORRECT — `card.js` runs as top-level code

```js
// container and mica are injected globals. Write top-level code only.
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

No class. No registration. No `this`. No `export`. Top-level async is fine (`await` works at the top). Use `mica.files.write()` — you don't need to remember URL encoding, the `source`/`cardSource` fields, or the `application/json` header.

## Minimal working counter card

Three files under `.mica/card-classes/counter/`:

**`metadata.json`**
```json
{
  "extension": ".counter",
  "badge": "CTR",
  "defaultTitle": "Counter",
  "dependencies": { "scripts": [], "styles": [] }
}
```

**`card.html`**
```html
<div style="display:flex;flex-direction:column;gap:8px;padding:12px">
  <div id="display" style="font-size:32px;color:#e6edf3;text-align:center">0</div>
  <button id="inc" style="padding:8px;background:rgba(255,255,255,0.06);color:#ccc;border:1px solid rgba(255,255,255,0.1);border-radius:4px;cursor:pointer">+</button>
</div>
```

**`card.js`** — the ✅ example above.

**Instance**: create `docs/my.counter` with content `0`. Card appears on canvas.

## ✳️ STEP 0 — Start by copying the skeleton, do NOT write from scratch

A correct `card.js` / `card.html` / `metadata.json` / `card.css` skeleton lives at `/workspaces/mica/templates/_card-class-skeleton/`. The very first thing you do in any card-class build is:

```bash
cp -r /workspaces/mica/templates/_card-class-skeleton .mica/card-classes/<your-name>
```

Then `edit` the files in place to replace the `REPLACE_ME` placeholders and add your card's behavior. Do NOT use `write_file` to author **any** of the four files from an empty page:

- `card.js` hand-written from scratch leaks class-wrappers, `export` keywords, and invented base classes.
- `metadata.json` hand-written from scratch drops required fields (`badge`, `defaultTitle`) and leaks package.json-shaped fields (`name`, `version`) — see the Required fields table above.
- `card.html` / `card.css` hand-written drift from scoping conventions.

The skeleton already has the correct shape; stay inside its structure.

After the copy, **the very next thing you do — before adding any behavior — is replace every REPLACE_ME placeholder in `metadata.json`**. Until that's done, the card is broken at the framework level (the resolver compares `extension` to the directory name, so `.REPLACE_ME` in `world-time-clock/` produces a `card-error` and the card never loads). One quick verification:

```bash
grep -nR "REPLACE_ME" .mica/card-classes/<your-name>/
# expect: no output
```

If grep returns ANY hits, fix them before doing anything else.

Then in this order:

1. **`edit metadata.json`** — replace `extension`, set `badge` (2-3 char mnemonic), set `defaultTitle` (human-readable). Verify with the grep above; the file must contain zero `REPLACE_ME`.
2. `edit card.html`: replace the placeholder `<div id="body">` with your markup.
3. `edit card.js`: remove the placeholder line and add behavior. Uncomment the `mica.files.*` / `mica.on(...)` patterns you need.
4. `edit card.css` if you need custom styling beyond the default.
5. **Create an instance file** (e.g. `canvas/my.<extension>`) so the card mounts on the canvas.
6. **Visually verify with `render_capture`.** Call the tool with the instance filename, e.g.:

   ```
   render_capture({ filename: "canvas/my.<extension>" })
   ```

   The result includes a PNG of the rendered card — inspect it directly to confirm: the card mounted, the expected layout appears, labels are legible, nothing is clipped or overflowing, no red error banner. If something looks wrong, iterate on the card-class files and re-capture. JSON validity and `node -c` only prove syntax; only a visual check proves the card actually works.

## Build in stages, inline

A single card class is ONE coherent unit even though it has 4 files (the files share live state — DOM IDs flow from card.html → card.js, computed styles flow from card.css → card.js). Decomposing it across subagent slots fragments that shared state and produces broken cards. Build it inline, in stages. **Do NOT delegate a single-card-class build to subagents** — that pattern is for multi-card-class or multi-module work where units are genuinely independent.

Typical ladder AFTER the skeleton copy:

1. `edit metadata.json` — set extension + badge + defaultTitle
2. `edit card.html` — minimal layout with IDs for dynamic elements
3. `edit card.js` — one wired event (e.g. button click → DOM update)
4. read/write via `mica.getContent()` + `mica.files.*`
5. events via `mica.on('file-changed', ...)` if the card needs to react
6. CSS + polish

Ship step 1, verify, then step 2. Do not one-shot a 200-line `card.js`. Run `bash scripts/restart.sh` after server changes; hard-refresh after frontend-only changes.

## Debugging "Failed to load dependency: <url>" card-errors

When the chat surfaces a card-error of the form `Failed to load dependency: Failed to load https://...`, the URL itself is the prime suspect. The card class loaded its `metadata.json`, asked the browser to fetch the CDN script, and the browser got a 404 (or a CORS / MIME-type rejection).

**DO NOT re-read `metadata.json` looking for clarity.** The file contains exactly the URL that's failing — re-reading it produces no new information. This is a common loop trap: the model keeps cat-ing the metadata hoping the next read explains the error, the URL stays wrong, and the loop runs until the SDK kills the process. Break out immediately:

1. **Verify the failing URL with curl:**
   ```bash
   curl -sI -L "<the exact URL from the error>" | head -1
   ```
   If 404, the URL is hallucinated. Don't guess a fix — look it up.
2. **Find the real URL:**
   - npm registry: `curl -s https://registry.npmjs.org/<pkg> | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['dist-tags']['latest'], '/', d['versions'][d['dist-tags']['latest']].get('main', '?'))"` — gives latest version + the package's `main` entry point.
   - jsdelivr file index: `https://www.jsdelivr.com/package/npm/<pkg>` — lists every file in the tarball.
   - For scoped packages (`@scope/name`), the URL on unpkg is `unpkg.com/@scope/name@<version>/<file>` — easy to forget the `@scope/` part.
3. **Update `metadata.json` with the verified URL,** then ask the user to refresh; the card-error will fire again only if the new URL is also wrong.

Time budget for this: ONE round of curl + one metadata edit. If the second URL also 404s, stop and ask the user — guessing a third URL is a bad use of context.
