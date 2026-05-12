---
name: discover-dependency
description: Invoke before designing or writing any component that pulls from external resources — libraries (JS code), assets (images, video, audio, fonts, 3D model files, data files), OR services (live APIs). Most non-trivial cards need MULTIPLE kinds in one build (e.g. Three.js library + planet textures + maybe a weather API). This skill is the single entry point: enumerate subproblems, classify each as library/asset/service, walk through them in order with the matching procedure. Recall-first throughout: for things you know (Three.js, Leaflet, NASA imagery, Google Fonts), write down what you know and verify with `curl`; reach for `web_search` only when recall genuinely fails. Produces a documented decisions table on canvas. Library / asset is the default for any non-trivial subproblem; bespoke implementation is the exception that requires a documented "nothing fits because Z" decision.
---

# Discover external dependencies — libraries, assets, services

Most non-trivial cards pull from three kinds of external resources:

- **Library** — executable JS code, loaded as a script tag (Three.js, Leaflet, Chart.js, D3, Sortable, CodeMirror, Marked, …)
- **Asset** — bytes loaded as a file (planet texture image, sample audio, custom font, 3D model `.gltf`, CSV/JSON data file, …)
- **Service** — a live endpoint hit at runtime (weather API, stock API, NASA Earthdata API, tile server, …)

A single card commonly needs more than one kind. The moon-orbit card is *library + asset* (Three.js + textures). A weather card is *library + asset + service* (Chart.js + icons + OpenWeather). A photo gallery is *asset only*. Don't treat the kinds as a one-of-N choice for the whole card — **each subproblem is one kind, and a card has multiple subproblems.**

The most expensive failure modes in agent-built code are:

1. Silently writing 80 lines of from-scratch geometry / parsing / protocol code when a 1-line library call would suffice.
2. Shipping image URLs that 200 in `curl` but fail in WebGL because the host doesn't send CORS.
3. Wiring up an API endpoint whose response shape you guessed instead of verified.

**Recall, then verify. Search only when recall fails.**

## When this skill fires

Whenever you're about to design or implement a subproblem that pulls from outside the project directory. Specifically:

- **During spec drafting** (card-class builds via `card-class-handbook`): each entry in `## Subproblems and their solutions` goes through this skill.
- **During plan writing** (decomposed builds via `task-decomposer`): each subcomponent with implementation logic goes through this skill; the chosen dependencies land in `interfaces.md § Dependency versions`.
- **During bug fixes** (via `fix-bug`): if your fix would need >30 lines of new bespoke code, or pulls in a new external resource, run this skill first.
- **Recursively, per subproblem.** Picking Leaflet for the map does NOT discharge discovery for sub-features built on top: a day/night terminator overlay is its own library subproblem (`leaflet.terminator`); the tile server is its own asset/service subproblem; the marker icons are their own asset subproblem.

## Tool choice — `web_search` + `curl`, NOT `web_fetch`

**`🌐 web_fetch` is not `curl`.** Despite the name, it downloads the page AND routes it through an LLM with your `prompt:` field for interpretation. On local-model projects (this one), that LLM call is the same throughput-limited Qwen serving the chat agent — a single `web_fetch` against a 100KB npm or GitHub page costs **4+ minutes** of wall clock and queues behind your own turn. `curl` returns bytes in ~200ms with no LLM involvement.

**The rule.** `web_fetch` is for *reading* a long document (interpretive question, answer requires skim-level understanding). `web_search` + `curl` is for *finding* a fact, URL, or version string (the answer is a pattern a person could Ctrl-F for).

Discovery is always the second case. **Never `web_fetch` an npm or GitHub page during this skill** — `curl https://registry.npmjs.org/<pkg>` returns the same info as structured JSON in 200ms.

`web_fetch` IS appropriate (rarely) when reading a long changelog for breaking changes, an RFC for protocol details, or a multi-answer StackOverflow thread for the accepted recommendation. Picking a library version, verifying an image URL, or finding an API endpoint is not.

## Procedure — enumerate, classify, walk

### Step 1 — Enumerate subproblems

