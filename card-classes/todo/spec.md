# Card Class: todo

Interactive to-do list with sections, assignees, and priorities.

## Rendering
Displays tasks grouped by section (Active, Blocked, Done) with summary badges showing counts. Each task item shows: checkbox, priority button (H/M/L), assignee button group (human/agent/custom), and task text. Includes an "Add a task" input at the bottom. Dark theme with color-coded priorities (red=high, yellow=medium, green=low).

## Interactions
- **Toggle**: Click checkbox to mark done/undone. Done items move to the Done section with a timestamp.
- **Priority**: Click the priority button to cycle through high -> medium -> low -> none.
- **Assign**: Three-button group per task: human, agent, or custom (prompts for name). Active assignment is highlighted. Agent tasks (`@agent`) are picked up by reactive chat agents.
- **Add task**: Type in the input and press Enter or click "+ Add". Prefix with `@name` to assign. Default assignee is `human`, default priority is `medium`.
- Cross-window sync via `file-changed` event listener.
- All mutations use server-side handlers (`toggle`, `set_priority`, `reassign`, `add_item`) called via `mica.call()`.

## Data Format
Primary file: `tasks.md` -- Markdown with sections (`## Active`, `## Blocked`, `## Done`) containing GFM checklist items. Each item can have inline metadata: `@assignee`, `**priority: high**`, `**done: 2024-01-15**`.

Example:
```
## Active
- [ ] @human Design the homepage -- **priority: high**
- [ ] @agent Write unit tests -- **priority: medium**
## Done
- [x] @human Set up repo -- **priority: high** **done: 2024-01-10**
```

## Dependencies
None.
