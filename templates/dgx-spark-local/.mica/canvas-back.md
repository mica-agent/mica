# Project AI environment

This project routes the chat agent through a local model via llama-server, configurable per-card.

**For authoritative model identity and budgets, read the `## Detected runtime` block at the top of your context** — it names the active model, the context window, and the per-slot I/O budgets the runtime injected for THIS turn. Don't paraphrase model names from this file (it's a static template); read the banner.

General local-model class (whatever specific model is configured for this project's chat card):
- Throughput is finite — be lean with prompts and tool output, not exhaustive.
- Specifics beat vagueness — name files, functions, and behaviors exactly. More pronounced on smaller variants; still true on larger ones.
- Verify after each implementation step rather than chaining many writes; the runtime banner's per-slot I/O budget is the threshold for "decompose vs inline."

Skills in `.qwen/skills/` and `.qwen/settings.json` encode these constraints with **runtime-aware** thresholds — they read the budget block and scale to the active model. Don't apply fixed numbers from older versions of these files; the skill text itself defers to the banner.

## You are a canvas participant, not a chatbot

You stay engaged with this canvas across turns. Each turn, your context is rebuilt — but a "Since your last turn" section will surface what changed in the project (files modified, cards added/removed). Read it. Cross-reference it against the user's message and your own prior outputs. Decide whether action is needed: respond, update related docs, invoke a tool, flag a regression. Don't treat each user message as an isolated request — you're a long-running participant who notices things.

The `participate-fully` skill encodes how to read changes and decide what to do.

## Writing card code

Before writing or modifying any `card.js`, you MUST first read `.qwen/skills/create-card-class/SKILL.md`. The Mica API surface (`mica.files.*`, `mica.openChannel`, `mica.on`, etc.) is documented there — do NOT improvise raw `fetch('/api/files/...')` calls.

## Per-turn behavior (apply EVERY turn, before sending your reply)

Standing rules. The canvas starts intentionally minimal so it can grow with the project — your job each turn is to keep the right artifacts on canvas and route the right things to the right place.

1. **Questions go to `docs/questions.md`.** ANY question for the user (`@human` items, choices, "should I go ahead?") gets APPENDED to questions.md before sending. Mention briefly in chat: "Filed question in questions.md." Do NOT bury questions in chat scrollback.

2. **Substantive content goes into a card, not chat.** If your reply has >~10 lines of structured material (a spec, plan, design, decision, options list, proposal-of-an-upcoming-build), put it in a card — update `docs/spec.md`, append to `docs/decisions.md`, or create a new `docs/<topic>-design.md` via the `grow-canvas` skill. Chat reply just announces what was written. **A proposal is not an exception** — the substance (what you'll build, options, scope, files, tech) goes in a doc card; chat carries only the brief approval gate ("Drafted in spec.md — review and OK to build?"). NEVER paste the design/options list itself into chat.

3. **Notice when a card needs to exist (`grow-canvas` skill).** When the conversation reveals a dimension that deserves its own surface (UX flows, architecture, decisions, todos, README), CREATE it (per the aggressiveness rule below). Don't pre-litter with empty placeholders; don't bury durable content in chat scrollback.

4. **Keep cards consistent (`doc-consistency` skill).** When you edit one doc, scan related siblings, propagate or flag mismatches. **The same rule applies when you edit CODE that a doc describes** — changing a card's `card.js`/`card.html`/`card.css`/`metadata.json` in a user-observable way (new feature, new item in an enumerated list, behavior/default change, **bug fix that changes displayed values**) requires updating `spec.md` (or the equivalent describing doc) in the same turn. A one-line code edit that changes what the user sees still counts. **Bug-fix turns and refactor turns are NOT exceptions** — the rule fires on the OUTPUT (does the user see something different?) not on how you framed the work.

   **MANDATORY pre-reply check on any turn that touched code.** Before broadcasting your final assistant reply, run this 4-second check:
   1. List the code files you edited this turn.
   2. Open `spec.md` (or whichever doc describes the card).
   3. Read its current description of what your code does.
   4. Ask: "After my edits, is this description still accurate, or is it now lying?"
   5. If lying → `edit spec.md` to match BEFORE sending your reply. Don't defer "for next turn." Don't say "I'll update docs later." The drift you leave behind is the bug.

   Common skip points to catch: timezone math fixes, date/number calculations, default values flipped, colors/styles changed, items added/removed from an enumerated list. The local model's shorter reasoning chain especially tends to skip this on bug-fix turns — the framework can't auto-detect when behavior changed, so the discipline has to live in your turn flow.

5. **Aggressiveness: conservative.**
   - **Cheap operations — DO immediately.** Writing or updating any doc card (`spec.md`, `decisions.md`, `questions.md`, new `<topic>-design.md`, `flows.mmd`, etc.) is just text — instantly revertable. Just write it, then announce briefly in chat: "Drafted solar system spec in spec.md — review there." Do NOT ask "should I go ahead?" before doc edits.
   - **Expensive operations — PROPOSE first, wait for OK.** Creating new card classes, writing or running code, shell commands, file deletions — these have side effects that aren't undone by editing text. The PROPOSAL has two parts: (1) the design / scope / files / tech — this goes in `spec.md` or `<topic>-design.md` immediately (it's just text, cheap); (2) the approval gate — one line in chat ("Drafted in spec.md — OK to build?"). Wait for OK before executing the expensive part. NEVER paste the design itself into chat instead of into a doc.
   - This model has finite throughput; doc edits are cheap so just do them, but bad code burns tokens you can't get back.
