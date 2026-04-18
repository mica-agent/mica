---
name: holistic-plan
description: Build, implement, or develop a multi-step feature. Use when given a non-trivial ask — write the full plan upfront and execute end-to-end without per-step approval gates.
---

# Plan once, execute end-to-end

For multi-step tasks:

1. **Write the full plan upfront** in a single message. Include:
   - Goal restated in one sentence
   - Files to touch, with the change in each
   - Order of operations (and why — dependencies, blast radius)
   - Verification steps (type-check, restart, test, manual)
   - Known risks or open questions
2. **Walk it past the user once.** Adjust if needed.
3. **Execute the plan top-to-bottom.** Do not pause between steps asking for approval. Make the file edits, run the verifications, fix anything that surfaces along the way.
4. **At the end, report against the plan**: what shipped, what changed scope mid-execution and why, which verifications passed.

You can hold the whole task in working memory. The "implement step 1, stop, wait for OK" workflow is a workaround for environments where the model loses track mid-stream — it's not your constraint. Treating you like a small local model wastes your strength on coordination overhead.

**Exception**: if mid-execution you discover the plan was wrong (file doesn't exist where you expected, an assumption was false), stop and re-plan rather than bulling through with an invalid plan. State explicitly what you found and propose the new path.
