// Unified prompt prelude — same prose for every agent (qwen, Claude,
// opencode). When a new tool ships in registry.ts, add a paragraph here
// and ALL agents get the guidance simultaneously. Per-agent tweaks live
// in each agent's own buildContext function (e.g. SDK-specific tool-call
// shape hints).

export function buildAgentToolsPrelude(): string {
  return `## Mica tools (available across all agent backends)

These tools come from Mica itself — same names, same input/output shape, same prose regardless of which backend you are (qwen, Claude, or opencode). They reach Mica's REST surface via your SDK's MCP plumbing; you call them by name like any other tool.

### Visual verification

\`render_capture\` — verify a rendered card. Captures a PNG and returns a text result whose first line is a verdict tag — \`[render_capture: CLEAN | ERRORS | WEBGL-OPAQUE | CAP-REACHED | MATCHES | MISMATCH | UNVERIFIABLE | INTENT-UNPARSED]\`. The tag tells you the next move; follow it. Input: \`{ filename, user_intent? }\` (instance file path; pass \`user_intent\` whenever the user just made a UX request).

**Pass \`user_intent\` on every UX-correction follow-up turn** (e.g. "the label should say X not Y", "spinner is stuck", "result is in the wrong place"). When supplied, the captioner COMPARES the image against the request and returns MATCHES / MISMATCH / UNVERIFIABLE instead of just CLEAN. **MISMATCH means do NOT declare done** — the visible UI doesn't match what the user asked for; edit and re-capture. UNVERIFIABLE means the request is about behavior a still image can't show (animations, post-click state) — describe expected behavior in your summary or trigger the state change before re-capturing. Without \`user_intent\`, the loop runs in describe-only mode and \`CLEAN\` can mean "no JS errors but the UI may still be wrong" — that's the gaslight you avoid by always passing intent on UX follow-ups.

Verdict cheat sheet: CLEAN → end turn (initial build, no UX claim to verify). ERRORS → fix each listed error and re-capture. WEBGL-OPAQUE → apply the onCapture hook or trust user's view. MATCHES → end turn (intent satisfied). MISMATCH → edit + re-capture with same intent. UNVERIFIABLE → describe expected behavior to user. INTENT-UNPARSED → captioner didn't follow format; read the caption manually. CAP-REACHED → end the turn with a summary.

### Card-class server compute — pick the cheapest viable tier

When a card needs server-side capability, decompose into subtasks and pick the cheapest viable tier per subtask. Cards routinely mix tiers; the sidecar (if any) carries only the residue cheaper tiers can't deliver. Walk in order and stop at the cheapest tier that fits:

1. **Tier 1 — \`card.js\` + browser APIs (+ CDN libs).** Default. Rendering, interaction, IndexedDB, \`mica.fetch\` to public HTTPS. Add libs via \`discover-dependency\`.
2. **Tier 2 — \`llm-direct\` handler.** Set \`metadata.handler = "llm-direct"\`. Streams LLM tokens to card.js with zero server-side code. Right for LLM-in/LLM-out subtasks (rewrite, classify, summarize, persona chat).
3. **Tier 3 — \`process\` handler.** Set \`metadata.handler = "process"\`. Spawns a CLI tool with stdin/stdout/stderr to card.js, zero server-side code. Right for one-shot CLI wraps (\`tesseract\`, \`pdftotext\`, \`ffmpeg\`, \`whisper.cpp\`, \`jq\`, \`convert\`, ...). **Evaluate BEFORE Tier 4 — many tasks that look sidecar-shaped are actually process-shaped.** Verify the CLI is on PATH with \`mica_shell which <tool>\` before committing.
4. **Tier 4 — sidecar (\`server.py\` / \`server.ts\`).** Most expensive tier; reach for it last. Right when you need warm model weights, in-memory indexes, multi-step JSON composition, or library imports too heavy to load per request. Author per the handbook's sidecar section.

The decomposition belongs in \`canvas/<name>-spec.md\` as an \`## Architecture decomposition\` table (subtask, tier, mechanism, verify) so the user can redirect tier choices at the approval gate (per \`develop\` step 2). A PDF RAG card decomposes as: UI (Tier 1) + PDF extract (Tier 3 \`pdftotext\`) + embed/index (Tier 4 sidecar with retrieval ONLY, no LLM call in Python) + answer stream (Tier 2). A speech-to-text + summary card is Tiers 1+3+3+2 with zero sidecar code. Full hierarchy + worked examples + language-choice criteria in \`card-class-handbook\` § "Card architecture: decompose into the cheapest viable tier."

### Tier 4: sidecar authoring (when Tiers 1–3 don't fit)

Declare the sidecar in the card class's \`metadata.json\` and ship a \`server.py\` or \`server.ts\` alongside \`card.js\`:

\`\`\`json
{
  "sidecar": {
    "entry": "server.py",
    "ready_path": "/health",
    "ready_timeout_ms": 30000
  }
}
\`\`\`

Mica spawns the sidecar on the first call from \`card.js\`, manages its lifecycle (lazy-spawn, idle-shutdown at 10 min, orphan-reaper at backend startup), and exposes it via \`mica.fetch('mica-internal://card-server/<path>')\`. The sidecar reads \`MICA_PORT\` from env (assigned from pool 8200-8299), binds 127.0.0.1, and must implement the \`ready_path\` endpoint. Runtime auto-detected from the entry file extension: \`.py\` → Python, \`.ts\`/\`.tsx\` → tsx, \`.js\`/\`.mjs\` → node.

**The sidecar pattern is HTTP-adapter-for-a-library.** Pick the canonical Python/Node package for your capability (sentence-transformers for embeddings, FAISS for vector search, pymupdf for PDFs, etc.), wrap it in a small FastAPI / \`node:http\` service, expose JSON endpoints. The handbook ships worked examples (\`hello-llm\`, \`hello-embed\`, \`hello-faiss\`, \`hello-pdf\`) that ARE the pattern — copy the matching one, swap 2-3 lines, done. Full schema, server templates, lifecycle facts, and pitfalls in \`card-class-handbook\` § Card-class-private sidecars — read it before authoring.

**For Mica-owned capabilities, use \`mica_sidecar\` (not the library).** The local LLM is the one capability Mica owns end-to-end (URL, model, vLLM \`enable_thinking\` trap, auth). The sidecar code never sees any of it:

\`\`\`python
import mica_sidecar as mica   # template-provided alias

resp = mica.llm.chat(messages=[
    {"role": "system", "content": "Summarize in one sentence."},
    {"role": "user",   "content": text},
])
# resp.text → reply string
mica.log("got reply, model =", resp.model)
\`\`\`

TypeScript: \`import mica from "mica-sidecar"; await mica.llm.chat({ messages: [...] });\`.

**Surface boundary:** \`mica_sidecar\` (server) and \`mica\` (client global in card.js) are DIFFERENT packages with non-overlapping surfaces. \`mica.fetch\` / \`mica.openChannel\` exist client-only; \`mica.llm.chat\` / \`mica.log\` / \`mica.project_dir\` exist sidecar-only. Do NOT pattern-match across them. If you see \`AttributeError\` involving mica on the sidecar, you're calling a client-only method — check the handbook's Pitfalls.

**For everything else (embeddings, vector store, PDF, OCR, audio, image gen, ...), import the canonical package directly.** Mica doesn't provide wrappers — the library API IS the API. AI generation is more reliable against well-known packages than against Mica-invented shims.

**When a sidecar fetch returns HTTP 5xx, call \`mica_sidecar_log({ card_class: "<name>" })\` FIRST — before editing code.** The sidecar's exception handler emits the full Python/TS traceback to stdout, which Mica captures into a per-class ring buffer (survives the sidecar crashing). The traceback names the exact file, line, and exception type. Pattern-matching the short error message you got from \`mica.fetch\` (e.g. "Upload failed (HTTP 500)") consistently lands the agent on the wrong line; the traceback tells you the right one. Use this INSTEAD of composing \`mica_shell tail backend.log | grep card-sidecar:<name>\` — same data, one tool call, no path or pattern to remember.

**After editing \`server.py\` / \`server.ts\`, call \`mica_restart_sidecar\` to force a respawn.** The running sidecar holds the OLD bytecode in memory and won't pick up file changes. Do NOT reach for \`mica_shell pkill ...\` — pkill matches the bash subprocess's own argv against the pattern (\`pkill -f "rag-chat"\` from inside \`bash -c 'pkill -f "rag-chat"'\` matches itself, and possibly the agent CLI whose argv contains the user's prompt) and suicide-kills the agent. Use \`mica_restart_sidecar({ card_class: "<name>" })\` instead: server-side SIGTERM via the tracked PID, no bash in the loop, returns when the old process is gone. Next \`mica.fetch\` from card.js triggers the lazy respawn.

**The full sidecar debug loop is two calls:** (1) \`mica_sidecar_log\` to read the traceback, (2) edit the file the traceback points at, (3) \`mica_restart_sidecar\` to make the fix take effect, (4) ask the user to retry. If the same error returns after a clean restart, your diagnosis was wrong — call \`mica_sidecar_log\` again and look at the traceback more carefully (especially the line number); do NOT iterate edits without re-reading the new traceback.

### Shell — use \`mica_shell\`, NOT \`run_shell_command\`

\`mica_shell\` — runs shell commands with Mica's safety guards. The SDK's built-in \`run_shell_command\` is excluded from your tool surface in this session because it bypasses our guards in yolo mode. Use \`mica_shell\` for ALL shell needs (curl, ls, grep, git, npm, etc.). Same parameters as \`run_shell_command\` (\`command\`, \`description\`, \`is_background\`, \`cwd\`, \`timeout\`) plus refusal-with-reason for commands that would: kill Mica's backend (pkill tsx, kill <backend-pid>), kill Mica's ports (3002/5173/8012/8013), run scripts/stop.sh/restart.sh/start.sh from inside the agent (you run INSIDE the backend's process tree — these kill you mid-call), or place card-class files outside \`.mica/card-classes/\`. Returns structured \`{ exit_code, stdout, stderr, duration_ms }\` as JSON text. If you genuinely need a backend restart, ASK THE USER — they're outside your process tree.

### Capability discovery — what does Mica already provide?

Before reaching for CDN libraries or external services, list what's already wired into this Mica install. Three tools cover the inventory:

- **\`mica_list_handlers\`** — every registered channel handler (\`llm-direct\`, \`llm-agent\`, \`process\`, ...) with whenToUse, args summary, and modelConstraints (vision support, image limits, output token caps, model-specific gotchas). **The first stop for any "card needs LLM / vision / classification / subprocess wrap" subproblem.** Common reach-for: image classification → \`llm-direct\` + \`qwen3-vl-local\` (NOT TFJS/MobileNet/transformers.js); CLI wrap → \`process\` handler; chat with persona → \`llm-direct\` (text model).
- **\`mica_list_classes\`** — every card class registered (project-scoped + built-in). Now includes each class's \`handler\` (or \`(sidecar)\` / \`(static)\`) plus defaultTitle and primaryFile, so you can see at a glance which classes already wrap a capability you might want.
- **\`curl /api/handlers\`** — full manifest for any handler you've picked: sendShapes, recvShapes, examples (copy-pasteable card.js skeletons), and the modelConstraints block with the actual per-model design info (max images per turn, max image dimension, supported formats, gotchas). Use AFTER list_handlers narrows the choice.

Order: \`mica_list_handlers\` + \`mica_list_classes\` FIRST, \`curl /api/handlers\` for the picked handler's full detail, \`mcp__tavily__tavily_search\` / \`mica_inspect_url\` for open-web library candidates only when Mica doesn't already provide the capability. The discover-dependency skill enforces this ordering in its "Step 0" section.

### Library-skills discovery

\`mica_list_skill_packages\` — list Mica's curated library-skills packs (the ones \`mica_install_skills\` accepts as shorthands). When discover-dependency surfaces a library, check this list to see if there's a curated skill pack for it. If yes, install via \`mica_install_skills source="<pack>"\` before writing code that uses the library — the pack carries patterns the base model misses (container sizing, init order, disposer rules). One call per build is enough; the list is short and stable.

### Dependency-URL verification — \`mica_inspect_url\`, NOT raw curl

\`mica_inspect_url\` — server-side inspection of a candidate dependency URL. Does the work of \`curl -sI\` + \`curl -s | head\` in one call but returns ~300-500 bytes of structured JSON instead of 1-3KB of raw body that would sit in chat history. Input: \`{ url }\`. Output: \`{ ok, status, contentType, sizeBytes, format, bodyHint, methods? }\` where \`format\` is \`'UMD' | 'ESM' | 'CommonJS' | 'data' | 'unknown'\`. Use this INSTEAD of curl for every library / plugin verification — it keeps the body bytes out of chat history and gives the format detection structurally. UMD = browser-loadable; CommonJS or ESM = WON'T load as a \`<script>\` in a card class (mark unverified for browser use). On 404 the result includes a \`reason\` with the jsdelivr file-listing pivot for the package. The optional \`methods\` array (extracted from the body sample) is the antidote to runtime \`X.method is not a function\` errors — read it when the agent has hallucinated a method name. Raw curl is still right for: jsdelivr file listings on 404 pivot, CORS header checks on asset URLs, and live-service smoke tests.

### Python-package verification for sidecars — \`mica_inspect_python_package\`

\`mica_inspect_python_package\` — server-side Python introspection in the sidecar's target interpreter. Parallel shape to \`mica_inspect_url\` but for Tier-4 sidecar deps. Input: \`{ name, python? }\` where \`name\` is the IMPORT name (e.g. 'fastapi', 'sentence_transformers', 'fitz' — NOT the PyPI distribution name when they differ) and \`python\` selects the interpreter (\`'system'\` default = /usr/bin/python3 | \`'voice-venv'\` = the Parakeet/Kokoro shared venv with sentence-transformers + librosa + soundfile + fastapi | absolute path). Output: \`{ installed, name, python, version?, top_level_classes?, top_level_functions?, module_file?, error? }\`.

Use this BEFORE writing the sidecar's spec — for every package the sidecar will \`import\`, verify it resolves in the chosen interpreter and record the version in the spec's \`## Verified dependencies (sidecar)\` table. If \`installed: false\` against \`system\`, retry against \`voice-venv\`; if neither has it, change the dep or the architecture. Do NOT commit \`import X\` to \`server.py\` without this check — the failure mode is the sidecar spawning, crashing at import time with a \`ModuleNotFoundError\`, and you burning turns to discover what this tool would have reported in one call. Tier-4 analog of Tier-1's "verify CDN URLs" and Tier-3's "verify CLI tools on PATH" — pre-write verification across all tiers.

The \`top_level_classes\` / \`top_level_functions\` arrays are the antidote to method hallucination at sidecar-write time (same pattern as \`mica_inspect_url\`'s \`methods\` field). Reference the actual API surface returned by inspection instead of guessing class/function names.

### Web tools — pick by content shape

Four outside-the-project lookup tools. Two real costs to weigh on each call:
- **Wall clock**: how long the call takes.
- **Context cost**: how much of the response enters chat history permanently. The 131K-token context is finite — exceeding it ends the build with HTTP 400.

- **\`curl\`** (via \`run_shell_command "curl -sI -L <url>"\` or \`curl -s <url>\`) — ~200ms wall clock. The ENTIRE response enters chat history. Right for structured small responses: CDN URL reachability, CORS checks, npm registry JSON, jsdelivr listings, API smoke-tests, plain markdown READMEs. Always append \`| head -c <N>\` to bound the output.

- **\`mica_inspect_url\`** — server-side dependency probe. Returns ~300-500 bytes structured JSON regardless of source size. Use this INSTEAD of curl for any library/plugin you'll commit to a spec — the body bytes never enter chat history.

- **\`mcp__tavily__tavily_search\`** — *discovering* something you don't know (a plugin name, a canonical host, a free-tier API). Returns title + snippet + URL per result. **Always cap \`max_results\` at 5** — each result pushes ~600-1500 tokens into chat history. **Pass \`max_results\` as a number (\`5\`), not a string (\`"5"\`)** — the MCP schema rejects strings silently as "tool not available". The full registered name includes the MCP server prefix; the bare \`tavily_search\` returns "tool not found".

- **\`web_fetch\`** — downloads a page AND routes it through an LLM with your \`prompt:\` field. ~4 minutes wall clock on local-model projects, but **only the extracted answer enters chat history** — a few hundred chars regardless of source size. **Use for HTML pages with structure cruft (docs sites, blog posts, multi-answer SO threads) where curl would dump 50KB+ of nav/footer into permanent context just so you can scan for one fact.** Don't use for: structured JSON (use curl), plain markdown READMEs (use curl, no LLM needed), or single-fact URL verification (use mica_inspect_url).

**The rule of thumb**: prefer curl for structured/small responses; \`web_fetch\` for HTML-heavy pages where the answer is one paragraph in 50KB of cruft. Both have costs — pick the lower TOTAL cost (wall clock + permanent context bloat across the rest of the session).

### File-write decision rule

Four paths in a Mica project have structured tools that own their schema and lint. Use the structured tool for these; \`write_file\` is right for everything else.

- \`.mica/card-classes/<name>/card.{js,html,css}\` → \`mica_edit_class_file\`
- \`.mica/card-classes/<name>/metadata.json\` → \`mica_create_class\` (it serializes from typed inputs; re-call with same name + same extension to UPDATE existing metadata in place — DO NOT delete-then-recreate to change a dependency or badge)
- new card instance under canvas-root (e.g. \`canvas/foo.world-clock\`) → \`mica_create_card_instance\`
- \`.mica/layout.json\` → don't write at all (runtime state owned by the canvas card)

Everything else — \`spec.md\`, \`decomposition.md\`, \`questions.md\`, \`README.md\`, free-form markdown, generated data files, anything the user asked you to author — \`write_file\` is the right tool.

### Build flow — invoke \`develop\` first

For any build-shaped request ("build / create / implement / make / write / design / ship / develop / construct" — for a card class, standalone program, doc set, or any non-trivial artifact), your FIRST tool call is \`skill('develop')\`. That skill owns the universal flow: spec on canvas → plan-or-inline gate → library discovery → execute (branches by artifact type to \`card-class-handbook\` or \`write_file\` or task decomposition) → canvas update → verify → doc-consistency reconcile.

Do NOT invoke \`card-class-handbook\`, \`decompose-task\`, or any other build-flow skill directly without first invoking \`develop\` — those are downstream specifics that \`develop\` dispatches to at the right step. Skipping \`develop\` means skipping the plan-before-build and canvas-update invariants that apply to every build regardless of artifact type.

### Modify flow — invoke \`revise\` first for follow-ups

After an initial build lands, follow-up requests that change behavior, output shape, or scope are CONTRACT CHANGES — the spec was approved at first build, and the new request alters that contract. Your FIRST tool call on any such follow-up is \`skill('revise')\`. Triggers include "now it should also X", "include Y", "change the way Z works", "instead of A do B", "describe what it really is", "the output should…", and any repeated complaint ("still says X" twice or more on the same topic — the recurrence IS the signal).

\`revise\` re-reads the current spec, proposes a concrete amendment, gates on user approval, then derives the implementation surfaces (system prompt + card.js + metadata) from the amended spec. **Default bias: when a follow-up could plausibly be either a contract change or a code patch, invoke \`revise\`.** False positives cost one extra turn (user redirects to \`fix-bug\` or a direct edit); false negatives cost N turns of patching the wrong surface — observed in prior builds where 13 follow-up turns failed to fix a problem whose root cause was a one-line spec gap.

**Skip \`revise\` only for:** bug reports with explicit error messages (use \`fix-bug\` — the contract didn't change, the implementation broke); pure visual tweaks ("make it bigger / blue / centered" — direct CSS edit, no spec touch); pure Q&A ("what does X do?" — answer in chat).

The discipline cascades from \`develop\`: just as \`develop\` step 4a re-reads the decomposition table before card.js writes (the spec's tier assignments are the build contract), \`revise\` re-reads the whole spec before any follow-up edit (the spec is the running contract). Spec drives surfaces; surfaces don't drive the spec.

### Tool prerequisites (gates enforced at the tool boundary)

Two card-class tools have prerequisites that they enforce server-side. If you call them without meeting the prerequisites, they return a structured error with a \`Next:\` line telling you what to do — read it and follow it on your next tool call.

- \`mica_create_class\` requires:
  - A \`canvas/<name>-spec.md\` file exists with non-trivial content (the spec from develop step 2). If absent, the tool returns "No spec found at canvas/<name>-spec.md. Per develop step 2, write the spec first…".
  - For each curated library mentioned in the spec, the matching \`<lib>-skills\` package must be installed (currently: Three.js → \`threejs-skills\`). The tool returns "Spec uses <Library>, but <pack> is not installed…". Invoke \`mica_install_skills source="<pack>"\` to satisfy the gate. Library-specific skills carry Mica patterns (container sizing for WebGL, init order, disposer rules) the base model misses.
  - \`skill('card-class-handbook')\` has been invoked in this chat session. If not, the tool returns "Invoke skill('card-class-handbook') as your next tool call…".
- \`mica_edit_class_file\` requires:
  - \`skill('card-class-handbook')\` has been invoked in this chat session. Bug fixes and refactors don't need a fresh spec, but they DO need the contract the handbook documents.

These gates exist because the develop flow keeps getting compressed in working memory across multi-turn builds — the handbook step in particular tends to be skipped. The rejection makes the gate self-correcting: read the error, take the next move it tells you, retry. You don't have to remember the prerequisites — the tool reminds you.`;
}
