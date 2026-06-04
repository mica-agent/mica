---
name: revise
description: FIRST tool call for any follow-up that changes behavior, output, or scope of an existing card or program — "now it should also X", "include Y", "change the way Z works", "instead of A do B", "the output should…", "also let me…", "remove…", "describe what it really is", or any repeated complaint ("still says X" ×2+). Default any change request to "this is a spec change" — the contract was approved at first build; this request alters that contract. Cheaper to re-confirm contract than to chase the wrong surface. Skip ONLY for bug reports with explicit error messages (use `fix-bug`), pure visual/layout tweaks ("make it bigger / blue / centered" — direct CSS edit), or pure Q&A.
---

# Revise — change the contract before the code

A follow-up that asks for new behavior, different output, or expanded scope is a CONTRACT CHANGE, not a code patch. The spec was approved at first build; that approval is now stale. Re-confirming the new contract before any code touch prevents the failure mode where N turns of cosmetic edits chase a complaint whose source was the spec all along.

Same architecture as `develop` (initial builds) and `fix-bug` (error reports): a skill that owns one entry point of the flow. `revise` owns the follow-up entry.

For cross-skill discipline (reading, reuse, API discipline, approval flow) see `.qwen/skills/_conventions.md`. Tenet numbers refer to ARCHITECTURE.md / CLAUDE.md.

## Routing — when this vs alternatives

| User says | Skill |
|---|---|
| "build / create / implement / make X" (new) | `develop` |
| "Error: <message>" / "fix this crash" | `fix-bug` |
| "now it should also Y" | **`revise`** |
| "change the way X works" | **`revise`** |
| "include / add / remove" (behavioral) | **`revise`** |
| "describe / show / display what …" (output shape) | **`revise`** |
| "still says X" repeated on same complaint | **`revise`** — the recurrence IS the signal that the spec is wrong, not the code |
| "make it bigger / blue / centered" | direct edit (CSS only) — no spec touch |
| "what does X do?" | answer in chat — no edit |

**Default bias: when in doubt, invoke `revise`.** False positives cost one extra turn (you propose an amendment, user replies "no, just patch it" and you switch). False negatives cost N turns of chasing the wrong surface — observed in prior builds where 13 follow-up turns failed to fix a problem whose root was a one-line spec gap.

## The five-step playbook

### 1. Read the current spec

The spec is the authoritative contract — your memory of what was built is stale. Find it via `glob` if you don't already know the path (typically `canvas/<name>-spec.md` or a sibling). Read the WHOLE spec, not just sections — the contract is the whole document.

**If no spec exists**, the contract was implicit. Stop and invoke `develop` instead — `revise` assumes a prior `develop` produced a spec to revise. Without one, there's no contract to amend; you'd be authoring net-new.

### 2. Classify the change and propose the amendment

What kind of change is the user asking for? Map to one of:

- **Output contract change** — the data/text the user sees has a different shape. (E.g., was `{classification}`, now `{classification, description}`. Was a number, now a struct. Was one line, now a paragraph.)
- **Behavior change** — same inputs, different outputs or different flow. The card's logic shifts.
- **Scope expansion** — new inputs supported, new actions, new states. (E.g., "also let me upload audio files.")
- **Scope reduction** — feature removal.
- **Constraint change** — limits, validation, formats. (E.g., "downscale images >2MB", "only accept PDFs.")

Write the amendment as a concrete spec edit. Show the EXACT replacement text for the affected section. Don't paraphrase ("I'll update the spec to mention description"); produce the diff ("Output Contract was `{classification: string}`; will be `{classification: string, description: string}`").

If the change touches multiple spec sections, propose all the edits together — they're one logical amendment.

### 3. Approval gate (tenet 14)

Your turn ENDS after step 2. Your chat reply is:

> *"Reading this as a [output-contract / behavior / scope / constraint] change to the spec. Proposed amendment: [show the spec edit, verbatim]. OK to update?"*

Wait for the user's NEXT message. Do NOT advance to step 4 in this turn — no `mica_edit_class_file`, no `write_file`, no spec write. The gate fires on tool-return; "approval" is the user's next message, nothing else.

**If the user redirects** ("no, I meant just fix the parser" / "actually this is a bug, here's the error"), abandon `revise` and switch to the correct skill (`fix-bug`, direct edit, etc.). The misclassification cost is one turn; recoverable.

**If the user says "looks good, proceed"**, continue to step 4.