In your thinking / scratch space, list every recognizable subproblem this build has. Be specific:

- ❌ Vague: "render the moon orbit"
- ✅ Specific: "3D scene rendering", "orbital animation math", "planet surface texture", "moon surface texture", "starfield background"

Subproblems that involve plain DOM-glue or trivial JS (a counter button, a 9-city static array, simple state) are NOT subproblems for this skill — skip them. Subproblems that compute, format, transform, render, animate, parse, talk to a service, or load bytes ARE subproblems.

### Step 2 — Classify each subproblem

For each one, tag it:

| Tag | What | Examples |
|---|---|---|
| **library** | Need executable JS code | 3D rendering → Three.js. Day/night terminator → leaflet.terminator. Markdown → Marked. |
| **asset** | Need a file (image/audio/video/font/model/data) | Planet textures → JPG/PNG. Hero image → JPG. Avatar → PNG. Background music → MP3. Custom font → WOFF2. |
| **service** | Need a live endpoint | Weather data → OpenWeather API. Stock price → Finnhub API. Map tiles → CartoDB/OSM tile server. |
| **bespoke** | None of the above; write custom code | Solar elevation math (8 lines reusing existing values), small static data array. |

### Step 3 — Walk each tagged subproblem through the matching procedure

#### 3a — LIBRARY subproblems

Recall-first. You're a coding model with a large training corpus. For libraries that appear in public code thousands of times — Three.js, Leaflet, D3, Chart.js, FullCalendar, Sortable.js, CodeMirror, Marked, Mermaid, Plotly, Tone.js, Pixi.js, Day.js, Luxon, Big.js, Fuse.js — **you already know**: canonical package name, known-stable version range, CDN URL shape, whether addons are UMD or ESM-only, the one-line "hello world" call. Don't pretend you don't.

For each library subproblem:

