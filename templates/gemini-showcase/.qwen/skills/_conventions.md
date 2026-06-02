# Skill conventions reference

Canonical source for cross-skill patterns. When a skill says
"see _conventions.md", jump here. Don't restate these patterns
in individual skills — cite this file by section.

Tenet numbers refer to the 16 engineering convictions in
ARCHITECTURE.md / CLAUDE.md.

## Reading discipline (tenets 9 + 13)

Read named sections, not whole files. Every line read consumes
the model's working set; whole-file reads burn it on prose you
won't use.

- Use `Grep` with `output_mode: "content"` and `-C 5` when you
  only need lines around a match.
- Use `Read` with `offset`/`limit` when you only need a section
  of a long file.
- Reference docs by section anchor (`spec.md#orbit-mechanics`),
  not by whole-file path, when handing context to a subagent.
- For files you wrote last turn, re-read first if the user may
  have edited them — your prior memory is stale on user edits.

The test: would you read this if context cost a dollar a line?

## Reuse before reinventing (tenet 15)

Before writing custom code, walk the decision tree in order:

1. **Does `mica.*` expose this capability?** See ARCHITECTURE.md
   §"The `mica.*` bridge". Examples: `mica.invokeMicaAI` for
   chat threads, `mica.openChannel` for bidirectional sessions,
   `mica.fetch` for HTTP, `mica.exec` for shell. If yes → use
   it. Do not shim equivalent logic in card.js.

2. **Does the agent SDK or platform handle it?** Token-aware
   chat-history trimming, silent summarization, prompt-cache
   management, `/compress`-equivalents — those live on the
   agent's side of the line (tenet 10). Don't reimplement them
   in Mica.

3. **Is there an established 3rd-party library?** Invoke the
   `discover-dependency` skill. The threshold is: if you would
   write >20 lines of bespoke logic in an area where libraries
   commonly exist (rendering, math, parsing, networking, dates,
   charts, geometry, layout), search first.

4. **None of the above?** Surface to the user before writing
   custom code: *"I'd write ~N lines for X. mica.* doesn't
   cover it, didn't find a library that fits — ok to write
   custom?"* Don't silently roll your own.

## Latest stable + bridge gaps (not walk back)

Pick the latest stable version of any library. `mica_inspect_url`
it to learn what format it ships. Apply the matching load pattern.
That's the rule.

When the latest doesn't fit your context, **bridge** — write a small
adapter, use Pattern B (`await import()`) for ESM, mix Pattern A core
+ Pattern B addons. Don't walk back through older versions hoping to
find one where everything matches a single format.

Walking back to an older version is acceptable only when:

- The latest is brand-new (released <1 month ago) and untested
  AND the rollback distance is one minor version.
- An explicit user constraint requires an older version (legacy
  ecosystem, must-match-server, etc.).

Otherwise walking back signals you haven't found the bridge yet.

For the mechanics of Pattern A vs B and mixed-format integration,
see `card-class-handbook § "Pattern A — UMD"` and `§ "Pattern B —
Dynamic ES module import"`. For the version-selection rule applied
step-by-step, see `discover-dependency § "Pick latest, inspect,
apply the matching pattern"`.

## API discipline (tenet 16)

Once an API is chosen, use signatures verbatim. Don't improvise
method names that "look right."

- **`mica.*`**: ARCHITECTURE.md §"The `mica.*` bridge" is the
  authority. `mica.read()` is not a method; `mica.getContent()`
  is. Look up before calling. If a method isn't in
  ARCHITECTURE.md, it doesn't exist.
- **3rd-party endpoints (URLs, services)**: fetch once with
  `curl` or a small probe before code parses the response.
  URL strings, parameter names, and response shapes are not
  guessable from the API name.
- **Library imports**: read the package README or run a small
  smoke-import before code depends on a method name. The
  README's first example is usually the canonical signature.

If a fetch or import test fails at this stage, that's the
cheapest place to catch it — before code is written around the
wrong shape.

## Precision over recall for external facts

Read the **"Model self-awareness"** block at the top of each
turn — it lists categories where this model's recall is rated
`very-low`. For any `very-low` category, *do not estimate from
memory*, even when you "feel sure," and even for famous things.
The cost-of-error (visibly wrong output) far exceeds the cost of
a tool call.

The trap that keeps tripping the geographic-coordinates case:

