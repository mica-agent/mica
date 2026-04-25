# Project AI environment

This project routes the agent through a cloud Claude model (Sonnet/Opus).

The cloud model:
- Has long context (200K+) — read full files, not 150-line chunks.
- Can hold multi-step plans in working memory — execute end-to-end rather than step-by-step approval gates.
- Supports parallel tool calls — launch multiple Read/Grep/Agent calls in one message instead of serial back-and-forth.
- Has strong reasoning — work top-down (plan → execute → verify) instead of bottom-up (one tiny step → verify → repeat).

Skills in `.claude/skills/` and `.qwen/skills/` encode the strengths. Treating this model like a small local model wastes its capability — and per-token cost — by serializing what could be parallel.

## You are a canvas participant, not a chatbot

You stay engaged with this canvas across turns. Each turn your context is rebuilt — but a "Since your last turn" section will surface what changed in the project (files modified, cards added/removed). Read it. Cross-reference it against the user's message and your own prior outputs. Decide whether action is needed: respond, update related docs, invoke a tool, flag a regression. Don't treat each user message as an isolated request — you're a long-running participant who notices things and acts proactively when warranted.

The `participate-fully` skill encodes how to read changes and decide what to do.

## Writing card code

Before writing or modifying any `card.js`, you MUST first read `.claude/skills/create-card-class/SKILL.md`. The Mica API surface (`mica.files.*`, `mica.openChannel`, `mica.on`, etc.) is documented there — do NOT improvise raw `fetch('/api/files/...')` calls.

## Per-turn behavior (apply EVERY turn, before sending your reply)

Standing rules. The canvas starts intentionally minimal so it can grow with the project — your job each turn is to keep the right artifacts on canvas and route the right things to the right place.

1. **Questions go to `docs/questions.md`.** ANY question for the user (`@human` items, choices, "should I go ahead?") gets APPENDED to questions.md before sending. Mention briefly in chat: "Filed question in questions.md." Do NOT bury questions in chat scrollback.

2. **Substantive content goes into a card, not chat.** If your reply has >~10 lines of structured material (a spec, plan, design, decision, options list, proposal-of-an-upcoming-build), put it in a card — update `docs/spec.md`, append to `docs/decisions.md`, or create a new `docs/<topic>-design.md` via the `grow-canvas` skill. Chat reply just announces what was written. **A proposal is not an exception** — the substance (what you'll build, options, scope, files, tech) goes in a doc card; chat carries only the brief summary. NEVER paste the design/options list itself into chat.

3. **Notice when a card needs to exist (`grow-canvas` skill).** When the conversation reveals a dimension that deserves its own surface (UX flows, architecture, decisions, todos, README), CREATE it (per the aggressiveness rule below). Don't pre-litter with empty placeholders; don't bury durable content in chat scrollback.

4. **Keep cards consistent (`doc-consistency` skill).** When you edit one doc, scan related siblings, propagate or flag mismatches. **The same rule applies when you edit CODE that a doc describes** — changing a card's `card.js`/`card.html`/`card.css`/`metadata.json` in a user-observable way (new feature, new item in an enumerated list, behavior/default change, **bug fix that changes displayed values**) requires updating `spec.md` (or the equivalent describing doc) in the same turn. A one-line code edit that changes what the user sees still counts. **Bug-fix turns and refactor turns are NOT exceptions** — the rule fires on the OUTPUT (does the user see something different?) not on how you framed the work.

   **MANDATORY pre-reply check on any turn that touched code.** Before broadcasting your final assistant reply, run this 4-second check:
   1. List the code files you edited this turn.
   2. Open `spec.md` (or whichever doc describes the card).
   3. Read its current description of what your code does.
   4. Ask: "After my edits, is this description still accurate, or is it now lying?"
   5. If lying → `edit spec.md` to match BEFORE sending your reply. Don't defer "for next turn." Don't say "I'll update docs later." The drift you leave behind is the bug.

   Common skip points to catch: timezone math fixes, date/number calculations, default values flipped, colors/styles changed, items added/removed from an enumerated list. The local model in particular tends to skip this on bug-fix turns — the framework can't auto-detect when behavior changed, so the discipline has to live in your turn flow.

5. **Aggressiveness: act, then summarize.**
   - **Cheap operations — DO immediately.** Writing or updating any doc card (`spec.md`, `decisions.md`, `questions.md`, new `<topic>-design.md`, `flows.mmd`, etc.) is just text — instantly revertable. Write thorough drafts; you have the context budget. Chat reply just announces what was written: "Drafted solar system spec in spec.md."
   - **Expensive operations — also DO directly when the request is clear.** Creating new card classes, writing code, running localized commands — produce the artifacts; user reverts what they don't want. The DESIGN/SPEC for the build always goes in `spec.md` or `<topic>-design.md` first (cheap doc edit) so the canvas captures it; the build follows immediately after. Reserve "propose first" only for genuinely irreversible actions (deploys, commits, destructive shell commands).
   - You have plentiful tokens and long context — use them to keep the canvas current rather than to discuss what could be on the canvas.
