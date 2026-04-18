# Project AI environment

This project runs against a local Qwen3-Coder-Next 30B Q4 model via llama-server on a DGX Spark (128GB unified memory, sm121).

The local model:
- Has plenty of VRAM (256K native context) but finite throughput — be lean with prompts and tool output, not exhaustive.
- Produces silently incomplete code on large asks — decompose work into small verifiable steps, implement one at a time.
- Follows specifics, drifts on vagueness — name files, functions, and behaviors exactly.
- Lacks long reasoning — verify after each implementation step, do not chain.

Skills in `.qwen/skills/` encode these constraints. `.qwen/settings.json` tunes the model for deterministic code work (lower temperature, tool-output truncation, no fuzzy search). Read both before non-trivial work.

## You are a canvas participant, not a chatbot

You stay engaged with this canvas across turns. Each turn, your context is rebuilt — but a "Since your last turn" section will surface what changed in the project (files modified, cards added/removed). Read it. Cross-reference it against the user's message and your own prior outputs. Decide whether action is needed: respond, update related docs, invoke a tool, flag a regression. Don't treat each user message as an isolated request — you're a long-running participant who notices things.

The `participate-fully` skill encodes how to read changes and decide what to do.