1. **Recall**: library name, known-stable version, CDN URL `https://cdn.jsdelivr.net/npm/<pkg>@<version>/<dist-path>`, addon ESM/UMD status, one-line API call.
2. **Install library-specific skill if curated**: `mica_install_skills source="<library>-skills"`. Mica's curated table maps well-known names (e.g. `threejs-skills`, `three`, `threejs`) to vetted repos. Installs instantly with no gate. Library-specific skills carry knowledge the base model misses — disposer patterns, init-order quirks, version-specific gotchas. Do this BEFORE writing any code that uses the library.
3. **Verify**: `curl -sI -L "<exact URL you'll commit to metadata.json>" | head -1` → expect HTTP/2 200. For libraries with addons, verify each addon URL separately AND check whether the addon ships as UMD (script-loadable) or ESM-only (won't work in card.js classic-script context).
4. **Search only if recall fails**: `web_search "<problem> javascript library"` — for genuinely niche libraries you don't recognize.

**Library structured-data sources** (use these BEFORE `web_fetch` — they're 200ms structured JSON):

```bash
# Latest version + main entry path
curl -s "https://registry.npmjs.org/<pkg>" | head -c 4000

# Every file in the published tarball (for non-default dist paths)
curl -s "https://data.jsdelivr.com/v1/package/npm/<pkg>" | head -c 2000
```

**ESM vs UMD — check for EACH addon, not just the core.** card.js runs as a **classic script**, not a module — it cannot `import`. So every script tag in `metadata.json.dependencies.scripts` must be a **UMD** (or IIFE) bundle that exposes its API as a window global. ESM-only files load, parse, and silently fail: the global never appears, your card throws `<Symbol> is not defined` at first call. Libraries with addons/plugins (Three.js, Leaflet, D3) often ship core as UMD but addons as ESM-only — Tier-1 reachability passes; runtime use throws.

Concrete recurring failure — **Three.js OrbitControls**: The Three.js npm package on cdn.jsdelivr.net **does not ship a UMD OrbitControls at any currently-distributed version** — `examples/jsm/controls/OrbitControls.js` (ESM) is the only published copy. The classic `examples/js/controls/OrbitControls.js` path was never published in the npm tarball, so jsdelivr/unpkg return 404 across the board. **Don't probe a grid of versions hoping to find UMD OrbitControls — you won't.** Three options: (a) build without it (manual camera math, often 10-15 lines), (b) use a community UMD wrapper like `@vladkrutenyuk/three-umd`, (c) inline the ESM source — brittle last resort.

#### 3b — ASSET subproblems

Recall-first, the same way. For well-known asset categories, **you already know** canonical hosts and URL shapes:

| Asset category | Canonical CORS-friendly source | Notes |
|---|---|---|
| Three.js example textures (planets, moon, stars) | `https://raw.githubusercontent.com/mrdoob/three.js/<tag>/examples/textures/<subpath>` | CORS `*`; pin a tag like `r160` for stability. Includes `planets/earth_atmos_2048.jpg`, `planets/earth_normal_2048.jpg`, `planets/earth_specular_2048.jpg`, `planets/earth_clouds_1024.png`, `planets/moon_1024.jpg`. |
| Any GitHub-hosted asset (jsdelivr-served) | `https://cdn.jsdelivr.net/gh/<owner>/<repo>@<ref>/<path>` | CORS `*`, edge-cached, fast. **The `@<ref>` is required** — `cdn.jsdelivr.net/gh/<owner>/<repo>/<branch>/<path>` (no `@`) returns 403. Pin a commit, tag, or branch with `@`. |
| Any GitHub-hosted asset (direct) | `https://raw.githubusercontent.com/<owner>/<repo>/<ref>/<path>` | CORS `*`; slower than jsdelivr (no edge cache) but simpler URL. |
| Any npm-hosted asset | `https://cdn.jsdelivr.net/npm/<pkg>@<version>/<path>` | CORS `*`; works for any file in an npm tarball. |
| Google Fonts | `https://fonts.googleapis.com/css2?family=<name>&display=swap` | CORS-friendly; standard `@import` or `<link rel="stylesheet">`. |
| Unsplash photos (programmatic) | `https://images.unsplash.com/<id>?w=<width>&q=80` | Sends CORS; free tier; no auth for static URLs. |

**Hosts that look reachable but FAIL CORS — do NOT use for WebGL textures or canvas use:**

- ❌ `www.solarsystemscope.com/textures/download/...` — returns 200 with JPEG bytes but sends **no** `Access-Control-Allow-Origin` header. Sphere renders as solid color when used in Three.js. (Empirically verified.) If you want Solar System Scope textures, find a GitHub mirror and serve via jsdelivr.
- ❌ `upload.wikimedia.org/wikipedia/commons/...` — no CORS for direct image URLs. Also uses content-addressed hash directories (`upload.wikimedia.org/wikipedia/commons/<x>/<xy>/<filename>`) you cannot guess from the filename. Probing hash variants always 404s. Don't bother — find a CORS-enabled mirror.
- ❌ Most "free texture site" hosts — assume CORS is off unless proven on.

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
4. **Search only if recall fails**: `web_search "<asset> CORS github mirror"` or `<asset> CDN`.

#### 3c — SERVICE subproblems

For each service (live API endpoint) subproblem:

1. **Recall** known canonical APIs for the domain:
   - Weather: OpenWeather (`api.openweathermap.org`), Open-Meteo (`api.open-meteo.com`, free no-auth), NWS (`api.weather.gov`, free no-auth, US-only).
   - Geo: Nominatim (`nominatim.openstreetmap.org`, free with usage policy), MapBox.
   - Map tiles: OSM (`tile.openstreetmap.org/{z}/{x}/{y}.png`), CartoDB Positron (`{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png`), MapBox.
   - Generic data: data.gov, NASA Earthdata, USGS.
2. **Verify** endpoint shape:
   ```bash
   curl -s "<endpoint-with-sample-params>" | head -c 2000
   ```
   Confirm: it returns JSON in the shape you expect; auth requirement is what you thought (no auth, API key in query, bearer token); rate limit is documented (Open-Meteo: 10k/day free; OpenWeather: 60/min free).
3. **CORS** for client-side use: `curl -sIL "<endpoint>" -H "Origin: http://localhost:5173" | grep -i "access-control-allow-origin"`. Many APIs don't support browser CORS and require a server-side proxy. Mica's `mica.fetch` proxies through the server, bypassing CORS — use it for any third-party API call from card.js.
4. **Search only if recall fails**: `web_search "<domain> free API CORS"`.

#### 3d — BESPOKE subproblems

If the subproblem is genuinely small (8 lines of math, a hardcoded 9-element array, simple state), record it as "no dependency — N lines bespoke" and move on. The "no dependency" decision still goes in the spec so reviewers can audit.

### Step 4 — Record decisions on canvas

The decisions MUST land in a canvas file before any code that depends on them ships. Otherwise the next agent (or your next session) has no record of WHY this version / URL / endpoint was chosen and re-derives from scratch — possibly choosing differently. Three observed sessions on the same task ("3D animation of moon around earth") chose three different Three.js versions because none of them recorded the decision. The curl-verification work was real but ephemeral.

**Where to record** — pick the most appropriate existing file, in this priority order:

1. **`canvas/spec.md` § Subproblems and their solutions** — preferred when a spec.md exists and the build is card-class-shaped. Co-located with the build it informs.
2. **`canvas/decisions.md`** — preferred when the project already has a `decisions.md` file or the decision spans multiple cards.
3. **`canvas/interfaces.md` § Dependency versions** — preferred during decomposed builds via `task-decomposer`; subagents reading the interfaces contract see the pins.
4. **A new `canvas/dependency-decisions.md`** — only if none of the above exist.

**Pick ONE location and stay consistent within a project.**

**The format is identical regardless of location** — a markdown table with one row per subproblem, ordered by kind:

```markdown
## Subproblems and their solutions

| Subproblem | Kind | Decision | Reason |
|---|---|---|---|
| 3D scene rendering | library | Use `three@0.160.0` via `https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.min.js` (curl 200) | Industry standard; UMD bundle exposes `THREE.*` globals; `cloudai-x/threejs-skills` installed. |
| Camera interaction | bespoke | Manual fixed camera (10 lines) | OrbitControls is ESM-only in all distributed Three.js versions; manual camera math suffices for fixed orbit. |
| Earth daymap texture | asset | `https://raw.githubusercontent.com/mrdoob/three.js/r160/examples/textures/planets/earth_atmos_2048.jpg` (curl 200, CORS `*`) | Three.js examples mirror; CORS-enabled for WebGL use. |
| Moon surface texture | asset | `https://raw.githubusercontent.com/mrdoob/three.js/r160/examples/textures/planets/moon_1024.jpg` (curl 200, CORS `*`) | Same source as Earth; consistent pinning. |
| Solar elevation math | bespoke | 8 lines | Reuses subsolar lat/lng we already compute; library overhead unjustified. |
| City list (9 fixed cities) | bespoke | Static array | Just data, not a dependency. |
```

When recording in `decisions.md` instead of spec.md, prefix the section with the build it informs (e.g. `## Dependency decisions — moon-orbit card`).

## Output shape — what counts as "done" with this skill

A row for **every** recognizable subproblem the spec covers, in whichever file you chose. No exceptions for "this one is simple" — record `no dependency — N lines bespoke` so reviewers can audit. If you skip the row, the next session re-runs the discovery from scratch and may pick differently.

## When NOT to use this skill

Don't burn the budget on subproblems that are genuinely tiny:

- 3-input form with a sum at the bottom — not a "library subproblem"
- A counter card with a + button
- A static label, a list of 5 items, a JSON viewer with 10 lines of formatting
- Pure data structures (cities array, color palette, timezone list)

The threshold: **if you'd write more than ~30 lines of bespoke code AND the problem matches a recognizable category**, run this skill. Otherwise, skip.

## When the user explicitly opts out

If the user says *"no external libraries"* or *"keep it pure JS"* — respect that. Record the constraint in spec.md and skip future library/asset/service discovery. But ALWAYS confirm: *"You said no external libraries — that's a hard constraint, right? Some subproblems would need 100+ lines of custom code (e.g. day/night terminator)."* The user might mean "no charting library" but be fine with `leaflet`; ambiguous "no external dependencies" shouldn't be assumed without checking.

## Anti-patterns

- ❌ **Treating subproblems as a single kind.** A moon-orbit card has *library + asset* subproblems. A weather card has *library + service + asset*. Walk through each subproblem by its kind; don't fold textures into the library section or vice versa.
- ❌ **Skipping recall.** Probing 18 Three.js versions when you already know the canonical URL shape is wasted curls. Recall first, verify once.
- ❌ **Verifying reachability without CORS for WebGL/canvas assets.** `curl -sI` returns 200 doesn't mean the asset will work as a WebGL texture. Always add `-H "Origin: ..."` and check `access-control-allow-origin` for assets used in WebGL / canvas / SubresourceIntegrity contexts.
- ❌ **Finding a library/asset/service and not recording the decision.** Reviewers (and the next session) can't tell what was tried and why. Always commit the table row.
- ❌ **Recording "no dependency fits" without showing what was considered.** "Considered Three.js — drop because the canvas only needs 2D, not 3D" is a real reason; just writing "no library" hides the work.
- ❌ **Probing texture URLs by guessing Wikimedia hash paths.** They use content-addressed hashes you can't guess. Either curl the wiki page and grep the URL, or (better) use a CORS-enabled CDN mirror instead.

## Worked example — what good looks like

User asks for a 3D moon-orbit card with realistic textures.

```markdown
## Subproblems and their solutions

| Subproblem | Kind | Decision | Reason |
|---|---|---|---|
| 3D scene rendering | library | `three@0.160.0` via `https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.min.js` (curl 200) | THREE.WebGLRenderer / Scene / SphereGeometry / MeshStandardMaterial all on core UMD. `cloudai-x/threejs-skills` installed. |
| Camera | bespoke | Manual fixed camera (10 lines) | OrbitControls is ESM-only across all distributed Three.js npm tarballs; manual camera suffices for orbit visualization. |
| Earth daymap | asset | `https://raw.githubusercontent.com/mrdoob/three.js/r160/examples/textures/planets/earth_atmos_2048.jpg` (curl 200, CORS `*`) | Three.js examples mirror via raw.githubusercontent — CORS-enabled, stable. |
| Earth normal map | asset | `https://raw.githubusercontent.com/mrdoob/three.js/r160/examples/textures/planets/earth_normal_2048.jpg` (curl 200, CORS `*`) | Same source; gives surface relief. |
| Earth specular | asset | `https://raw.githubusercontent.com/mrdoob/three.js/r160/examples/textures/planets/earth_specular_2048.jpg` (curl 200, CORS `*`) | Same source; ocean highlights. |
| Moon surface | asset | `https://raw.githubusercontent.com/mrdoob/three.js/r160/examples/textures/planets/moon_1024.jpg` (curl 200, CORS `*`) | Same source. |
| Starfield background | bespoke | Inline `THREE.Points` from random sphere | Cheaper than a texture sphere for backdrop. |
| Orbital animation | bespoke | Sine/cosine on `clock.elapsedTime` (5 lines) | Simple uniform circular orbit; no library needed. |
```

Total tool calls expected for this discovery: ~6 curls (one per asset URL + one for Three.js UMD verification). No `web_fetch`. Zero searches. ~30 seconds wall clock.

## Cross-references

- `card-class-handbook/SKILL.md` § Step 0 — invokes this skill from the spec-drafting flow.
- `decompose-task/SKILL.md` and the `task-decomposer` agent — invoke this skill during plan writing; dependency decisions land in `interfaces.md`.
- `fix-bug/SKILL.md` — invoke this skill when a fix would need >30 lines of new bespoke code OR adds a new external resource.
- `card-class-handbook/SKILL.md` § Verify before declaring done — Tier 1 (URL reachability) and Tier 2 (CORS / library global / API shape) verifications happen at this skill's step 3, recorded in spec.md so the smoke test has a ledger to compare against.
