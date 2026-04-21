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

## When to delegate to a subagent (the `task` tool)

Every `write_file` you call puts the file's full content into your context and keeps it there for the rest of the turn. Hit ~10 writes of non-trivial files in one turn and the context balloons past the local model's 65K window — the turn errors out mid-stream.

**Use the `task` tool** to delegate one-component-at-a-time work to `component-coder`. The subagent runs with its own context window, completes the component, and returns a short summary — the parent conversation sees the summary, not the full file contents. That lets one turn safely produce many components in parallel.

### When to delegate
- The decomposition plan produces **>3 files of new code** — delegate each coherent unit to `component-coder`.
- A single component spans **>200 lines of new code** — delegate so your parent turn doesn't carry all that text forward.
- You need **parallel work across independent components** (writing 5 modules with no dependency chain between them).

### When NOT to delegate
- Small edits (<20 lines, already-existing file) — just write them inline. Subagent startup is overhead for tiny changes.
- Cross-cutting refactors where every file depends on the edit shape being consistent — the parent keeping the whole change in one context produces more coherent output than 5 independent subagents.
- A fix whose contents you cannot describe in a one-paragraph task prompt — the subagent only sees what you hand it.

### Before you delegate — write the contracts

Subagents run with fresh context. They will see the canvas (`docs/spec.md`, etc.) but they will not see each other's in-flight work. If two subagents need to agree on a type or function signature, that agreement MUST exist on canvas before you invoke either one.

Steps (do these INLINE in the parent turn before any `task` call):

1. Author or update `docs/interfaces.md` with every shared type, function signature, class contract, and data shape. This is cheap — it's text. Just write it.
2. Confirm it's on disk with a quick verification read.
3. NOW spawn subagents. Each `task` invocation hands them:
   - A brief targeted prompt: "Implement src/email_monitor.py per spec § 3.2 and docs/interfaces.md § EmailMonitor."
   - Pointers to upstream dependencies: "Depends on src/config.py (read it before writing)."
   - Pointers to downstream consumers: "src/main.py will call poll_new_emails() → list[dict]."
   - Done criteria: "File must pass `mypy src/email_monitor.py`."

### Invocation shape

```
task({ agent: "component-coder", prompt: "Implement src/<file>. See docs/spec.md § X and docs/interfaces.md § Y. Upstream: … Downstream: … Done when: …" })
```

Concurrency is capped per-project (default 3 concurrent). If you hit the cap, wait — your next retry will succeed when an earlier subagent finishes.

### Do NOT

- Do NOT invent contracts in the parent and hope subagents guess the same way. Write them down first.
- Do NOT paste spec content into the task prompt when it's already on canvas — the subagent reads the canvas from its own context. Just point at the section.
- Do NOT let subagents call each other (depth-1 delegation only). If a subagent discovers it needs sub-subagents, it reports back so you can plan another pass.
