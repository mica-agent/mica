---
name: discover-library
description: Invoke before designing or writing any component that does work beyond DOM-glue (anything that computes, formats, transforms, animates, draws, parses, talks to a service, or performs domain math — dates, time zones, sun/moon position, geo distance, color, audio, charts, drag-drop, calendaring, syntax highlighting, file diffing, etc.). Mica should not be reluctant to take on a dependency — if a library exists and is verifiable, use it. The skill takes <30 seconds (search → curl-verify) and produces a documented decision on canvas either way ("use X@version because Y" OR "no library fits because Z"). Library is the default; bespoke is the exception that requires a documented "no library fits" decision.
---

# Discover an existing library before designing custom

Recognizable subproblems usually have established libraries. The most expensive failure mode in agent-built code is silently writing 80 lines of from-scratch geometry / parsing / protocol code when a 1-line library call would suffice. **Search before you design.**

## When this skill fires

Whenever you're about to design or implement a subproblem that fits a recognizable category. Specifically:

- **During spec drafting** (card-class builds via `create-card-class`): each entry in `## Subproblems and their solutions` gets a search.
- **During plan writing** (decomposed builds via `task-decomposer`): each subcomponent that includes implementation logic gets a search; the chosen library lands in `interfaces.md § Library versions`.
- **During bug fixes** (via `fix-bug`): if your fix would need >30 lines of new bespoke code, search first — maybe a library replaces both the bug and the surrounding code.
- **Recursively, per subproblem.** Picking Leaflet for the map does NOT discharge the search for sub-features built on top of it: a day/night terminator overlay is its own search target (`leaflet day night terminator plugin` → `Leaflet.Terminator`); a heatmap layer is its own (`leaflet.heat`); marker-clustering its own (`leaflet.markercluster`). After choosing a primary library, list the sub-features the user asked for and run a separate search per sub-feature.

## Procedure — 4 steps, ONE `web_search` + ONE `web_fetch` per subproblem

### 1. Search

```
web_search "<problem> javascript library"
```

Examples that work:
- `leaflet day night terminator plugin`
- `javascript chart library timeline scrubber`
- `javascript code editor lightweight CDN`
- `javascript drag and drop sortable cdn`

One query per subproblem. The top maintained candidate is usually the right answer.

### 2. Evaluate

`web_fetch` the top candidate's README or npm page. Confirm:

- It solves THIS specific subproblem (not adjacent — read the API summary).
- It's actively maintained (last commit/release within ~12 months).
- It ships a UMD-formatted bundle on cdn.jsdelivr.net (every npm package has a jsDelivr URL by default; the pattern is `https://cdn.jsdelivr.net/npm/<pkg>@<version>/<dist-path>`). UMD exposes the library as a window global, callable directly from card.js without imports. Look up the canonical `<dist-path>` in the package's README.
- The API surface is what you'd want to call (`L.terminator()` is one line; some libraries demand a 50-line builder pattern).

If the top candidate fails any of these, look at the second candidate. Stop after two — three or more candidates means the search query was too vague or the subproblem is genuinely bespoke.

### 3. Verify CDN URL

```bash
curl -sI -L "<the exact URL you'll write into metadata.json>" | head -1
# Expect: HTTP/2 200 (302 chains fine if final is 200)
```

The URL has to be the EXACT string you'll commit to `metadata.json.dependencies.scripts`. Both unpkg and jsdelivr return 404 for hallucinated paths — wrong version, wrong file, wrong scope. Common slip-ups:

