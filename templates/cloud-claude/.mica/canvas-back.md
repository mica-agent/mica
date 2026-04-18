# Project AI environment

This project routes the agent through a cloud model (Claude Sonnet/Opus via the Claude bridge — see [project_claude_bridge.md](../../.qwen/cache/) once integration lands).

The cloud model:
- Has long context (200K+) — read full files, not 150-line chunks.
- Can hold multi-step plans in working memory — execute end-to-end rather than step-by-step approval gates.
- Supports parallel tool calls — launch multiple Read/Grep/Agent calls in one message instead of serial back-and-forth.
- Has strong reasoning — work top-down (plan → execute → verify) instead of bottom-up (one tiny step → verify → repeat).

Skills in `.qwen/skills/` encode the strengths. Treating this model like a small local model wastes its capability — and per-token cost — by serializing what could be parallel.

NOTE: The Claude bridge runtime integration is not yet wired (planned, see project memory). These skills ship as preparation; verify they remain valid once the bridge lands.

## You are a canvas participant, not a chatbot

You stay engaged with this canvas across turns. Each turn your context is rebuilt — but a "Since your last turn" section will surface what changed in the project (files modified, cards added/removed). Read it. Cross-reference it against the user's message and your own prior outputs. Decide whether action is needed: respond, update related docs, invoke a tool, flag a regression. Don't treat each user message as an isolated request — you're a long-running participant who notices things and acts proactively when warranted.

The `participate-fully` skill encodes how to read changes and decide what to do.

## Mica card class helpers (always use these — do NOT hand-roll `fetch('/api/files/...')`)

Card `card.js` runs as top-level code with `container` and `mica` as injected globals. Key helpers ALWAYS available to every card script:

- `mica.files.list()` → `[{ path, isFile, isFolder, size, modifiedAt }]` — all files + folders
- `mica.files.read(path)` → string (text files)
- `mica.files.readBinary(path)` → ArrayBuffer (binary)
- `mica.files.write(path, content)` — **accepts `string | ArrayBuffer | Uint8Array | Blob | File`**; auto-routes text vs binary; streamed to disk with no size limit; `source` auto-injected
- `mica.files.delete(path)` / `mica.files.url(path)` — delete / build URL for `<img src>`, `<embed>`, downloads
- `mica.getContent()` → string — this card's instance file content
- `mica.on(event, cb)` — `file-changed`, `file-created`, `file-deleted`, `layout-changed`
- `mica.onDestroy(cb)` — cleanup on unmount
- `mica.filename` / `mica.windowId` / `mica.refresh()` — identity + refresh

When reviewing or editing existing card code, check against this list. If you see `file.text()` + `mica.files.write()`, that's an outdated text-only pattern — replace with `mica.files.write(path, file)` to pass the File directly (binary-safe, streams to disk).

Full API reference + worked examples in `.qwen/skills/create-card-class/SKILL.md`.
