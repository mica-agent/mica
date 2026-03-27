# Archived from SPEC.md — 2026-03-27. Reference material, not current spec.

## Interaction Model

Mica defines interactions as **semantic operations** — what the user intends to do — independent of the physical gesture or input that triggers them. Each operation then has platform-specific bindings.

### Semantic Operations

#### Navigation Operations

| Operation | Description |
|-----------|-------------|
| **Layer Descend** | Move deeper into the layer stack (toward Implementation). Content transforms at the boundary. |
| **Layer Ascend** | Move up the layer stack (toward Portfolio/Mission). Current layer dissolves, parent layer emerges. |
| **Pan** | Move the viewport across the current layer's canvas without changing semantic level. |
| **Geometric Zoom** | Zoom in/out within the current layer for closer inspection without crossing a layer boundary. |
| **Zoom to Fit** | Frame all content at the current layer in the viewport. |
| **Sibling Navigate** | Move sequentially between artifacts at the same level (next/previous). |
| **Jump to Layer** | Navigate directly to a specific layer (via breadcrumb, voice, or bookmark). |

#### Artifact Operations

| Operation | Description |
|-----------|-------------|
| **Select** | Focus on an artifact. Shows its connections, metadata, and available actions. |
| **Open/Enter** | Enter an artifact that contains sub-content. |
| **Context Actions** | Reveal the set of actions available for a selected artifact. |
| **Artifact Carry** | Grab an artifact, navigate while holding it, and drop it in a new location. |
| **Annotate** | Add freeform marks, notes, or highlights to an artifact. |
| **Sketch** | Create new freeform visual content on the canvas. |
| **Approve/Reject** | Act on a system proposal or escalation. |

#### System Operations

| Operation | Description |
|-----------|-------------|
| **Converse** | Open-ended dialogue with the system. |
| **Command** | Direct instruction to the system. |
| **Checkpoint** | Capture the current state of the canvas for version history. |
| **Surface Switch** | Change coordination mode between connected surfaces. |

### Platform Bindings

#### Tablet (iOS/iPadOS)

| Operation | Primary Binding | Alternative |
|-----------|----------------|-------------|
| Layer Descend | Pinch spread (beyond threshold) | Double-tap artifact |
| Layer Ascend | Pinch close (beyond threshold) | Left-edge swipe |
| Pan | Two-finger drag | — |
| Geometric Zoom | Pinch spread/close (within threshold) | — |
| Zoom to Fit | Double-tap empty canvas | — |
| Sibling Navigate | Swipe left/right | — |
| Select | Tap | — |
| Open/Enter | Double-tap | — |
| Context Actions | Long press | — |
| Annotate | Pencil on artifact | — |
| Sketch | Pencil on empty canvas | — |
| Approve/Reject | Tap action target | Voice ("approve") |
| Converse | Voice (natural speech) | Keyboard text |
| Command | Voice (directive speech) | Keyboard text |
| Checkpoint | Voice ("checkpoint this") | UI button |

#### Desktop (Mouse + Keyboard)

| Operation | Primary Binding | Alternative |
|-----------|----------------|-------------|
| Layer Descend | Scroll wheel down (beyond threshold) | Double-click |
| Layer Ascend | Scroll wheel up (beyond threshold) | Backspace / Esc |
| Pan | Click + drag on canvas | Arrow keys |
| Geometric Zoom | Scroll wheel (within threshold) | Cmd +/- |
| Zoom to Fit | Cmd + 0 | Double-click empty canvas |
| Sibling Navigate | Tab / Shift+Tab | Arrow keys (when artifact selected) |
| Select | Click | — |
| Open/Enter | Double-click | Enter |
| Context Actions | Right-click | — |
| Converse | Keyboard text | Voice (if mic available) |
| Command | Keyboard command palette | Voice |
| Checkpoint | Cmd + S | — |

#### Large Display / Projection (Voice + Remote)

| Operation | Primary Binding |
|-----------|----------------|
| Layer Descend | Voice ("go deeper") / remote zoom |
| Layer Ascend | Voice ("go up") / remote back |
| Pan | Voice ("show me [area]") / remote directional |
| Jump to Layer | Voice ("show architecture") |
| Converse | Voice (primary input) |
| Command | Voice (primary input) |

#### Phone (Touch)

| Operation | Primary Binding |
|-----------|----------------|
| Layer Descend | Tap to enter |
| Layer Ascend | Back gesture |
| Approve/Reject | Tap / swipe |
| Sibling Navigate | Swipe left/right |

Phone surfaces show a simplified view focused on triage and approvals, not full canvas manipulation.

### Tactile Feedback

- **Layer boundary crossing** — a distinct haptic click when descending or ascending between layers
- **Checkpoint captured** — a confirmation haptic pulse
- **Escalation acknowledged** — a subtle feedback confirming the user's response registered
- **Artifact snapping** — light feedback when an artifact aligns to a grid or group

### Input Fluidity

All input modes are available simultaneously on surfaces that support them. A single interaction sequence might flow:

1. Voice: "I want the onboarding to feel conversational"
2. Pencil: sketches a rough three-screen flow
3. System: interprets and renders a wireframe
4. Touch: drags a wireframe to reposition it
5. Keyboard: types a precise label
6. Touch: taps "approve" on the system's interpretation
7. Voice: "Now show me how this connects to the architecture"
