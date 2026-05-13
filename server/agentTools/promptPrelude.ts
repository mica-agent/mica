// Unified prompt prelude — same prose for every agent (qwen, Claude,
// opencode). When a new tool ships in registry.ts, add a paragraph here
// and ALL agents get the guidance simultaneously. Per-agent tweaks live
// in each agent's own buildContext function (e.g. SDK-specific tool-call
// shape hints).

export function buildAgentToolsPrelude(): string {
  return `## Mica tools (available across all agent backends)

These tools come from Mica itself — same names, same input/output shape, same prose regardless of which backend you are (qwen, Claude, or opencode). They reach Mica's REST surface via your SDK's MCP plumbing; you call them by name like any other tool.

### Visual verification

\`render_capture\` — capture a PNG of a card on the canvas and return a vision-model description of what's actually visible. Use after building or editing a card class to verify the rendered output matches the spec — the canvas may render with broken layout / missing markers / wrong colors / runtime errors that source-only review can't catch. Input: \`{ filename: 'canvas/<name>.<ext>' }\`. Output: text. The browser tab must be open to the project's canvas; the model that captions runs locally via llama-server's vision encoder.

### Library-skills discovery

\`mica_list_skill_packages\` — list Mica's curated library-skills packs (the ones \`mica_install_skills\` accepts as shorthands). When discover-dependency surfaces a library, check this list to see if there's a curated skill pack for it. If yes, install via \`mica_install_skills source="<pack>"\` before writing code that uses the library — the pack carries patterns the base model misses (container sizing, init order, disposer rules). One call per build is enough; the list is short and stable.

### Dependency-URL verification — \`mica_inspect_url\`, NOT raw curl

\`mica_inspect_url\` — server-side inspection of a candidate dependency URL. Does the work of \`curl -sI\` + \`curl -s | head\` in one call but returns ~300-500 bytes of structured JSON instead of 1-3KB of raw body that would sit in chat history. Input: \`{ url }\`. Output: \`{ ok, status, contentType, sizeBytes, format, bodyHint, methods? }\` where \`format\` is \`'UMD' | 'ESM' | 'CommonJS' | 'data' | 'unknown'\`. Use this INSTEAD of curl for every library / plugin verification — it keeps the body bytes out of chat history and gives the format detection structurally. UMD = browser-loadable; CommonJS or ESM = WON'T load as a \`<script>\` in a card class (mark unverified for browser use). On 404 the result includes a \`reason\` with the jsdelivr file-listing pivot for the package. The optional \`methods\` array (extracted from the body sample) is the antidote to runtime \`X.method is not a function\` errors — read it when the agent has hallucinated a method name. Raw curl is still right for: jsdelivr file listings on 404 pivot, CORS header checks on asset URLs, and live-service smoke tests.

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
