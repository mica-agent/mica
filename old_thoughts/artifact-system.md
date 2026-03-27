# Archived from SPEC.md — 2026-03-27. Reference material, not current spec.

## Artifact System

### Artifacts as Shared Context

Every artifact in Mica is simultaneously:

- **An output** of some process (human creation or AI generation)
- **An input** to other processes (context for AI work, reference for human decisions)
- **Shared context** between human and AI team

Artifacts flow in three directions:

- **Down** — informs lower layers (wireframe → architecture → code)
- **Up** — informs higher layers (technical constraint → revised experience → revised mission)
- **Across** — informs sibling artifacts at the same layer (one wireframe shapes the next, one API contract informs adjacent services)

### Within-Layer Generative Loops

Artifacts at each layer are not static. They participate in **generative loops** where each artifact builds on previous artifacts to produce the next:

```
rough sketch → wireframe → mockup → interaction spec → prototype
     ↑                                                      |
     └──────────────── feedback/refinement ←────────────────┘
```

The system actively uses what exists at a layer to produce what's next. When the human creates or modifies an artifact, the system considers all sibling artifacts as context for its response.

### Cross-Layer Traceability

Every artifact maintains links to related artifacts at other layers. These links are:

- **Automatic** — the system creates them as artifacts are produced
- **Visible on demand** — the user can see what informs/depends on any artifact
- **Actionable** — when an artifact changes, the system identifies which linked artifacts may need to adapt

Example: A wireframe at the Experience layer links to:
- The persona and user story that motivated it (Mission layer context)
- The API contracts it implies (Architecture layer output)
- The UI components that implement it (Implementation layer output)
- Sibling wireframes that share interaction patterns (same-layer context)

### Native Rendering

Artifacts render in their native medium on the canvas. A wireframe is displayed as a wireframe, not as a card with a link to a wireframe. A system diagram is a diagram. Code is code. The canvas adapts its rendering to the artifact type, and each layer's canvas is optimized for its native artifact types.
