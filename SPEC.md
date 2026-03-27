# Mica Specification

## 1. Product Definition

### 1.1 What Mica Is

Mica is an extensible environment for building products with AI. It connects to your existing projects — git repos that work fine on their own — and provides a canvas where humans and AI agents collaborate to conceive, design, build, and ship.

Mica is not an IDE, not a project manager, not a whiteboard. It is a **canvas runtime** — an extensible surface that can represent any visualization of your work, composed from a single universal primitive: the **card**.

Think of it like Emacs: a highly extensible, recursive environment where the fundamental unit (buffer/card) can represent anything, and new capabilities are added by defining new types of that unit. The canvas itself is a card. A dashboard is a card. A chat panel, a code editor, a system diagram — all cards.

### 1.2 The Primary User

A product-builder who can hold an entire product vision — customer need, UX, architecture, tradeoffs — and has enough technical fluency to direct an AI team through implementation. Think the best startup product CEOs: strategic thinkers who can go deep when needed.

This person may be a solo operator or part of a very small human team. They do not need to write code, but they understand what code does.

### 1.3 The AI Team

The AI team is Mica's execution layer. Agents operate on your project through the canvas — reading project files, writing code, generating artifacts, surfacing decisions. Each agent has a brief that defines its personality and scope, and tools that let it act on the project.

The structure of the AI team is an implementation detail — Mica's UX must work whether the AI side is one agent or fifty. What matters is that agents are active participants, not passive tools waiting for commands.

### 1.4 The Relationship

The human-AI relationship in Mica is **ongoing and dynamic** — from first idea through live deployment and iteration. It is not a handoff model. It is continuous collaboration where both sides contribute, reference each other's work, and build on shared context.

### 1.5 Projects Are Sovereign

Mica does not own your projects. Projects are independent git repos that exist on their own. Mica **connects** to them and adds value through a `.mica/` directory — like `.vscode/` or `.github/`. Remove `.mica/` and the project is untouched.

A **workspace** is simply a collection of connected projects. Projects can join and leave freely. There is no lock-in.

---

## 2. The Card Model

### 2.1 Everything Is a Card

The card is Mica's universal primitive. Every piece of content, every tool, every view is a card. A brief is a card. A chat panel is a card. A system diagram is a card. **The canvas itself is a card** — one that renders other cards inside it.

This is the core architectural insight: there is one abstraction, and it composes recursively.

### 2.2 Card Classes

A **card class** defines a type of card — how it renders, what it contains, how it serializes. Card classes are the extensibility mechanism, like Emacs packages or browser extensions. Want a new visualization? Write a card class. Want a new workflow? Compose card classes.

The base card interface:

| Property | Purpose |
|----------|---------|
| `render()` | How this card appears on screen |
| `children?` | What cards it contains (if any — makes it a canvas) |
| `accepts?` | What card types can be dropped into it |
| `serialize()` | How this card persists its state |
| `deserialize()` | How this card restores from persisted state |

A **simple card** (brief, chat, goal) has no children — it renders content. A **canvas card** (layer view, dashboard, portfolio) has children and layout logic — it renders other cards. Both are cards. The distinction is whether `children` is defined.

### 2.3 Recursive Composition

Cards nest. A project dashboard is a card containing cards. A "layer view" is a card that arranges sub-cards by semantic level. A split-view comparing two architectures is a card containing two canvas-cards side by side.

Navigation is entering and leaving nested cards. "Zooming in" on a canvas-card means entering it and seeing its children. There is no separate navigation system — it falls out naturally from the card tree.

### 2.4 Three Persistence Tiers

Cards need to live somewhere. Where a card persists depends on its scope:

| Tier | Location | What lives here |
|------|----------|----------------|
| **Project** | `.mica/` inside the project repo | Briefs, goals, layer views, agent chat, project-specific card classes. Committed to git — team members share this context. |
| **Workspace** | `workspaces.json` + Mica's own directory | The portfolio card (shows all connected projects), workspace-level layout, cross-project views. Local to this Mica instance. |
| **User** | `~/.mica/` or equivalent | Preferences, custom card classes shared across workspaces, personal bookmarks. |

The portfolio/multi-project card spans projects — it can't live inside any single project's `.mica/`. It's workspace-scoped. Its children are project cards, each backed by that project's `.mica/` state.

### 2.5 Default Card Compositions

Mica ships with default compositions that provide immediate value:

- **Layer views** (mission, experience, architecture, implementation) — canvas-cards that organize project work by abstraction level
- **Portfolio view** — a workspace-scoped canvas-card showing all connected projects
- **Agent chat** — a card for conversing with layer-specific AI agents
- **File browser** — a card for navigating project source files
- **Terminal** — a card for running commands in the project's container