- Text search (Tavily, `web_fetch`) returns **prose**
  snippets — *"on the south shore"*, *"near Shipwreck Beach"* —
  not coordinates. Reading those and then producing a lat/lng
  IS recall, hidden inside a tool call. The model still made up
  the numbers; web search just confirmed the place exists.
- The right tool for precise external facts is one whose
  **output shape matches what you need**:
  - Coordinates → a geocoder. Free public option:
    `nominatim.openstreetmap.org/search?q=<name>&format=json`
    (returns `{ lat, lon, display_name, ... }`). Reach it via
    `mica_shell curl ...` for one-off queries, or via
    `mica.fetch` from inside a card. Respect the 1 req/sec
    rate limit and set a `User-Agent` header naming your card.
  - Prices → a finance API (Yahoo Finance, Alpha Vantage).
  - Current weather → OpenWeather or NWS.
  - Real-time anything → an API that returns structured data,
    not a blog post.

When a `very-low` category has no matching tool in your surface,
the procedural default still applies: stop and propose to the
user *"I need precise X; my tools return prose. Want me to call
<service> directly via `mica_shell` / `mica.fetch`?"* before
writing any code that consumes estimated values.

This applies the same shape of discipline as the existing
asset-URL rule: skip recall, reach for the structured tool,
verify before commit.

## Curate-context dispatch (tenet 13)

When dispatching to a subagent:

- Reference files by path **and named section anchor**:
  `spec.md#orbit-mechanics`, `interfaces.md#chart-handler`.
- Do **not** pass whole documents.
- Do **not** pass peer-subagent context. Each subagent owns its
  scope; give it only what it needs to fulfill its contract.
- Each `Context:` block in the dispatch payload answers one
  question: *"what does this subagent need to read to do its
  job?"* — nothing more.

A dispatch payload that runs longer than the subagent's
expected output is a smell. Re-curate.

## Decomposition gates (tenet 12)

Decompose into subagent dispatches only when **both** gates
pass:

**(a) Real architectural seams.** Each piece can be specified
    by an interface contract another agent could implement
    without reading the others' code.

**(b) Whole exceeds working set.** The integrated artifact
    would be >500 lines, OR would require tracking >5 distinct
    concerns simultaneously.

If either gate fails, work inline. No third gate exists.

The following are **not gates** and never satisfy (a) or (b):

- "Reusable design memory"
- "Narrative cleanliness"
- "Future flexibility"
- "Better artifact organization"
- "The user might want to revisit this later"

If you find yourself writing "Decompose. Reasoning: ... **BUT**
[any of the above]", stop. The BUT is the smell. Either both
gates pass and you decompose, or you work inline. There is no
in-between.

## Approval flow (tenet 14)

A file save is NOT a build trigger. The file-watcher event
tells you state changed; it does not authorize action.

The user must send an explicit affirmative message — *"ok build
it"*, *"yes go ahead"*, *"let's build"*, *"ship it"*, *"start
implementation"* — before any of these actions:

- Invoking `task-decomposer`
- Invoking `card-class-handbook`
- Writing card-class files (`.mica/card-classes/<ext>/...`)
- Dispatching `component-coder`

Until that message lands, your only legitimate response to a
spec or design-doc edit is:

- Acknowledgment in chat: *"spec.md updated — let me know when
  you want me to build."*
- Refinement questions or suggestions to improve the spec.
- Optionally posting the gate: *"Spec looks firm to me — ok to
  build?"* A question is not a build action.

This rule covers `card-class-handbook` the same as `task-decomposer`:
no card-class files written in response to a file-change event.

## Naming and hygiene

- **Card-class directory matches the extension.** `.kanban`
  cards live in `.mica/card-classes/kanban/`. `.terminal` →
  `.mica/card-classes/terminal/`. The extension is the routing
  key.
- **Instance files live at canvas root.** A `my-board.kanban`
  file goes in the project root, never inside `.mica/`.
- **`.mica/` holds operational metadata only.** Config, layout,
  chats, per-card AI context, project-scoped card classes.
  Delete `.mica/` and the project is back to plain files.
- **Server-side channel handlers live in `server/`**, never
  inside card-class directories. Card classes are
  `card.html + card.js + card.css + metadata.json`. No
  `render.js`, no `server.ts` inside the card-class folder.
