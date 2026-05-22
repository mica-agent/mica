---
name: discover-dependency
description: Invoke before designing or writing any component that pulls from external resources — libraries (JS code), assets (images, video, audio, fonts, 3D model files, data files), OR services (live APIs). Most non-trivial cards need MULTIPLE kinds in one build (e.g. a rendering library plus textures plus a public API). This skill is the single entry point: enumerate subproblems, classify each as library/asset/service, walk through them in order with the matching procedure. Recall-first throughout: write down what you already know for each subproblem and verify with `curl`; reach for `mcp__tavily__tavily_search` only when recall genuinely fails. Produces a documented decisions table on canvas. Library / asset is the default for any non-trivial subproblem; bespoke implementation is the exception that requires a documented "nothing fits because Z" decision.
---

# Discover external dependencies — libraries, assets, services

Most non-trivial cards pull from three kinds of external resources:

- **Library** — executable JS code, loaded as a script tag.
- **Asset** — bytes loaded as a file (image, audio, video, font, 3D model, data file).
- **Service** — a live endpoint hit at runtime (data API, tile server, etc.).

A single card commonly needs more than one kind: a rendering library plus its textures, a chart library plus a data service, a gallery built from assets alone. Each subproblem is one kind; a card has multiple subproblems. Classify each separately.

Three failure modes to plan against:

1. Writing many lines of from-scratch geometry / parsing / protocol code when a one-line library call would suffice.
2. Shipping image URLs that resolve in `curl` but fail in WebGL because the host doesn't send CORS.
3. Wiring up an API endpoint whose response shape was guessed instead of verified.

**Recall, then verify. Search only when recall fails.**

## When this skill fires

Whenever you're about to design or implement a subproblem that pulls from outside the project directory. Specifically:

- **During spec drafting** (card-class builds via `card-class-handbook`): each entry in `## Subproblems and their solutions` goes through this skill.
- **During plan writing** (decomposed builds via `task-decomposer`): each subcomponent with implementation logic goes through this skill; the chosen dependencies land in `interfaces.md § Dependency versions`.
- **During bug fixes** (via `fix-bug`): if your fix would need >30 lines of new bespoke code, or pulls in a new external resource, run this skill first.
- **Recursively, per subproblem.** Picking one library to cover the main visual does NOT discharge discovery for sub-features built on top. Every named overlay, plugin-shaped behavior, or distinct visual element is its OWN subproblem — most popular UI libraries have a plugin ecosystem, and "library X with plugin Y" almost always beats "library X plus bespoke math reimplementing Y" on both correctness and lines-of-code. Tile servers, marker icons, and other ancillary resources are their own asset/service subproblems too.

## Step 0 — does Mica already provide this capability?

**Before searching the open web, check Mica's own discovery surface.** Many capabilities are already wired in via channel handlers or built-in card classes — picking those is cheaper than authoring a new CDN dependency, AND it avoids per-card churn for things Mica is responsible for (auth, model selection, error handling, lifecycle).

Three tool calls cover the inventory:

1. **`mica_list_handlers()`** — every registered channel handler (e.g. `llm-direct`, `llm-agent`, `process`) with its `whenToUse`, args, and `modelConstraints` (per-model limits and capabilities — vision support, max images per turn, output token cap, gotchas). **This is THE surface for "Mica already has a vision model / chat model / subprocess wrapper / agent loop."**
2. **`mica_list_classes()`** — every card class on disk (built-in + project-scoped). Each entry shows the `handler` it uses (or `(sidecar)` / `(static)`) and `defaultTitle`. Tells you whether a card class already wraps the capability you want.
3. **`curl /api/handlers`** — full manifest detail for any handler you picked: `sendShapes`, `recvShapes`, `examples` (copy-pasteable card.js skeletons covering common usage), `argsSchema` (every config knob). Use AFTER `mica_list_handlers` narrows the choice.

**Common capability → handler mapping (verify each via the tools above; this is recall, not the source of truth):**

| Subproblem | Likely Mica-provided path |
|---|---|
| Classify / describe / extract from an image | `llm-direct` + a vision-capable model |
| Stream LLM completions for chat / summarization / rewriting | `llm-direct` + a text model |
| Tool-using agent inside a card | `llm-agent` (lighter than the project-wide chat card) |
| Wrap a CLI tool | `process` handler — Tier 3, zero server code |
| Voice STT / TTS | already-running sidecars — see the `voice` built-in card class |

If a Mica path fits → spec records *"uses handler X / card class Y; verified via mica_list_handlers"* and you skip web search for that subproblem. If nothing fits → continue to the open-web flow below.

