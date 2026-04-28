---
name: single-file-edit
description: Edit, modify, or change code that touches more than one file. Use when a task spans multiple files — propose order and verify per file rather than batching.
---

# One file at a time

When a task touches multiple files:

1. **List the files and the change to each**. Don't start editing yet.
2. **Propose an order** — usually: types first, then producers, then consumers; or: server → API → UI. Never edit the consumer before the producer exists.
3. **Ask once**: "OK to proceed file-by-file with `npx tsc --noEmit` between each, or batch all changes and verify at the end?"

Default to file-by-file:
- Edit one file
- Run `npx tsc --noEmit` (catches missing imports / broken types across the boundary)
- One-line progress note ("✓ updated channelManager.ts")
- Move to the next file

If batching:
- Make all edits
- Run `npx tsc --noEmit`
- If any `server/*.ts` file changed, **ask the user inline to restart** — never run `scripts/restart.sh` yourself; you're inside the backend's process tree and the script will SIGTERM you mid-tool-call. Card classes and project files hot-reload via the file watcher; no restart needed for those.
- Report

The local model loses track of multi-file changes mid-stream and writes inconsistent identifier names across files. Type-checks between edits catches this immediately instead of at the end.
