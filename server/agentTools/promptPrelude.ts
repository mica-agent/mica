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

### Web tools — \`mcp__tavily__tavily_search\` + \`curl\`, NOT \`web_fetch\`

You have three outside-the-project lookup tools. Each has one job; mixing them up burns chat-history context (which is finite at 131K tokens — exceeding it ends the build with HTTP 400).

- **\`curl\`** (via \`run_shell_command "curl -sI -L <url>"\` or \`curl -s <url>\`) — verifying a specific URL / endpoint / package. Returns bytes in ~200ms. This is the default for: CDN URL reachability, CORS checks, npm registry JSON (\`curl -s https://registry.npmjs.org/<pkg>\`), jsdelivr file listings (\`curl -s https://data.jsdelivr.com/v1/package/npm/<pkg>\`), API smoke-tests. Append \`| head -c <N>\` to bound the output.

- **\`mcp__tavily__tavily_search\`** — *discovering* something you don't know (a plugin name, a canonical host, a free-tier API). Returns title + snippet + URL per result. **Always cap \`max_results\` at 5** — each result pushes ~600-1500 tokens into chat history and the context budget is real. **Pass \`max_results\` as a number (\`5\`), not a string (\`"5"\`) — the MCP schema enforces this and string values are rejected silently as "tool not available".** The tool's full registered name includes the MCP server prefix; calling the bare name \`tavily_search\` returns "tool not found". After a search surfaces a candidate, **always follow with \`curl\`** to verify the URL / version / shape before committing to it in a spec or code.

- **\`web_fetch\` — DO NOT use for discovery, verification, or anything in dependency discovery.** Despite the name, it's not a plain HTTP fetch: it downloads the page AND routes the bytes through an LLM with your \`prompt:\` field, costing 4+ minutes per call on the local model AND dumping the entire page into your chat history for the rest of the session. \`curl\` returns the same bytes in 200ms with no LLM round-trip and the truncation-friendly \`| head -c <N>\`. The only legitimate \`web_fetch\` use is reading a long-form prose document (RFC, lengthy changelog, multi-answer SO thread) for skim-level understanding — and that's rarely needed during a build.

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
