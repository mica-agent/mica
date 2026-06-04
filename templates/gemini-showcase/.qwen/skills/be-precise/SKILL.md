---
name: be-precise
description: Write code, edit files, or call tools. Use whenever you act on the codebase — name specific files, functions, and behaviors instead of describing them vaguely.
---

# Be precise

The local model follows specifics and drifts on vagueness. The DGX Spark has plenty of VRAM (128GB), so context is not the bottleneck — but prompt-processing time scales with how much you load and the model's wall-clock throughput is finite. Be specific and lean, not exhaustive.

## In tool calls

- Name files by exact path: `server/plugins/llmChat.ts`, not "the chat plugin file."
- When uncertain whether a file exists, run `Glob` or `Read` first. Don't write code that imports from a guessed path.
- Use `Grep` with `output_mode: "content"` and `-C 5` instead of `Read` when you only need to see the lines around a match. You'll spend less time re-reading.
- Use `Read` with `offset`/`limit` when you only need a section of a long file. Reading 800 lines to use 30 wastes the model's working pass.

## In code you write

- Use exact identifier names from the codebase. If a function is `createLlmChatHandler`, don't introduce variants like `chatHandlerFactory`.
- Match existing patterns in the file/module you're editing. Don't import a new style mid-file.
- Don't add abstractions, helpers, or wrappers the task did not request. Three similar lines beats a premature abstraction.

## In responses to the user

- State what you did with file paths and line numbers, not summaries.
- If you can't verify something, say so. Don't fill the gap with confident-sounding claims.

The model is fast at being literal and slow at being creative. Lean into the literal.
