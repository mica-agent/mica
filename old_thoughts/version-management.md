# Archived from SPEC.md — 2026-03-27. Reference material, not current spec.

## Version Management

### Design Principle

GitHub is the **source of truth** for all project state — every layer, every artifact. The complete state of a Mica project must be reproducible from a repository clone.

Versioning should feel **natural to the medium at each layer** — not like a foreign "save/commit" workflow imposed on creative work.

### Layer-Native Versioning Affordances

Each layer has a versioning metaphor that matches how people naturally checkpoint that type of work:

| Layer | Metaphor | Affordance | What It Feels Like |
|-------|----------|------------|-------------------|
| **Mission** | **Snapshot** | Stamp a date on the brief. "We've aligned on this." | Like writing a date on a whiteboard and taking a photo. |
| **Experience** | **Pin** | Pin a version of a design to the wall. Previous versions recede but remain accessible. | Like pinning a printout to a corkboard. |
| **Architecture** | **Baseline** | Sign off on a blueprint. Creates a reference point that implementation builds against. | Like signing off on architectural drawings before construction begins. |
| **Implementation** | **Commit / Branch / PR** | Standard git workflow. Already solved — Mica surfaces it natively. | Familiar to anyone who has worked with code. |

The user never thinks in terms of git mechanics at the upper layers. They think:
- "Is this worth remembering?" → snapshot/pin/baseline
- "What did we decide last week?" → browse history
- "What changed since we baselined?" → see drift

### Repository Structure

All Mica artifacts are serialized and stored in the repository:

```
project-repo/
├── .mica/
│   ├── mission/          # Mission layer artifacts
│   ├── experience/       # Experience layer artifacts
│   ├── architecture/     # Architecture layer artifacts
│   ├── canvas-state.json # Spatial positions, layer configuration
│   └── history/          # Checkpoint metadata and descriptions
├── src/                  # Implementation layer — standard code
├── tests/
└── ...
```

### The System's Role in Versioning

The system makes versioning **effortless and timely**:

- **Suggests checkpoints** — "You've made significant changes since your last pin. Want to capture this?"
- **Auto-describes** — generates meaningful description of what changed
- **Surfaces drift** — "The architecture baseline was set 3 days ago, but 4 experience artifacts have changed since."
- **Coordinates cross-layer consistency** — flags when a checkpoint creates inconsistency

### Diff at Every Layer

| Layer | Diff Visualization |
|-------|-------------------|
| **Mission** | Narrative diff — what language shifted, which constraints changed |
| **Experience** | Visual diff — overlay comparison of wireframes, side-by-side mockup versions |
| **Architecture** | Structural diff — what components/connections changed, new/removed dependencies |
| **Implementation** | Code diff — standard git diff with context linking back to architecture and experience |

### Under the Hood

Translation to git happens invisibly at the upper layers:

- A **snapshot** (Mission) = a git commit of `.mica/mission/` with an auto-generated message
- A **pin** (Experience) = a git commit of `.mica/experience/` with the pinned artifacts tagged
- A **baseline** (Architecture) = a git commit of `.mica/architecture/` plus a git tag
- **Implementation** commits are standard git commits

### Branching and Exploration

For exploratory work — "what if we took a completely different architecture approach?" — the system can create a branch under the hood. The user experiences this as a **parallel canvas**:

- "Let me try something" → system creates a branch, canvas enters exploration mode
- "I like this direction" → system merges the branch
- "Never mind" → system discards the branch, canvas reverts cleanly