### 4. Apply the spec amendment AND derive the implementation surfaces

User approved. Now:

1. **Edit the spec** with the exact amendment text from step 2. The spec is now the new contract. This happens BEFORE any code edit.
2. **Identify which surfaces the new contract affects.** Walk the amended sections; each section maps to one or more code surfaces. For LLM-driven cards (handler = `llm-direct` or any in-card LLM call), the surfaces commonly are:
   - **System prompt** — if the output contract changed, the prompt needs to ASK for the new shape. The prompt is the API to the model; if you don't ask for description, the model won't return it.
   - **Output parsing in card.js** — if the model returns a new shape, the parser needs to handle it.
   - **Render in card.js** — if new fields, the UI needs to surface them.
   - **metadata.json dependencies** — if scope expanded into a new library / handler.
   
   For non-LLM cards, surfaces shrink (no prompt) but the same discipline applies: walk the spec, map each amended section to a code surface.
3. **Plan edits in spec order, not file order.** The spec defines what changed; the code follows. Don't start with `mica_edit_class_file` and infer the spec change later — that's the failure mode this skill exists to prevent.

### 5. Verify against the amended contract

Same verification as `develop` step 6, with one addition specific to revise:

- **Canvas card**: `render_capture` for visual confirmation.
- **If the user complaint that triggered this revise was empirical** (e.g., "it says X when I do Y"), re-run their exact action and confirm the output matches the amended contract. The user is comparing against their original complaint; your verification must address THAT.
- **For LLM-driven cards specifically**: confirm the model's actual output matches the amended Output Contract. If the contract says `{classification, description}` and the model returns `{classification}` only, the prompt edit didn't take effect — iterate on the prompt, not on the parser. The parser can't extract what the model didn't generate.
- **State the observable difference in your reply.** "The card now shows X instead of Y when you do Z." Concrete; the user can validate it quickly.

## Why this beats direct code edits — the failure pattern

The canonical failure this skill exists to prevent:

1. User: *"Now it should show what it really is in parens."*
2. Agent (without revise): interprets as a text-format change. Edits `card.js` to wrap output in parens. Ships.
3. User sees `not hot dog (not hot dog)` — because the underlying prompt only ever returned classification; there's no description to wrap.
4. User: *"Still says 'not hot dog (not hot dog)'."*
5. Agent edits the parser again. User reports same thing. Loop continues.

After 5+ turns of cosmetic edits, the actual change required was: the SPEC's Output Contract needed to grow from `{classification}` to `{classification, description}`. From that contract, the implementation derives naturally: prompt asks for both fields, parser reads both, renderer shows both. One spec amendment + a coherent set of three derived edits.

What `revise` enforces:

- **Spec first.** Your memory of the build is stale; the spec is the contract.
- **Amendment in chat before code.** The user can correct your interpretation BEFORE any tool fires.
- **Derived surfaces, not patched surfaces.** The contract change tells you which surfaces need editing; you don't guess.

## What NOT to do

- **Don't call `mica_edit_class_file`, `write_file`, or any code-touching tool before the approval gate.** The spec amendment is the artifact this turn; the code comes after approval.
- **Don't skip the gate because the request "feels small."** "Just add description" sounds minor until the implementation reveals the prompt itself needs restructuring.
- **Don't treat bug reports as revise.** An error message ("Error: X is undefined") goes through `fix-bug` — the contract didn't change; the implementation broke. Use the routing table at the top.
- **Don't re-write the implementation from scratch.** Revise = minimum diff that delivers the amended contract. If the amendment requires rewriting the whole card, the change is bigger than a revision — consider whether the user wants a `develop` flow on a new card instead.
- **Don't batch multiple unrelated revisions.** If the user asks for three changes in one message, propose all three amendments in one reply (still one approval gate), then apply them serially in step 4 with verification between.
- **Don't paraphrase the amendment.** "I'll update the spec to include description" is not an amendment; the verbatim replacement text is. The user needs to see the actual contract change to approve it.

## Reporting back

At the end of a revise turn (after step 5):

- **What contract changed** in one line — the actual spec amendment, not a paraphrase.
- **Surfaces touched** — system prompt? card.js parser? card.js renderer? metadata.json? List each.
- **Verification** — what you ran (the original user action, or a representative one) and what the output was.
- **Observable difference** — what the user should see different now.

Trust the diff to speak. Don't restate what the code now does — the diff and the spec amendment cover that.
