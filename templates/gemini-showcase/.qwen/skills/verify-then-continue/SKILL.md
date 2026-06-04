---
name: verify-then-continue
description: After writing or editing code, verify it works before moving on. Use after every code change — type-check is necessary but not sufficient.
---

# Verify before continuing

After every code change, run the relevant verification BEFORE claiming done or moving to the next step:

1. **Type-check** — `npx tsc --noEmit`. Required after any TypeScript edit.
2. **Restart** — required after any `server/*.ts` change. **Never run `scripts/restart.sh` or `scripts/stop.sh` yourself** — you live inside the backend's process tree; the script will SIGTERM you mid-tool-call and the restart will not complete. Ask the user inline: *"I edited `server/foo.ts` — can you run `scripts/restart.sh` from your shell?"* They're outside your process tree. (Card classes and project files hot-reload via the file watcher; no restart needed for those — skip this step.)
3. **Hit the actual surface** that changed:
   - HTTP endpoint: `curl -s http://127.0.0.1:3002/api/<path>`
   - Card UI: ask the user to hard-refresh and confirm visible behavior. You cannot drive the browser.
   - WebSocket channel: write a small smoke script at `test/<name>-test.mjs` using the project's `ws` package, run it, then `rm` it.
4. **Read the backend log** — `tail -30 /workspaces/mica/.mica-pids/backend.log`. Look for errors, registration messages, the behavior you expected.
5. **Report concrete pass/fail**. Include the test output. Don't say "it works" — show the evidence.

If you can't verify (UI-only change), say so explicitly: "type-checks pass, can't drive browser — needs manual test."

After editing this project's `.qwen/skills/<name>/SKILL.md` files (or the `.qwen/QWEN.md` / `.qwen/settings.json`), run the slash command `/memory refresh` so the agent picks up the new context without restarting the session.

Never chain implementation steps without running verification between them. The local model produces silently broken code; verification is how you catch it.
