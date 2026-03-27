# Archived from SPEC.md — 2026-03-27. Reference material, not current spec.

## Spatial Model

### The Layer Stack

Mica organizes product information across five semantic layers, each representing a different level of abstraction:

| Layer | Name | Purpose |
|-------|------|---------|
| 0 | **Portfolio** | All projects — health, activity, attention needed |
| 1 | **Mission** | Single project's strategic intent, constraints, customer definition |
| 2 | **Experience** | User-facing goals, UX flows, how the product feels |
| 3 | **Architecture** | System design, capabilities, technical tradeoffs |
| 4 | **Implementation** | Execution — code, tests, deployment, AI team activity |

These layers are not organizational hierarchy. They are **levels of abstraction** — like altitude on a map. The user moves between them spatially, not through menus or navigation trees.

### Semantic Zoom

Navigation between layers uses **semantic zoom**: continuous gesture (pinch/spread) with categorical content transformation at layer boundaries.

**Key principles:**

- **Content transforms, it does not scale.** Zooming from Mission to Experience does not shrink Mission cards — the Mission layer dissolves and the Experience layer emerges as the new workspace. Each layer has its own visual language and artifact types.
- **The gesture is continuous, the content is discrete.** The pinch gesture is fluid (like Maps), but content snaps to the appropriate semantic representation at threshold crossings. There is no "in between" state where two layers are half-visible.
- **Haptic feedback at boundaries.** When the user crosses a layer threshold, a subtle haptic click confirms the transition. This builds muscle memory and spatial intuition.
- **Animated transitions maintain spatial memory.** The user must always understand *where* they are and *how they got there*. Transitions animate so the brain can track the spatial relationship between layers.

### Within-Layer Navigation

Each layer is a spatial workspace, not a list or a tree. The user pans to explore, selects artifacts to focus, and uses geometric zoom for closer inspection — all without changing semantic level.

### Spatial Stability

Artifacts maintain their spatial position between visits. If the user placed a wireframe in the upper-left of the Experience canvas, it stays there. The system does not rearrange content. Spatial memory is the user's primary orientation mechanism — disrupting it destroys trust.

The system may *suggest* spatial arrangements (e.g., "these three components are related — want me to group them?") but never moves artifacts without consent.
