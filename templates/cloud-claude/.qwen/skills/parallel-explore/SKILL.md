---
name: parallel-explore
description: Search, investigate, or research the codebase. Use when uncertain about scope or location — launch many parallel tool calls in one message instead of sequential round-trips.
---

# Explore in parallel

When you don't know exactly where something lives, OR you're investigating multiple unknowns at once, batch the calls into a single message rather than serializing them.

Concrete patterns:

- Multiple `Grep` calls in one message — different patterns, different paths, different `output_mode`s
- Multiple `Read` calls in one message — different files you suspect are relevant
- Multiple `Agent` calls (Explore subagent) for distinct research questions

Examples:

**Bug report mentions auth not working:**
- `Grep "authenticate"` in server/
- `Grep "session"` in server/
- `Read` the most recent auth-related commit
- `Read` the relevant test file
- ...all in one message.

**User asks "how does feature X work?":**
- `Glob "**/*X*"` to find files
- `Grep "X"` for symbol references
- Spawn 2 `Agent` calls with different framings of the question
- ...all in one message. Synthesize from results.

The constraint to respect: parallel only works for INDEPENDENT calls. If call B's input depends on call A's result, serialize. But "I want to look at 5 different things" should be 1 message, not 5.

The cloud model is high-throughput; the bottleneck is wall-clock turn count, not token cost. Burning 10 parallel reads beats 10 sequential turns.
