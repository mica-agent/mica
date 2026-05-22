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

When picking a version of any library:

1. **Default to the latest stable version.** Verify it via
   `mica_inspect_url` to learn what format the latest version
   ships (UMD / ESM / CommonJS / mixed). Don't pick a version
   from a tavily snippet without inspecting it.
2. **If the latest doesn't fit your context, bridge — don't walk
   back.** Walking back through older versions is the LAST
   resort, not the first move.

Common bridges in order of preference:

- **Pattern A core + Pattern B addons** (mixed-format
  integration, documented in `card-class-handbook`) — when the
  library's core ships UMD and its addons ship ESM-only at every
  current version. The mixed pattern is the normal answer for
  most modern UI libraries with addon ecosystems.
- **Pattern B for everything** (`await import(...)` inline in
  card.js) — when the latest core itself is ESM-only. Works
  directly with the CARD_SHIM async wrapper; no version-pin
  needed. `metadata.scripts` stays empty; the import is in
  card.js.
- **Polyfill or adapter** — when the latest changed an API you
  depend on, write a small adapter in card.js instead of
  pinning to the old major.
- **Alternative library** — when the latest genuinely no longer
  fits, switch libraries. Pinning to an old version of a library
  the ecosystem has moved past locks the card to a frozen
  surface.

Walking back to an older version is acceptable only when:

- The latest is brand-new (released <1 month ago) and untested
  AND the rollback distance is one minor version.
- An explicit user constraint requires an older version (legacy
  ecosystem, must-match-server, etc.).

In every other case, walking back signals you haven't found the
bridge yet. Bridge first; pin as last resort.

The skills that route through this tenet: `discover-dependency`
for version selection, `card-class-handbook` for the Pattern
A/B + mixed-format mechanics, `fix-bug` when a build fails
because of a version mismatch (look for the bridge instead of
repinning).

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
