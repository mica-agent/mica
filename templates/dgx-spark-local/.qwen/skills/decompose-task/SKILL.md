---
name: decompose-task
description: Build, implement, create, develop, refactor, or extend any code. Use whenever the user asks for non-trivial code work — break the task into small verifiable steps before writing any code.
---

# Decompose the task

Before writing any code for a non-trivial ask:

1. **Restate the ask** in one sentence. If ambiguous, ask before proceeding.
2. **Locate the surface area** — use `Glob`, `Grep`, and `Read` to identify which files exist, which need creating, which call sites are affected. Never assume paths; confirm them.
3. **Write a 3–6 step plan**, each step independently runnable (compiles + produces visible output or a passing check). Examples of a typical decomposition:
   - **Building a new card class**: `metadata.json` → minimal `card.html` → one wired event in `card.js` → server channel handler if needed → polish
   - **Adding a server endpoint**: type signatures + handler stub → wire route in `server/index.ts` → smoke test with `curl` → integrate with caller → error paths
   - **Refactoring a function**: extract pure function with same signature (no callers changed) → swap one call site → run type-check → swap remaining → delete original
   - **Bug fix**: write the minimal failing case (script or curl reproducing it) → fix the smallest thing that makes it pass → check no regressions on the test surface
4. **Implement step 1 only**. Run the relevant verification (`npx tsc --noEmit`, `bash scripts/restart.sh`, hard-refresh, `curl`).
5. **Stop and report**: what you did, what's next, anything you'd change about the plan now that you've seen step 1.

The local model produces silently incomplete code on large asks. Small steps + verification per step is how you ship working code rather than confident-looking broken code.
