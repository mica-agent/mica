---
name: deep-research
description: Understand, analyze, or change existing code. Use when asked to modify or extend something — read the full surrounding context first, not just the lines being changed.
---

# Read full files before editing

Before changing code:

1. **Read the entire file you're about to edit** — no `offset`/`limit`. The model has 200K+ context; a 1500-line file is fine.
2. **Find the call sites** — `Grep` for the function/symbol you're changing across the project. Read each caller.
3. **Read related test/spec files** if present.
4. **Write a brief grounding** (3–5 sentences) of what the code does, who calls it, what would break if you got the change wrong. Put it in your response so the user can verify your model is correct.
5. **Then propose the change.**

Skipping this step is the #1 source of regressions on cloud models. The local-dev convention of "read in 150-line chunks" exists because of finite local context — that constraint does NOT apply here. Use the budget.

For genuinely large files (5000+ lines, e.g., bundled JS), use targeted reads + `Grep` instead — but for the typical TypeScript/Markdown/config file in this project, read it whole.
