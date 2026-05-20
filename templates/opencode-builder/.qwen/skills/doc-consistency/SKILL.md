---
name: doc-consistency
description: Keep docs and the code they describe in sync. Triggers when editing a spec/design/decisions doc, OR when editing code (card.js/html/css/metadata.json) that a doc describes. Propagate user-observable behavior changes back to the doc in the same turn.
---

# Keep related docs consistent

Projects accumulate multiple docs describing the same system — spec, design, implementation plan, diagrams, decisions, README. And the CODE they describe is just another source of truth that can drift. If you touch one without checking the others, they drift silently. The user then has to ask you to "confirm X and Y are consistent" after the fact. Prevent this.

## The default: ask on inkling, don't autonomously update

If your turn touched anything that *might* leave a sibling doc inaccurate — even slightly, even if you're not sure — **ask the user before updating**. One inline line at the end of your chat reply:

> *"Added Beijing to `world-worldclock.worldclock`. Should I also update `spec.md` / `spec-city-data.md` to reflect the new city count and listing?"*

The threshold is **inkling**, not certainty. Err toward asking. The cost is one short user reply ("yes" / "no" / "just spec.md"); the saving is no silent drift, no propagation cascade, no aggressive overreach.

**Why this is the default:**

- **Cascade-proof.** You don't auto-write multiple docs in one turn. The user is the cap. Nothing loops.
- **Tolerates misjudgment.** You don't have to be RIGHT about whether the doc needs updating — sensing "maybe" is enough to ask. That's a much lower bar than the rule it replaces.
- **Matches the spec-first approval gate** (STEP 0.75 of `card-class-handbook`). Same shape: stop, ask, defer to the user.
- **Closes the "I did the minimum, done" loophole.** Asking IS a minimum action — smaller than updating. So your bias toward minimum action actually triggers the rule instead of skipping it.

**The ask is inline in your chat reply, NOT in `canvas/questions.md`.** Questions in questions.md are for async / batched items the user reads later. A doc-update ask is a synchronous gate — it goes where the user is already looking (the chat). Don't fight the participate-fully skill's "questions go to questions.md" rule — that's for a different kind of question.

**If the user says "yes":** update the docs they named. **Stop after that and ask again before touching further siblings** if more updates would still be needed. (Don't keep going on the strength of one yes.) **If the user says "yes, all of them":** treat as authorization for one round of fan-out — still capped at the existing stop conditions ("max 2 docs per turn without checking in"). **If the user says "no":** move on, no further doc edits.

**If the user says "yes" repeatedly across a session for the same kind of change** (e.g., "yes update spec.md" five times in a row for city-list edits), you can graduate to *"I'll update spec.md and ask before touching focused docs"* — but only after explicit signal, and only for the same kind of change. The default for any new kind of change resets to *ask*.

**When NOT to ask** — if the change is genuinely doc-irrelevant:

- Pure refactor with no user-observable behavior change. State this in chat: *"Refactored foo.js, no behavior change — no doc update needed."*
- Internal-only fix (a memory leak, a private helper rename) where nothing the user sees changes. Same.
- Adding a comment, fixing a typo in a string the user can't see. Same.

If you can't confidently say "no inkling," the answer is to ask. The bar to skip is high; the bar to ask is low.

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

## After editing CODE OR INSTANCE DATA that a doc describes

Code drift and instance-data drift are the SAME problem — `spec.md` describes a card's behavior or its visible city list, you add a feature by editing `card.js` OR add a city by editing `world-worldclock.worldclock`, now spec and reality disagree. The user has to notice and ask.

The threshold is NOT "big feature." It's **any user-observable change**: adding an item to a list the spec enumerates ("Cities shown (17)"), adding/removing a feature, changing a behavior, renaming a mode, altering a default. Even a one-line edit qualifies. **And it doesn't matter whether the change went into a `.js` file or an instance file** — if the user can see the difference, the spec can lie about it.

The procedure follows the "ask on inkling" default above: do the user-requested edit first, then ask before touching any sibling doc. **Do NOT bundle silent doc updates into the same turn** — even when you're confident the doc needs updating. Ask. Always ask.

### Examples of inklings that should trigger an ask

- **Adding a city to a `CITIES` array OR to an instance file's content** → ask: *"Should I update spec.md's city count and list?"*
- Flipping a default (tick rate, timezone, color scheme) → ask: *"Should I update spec.md's Defaults section?"*
- Adding a new panel, tooltip, click behavior, hotkey → ask: *"Should I update spec.md's Interaction section?"*
- Changing an algorithm in a way the user will feel (day/night calculation, distance formula) → ask: *"Should I update spec.md's How-it-works section?"*
- **Bug fix that changes displayed values** → ask. The frame is "what does the user see now vs before?" If the answer is "different output," it's user-observable. Examples: replacing hardcoded `utcOffset` with IANA timezones (the old spec table of UTC offsets is now lying); rounding fix that changes label values; off-by-one in a date calculation. Bug fix is NOT a free pass to skip the ask — if anything, it's the most important time to ask.
- Pure refactor, no user-observable change → no ask needed. State in chat: *"Refactored foo.js, no behavior change."*

### Don't think of work as "feature" vs "bug fix" vs "refactor"

The doc-consistency rule fires on the OUTPUT, not the INTENT. If your turn changes what the card shows the user, the spec MIGHT need to match — whether you framed the work as adding a feature, fixing a bug, or rewriting the algorithm. The simplest test: open spec.md, read its description of the card's behavior, then ask *"is this still true after my edit?"* If you can confidently say yes → silent. If no, or you're not sure → ask the user inline.

### Pre-broadcast inkling check

Before broadcasting your final reply, do the inkling check:

1. Re-read your own edits (every file you wrote this turn — including instance files, not just code).
2. For each, ask: *"If someone reads `spec.md` (or its split focused docs) after this turn, will it still accurately describe what the card does?"*
3. If the answer is "yes, still accurate" for all of them → no ask needed. Ship the reply.
4. If the answer is "no" or "not sure" for any of them → append a one-line ask to your reply naming the doc(s) you'd update if authorized. Wait for the user.

The bar to skip the ask is "I am confident no sibling doc was made inaccurate." The bar to ask is "anything resembling an inkling." Asking is cheap; silent drift is expensive.

## Ask when ambiguous — NEVER silently harmonize

If two docs disagree and you can't tell which is authoritative, STOP and ask the user before editing either:

> "`design.md` says the stage is called `Transcoder`. `system-diagram.mmd` calls it `Transcoder - ffmpeg`. Which is the canonical name? Should I (a) rename in both, (b) accept both (ffmpeg is impl detail), or (c) something else?"

Never invent a third version. Never delete content to resolve a conflict. Never rewrite to something "cleaner" — the user picked their words.

## Stop conditions

- Don't update a doc whose mtime is newer than the one you're editing without flagging — user may have just hand-edited it.
- Don't reformat, restructure, or "improve" sibling docs while propagating. Narrowest possible edit.
- Don't edit the same identifier in more than 2 docs per turn without checking in first ("I'd need to touch 4 files; OK?").
