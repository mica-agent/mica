---
name: doc-consistency
description: Keep docs and the code they describe in sync. Fires (a) before writing or editing a spec, plan, design doc, diagram, decision note, README, etc., AND (b) before or after editing CODE that a doc describes (e.g., a card class's card.js/html/css/metadata.json when the canvas has a spec.md). Checks sibling docs for alignment, propagates user-observable behavior changes from code back to spec, asks when contradictions surface.
---

# Keep related docs consistent

Projects accumulate multiple docs describing the same system — spec, design, implementation plan, diagrams, decisions, README. And the CODE they describe is just another source of truth that can drift. If you touch one without checking the others, they drift silently. The user then has to ask you to "confirm X and Y are consistent" after the fact. Prevent this.

## Before WRITING a new doc

1. **List sibling docs**: `ls docs/` (or the target dir).
2. **Identify overlap**: for each sibling that might describe the same subject matter, `Read` the file. Note the components/features it names, the vocabulary it uses.
3. **Decide the new doc's role**:
   - A refinement of an existing doc → reference it explicitly at the top ("See `spec.md` for product requirements.").
   - A different view (diagram for spec, plan for design) → **mirror names and terms exactly**. Do not rename. Do not improve wording.
   - Potentially duplicative → ask the user: "We already have `spec.md` covering X. What does this new doc add that the existing one doesn't?"
4. **Write the doc using the sibling vocabulary.** If `spec.md` calls it "Inbox Monitor", do not call it "Email Watcher" in your diagram.

## Before EDITING an existing doc

1. **Grep for references**:
   - `Grep` the file's name across the project (`grep -rn "spec.md" docs/`).
   - `Grep` for key terms the file introduces (`grep -rn "Inbox Monitor" docs/`).
2. **List siblings that would be affected** by the edit.
3. **Per sibling, decide**:
   - **Propagate**: mechanically update the sibling to match. State what you changed.
   - **Flag**: sibling expresses a DECISION that overrides your edit → stop and ask.
   - **Skip**: sibling describes a different layer and isn't affected.
4. **Report changes**: "I updated `design.md` section 3. Propagated the rename to `system-diagram.mmd`. Left `decisions.md` alone (it records a prior version; adding a new decision entry would be a separate action if you want one)."

## Before editing CODE that a doc describes

Code drift is the SAME problem as doc drift — `spec.md` describes a card's behavior, you add a feature by editing `card.js`, now spec and code disagree. The user has to notice and ask.

The threshold is NOT "big feature." It's **any user-observable change**: adding an item to a list the spec enumerates ("Cities shown (15)"), adding/removing a feature, changing a behavior, renaming a mode, altering a default. Even a one-line edit qualifies.

1. **Before editing code**, scan for a describing doc:
   - `spec.md`, `<name>-design.md`, `README.md`, any `.md` in `docs/` or `canvas/` that names the card/module/file you're about to change.
   - Quick grep: `grep -rln "<card-class-name>\|<filename>" canvas/ docs/` (or your project's doc dir).
2. **If a doc describes the code you're about to change**, plan the spec edit in the SAME turn as the code edit. Both writes go through; both land on disk; both get announced in your chat reply. Do not ship the code change alone and defer the spec "for next turn" — that IS the drift.
3. **If no doc describes it yet**, you're writing undocumented code. Either (a) add a one-paragraph note to `spec.md` alongside the code change, or (b) call it out in chat so the user can decide whether to grow a doc via `grow-canvas`.

### Examples of things that qualify

- Adding a city to a `CITIES` array → update the spec's city count and list.
- Flipping a default (tick rate, timezone, color scheme) → update the spec's "Defaults" section.
- Adding a new panel, tooltip, click behavior, hotkey → update the spec's "Interaction" section.
- Changing an algorithm in a way the user will feel (day/night calculation, distance formula) → update the spec's "How it works" section.
- Pure refactor, no user-observable change → no spec edit needed. Say so in chat: "Refactored foo.js, no behavior change."

### Self-check before finishing a turn that touched code

Before broadcasting your final reply, re-read your own code edits. Ask: *"If someone reads `spec.md` after this turn, will it still accurately describe what the card does?"* If no — edit spec now, before replying. Trivial edits to spec are cheap; the drift you leave behind is expensive.

## Ask when ambiguous — NEVER silently harmonize

If two docs disagree and you can't tell which is authoritative, STOP and ask the user before editing either:

> "`design.md` says the stage is called `Transcoder`. `system-diagram.mmd` calls it `Transcoder - ffmpeg`. Which is the canonical name? Should I (a) rename in both, (b) accept both (ffmpeg is impl detail), or (c) something else?"

Never invent a third version. Never delete content to resolve a conflict. Never rewrite to something "cleaner" — the user picked their words.

## Stop conditions

- Don't update a doc whose mtime is newer than the one you're editing without flagging — user may have just hand-edited it.
- Don't reformat, restructure, or "improve" sibling docs while propagating. Narrowest possible edit.
- Don't edit the same identifier in more than 2 docs per turn without checking in first ("I'd need to touch 4 files; OK?").
