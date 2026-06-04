---
name: grow-canvas
description: Propose new cards on the canvas as the conversation reveals dimensions that deserve their own surface — UX flows, system architecture, decision logs, READMEs, todo lists, etc. Use whenever the user describes something substantial that would be lost in chat scrollback or that other cards would benefit from referencing.
---

# Grow the canvas as the conversation grows

The project starts intentionally minimal: a chat card, a canvas-back doc, and a skills card. No spec, no questions doc, no todo. Everything else is added on demand — when the conversation reveals it would be useful — not pre-littered as empty placeholders. Your job is to notice when a new card would help and **propose** creating it.

This is the opposite of "scaffold everything upfront." Empty placeholder cards are noise; they make the canvas feel cluttered before the project even has shape. Wait for a real signal, then propose.

## When to propose

Use the FIRST trigger that fits. Don't pile multiple proposals into one turn.

| Conversation signal | Proposed card |
|---|---|
| Discrete actionable items pile up in chat ("we should do X, then Y, then Z") | `todo.todo` |
| A real tradeoff is decided ("OK, let's go with option B because…") | `decisions.md` (and append the decision) |
| User describes a multi-step user flow / journey | `flows.mmd` (mermaid) |
| User talks about components, services, or system boundaries | `architecture.mmd` (mermaid) |
| Data shape / entities / relationships become a topic | `data-model.mmd` (mermaid) |
| Project shape is clear enough that a newcomer would benefit from orientation | `README.md` |
| Shell access is needed for a specific task ("can you run X?") | `terminal.terminal` |
| Specialized data needs structured editing not covered above | propose a new card class via the `card-class-handbook` skill |

**Use the existing class, don't invent.** For mermaid specifically: the extension is `.mmd` (NOT `.mermaid`) and the built-in `mmd` card class renders it. Do NOT create a custom "diagram" or project-scoped `mmd` class — `mica.cardClasses.list()` will show `mmd` is already there. Same logic for any entry in the table above: these extensions map to built-in classes; use them directly.

## How to propose

In your reply:

1. **Name the card** — exact filename (e.g. `docs/flows.mmd`) and which card class will render it.
2. **Cite the trigger** — quote or paraphrase the part of the conversation that surfaced the need. Don't propose in the abstract.
3. **Describe what it would contain** — one sentence. Not a wall of placeholder structure.
4. **Wait for OK** before creating it. Same etiquette as `doc-consistency`'s "Ask when ambiguous."

Example:

> You just described a sign-up → onboarding → first-action flow. Want me to start `docs/flows.mmd` with that as a mermaid diagram? It'll grow as we keep talking about user journeys.

If the user says yes (or just "go"), create the card and seed it with **what's already been discussed**, not generic boilerplate.

## Seed with conversation context, not boilerplate

When you create the card after user OK:

- Populate it with the actual content that surfaced the need. If they described 3 steps in the flow, the seeded mermaid has those 3 steps — not `A[Replace me] --> B[With your real flow]`.
- Reference siblings. If the new card overlaps with `spec.md`, link it: `> See [spec.md](spec.md) for product requirements.`
- Mirror existing vocabulary exactly (per `doc-consistency`). If `spec.md` calls it "Inbox Monitor", do not call it "Email Watcher" in your diagram.

## One proposal per turn

Even if the conversation reveals multiple gaps at once, propose only the most pressing one. Wall-of-suggestions ("we should also create flows.mmd, architecture.mmd, decisions.md, and a README") is a failure mode — it overwhelms the user and forces them to manage your queue.

Pick one. Wait. The next gap will still be there next turn.

## Stop conditions

- **Don't propose a card that already exists.** `ls docs/` before proposing.
- **Don't propose dummy cards** just because they "feel like they should be there." Wait for a real conversation signal.
- **Don't propose architectural cards before there's anything architectural to put in them.** A `flows.mmd` with `A --> B` placeholder is worse than no card.
- **Don't auto-create on the user's initial message.** First read what exists (per `participate-fully`); only propose new cards once the conversation has actually surfaced something the existing cards don't capture.
- **Don't propose a card AND also start writing other docs in the same turn.** Propose, then wait — let the user steer.

## Relationship to other skills

- `participate-fully` — runs every turn, decides what to do based on what changed. May trigger you when a file change reveals a gap.
- `doc-consistency` — once a card is created, sibling docs may need updates. That skill handles the propagation.
- `card-class-handbook` — for cases where no existing card class fits the need. You propose; that skill builds the class.