These are starting points. Users and agents can create, rearrange, and extend card compositions freely.

---

## 3. Human-AI Collaboration

### 3.1 The System as Active Participant

Mica's AI is not a passive tool waiting for commands. It is an **active collaborator** that:

- **Proposes** — "Based on your mission, here are three experience flows worth considering"
- **Challenges** — "This architecture decision conflicts with your local-first constraint"
- **Generates** — produces cards from human input (sketches → wireframes, descriptions → diagrams)
- **Interprets** — structures unstructured human expression into formal artifacts
- **Maintains context** — uses all cards across the project as working memory
- **Asks** — surfaces questions at the right level in the right medium

### 3.2 Modality Matching

The system communicates in whatever modality maximizes mutual comprehension:

- If the human is talking, the system **listens, then writes it down** as structured cards
- If the system needs to explain a tradeoff, it **draws a diagram and talks through it**
- If there's a quick yes/no decision, it presents **a tap target, not a conversation**
- If the human is sketching, the system **watches and offers a refined interpretation**

The system should also **suggest** input modes based on context. There is no fixed mapping of modality to task. The principle is pragmatic: **use whatever is fastest for shared understanding in the current moment.**

### 3.3 Multi-Modal Input

The human communicates through whatever input is natural in the moment:

| Input | Strengths | Example Use |
|-------|-----------|-------------|
| **Voice** | Expressing intent, vision, feelings, rapid ideation | "I want onboarding to feel like a conversation, not a form" |
| **Stylus** | Spatial thinking, sketching layouts, annotating | Rough wireframe sketch, marking up a mockup |
| **Keyboard** | Precision — naming, specs, structured data, commands | API endpoint names, constraint definitions |
| **Touch/gesture** | Navigation, arrangement, approval/rejection | Tap to approve, swipe to dismiss |
| **Mouse/trackpad** | Precision pointing, desktop workflows | Architecture diagram editing, implementation review |

All input modes are available at all times. The system accepts and integrates them fluidly — a user might voice a description, sketch a layout, type a label, and tap to approve, all in one interaction sequence.

---

## 4. Signal System

### 4.1 Two-Tier Attention Model

Mica uses two distinct signal types to communicate project state:

#### Ambient Signals

Ambient signals are **spatial and visual** — the human's peripheral awareness. Always present, never demanding. The human reads them with intuition and decides whether to engage.

Examples:
- **Disproportionate activity** — a region grows visually denser when the AI team has been working there too long
- **Circular activity** — overlapping traces show the AI team revisiting the same area repeatedly (stuck/thrashing)
- **Orphaned cards** — cards not connected to anything, visually drifting
- **Confidence degradation** — areas where AI certainty is dropping, shown as visual softening

In the card model, ambient signals are **card properties** — any card can surface health, activity level, or attention indicators through its rendering.

#### Explicit Escalations

Explicit escalations are **direct and actionable**. The system has identified something that requires human attention:

- **Decision needed** — "This approach requires choosing between A and B. Here are the tradeoffs."
- **Conflict detected** — "Your privacy constraint conflicts with the proposed API design."
- **Blocked** — "I can't proceed on X until Y is resolved."
- **Uncertainty** — "I'm not confident in this approach and want your input."
- **Risk** — "This change affects a critical path. I want you to review before I proceed."

**Escalation behavior:**
- Prioritized by impact and urgency
- Age visually (yellow → orange → red) so the human sees what's been waiting
- Include full context — not just the question, but relevant cards, options considered, and a recommendation
- Downstream work visually stacks up behind a blocker, making the cost of delay visible

### 4.2 Signal Aggregation

Signals aggregate naturally through the card tree. A canvas-card's health reflects the health of its children. Zooming out (ascending to a parent canvas-card) shows aggregated project health. Zooming in shows individual card-level signals.

---

## 5. Dogfooding

Mica's own development is the standing test case. The product must be able to represent:

- **Mission:** "Be the extensible canvas runtime for human-AI product building"
- **Experience:** The UX specification — card compositions for navigation, collaboration, signals
- **Architecture:** Card model, React component hierarchy, server infrastructure, `.mica/` structure
- **Implementation:** The actual codebase, tests, deployment

If Mica cannot represent its own product development lifecycle, it is not general enough.

---

## Archived Material

Detailed UX specifications (multi-surface architecture, platform-specific interaction bindings, visual design principles, layer-specific artifact types, working style templates, version management mechanics) have been moved to `old_thoughts/` for reference. These represent valuable earlier thinking that informed the current direction but are not part of the active specification.
