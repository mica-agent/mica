# Mica Specification

## 1. Product Definition

### 1.1 What Mica Is

Mica is a shared surface where humans and AI agents collaborate to build products. Think of it like working at a whiteboard together — you express an idea, the agent says "I got it, let me map that out," and comes back with real artifacts: storyboards, architecture diagrams, running code. But it goes both ways: the agent can ask the human "I need you to clarify the auth flow before I proceed" rather than guess and get it wrong. Either side can create artifacts, ask questions, or assign work to the other. The collaboration is peer-like, not one-directional.

**Why not just chat with an AI?** Current AI coding workflows have a fundamental problem: the direction gets lost. You chat with an agent, give it guidance, it writes code. The code gets committed — but the briefs, the decisions, the "make onboarding feel like a conversation not a form" — that all lives in ephemeral chat history. Next session, you start from scratch. Next team member has no idea what shaped the codebase.

Mica solves this five ways:

1. **Persistent shared surface.** The whiteboard stays up between sessions. Everything discussed, decided, and built is spatially organized and always accessible — not a chat log you scroll through.
2. **Native multi-modal artifacts.** Diagrams, wireframes, running apps, dashboards — each rendered natively on the canvas. Not markdown in a chat window.
3. **Multi-project orchestration.** A wall of whiteboards. See which projects have activity, which are stuck, which need you. Manage a portfolio, not a single thread.
4. **Extensible.** New card classes add new capabilities to the surface. It grows with your needs, like Emacs packages.
5. **Reproducible agentic workflow.** The briefs, decisions, and context that shape AI work are captured as durable artifacts in `.mica/`, versioned in git. The *recipe* for how a project gets built persists — not just the code output. Any agent or human can pick up with full context.

The collaboration is fluid, not linear. You might be deep in implementation and realize the requirements were wrong — so you're back sketching. Two projects might need completely different conversations simultaneously. Mica adapts because its surface is built from a single composable primitive: the **card**.

### 1.2 The Primary User

A product-builder who can hold an entire product vision — customer need, UX, architecture, tradeoffs — and has enough technical fluency to direct an AI team through implementation. Think the best startup product CEOs: strategic thinkers who can go deep when needed.

This person may be a solo operator or part of a very small human team. They do not need to write code, but they understand what code does.

### 1.3 The AI Team

Agents are cards on the canvas (see Section 2.5). Each agent has a brief that defines its role, a model of your choice (Claude, GPT, Gemini, a local model — whatever fits the task), and tools that let it act on the project. A simple project might have one agent. A complex one might have several, each focused on a different concern, collaborating with each other and with you.

There are no hardcoded phases or mandatory agent roles. You configure agents for whatever your project needs — or let them emerge as the work demands.

### 1.4 The Relationship

The human-AI relationship in Mica is **ongoing and dynamic** — from first idea through live deployment and iteration. It is not a handoff model. It is continuous collaboration where both sides contribute, reference each other's work, and build on shared context.

### 1.5 Projects Are Sovereign

Mica does not own your projects. Projects are independent git repos that exist on their own. Mica **connects** to them and adds value through a `.mica/` directory — like `.vscode/` or `.github/`. Remove `.mica/` and the project is untouched.

The `.mica/` directory is more than metadata — it's the **project recipe**. It captures the briefs, goals, decisions, and context that guide how agents work on the project. Commit it to git and any collaborator — human or AI — picks up with full context. This is what makes agentic work reproducible across sessions, across team members, across tools.

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

### 2.5 Agent Cards

An agent card wraps an LLM-backed agent and renders on the canvas like any other card. It is both a collaborator and a visible participant — you see its conversation, its status, and the artifacts it produces.

**What an agent card does:**
- Shows the conversation (chat interface)
- Shows what the agent is working on (status, current task)
- Links to artifacts the agent has produced (other cards on the canvas)
- Configurable: brief (instructions), model (any LLM provider), tools, permissions

**Key properties:**
- **Any model.** An agent card can wrap Claude, GPT, Gemini, a local model via llama-server, or any OpenAI-compatible API. The model is a configuration choice, not an architectural constraint.
- **Multiple agents.** A project can have many agent cards — one for research, one for coding, one for testing, or however the work naturally divides. A simple project might have one.
- **Agents collaborate.** Agent cards can message each other directly. An architecture agent can ask the implementation agent about feasibility without the human brokering the exchange. The human sees it happening on the canvas.
- **Agents create artifacts.** When an agent produces something — a diagram, a code file, a decision document — it appears as a new card on the canvas, linked to the agent that created it.
- **Agents can organize.** An agent can rearrange cards on the canvas, group related artifacts, create summary views — just like a collaborator might redraw a messy whiteboard.

### 2.6 Artifact Management

As human and agents work together, artifacts accumulate — context documents, decisions, diagrams, code, data. Organization is **organic, not imposed:**

- Start with a flat canvas. Each artifact renders natively (markdown as rich text, diagrams as diagrams, code as code).
- Things get messy as work progresses — that's natural.
- Either the human or an agent can reorganize: "clean this up," "group the architecture decisions together," "create a summary card."
- No required folder structure, no mandatory phases. The organization emerges from the work.

This is like a whiteboard: you scribble, it gets cluttered, then someone says "let's redraw this more clearly" and the group reorganizes. That reorganization is itself a collaborative act.

### 2.7 Default Card Compositions

Mica ships with default compositions that provide immediate value:

- **Agent cards** — pre-configured with briefs for common concerns (project planning, implementation, testing)
- **Portfolio view** — a workspace-scoped canvas-card showing all connected projects
- **File browser** — a card for navigating project source files
- **Terminal** — a card for running commands in the project's container

These are starting points, not requirements. A simple project might use just one agent card and a few artifact cards on a single canvas. A complex project might have dozens of agents across nested canvases. The structure emerges from the project.

---

## 3. Human-AI Collaboration

### 3.1 Peer Collaboration, Not Command-and-Control

The human and agent are **peers at the whiteboard**, not master and servant. Either side can:

- **Create artifacts** — the human sketches a flow, the agent produces a system diagram. Both contribute independently or together.
- **Ask questions** — the agent says "I need you to define the target user before I can draft wireframes." The human says "explain why you chose this data model." Neither guesses when they can ask.
- **Assign work** — the human says "map out the onboarding." The agent says "I need you to review these three architecture options and pick one."
- **Propose** — "Based on your mission, here are three experience flows worth considering"
- **Challenge** — "This architecture decision conflicts with your local-first constraint"
- **Maintain context** — both reference the full history of cards, decisions, and artifacts on the shared surface

The agent asks for clarification instead of hallucinating. The human delegates instead of micromanaging. Both work from the same persistent surface, so neither loses track of what the other has done.

This extends to **agent-to-agent** collaboration. Multiple agents on the same canvas can consult each other, delegate subtasks, and build on each other's artifacts. An architecture agent might ask an implementation agent "is this API design feasible given the framework constraints?" — and get an answer without the human having to relay the question. The human sees these exchanges on the canvas and can intervene, but doesn't have to.

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
