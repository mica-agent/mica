---
name: doc-consistency
description: Create, update, modify, or write a spec, plan, design doc, diagram, decision note, README, or any project document. Use BEFORE writing and BEFORE editing — check sibling docs for alignment, adopt existing vocabulary, and ask when you find contradictions instead of silently picking a version.
---

# Keep related docs consistent

Projects accumulate multiple docs describing the same system — spec, design, implementation plan, diagrams, decisions, README. If you touch one without checking the others, they drift. The user then has to ask you to "confirm X and Y are consistent" after the fact. Prevent this.

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

## Ask when ambiguous — NEVER silently harmonize

If two docs disagree and you can't tell which is authoritative, STOP and ask the user before editing either:

> "`design.md` says the stage is called `Transcoder`. `system-diagram.mmd` calls it `Transcoder - ffmpeg`. Which is the canonical name? Should I (a) rename in both, (b) accept both (ffmpeg is impl detail), or (c) something else?"

Never invent a third version. Never delete content to resolve a conflict. Never rewrite to something "cleaner" — the user picked their words.

## Stop conditions

- Don't update a doc whose mtime is newer than the one you're editing without flagging — user may have just hand-edited it.
- Don't reformat, restructure, or "improve" sibling docs while propagating. Narrowest possible edit.
- Don't edit the same identifier in more than 2 docs per turn without checking in first ("I'd need to touch 4 files; OK?").