- **Missing `@scope/` prefix** for scoped packages (`unpkg.com/leaflet-terminator/...` is WRONG; the real package is `@joergdietrich/leaflet.terminator`).
- **Version that never published** (`@1.0.0` when the latest is `0.1.0` — your prior is biased toward round numbers).
- **Wrong subpath inside the package** (`/L.Terminator.js` vs `/index.js` vs `/dist/leaflet-terminator.js` — README filenames don't always match the npm-published layout).

If a HEAD check 404s, fall back to the package's npm registry listing (`https://registry.npmjs.org/<pkg>`) for the actual `main` field, OR `https://www.jsdelivr.com/package/npm/<pkg>` which lists every file in the published tarball.

### 4. Record the decision somewhere durable on canvas

The decision MUST land in a canvas file before any code that depends on it ships. Otherwise the next agent (or the next session of you) has no record of WHY this version was chosen and re-derives from scratch — possibly picking a different library or version. Three observed sessions on the same task ("3D animation of moon around earth") chose three different Three.js versions because none of them recorded the decision. The agent's curl-verification work was real but ephemeral.

**Where to record** — pick the most appropriate existing file, in this priority order:

1. **`canvas/spec.md` § Subproblems and their solutions** — preferred when a spec.md exists and the build is card-class-shaped. The decision is co-located with the build it informs.
2. **`canvas/decisions.md`** — preferred when the project already has a `decisions.md` file (decision log convention) or when the decision spans multiple cards / multiple specs.
3. **`canvas/interfaces.md` § Library versions** — preferred during decomposed builds via `task-decomposer`; subagents reading the interfaces contract see the version pin.
4. **A new `canvas/library-decisions.md`** — only if none of the above exist. Don't proliferate decision-log files when one of (1)–(3) already covers the project.

**Pick ONE location and stay consistent within a project.** If `decisions.md` already has library decisions, add to it; don't fork a new file just because spec.md is closer to the current edit.

**The format is identical regardless of location** — a markdown table with one row per subproblem:

```markdown
## Subproblems and their solutions

| Subproblem | Decision | Reason |
|---|---|---|
| World map rendering | Use `leaflet@1.9.4` (Tier-1 verified) | Industry standard; one line `L.map(id)` to mount. |
| Day/night terminator overlay | Use `leaflet.terminator@1.3.0` (Tier-1 verified) | Drop-in `L.terminator()` call; handles antimeridian crossing. |
| Solar elevation math | No library fits — bespoke 8 lines | Reuses values the card already computes; pulling a 40KB lib to save 8 lines is a loss. |
| City list (9 fixed cities) | No library — static data | Hardcoded array, not a "library subproblem." |
```

When recording in `decisions.md` instead of spec.md, prefix the section with the build it informs (e.g. `## Library decisions — earthquake-map card`) so multi-card projects keep their decisions sortable.

## Output shape — what counts as "done" with this skill

A row for **every** recognizable subproblem the spec covers, in whichever file you chose above. No exceptions for "this one is simple" — record "no library — N lines bespoke" so reviewers can audit the choice.

If you skip the row, the next session re-runs the search from scratch and may pick a different version. The whole point is to make the decision durable across sessions, not just visible in the current chat.

## When NOT to use this skill

Don't burn the budget on subproblems that are genuinely tiny:

- 3-input form with a sum at the bottom — not a "library subproblem"
- A counter card with a + button
- A static label, a list of 5 items, a JSON viewer with 10 lines of formatting
- Pure data structures (cities array, color palette, timezone list) — these aren't libraries

The threshold: **if you'd write more than ~30 lines of bespoke code AND the problem matches a recognizable category**, search. Otherwise, skip.

## When the user explicitly opts out

If the user says *"no external libraries"* or *"keep it pure JS"* — respect that. Record the constraint in spec.md and skip future searches. But ALWAYS confirm: *"You said no external libraries — that's a hard constraint, right? Some subproblems would need 100+ lines of custom code (e.g. day/night terminator)."* The user might mean "no charting library" but be fine with `leaflet`; ambiguous "no external dependencies" shouldn't be assumed without checking.

## Anti-patterns

- ❌ **Searching once for the top-level domain.** "javascript world clock library" finds nothing useful; you conclude "no library fits" and roll custom. **WRONG** — the top-level might be bespoke, but each *subproblem* (map, terminator, timezone display) has its own library.
- ❌ **Finding a library and not verifying the URL.** Top result on a search is a real library, but the version you guess + the file path you guess might 404. **Always run `curl -sI` on the exact URL.**
- ❌ **Recording "no library fits" without showing what was searched.** Reviewers can't tell whether you searched and picked or never searched. The row should name the search query AND the library you considered AND why it didn't fit.
- ❌ **Ignoring user pushback after a "no library" decision.** If the user says "use a library to simplify this," go back to step 1 and search again. The `## Subproblems` table is editable — re-search and update.

## Worked example — what good looks like

User asks for a world clock card with a day/night overlay. Subproblems and library decisions:

```markdown
## Subproblems and their solutions

| Subproblem | Decision | Reason |
|---|---|---|
| 2D world map | `leaflet@1.9.4` via `https://unpkg.com/leaflet@1.9.4/dist/leaflet.js` (curl 200; CSS at `.../leaflet.css`) | The default; `L.map(id)` mounts in one line. Considered SVG-embedded; rejected (need pan/zoom). |
| Map tiles | CartoDB Positron via `https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png` (sample tile curl 200; no auth) | Free tier; clean light theme. Considered OSM directly; CartoDB renders cleaner. |
| Day/night terminator | `@joergdietrich/leaflet.terminator@1.3.0` via `https://unpkg.com/@joergdietrich/leaflet.terminator@1.3.0/L.Terminator.js` (curl 200; exposes `L.terminator`) | Drop-in `L.terminator().addTo(map)`. Handles antimeridian crossing internally. Considered: rolling custom solar math + `L.polygon`; rejected (~80 lines + drift risk). |
| Live timezone display | `Intl.DateTimeFormat` (browser built-in) | No library needed; `new Intl.DateTimeFormat('en-US', {timeZone: 'Asia/Tokyo'})` returns formatted local time. |
| Solar elevation (per-city day/night flag) | No library — bespoke 8 lines | Reuses subsolar lat/lng we computed for the terminator. Library overhead unjustified for 8 lines. |
| City list (9 preset cities) | No library — static array | Just data. |
```

This is what spec.md should look like before any code is written. The reviewer scanning this can immediately catch a wrong call ("wait, why are we hand-rolling solar math when leaflet.terminator already does it?").

## After choosing — install library skills if available

For each non-trivial library you've selected, check if a Mica-shaped skills package exists and install it. Library-specific skills carry the procedural knowledge the model's training-data priors miss — disposal patterns, init-order quirks, version-specific gotchas — and prevent recurring failures (e.g. Three.js cards that leak GPU memory because textures aren't disposed on remount).

Try in order, cheap-to-expensive:

1. **Curated shorthand** — `mica_install_skills source="<library>-skills"` (e.g. `threejs-skills`). Mica's curated table maps the well-known names to vetted repos; installs instantly with no gate. Currently mapped: `three`, `threejs`, `threejs-skills` → `cloudai-x/threejs-skills`. Other names won't be in the table yet — that's fine, fall through.
2. **GitHub convention** — `mica_install_skills source="github:<owner>/<library>-skills"` if you can guess a likely owner (e.g. `github:mrdoob/three-skills`). Convention-based; instant install if the repo exists.
3. **Web search** — `web_search "<library> skills SKILL.md"` or `<library> mica skills` to find community packages. Pick the top maintained candidate; `web_fetch` its README to verify it follows the SKILL.md convention (each skill is a directory with `SKILL.md` + YAML `name:` / `description:` frontmatter).
   - First call: `mica_install_skills source="<the URL you found>"`. The tool returns a "Pending user approval" report with the resolved URL.
   - Surface that URL to the user in your reply: *"I found a skills package at `<URL>` — install it?"*
   - On user yes, retry with the SAME args plus `approve: true`. Mica records the approval in `.mica/skills-approvals.json` so future installs of the same URL skip the gate.
   - On user no or "skip libraries-skills," proceed without — record "no skills package available" next to the library decision in spec.md.
4. **None found** — record `"no skills package available"` in the spec next to the library decision and proceed. This is fine; community skills don't exist for every library.

Newly installed skills are visible to the agent on the NEXT turn via the `skill` tool. To use them in the SAME turn (e.g. mid-build), `read_file` the relevant SKILL.md directly from `.qwen/skills/<name>/<skill-dir>/SKILL.md` (or `.claude/skills/<name>/...` for Claude/opencode).

## Cross-references

- `create-card-class/SKILL.md` § STEP 0.5 — invokes this skill recursively for each subproblem during inline card-class builds.
- `decompose-task/SKILL.md` and the `task-decomposer` agent — invoke this during plan writing; library decisions land in `interfaces.md § Library versions`.
- `fix-bug/SKILL.md` — invoke this when a fix would need >30 lines of new bespoke code.
- The Pre-completion smoke test in `create-card-class/SKILL.md` — Tier 1 (URL reachability) and Tier 2 (library global / API surface) verifications happen at this skill's step 3, recorded in spec.md so the smoke test has a ledger to compare against.
