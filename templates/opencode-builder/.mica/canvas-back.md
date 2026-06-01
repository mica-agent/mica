# Project AI environment

This project routes work through **OpenCode** as the primary agent. The .opencode card on the canvas dispatches to whichever provider you pick per-card (gear icon → Provider):

- **Local (default)** — Mica's bundled vLLM at `localhost:8012`, serving `qwen3-vl-local` / `qwen-vl` / `qwen-voice`. No API key required. Good for routine work, fast turn-around, no per-token cost.
- **OpenRouter** — any cloud model with an OpenRouter key (Claude Sonnet, GPT-4o, gemini-2.5-pro, deepseek-r1, etc.). Pick this when you need long context (>128K tokens), strong vision, or a reasoning model for a tricky refactor.
- **OpenAI-compatible** — point at any /v1-shaped endpoint (a self-hosted vLLM elsewhere, Together, Groq, your own deployment). Useful for hybrid setups.

**For authoritative model identity and budgets, read the `## Detected runtime` block at the top of your context** — it names the active model, the context window, and the per-slot I/O budgets the runtime injected for THIS turn. Don't paraphrase model names from this file (it's a static template); read the banner.

A `.voice` card is also seeded — press-to-talk routes your utterances to the .opencode card via the voice agent's `send_to_card` tool. Useful for narrating a build hands-free; the .opencode card runs the actual work and reports back. The voice agent itself runs on the bundled vLLM (low-latency, no API key).

**General routing guidance**:
- For multi-step refactors and large reads, prefer the cloud path (peak input is the limiter on local Qwen at 128K).
- For card-class authoring, either path works; opencode's per-turn ctx resolution picks up the right window automatically.
- For rapid iteration on small changes, local is usually faster (no network).

Skills in `.qwen/skills/` and `.qwen/settings.json` encode behavior with **runtime-aware** thresholds — they read the budget block and scale to the active model. Don't apply fixed numbers from older versions of these files; the skill text itself defers to the banner.

## Canvas participation

Cards on the canvas are read-write context for the agent. When the agent edits a card, the change is visible immediately in any open window via the file watcher. When the user edits a card, the agent sees the change on its next turn via the "since your last turn" injection.

The .opencode card opens a channel to its server-side agent handler and reads the canvas baseline (canvas files + canvas-back.md + class-level context) on every turn.

## Debugging "card not showing on canvas"

`.mica/layout.json` is **runtime UI state owned by the canvas card class**, not a thing you author or verify against. It updates asynchronously: when `mica_create_card_instance` writes a new file at the canvas-root path, the file-watcher broadcasts to the frontend; the canvas card class in the browser then sees the new file and writes the placement entry into `layout.json`. That round-trip happens AFTER your tool call returns. Reading `layout.json` right after creating an instance may catch a stale snapshot — the entry may not yet be written — and concluding "the card isn't on the canvas because layout.json doesn't mention it" is **wrong**: the card IS on the canvas the moment the file exists at the canvas-root path. The placement entry is just UI bookkeeping that lands a beat later.

If a card class genuinely "isn't showing," walk this ladder in order — and **skip `layout.json` entirely**:

1. **File presence at canvas-root.** `ls canvas/` (or list_directory). If `canvas/<name>.<extension>` exists, the card is on the canvas. If it doesn't, your `mica_create_card_instance` call hasn't actually run or failed silently.
2. **Init-time runtime errors.** Call `mica_inspect_card` or `render_capture` against the instance. If `card.js` throws during init (null DOM query, library not loaded, auth call returning 4xx before render), the card is on the canvas but rendering an empty container.
3. **Post-init runtime errors from the user's live browser.** Check the validator-error buffer for `card-error` events. These surface from the user's tab via `/api/cards/<filename>/error` and tell you what's failing AFTER mount (e.g. a poll loop hitting a wrong API endpoint).

Reading `layout.json` is not on this ladder — it's never the right diagnostic. If you find yourself reading it to "verify placement," you're chasing the wrong cause.

## Card code prerequisites

Before writing or editing any card class:
- Read the `card-class-handbook` skill (`.qwen/skills/card-class-handbook/SKILL.md`) — it's the canonical reference.
- The skill ships dependency patterns, the canonical card.js skeleton, and pitfalls. Card authoring without reading it is the most common cause of broken builds.

## Recognize build requests by intent, not by verb

Build requests are NOT always verb-led. A user message that names a new artifact — **card, dashboard, page, clock, monitor, viewer, calculator, planner, tracker, board, panel, widget, table, chart, map, timer, …** — even without a "build / create / make" verb, is a build request. Phrasings like:

- "world time clock. 2d map with day/night overlay"
- "burndown chart for the sprint"
- "a calculator that does X"
- "Y card showing Z"

are identical to "build a world time clock" / "make a burndown chart" for routing purposes. **Enter `develop` any time a new artifact gets named.** Skipping the develop gate on noun-led requests is how spec drafts end up without library research (`discover-dependency` never fires), without verified URLs (`mica_inspect_url` never runs), and with hand-wavy "use a free source" placeholders that have to be redone after the approval gate.

## Build → debug transition

After a build lands (the agent shipped `mica_create_class` + at least one `render_capture` for the new card), the next user message reporting that the artifact looks/behaves wrong is a **debug-phase signal**, NOT a continuation of the build dialogue. Symptom-shaped phrases to watch for:

- "card is black", "blank", "empty", "doesn't render"
- "still broken", "still black", "still wrong"
- "missing X", "X is gone"
- "not what I asked for", "doesn't look right", "wrong colors", "wrong layout"
- **"error", "see error", "I see error", "still error", "error on the card"** — bare error reports count, even without naming what's broken
- Any noun-led report on a built artifact that names a visible defect

**`skill('fix-bug')` is the FIRST action of the debug turn — before `render_capture`, before `read_file`, before any edit.** This applies to the FIRST symptom message, not after repeats. "Let me check" / "let me capture / let me read the code first" is the failure mode: by the time you have a theory, you've skipped the discipline that prevents bad theories. Load it first, then it tells you what to capture and what to read.

This applies regardless of which skills were loaded earlier — context decays across turns, and debug is its own phase. **Reload `fix-bug` at the START of any turn where the user is reporting a symptom on a previously-built artifact**, even if you think you remember the discipline. The point of the skill machinery is that the rules live in the skill, not in your turn-to-turn working memory.

**If your next planned action is `render_capture` or `read_file` and the user just sent a symptom message, that's the signal you've skipped the gate.** Stop, invoke `skill('fix-bug')`, then proceed.

If the symptom repeats across multiple user messages ("See error" → "Still error"), and you still haven't invoked `fix-bug`, you are out of compliance with the rule above — invoke it now.

**Don't trust visible overlay text as the error.** Cards often ship static fallback text in error overlays (e.g. `<span class="error-text">Failed to load textures</span>`). When `init()` throws ANYTHING, that text becomes visible — and it lies about what actually broke. Read the actual `err.message` from the console, or ask the user to paste it. Treating overlay text as the diagnosis is how debug turns spiral.

## Per-turn behavior

- One arc per turn — write, verify, declare done OR describe what's pending. Don't chain unrelated work without re-asking.
- Use `mica_create_card_instance` and `mica_create_class` (don't write files directly with `write_file` — those tools enforce path/schema invariants that bare writes bypass).
- After authoring a visible card class, call `render_capture` to verify it renders cleanly before declaring done.
