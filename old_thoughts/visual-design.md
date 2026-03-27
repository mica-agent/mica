# Archived from SPEC.md — 2026-03-27. Reference material, not current spec.

## Visual Design Principles

### Dark Theme

Mica uses a dark theme as its primary palette. Dark backgrounds reduce visual fatigue during extended work sessions and make colored signals, health indicators, and artifact content stand out.

### Layer Color Identity

Each layer has a subtle color identity that reinforces spatial orientation:

| Layer | Color Family | Rationale |
|-------|-------------|-----------|
| Portfolio | Neutral/silver | Overview, no single project identity |
| Mission | Deep blue | Strategy, depth, trust |
| Experience | Warm tones (amber/coral) | Human, emotional, user-facing |
| Architecture | Cool green/teal | Technical, structural, systematic |
| Implementation | Purple/violet | Execution, energy, activity |

These colors appear as subtle background gradients, border accents, and breadcrumb highlights — not as overwhelming theme changes.

### Typography

- Primary: SF Pro Display (system font, optimized for Apple devices)
- Artifact content renders in the appropriate format (monospace for code, proportional for prose, etc.)
- Layer titles and navigation use consistent typographic hierarchy

### Glassmorphic UI Elements

Toolbar, breadcrumbs, and overlay controls use translucent/glassmorphic styling — present but not occluding the canvas. The canvas content is always the primary visual element.

### Animation Principles

- All layer transitions animate (200-300ms) to maintain spatial memory
- Artifacts entering or leaving the canvas fade and scale, never pop
- Ambient signals animate slowly and continuously (breathing, pulsing) — never abruptly
- Escalation aging (yellow → orange → red) is gradual, over minutes/hours, not seconds
- 120fps target for all gesture-driven animation — any latency breaks direct manipulation
