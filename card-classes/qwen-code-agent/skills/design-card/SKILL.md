---
name: design-card
description: Collaboratively design a new card type before building it. Use when asked to build, create, or make a new type of card, widget, or visualization.
---

# Design a Card Collaboratively

When the user asks to build a new card type, do NOT start coding immediately.
Produce specification documents first. Both user and agent must be aligned before implementation begins.

## Step 1: Read canvas context

Read the existing canvas cards to understand the project:
- `goal.goal` — current project goals
- `todo.todo` — existing tasks
- `architecture.mmd` — system architecture
- `brief.md` — project identity

## Step 2: Create a specification document

Create a `{name}-spec.md` card on the canvas. This is the primary design artifact. Write it with these sections:

```markdown
# {Card Name} — Specification

## Purpose
What this card does, who it's for, and why it's needed.
Reference project goals from goal.goal if relevant.

## Functionality
Detailed list of what the card does:
- Feature 1: description
- Feature 2: description
- Feature 3: description

## UX Flow
See `{name}-ux.mmd` card on canvas for the interaction flow diagram.

## Data Model
What data the card stores and its structure:
```json
{
  "field1": "type and purpose",
  "field2": "type and purpose"
}
```

## Technology & Dependencies
CDN libraries, APIs, or tools needed:
- Library: version, purpose, CDN URL
- Library: version, purpose, CDN URL
Explain WHY each dependency is needed. Prefer fewer dependencies.

## Visual Design
Layout description, color scheme, responsive behavior:
- Layout: [flex row/column, grid, etc.]
- Theme: [dark/light, colors]
- Sizing: fills card dimensions, responsive to resize

## Open Questions
- [ ] @user [question needing user input]
- [ ] @user [question needing user input]

## Status
- [ ] Purpose — agreed
- [ ] Functionality — agreed
- [ ] UX Flow — agreed
- [ ] Data Model — agreed
- [ ] Technology — agreed
- [ ] Visual Design — agreed
```

Fill in what you can from the user's request. Mark sections you're unsure about and add questions to Open Questions.

## Step 3: Create a UX flow diagram

Create a `{name}-ux.mmd` card on the canvas with a mermaid flowchart showing the user interaction flow. Example:

```
flowchart TD
    A[User opens card] --> B[Shows initial state]
    B --> C{User action?}
    C -->|Click Add| D[Show input form]
    C -->|Click Item| E[Select item]
    C -->|Drag| F[Reorder items]
    D --> G[Save data]
    G --> B
    E --> H[Show detail view]
    H --> B
```

Write raw mermaid syntax — no markdown fences. The card renders it directly.
Both user and agent can edit this diagram. Changes to the UX flow should be reflected in the spec.

## Step 4: Update project cards


After creating the spec:

1. **Update goal.goal** — add the new objective
2. **Update architecture.mmd** — show how the new card fits into the project (mermaid syntax, no fences)
3. **Update todo.todo** — add tasks with @-assignments:
   - `- [ ] @user Review {name} spec and answer open questions`
   - `- [ ] @agent Draft spec sections from project context`
   - `- [ ] @user Approve spec for implementation`
   - `- [ ] @agent Implement {name} card class`

## Step 5: Iterate with the user

The spec card and todo card are the coordination surfaces.

**When the user edits the spec:**
- Read changes and respond — they may have answered questions, changed requirements, or added detail
- Update architecture and todo to reflect the changes
- Remove resolved items from Open Questions

**When the user edits other cards:**
- Architecture diagram changed → update spec to match
- Todo reprioritized → follow their priorities
- Goals changed → adjust spec accordingly

**When you complete a section:**
- Check it off in the Status checklist
- Ask the user to review if it needs their input

This is a conversation, not a pipeline. Either side can update any card at any time.

## Step 6: Build on user approval

Do NOT start coding until:
1. Open Questions are resolved
2. The user explicitly says to build/implement/create it

When they do:
- Read the spec card and all canvas cards for final context
- Use the `create-card-class` skill to implement
- The spec card stays on canvas as living documentation