**The failure mode this catches**: agent reaches for a heavyweight in-browser ML bundle when `mica.openChannel('turn', { model: '<vision-model>', history: 'stateless' })` does the same job in one line. Same anti-pattern for chat (use `llm-direct` instead of a self-hosted JS client), subprocess wraps (use the `process` handler — `child_process` from card.js doesn't work), speech (use the voice sidecars instead of bundling a speech library).

## Step 0a — What do you already know? (recall before search)

**Before any `tavily_search` or `web_fetch`, state out loud what you already know about each subproblem.** You are a coding model trained on a vast corpus of public code, READMEs, and API documentation. For common needs — well-known CDN libraries, asset hosts, public APIs — your training prior is the cheapest source: zero tokens, zero wall clock, zero round trips. Tavily costs ~600-1500 tokens per result × N results, permanently in context. Recall is free.

Write a short recall paragraph in your thinking, one per subproblem. The shape of a good recall paragraph:

- **Library**: name the package, the version line you trust, the canonical CDN URL pattern (`cdn.jsdelivr.net/npm/<pkg>@<version>/<dist-path>`), the global it exposes, and whether addons are UMD or ESM-only.
- **Asset**: name a CORS-enabled host that serves the file kind you need (a GitHub-served mirror via jsdelivr, a project's `examples/` directory, a known CDN), and the URL pattern.
- **Asset (hard host)**: if the host uses unguessable paths (content-addressed hashes, signed URLs), name its lookup API instead of guessing the file URL.
- **Service**: name the canonical endpoint, the auth requirement, and whether browser CORS is supported.

**The decision tree**, per subproblem:

1. **Strong prior** (you can state the exact URL or API call) → verify with **one** `mica_inspect_url` / `curl` / API call. If 200 + right shape → commit. Skip web search entirely.
2. **Pattern prior** (you know the host's URL shape but not the exact path) → construct a candidate URL and verify with one call. If 200 → commit. If 404, try the host's listing API (`data.jsdelivr.com/v1/package/npm/<pkg>`, `api.github.com/repos/<o>/<r>/contents/<path>`, MediaWiki API) — that's still one call, not a search.
3. **Category prior only** (you know the kind of resource needed but no host/URL) → fall through to web search, capped per the budget rule below.
4. **No prior** (truly novel) → web search.

**For asset hosts especially: prefer the host's API over generic web search.** Wikimedia, jsdelivr, GitHub, npm, and most CDN/registry hosts have APIs that return canonical URLs in a single structured call. Searching the open web for "find me the URL of file X on host Y" is the wrong shape — the host already exposes that exact query.

The agent failure shape this prevents: many tavily searches against a host whose direct file URLs use unguessable paths (content-addressed hashes, signed paths), when the host already exposes a lookup API that returns the canonical URL in one structured call.

## Search budget per subproblem

**Cap: 3 web searches (`tavily_search` + `web_fetch` combined) per subproblem.** Searches are the most expensive lookup tool: each one burns ~600-1500 tokens of permanent context per result, and the failure mode "keep iterating query phrasing" wastes the budget without converging.

If your 3rd search hasn't yielded a working URL or endpoint, **STOP searching** and escalate in this order:

1. **Reflect on host APIs.** Did your searches return pages on a specific host (a wiki, a code-host, an npm registry)? That host almost certainly has an API that returns canonical URLs directly. One API call beats N searches.
2. **Drop the resource.** If 3 searches haven't surfaced a working URL, the resource may not be CORS-friendly, may not have a direct URL, or may not exist as a free public resource. Pick a fallback (a simpler placeholder, stub data instead of a live API) and document the substitution in the spec.
3. **Ask the user.** "I can't find a working URL for X. Do you have a preferred source?" One round-trip is cheaper than 10 more searches AND surfaces user-side knowledge Mica can't access (an internal mirror, a known CDN, a license-already-paid asset library).

**Anti-pattern: iterating query phrasing past the cap.** Adding quotes, swapping resolution or size keywords, appending `site:<host>`, dropping a word — these are not new searches, they're the same search with cosmetic variation. If recall + verify + 3 searches haven't surfaced the URL, the next 10 won't either. Escalate.

## Tool choice — pick by content shape

Two real costs on each external call: **wall clock** (how long the tool takes) and **context bloat** (how much of the response sits in chat history for the rest of the session). The cheapest tool depends on the response shape.

**Tool naming gotcha.** `mcp__tavily__tavily_search` is the actual registered name — the bare `tavily_search` returns "tool not found." Pass `max_results: 5` as a **number** (not the string `"5"` — the MCP schema rejects string values with a "tool not available" error).

| Content shape | Tool | Why |
|---|---|---|
| Structured JSON (npm registry, jsdelivr listings, GitHub API) | `curl -s ... \| head -c N` | Already structured; small response; grep-friendly. |
| Plain markdown (README.md, CHANGELOG.md, docs/*.md) | `curl -sL ... \| head -c 8000` | Dense; low cruft; scan directly with no LLM round-trip. |
| Single-fact URL verification (format, status, methods) | `mica_inspect_url` | ~500B structured JSON regardless of source size; the body bytes never enter chat history. |
| Finding a thing you don't know (plugin name, free-tier API) | `mcp__tavily__tavily_search` (max_results: 5) | Returns title + snippet + URL per result; cap to 5 for context budget. |
| HTML page with structure (docs sites, blog posts, READMEs, plugins pages, multi-answer SO threads) | `web_fetch` with a SPECIFIC prompt | 30-90 sec for a README or plugins page; few minutes for a long blog post. **Only the extracted answer enters context** — saves 50KB+ of nav/sidebar/footer from permanent history. |

**`web_fetch` is the right tool for documentation pages with structure.** It downloads a page AND routes it through an LLM with your `prompt:` field, returning only the extracted answer — typically ~200 chars regardless of whether the source was 5KB or 200KB. Wallclock scales with page size: a README or plugins page is 30-90 sec; a long blog post or multi-answer thread is a few minutes. Still cheaper than 10 tavily iterations on the same question — both on wallclock and on context cost (each tavily result drops ~600-1500 tokens into history permanently).

That's a net win when:

- The page is a library README or plugins index and you want the install snippet or a curated list of candidates (this is the most common build-time case — see step 3a below).
- The page is HTML with lots of cruft (nav, sidebar, footer, embedded scripts) and your question targets one paragraph.
- The page is long-form prose (RFC, multi-answer SO thread, lengthy changelog) and curl would dump it all into permanent context.

It's a net loss when:

- The response is small JSON (npm/jsdelivr — use curl).
- You need bytes verification of one URL's format/status — use `mica_inspect_url`.

**The rule of thumb**: if you have a library name and want its canonical CDN URL OR a list of plugins, `web_fetch` is almost always the right call. The wall-clock cost (30 sec to a few minutes) reliably beats the context cost of multiple tavily iterations on the same question.

## The one universal rule

**Any URL you write into a spec, a card's `metadata.json`, or `card.html` / `card.js` MUST have been verified with `mica_inspect_url` first.** No exceptions. This includes:

- URLs you recalled from training and feel confident about.
- URLs you derived from a jsdelivr file listing (the listing tells you what files *exist* in the package; only `mica_inspect_url` confirms the exact path renders 200, has the right format, and exposes the methods you'll call).
- URLs you got from a tavily search result.
- URLs you modified (changed version, swapped `/dist/`, added `.min`, removed `.min`). A modified URL is a NEW URL — inspect_url it again before commit.

The rule exists because URL construction is where hallucination compounds silently. The agent recalls `cdn.jsdelivr.net/npm/<pkg>@<ver>/<path>` correctly in shape but guesses the path component, writes it into the spec, and the build phase commits a 404. The cost of one `mica_inspect_url` call (~500 bytes, ~200ms) is trivial against the cost of a wrong URL surfacing as a runtime failure during render-verify.

If `mica_inspect_url` returns `ok: false`, that URL does not ship. Use the `reason` field's pivot suggestion (usually the jsdelivr listing) to find a real path, then `mica_inspect_url` the real one before writing it anywhere.

## Procedure — enumerate, classify, walk

### Step 1 — Enumerate subproblems

In your thinking / scratch space, list every recognizable subproblem this build has. Be specific:

- Vague: "render the visualization"
- Specific: name each distinct visual primitive, animation type, asset, and computation as its own subproblem.

Subproblems that involve plain DOM-glue or trivial JS (a single button, a small static array, simple state) are NOT subproblems for this skill — skip them. Subproblems that compute, format, transform, render, animate, parse, talk to a service, or load bytes ARE subproblems.

### Step 2 — Classify each subproblem

For each one, tag it:

| Tag | What | Examples |
|---|---|---|
| **library** | Need executable JS code | Core visual primitives (rendering engines, chart libraries, map libraries, markdown renderers), AND plugins on top of those for distinct sub-features — overlays, controls, layout modes — that ship as their own package. |
| **asset** | Need a file (image/audio/video/font/model/data) | Textures, hero images, avatars, background music, custom fonts, data files. |
| **service** | Need a live endpoint | Weather, stock, map tile servers, geocoding, currency rates. |
| **bespoke** | None of the above; write custom code | Trivial DOM glue, small static data arrays, one-line wrappers around browser built-ins. **Math or geometry that has an established library on the open ecosystem is NOT bespoke — it's a library subproblem you haven't searched yet.** |

**Before classifying as `library`: check for a browser built-in.** A class of common needs has native browser APIs that are typically a one-liner. Preferring them avoids the entire library hunt and the bundle/version/loading complexity that follows:

| Need | Browser native | Common over-reach |
|---|---|---|
| Time zones / locale-aware formatting | `Intl.DateTimeFormat({ timeZone, ... })`, `toLocaleString(locale, opts)` | moment + moment-timezone, date-fns-tz, luxon |
| Number / currency formatting | `Intl.NumberFormat` | numeral.js |
| Date math (basic) | `Date`, `Date.now()`, `+` arithmetic, `Intl.RelativeTimeFormat` | moment, dayjs (for simple needs) |
| Locale-aware string sort | `Intl.Collator` | lodash sortBy with custom comparator |
| Crypto / hashing | `crypto.subtle.digest`, `crypto.randomUUID()` | js-sha256, crypto-js, uuid |
| Animation frame loop | `requestAnimationFrame` | gsap (for non-tween uses) |
| Local persistence | `localStorage`, `IndexedDB` | external KV stores |
| URL parsing / construction | `new URL(...)` | url libs |
| Element observation | `IntersectionObserver`, `ResizeObserver`, `MutationObserver` | scroll/resize event listeners + libraries |
| Clipboard | `navigator.clipboard.writeText/readText` | clipboard.js |

**The rule**: if a need has a 5-line native solution, tag it `bespoke` ("uses built-in browser API"), not `library`. A 100-300KB external library wrapping a one-liner is a tax in download size, version pinning, bundle-variant selection, and script-loading order — for no functional gain. Card.js runs in a real browser; modern APIs are available.

**Symmetric rule for the opposite mistake — bespoke gate.** Before tagging any subproblem as `bespoke` *for any reason other than "5-line browser-native solution exists"*, you MUST have completed a recall + at-least-one-search pass for a library that solves it. The shape to watch for is the thought "*this could be a library, or I could compute it myself*" — that's the exact moment to STOP and search, not the moment to default to "compute it myself." Reasons this is the dominant failure mode:

- The agent's training corpus contains many examples of "here is the math formula for X," which makes a from-scratch implementation feel reachable.
- A specialized library that solves X often has a smaller training footprint than the math formula, so the formula path feels MORE familiar than the library does — recall is biased toward bespoke even when a library would be far cleaner.
- "I can do it in N lines" is a recall claim, not a verified one. Until you've actually typed the N lines AND debugged them, the real cost is unknown. The library you haven't searched for might be 1 line.

**Gate**: if your draft classification table has any `bespoke` row whose subproblem is NOT in the browser-native table above (Intl, crypto.subtle, requestAnimationFrame, etc.), go run `mcp__tavily__tavily_search "<feature> <ecosystem-or-host-library> plugin"` or equivalent recall+verify for the library candidate BEFORE finalizing the classification. The spec/decisions table can land on `bespoke` legitimately — but only after a search rejected the library option, and the rejection reason is recorded.

### Step 3 — Walk each tagged subproblem through the matching procedure

**Enumerate candidates first.** For each subproblem (especially library / plugin / service ones), write down 3–5 candidate options — mix kinds where relevant (a library plus a bespoke fallback). Recall-first; `mcp__tavily__tavily_search` (max_results: 5) only when recall genuinely fails for a category. Don't pre-filter to your favorite — list alternatives even if you wouldn't pick them. The candidate space becomes visible to the user when you record it on canvas (Step 4), so they can redirect *before* you commit to one.

**Pick on positive fit, not elimination.** Once 2–3 candidates pass the tech-bar (UMD-loadable, CORS-clean — Step 3a-3c verification), choose using **positive signals**, not "the one I have more training data on":

- **Native feature match** (highest weight). Search prior art: `<library> <feature>`. If candidate A has a plugin or built-in that solves your specific sub-feature in one line and candidate B requires writing it from scratch, A wins regardless of which library you recall better.
- **Prior art density**. Search `"<exact use case>" site:github.com stars:>20`, or `<use case> <library> example codepen`. Lots of working examples = well-trodden path = less debug time. A smaller-star library where many repos solve your exact use case beats a bigger-star library where no one has done it.
- **User-facing quality**. For visible UI (maps, charts, image viewers, 3D scenes): prefer libraries that ship pre-built visual primitives over libraries that hand you a blank canvas and require you to assemble the look yourself, even when the latter is technically capable. The output should feel like the modern web, not a textbook diagram.
- **Plugin ecosystem breadth**. Quick `<library> plugins` or `<library> awesome list` search. Many plugins = many of your future needs (interactivity, animation, time controls, data overlays) are already someone's solved problem.

**Discard ONLY for hard blockers**, not for unfamiliarity: not UMD-compatible (won't load via `<script>`), confirmed hard CORS issue, genuinely abandoned (no commits in 5+ years, no recent published versions). *"I have less training data on this one"* is **not** a hard blocker — that's exactly what Mica's curated `<library>-skills` packs exist for. Use `mica_list_skill_packages` and `mica_install_skills` to load the missing context BEFORE rejecting a candidate.

**Sequence the work**: positive-fit search FIRST (cheap; one or two tavily/curl calls), then tech-verify the leading candidate (`mica_inspect_url`). Don't run `mica_inspect_url` on every candidate's URLs before you've decided which one fits — that's the elimination-first failure mode that wastes tool calls verifying candidates you'll discard for non-tech reasons anyway.

#### 3a — LIBRARY subproblems

Recall-first. You're a coding model with a large training corpus. For any library that appears in public code thousands of times, **you already know**: canonical package name, known-stable version range, CDN URL shape, whether addons are UMD or ESM-only, the one-line "hello world" call. Surface that recall before reaching for search.

**Two canonical first moves when recall alone doesn't give you the URL.** These compress what's otherwise 10+ tavily iterations into 1-2 web_fetch calls. Reach for them before tavily.

**Move 1 — you have a library name but not the canonical CDN URL.** The README is the source of truth: the maintainer documents the recommended `<script>` tag URL there. One call:

```
web_fetch({
  url: "https://cdn.jsdelivr.net/npm/<pkg>@<version>/README.md",
  // or the GitHub repo URL if the README is mostly elsewhere
  prompt: "What's the recommended CDN URL for using this library via a <script> tag? Include the exact URL, version, and any required CSS."
})
```

Returns the install snippet directly. Pair with one `mica_inspect_url` on the returned URL to verify, then commit it to the spec. Two calls total, not ten search iterations.

**Move 2 — you need a plugin or addon for a known library.** Most popular UI libraries maintain a canonical ecosystem page that lists vetted community plugins, categorized by feature. Examples of where to look:

- The library's official docs site, under "Plugins" / "Ecosystem" / "Addons" (`<library>.org/plugins.html` or similar).
- The library's GitHub wiki (`github.com/<owner>/<repo>/wiki/Plugins`).
- An "awesome-<library>" curated list on GitHub.

One call:

```
web_fetch({
  url: "<plugins index URL>",
  prompt: "List plugins related to <sub-feature>, with their GitHub URLs and short descriptions."
})
```

The maintainer has already filtered out dead/broken/obscure options — you get a curated shortlist. Pick one, `mica_inspect_url` the chosen plugin's CDN URL to verify, commit.

**Why these two moves first.** They mirror how a human developer actually finds libraries — piggy-backing on someone else's curation (the README install snippet, the plugins index) rather than reconstructing the universe via raw web search. Raw tavily search of URL variants is the slow path. README and plugins-page are the fast paths.

Tavily is still the right primitive for genuinely novel discovery — *what category of solution exists for an unfamiliar problem*. Once you have a library NAME, switch to web_fetch on the README; once you have a parent library and want one of its plugins, switch to web_fetch on its plugins page.

For each library subproblem:

1. **Recall**: library name, known-stable version, CDN URL `https://cdn.jsdelivr.net/npm/<pkg>@<version>/<dist-path>`, addon ESM/UMD status, one-line API call.
2. **Install library-specific skill if curated**: `mica_install_skills source="<library>-skills"`. Mica's curated table maps well-known library names to vetted repos. Installs instantly with no gate. Library-specific skills carry knowledge the base model misses — disposer patterns, init-order quirks, version-specific gotchas. Do this BEFORE writing any code that uses the library.
3. **Verify** with `mica_inspect_url <CDN URL>`. The tool returns `{ ok, status, contentType, format, methods }` in ~500 bytes — saves chat-history context over raw `curl -s | head`. Read the `format` field:
   - `"UMD"` — browser-loadable as `<script>`. Mark verified.
   - `"ESM"` or `"CommonJS"` — won't load as a classic script in card.js. Mark unverified for browser use; pick a different version or library.
   - `"data"` — JSON/CSS/text. Fine for asset rows.
   - `ok: false` (non-200) — `reason` includes a pivot suggestion. **404 pivot rule**: your next call is `curl -s https://data.jsdelivr.com/v1/package/npm/<pkg>` for the package's file listing — find the real path. Do NOT guess more URL variants.

   For libraries that produce visible UI (maps, charts, image viewers), ALSO fetch the README to find ancillary CSS / font / data dependencies: `curl -s https://cdn.jsdelivr.net/npm/<pkg>@<version>/README.md | head -c 8000` and scan the first quickstart HTML example for `<link rel="stylesheet">` tags. Add each ancillary URL as a separate verified row (run `mica_inspect_url` on it too). Missing an ancillary CSS file is a silent-failure mode — the library loads, the API is defined, but the visible output renders blank because layout styles never load.

   Raw `curl -sI -L | head -1` is fine when you just want a status code; `mica_inspect_url` is the default for any dependency you're about to commit to `metadata.json`.
4. **Search only if recall fails**: `mcp__tavily__tavily_search "<problem> javascript library"` (max_results: 5) — for genuinely niche libraries you don't recognize.

**Library structured-data sources** (curl wins here — 200ms structured JSON, no LLM round-trip):

```bash
# Latest version + main entry path
curl -s "https://registry.npmjs.org/<pkg>" | head -c 4000

# Every file in the published tarball (for non-default dist paths)
curl -s "https://data.jsdelivr.com/v1/package/npm/<pkg>" | head -c 2000
```

**ESM vs UMD — check for EACH addon, not just the core.** card.js runs as a **classic script**, not a module — it cannot `import`. So every script tag in `metadata.json.dependencies.scripts` must be a **UMD** (or IIFE) bundle that exposes its API as a window global. ESM-only files load, parse, and silently fail: the global never appears, your card throws `<Symbol> is not defined` at first call. Libraries with addons/plugins often ship core as UMD but addons as ESM-only — Tier-1 reachability passes; runtime use throws.

**ESM-only candidate? Try four fallbacks before going bespoke.** The first failed CDN path on an addon/plugin is not the end of discovery — many plugins publish ESM as the "modern" entry but ship a UMD bundle the package's `package.json` doesn't advertise. In order:

1. **README**: `curl -sL https://raw.githubusercontent.com/<owner>/<repo>/<branch>/README.md | head -c 8000`. Search for `<script` tags in the quickstart example — that's the canonical script-tag path the author documents. UMD/IIFE distributions are almost always mentioned here when they exist.
2. **Full file listing on jsdelivr**: `curl -s https://data.jsdelivr.com/v1/package/npm/<pkg>` and look for `.umd.js`, `.iife.js`, or `dist/<name>.js` paths that the npm package's main entry doesn't point at.
3. **Community wrappers / alternative plugins**: `mcp__tavily__tavily_search "<plugin-name> script tag CDN"` or `"<feature> <ecosystem> plugin"`. One ESM-only repo doesn't mean the feature is unavailable in the ecosystem — there is usually more than one plugin per feature, and at least one of them ships a UMD bundle.
4. **Bespoke as last resort, with documented rationale**. Going bespoke before steps 1–3 silently commits the user to N lines of custom code they didn't ask for. If you go bespoke anyway, the spec MUST list which alternatives were tried and why each was rejected — so the user can override with a known-working alternative they recognize.

Use `curl` for README / file-listing scans — READMEs are dense markdown that scans directly in ~200ms with no LLM round-trip. (`web_fetch` is the right tool for HTML-heavy docs sites with structural cruft, not for plain markdown READMEs — see § Tool choice.)

**Grid-probing addon versions is wasted effort.** If a library's addon doesn't ship as UMD at one version, it almost certainly doesn't at any version — packages don't reintroduce dropped distribution formats across minor releases. After one 404 on the addon at a known-good version, switch tracks: read the README for the documented script-tag path, scan the jsdelivr file listing for `.umd.js` / `.iife.js`, search for a community UMD wrapper, or fall back to manual inline code with a documented rationale.

#### 3b — ASSET subproblems

Recall-first, the same way. The canonical CORS-friendly host shapes:

| Asset category | URL shape | Notes |
|---|---|---|
| Any GitHub-hosted asset (jsdelivr-served) | `https://cdn.jsdelivr.net/gh/<owner>/<repo>@<ref>/<path>` | CORS `*`, edge-cached, fast. **The `@<ref>` is required** — the no-`@` form returns 403. Pin a commit, tag, or branch with `@`. |
| Any GitHub-hosted asset (direct) | `https://raw.githubusercontent.com/<owner>/<repo>/<ref>/<path>` | CORS `*`; slower than jsdelivr (no edge cache) but simpler URL. |
| Any npm-hosted asset | `https://cdn.jsdelivr.net/npm/<pkg>@<version>/<path>` | CORS `*`; works for any file in an npm tarball. |
| Library's own examples directory | look for `examples/` on the library's GitHub repo; serve via jsdelivr-gh or raw.githubusercontent | Pin to a release tag for stability. |
| Public CDN-hosted font service | check the service's documented CSS URL pattern | Usually CORS-friendly and works with standard `@import` or `<link rel="stylesheet">`. |

**Many hosts that serve image bytes do NOT send CORS headers, so the asset 200s in `curl` but fails as a WebGL texture / canvas drawImage source.** The failure shape: the sphere or surface renders as solid color, no console error. Mitigation: for any asset used in WebGL / canvas / SubresourceIntegrity, verify CORS in Step 3b's curl pair below. If a needed asset's source doesn't send CORS, find a GitHub mirror and serve it through jsdelivr.

For each asset subproblem:

1. **Recall** canonical CORS-friendly host + URL shape from the table above (or beyond, if you know more).
2. **Identify** the use case — `<img>` tag display (no CORS needed), WebGL texture / canvas `drawImage` (CORS REQUIRED), CSS background (CORS sometimes needed for `mask-image` or `font-display`).
3. **Verify** — TWO curl calls, not one:
   ```bash
   # (a) Reachability
   curl -sI -L "<url>" | head -1
   # → expect HTTP/2 200

   # (b) CORS (only if used in WebGL / canvas / SubresourceIntegrity)
   curl -sIL "<url>" -H "Origin: http://localhost:5173" 2>&1 | grep -i "access-control-allow-origin"
   # → empty output = NO CORS = will fail in WebGL
   # → `*` or echoed origin = CORS allowed = works
   ```
4. **Search only if recall fails**: `mcp__tavily__tavily_search "<asset> CORS github mirror"` (max_results: 5), or `"<asset> CDN"`.

#### 3c — SERVICE subproblems

For each service (live API endpoint) subproblem:

1. **Recall** canonical APIs for the domain — for common categories (weather, geo, map tiles, generic open data), state the host you trust, the URL pattern, and what auth it needs.
2. **Verify** endpoint shape:
   ```bash
   curl -s "<endpoint-with-sample-params>" | head -c 2000
   ```
   Confirm: it returns JSON in the shape you expect; auth requirement is what you thought (no auth, API key in query, bearer token); rate limit is documented.
3. **CORS** for client-side use: `curl -sIL "<endpoint>" -H "Origin: http://localhost:5173" | grep -i "access-control-allow-origin"`. Many APIs don't support browser CORS and require a server-side proxy. Mica's `mica.fetch` proxies through the server, bypassing CORS — use it for any third-party API call from card.js.
4. **Search only if recall fails**: `mcp__tavily__tavily_search "<domain> free API CORS"` (max_results: 5).

#### 3d — BESPOKE subproblems

If the subproblem is genuinely small (minimal math, a small static array, simple state), record it as "no dependency — N lines bespoke" and move on. The "no dependency" decision still goes in the spec so reviewers can audit.

### Step 4 — Record decisions on canvas

The decisions MUST land in a canvas file before any code that depends on them ships. Otherwise the next agent (or your next session) has no record of WHY this version / URL / endpoint was chosen and re-derives from scratch — possibly choosing differently. Without a recorded decision, the curl-verification work is real but ephemeral, and the next session may pick a different version of the same library for the same task.

**Where to record** — pick the most appropriate existing file, in this priority order:

1. **`canvas/spec.md` § Subproblems and their solutions** — preferred when a spec.md exists and the build is card-class-shaped. Co-located with the build it informs.
2. **`canvas/decisions.md`** — preferred when the project already has a `decisions.md` file or the decision spans multiple cards.
3. **`canvas/interfaces.md` § Dependency versions** — preferred during decomposed builds via `task-decomposer`; subagents reading the interfaces contract see the pins.
4. **A new `canvas/dependency-decisions.md`** — only if none of the above exist.

**Pick ONE location and stay consistent within a project.**

**Optional but recommended for non-trivial builds (3+ subproblems): also write `canvas/<class>-research.md`** — a canvas-visible artifact enumerating ALL candidates considered (not just the chosen picks), with verified URLs. This is for the *user* to read on canvas BEFORE approving the build, so they can redirect to a different candidate before any code is written. The artifact is not validated by Mica — its format is a suggestion, not a contract — but the canvas-visibility makes the candidate space available for user review. Suggested shape:

```markdown
# Research: <class name>

## Subproblems
1. <subproblem>
2. <subproblem>

## Candidates per subproblem

### 1. <subproblem>
| Option | Type | URL | Verified | Notes |
|---|---|---|---|---|
| <library-A>@<version> | library | https://cdn.jsdelivr.net/npm/<pkg>@<version>/<path> | 200, UMD | full-featured option |
| <library-A> CSS | asset | https://cdn.jsdelivr.net/npm/<pkg>@<version>/<css-path> | 200, data | required for layout |
| <library-B> | library | https://cdn.jsdelivr.net/npm/<pkg>@<version>/<path> | 200, UMD | alternative; different trade-offs |
| Bespoke | — | — | ~N lines | hand-roll; only after the candidates above are rejected |

## Suggested stacks
| Stack | Picks |
|---|---|
| <library-A> | (1) core + CSS, (2) plugin for sub-feature X, (3) plugin for sub-feature Y |
| <library-B> | (1) core, (2) alternate plugin for X, (3) alternate plugin for Y |
```

The spec (location 1 above) THEN copies URLs verbatim from research's URL column — never introduce an unverified URL in the spec. Build phase consumes the spec; research is for user review.

**The format is identical regardless of location** — a markdown table with one row per subproblem, ordered by kind:

```markdown
## Subproblems and their solutions

| Subproblem | Kind | Decision | Reason |
|---|---|---|---|
| <core visual primitive> | library | Use `<pkg>@<version>` via `<verified CDN URL>` (curl 200) | <why this candidate won; what plugins/skills are loaded> |
| <sub-feature on top of core> | library | Use `<plugin>@<version>` via `<verified CDN URL>` (curl 200) | <one-line justification; alternatives rejected> |
| <one-shot interaction> | bespoke | <N> lines | <why no library — alternatives considered and rejected> |
| <asset> | asset | `<verified CORS-enabled URL>` (curl 200, CORS `*`) | <host choice rationale> |
| <static config> | bespoke | Static array | Just data, not a dependency. |
```

When recording in `decisions.md` instead of spec.md, prefix the section with the build it informs (e.g. `## Dependency decisions — <class name>`).

## Output shape — what counts as "done" with this skill

A row for **every** recognizable subproblem the spec covers, in whichever file you chose. No exceptions for "this one is simple" — record `no dependency — N lines bespoke` so reviewers can audit. If you skip the row, the next session re-runs the discovery from scratch and may pick differently.

## When NOT to use this skill

Skip when the build is genuinely tiny:

- A small form with arithmetic at the bottom — not a "library subproblem"
- A counter card with a + button
- A static label, a short list of items, a small data viewer with a few lines of formatting
- Pure data structures (a small static array, a color palette, a fixed config list)

The threshold: **if you'd write more than ~30 lines of bespoke code AND the problem matches a recognizable category**, run this skill. Otherwise, skip.

## When the user explicitly opts out

If the user says *"no external libraries"* or *"keep it pure JS"* — respect that. Record the constraint in spec.md and skip future library/asset/service discovery. But ALWAYS confirm: *"You said no external libraries — that's a hard constraint, right? Some subproblems would need 100+ lines of custom code."* The user might mean "no charting library" but be fine with a map library; ambiguous "no external dependencies" shouldn't be assumed without checking.

## Common drift modes

- **Treating subproblems as a single kind.** A non-trivial card typically has multiple subproblems of mixed kinds (library + asset, library + service + asset, etc.). Walk through each subproblem by its own kind; classify the textures separately from the renderer, the API separately from the chart library.
- **Skipping recall.** Probing many versions of a library you already know is wasted curls. Recall first, verify once.
- **Verifying reachability without CORS for WebGL/canvas assets.** `curl -sI` returns 200 doesn't mean the asset works as a WebGL texture. Add `-H "Origin: ..."` and check `access-control-allow-origin` for assets used in WebGL / canvas / SubresourceIntegrity contexts.
- **Finding a library/asset/service and not recording the decision.** Reviewers (and the next session) can't tell what was tried and why. Commit the table row.
- **Recording "no dependency fits" without showing what was considered.** A real reason names alternatives and explains why each was rejected. Just writing "no library" hides the work.
- **Guessing content-addressed hash paths.** Hosts that use unguessable directory hashes always 404 on guessed variants. Use the host's lookup API or switch to a CORS-enabled mirror.

## Worked example — what good looks like

Imagine a 3D card showing one celestial body orbiting another, with realistic textures.

```markdown
## Subproblems and their solutions

| Subproblem | Kind | Decision | Reason |
|---|---|---|---|
| 3D scene rendering | library | `<3d-lib>@<version>` via verified CDN URL | Industry-standard renderer; UMD bundle exposes a global; library-specific skill installed. |
| Camera | bespoke | Manual fixed camera (a few lines) | Common camera-control addons in this ecosystem are ESM-only across all distributed npm tarballs; manual camera suffices for a fixed orbit visualization. |
| Body surface textures | asset | Verified GitHub-served URLs with CORS `*` | Library's own examples directory mirror; CORS-enabled for WebGL use. |
| Starfield background | bespoke | Inline points geometry from a random sphere | Cheaper than a texture sphere for backdrop. |
| Orbital animation | bespoke | Trigonometric position on elapsed time | Simple uniform circular orbit; no library needed. |
```

Total tool calls expected for this discovery: one curl per asset URL plus one for the 3D library UMD verification. No `web_fetch`. Zero searches. ~30 seconds wall clock.

## Cross-references

- `card-class-handbook/SKILL.md` § Step 0 — invokes this skill from the spec-drafting flow.
- `decompose-task/SKILL.md` and the `task-decomposer` agent — invoke this skill during plan writing; dependency decisions land in `interfaces.md`.
- `fix-bug/SKILL.md` — invoke this skill when a fix would need >30 lines of new bespoke code OR adds a new external resource.
- `card-class-handbook/SKILL.md` § Verify before declaring done — Tier 1 (URL reachability) and Tier 2 (CORS / library global / API shape) verifications happen at this skill's step 3, recorded in spec.md so the smoke test has a ledger to compare against.
