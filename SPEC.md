# Mica UX Specification v0.1

## 1. Product Definition

### 1.1 What Mica Is

Mica is the operating surface between a human product-builder and an AI team. It is the single environment where a product is conceived, designed, built, and deployed through continuous human-AI collaboration.

Mica is not a project management tool, not an IDE, not a whiteboard, and not a chat interface. It is a **spatial, multi-modal collaboration environment** where:

- The human defines what they want built and why
- The AI team understands, executes, and surfaces progress
- Decisions, risks, and tradeoffs are elevated at the right moment
- The product takes shape visually — from intent through deployed reality
- Every artifact produced becomes shared context for all participants

### 1.2 The Primary User

A product-builder who can hold an entire product vision — customer need, UX, architecture, tradeoffs — and has enough technical fluency to direct an AI team through implementation. Think the best startup product CEOs: strategic thinkers who can go deep when needed.

This person may be a solo operator or part of a very small human team. They are adept at defining a complete product for a customer, can communicate with technical systems, and can flag technical risks. They do not need to write code, but they understand what code does.

### 1.3 The AI Team

The AI team is Mica's execution layer. It may consist of one agent or many (swarms), depending on the project. The AI team:

- Receives intent and context from the human through the Mica canvas
- Executes work across all layers (research, design generation, architecture, coding, testing, deployment)
- Surfaces its work, uncertainties, and decisions back onto the canvas
- Operates continuously and in real-time

The structure of the AI team is an implementation detail — Mica's UX must work whether the AI side is one agent or fifty.

### 1.4 The Relationship

The human-AI relationship in Mica is **ongoing and dynamic** — from first idea through live deployment and iteration. It is not a handoff model. It is continuous collaboration where both sides contribute, reference each other's work, and build on shared context.

---

## 2. Spatial Model

### 2.1 The Layer Stack

Mica organizes product information across five semantic layers, each representing a different level of abstraction:

| Layer | Name | Purpose |
|-------|------|---------|
| 0 | **Portfolio** | All projects — health, activity, attention needed |
| 1 | **Mission** | Single project's strategic intent, constraints, customer definition |
| 2 | **Experience** | User-facing goals, UX flows, how the product feels |
| 3 | **Architecture** | System design, capabilities, technical tradeoffs |
| 4 | **Implementation** | Execution — code, tests, deployment, AI team activity |

These layers are not organizational hierarchy. They are **levels of abstraction** — like altitude on a map. The user moves between them spatially, not through menus or navigation trees.

### 2.2 Semantic Zoom

Navigation between layers uses **semantic zoom**: continuous gesture (pinch/spread) with categorical content transformation at layer boundaries.

**Key principles:**

- **Content transforms, it does not scale.** Zooming from Mission to Experience does not shrink Mission cards — the Mission layer dissolves and the Experience layer emerges as the new workspace. Each layer has its own visual language and artifact types.
- **The gesture is continuous, the content is discrete.** The pinch gesture is fluid (like Maps), but content snaps to the appropriate semantic representation at threshold crossings. There is no "in between" state where two layers are half-visible.
- **Haptic feedback at boundaries.** When the user crosses a layer threshold, a subtle haptic click confirms the transition. This builds muscle memory and spatial intuition.
- **Animated transitions maintain spatial memory.** The user must always understand *where* they are and *how they got there*. Transitions animate so the brain can track the spatial relationship between layers.

### 2.3 Within-Layer Navigation

Each layer is a spatial workspace, not a list or a tree. The user pans to explore, selects artifacts to focus, and uses geometric zoom for closer inspection — all without changing semantic level. See Section 9 (Interaction Model) for the full set of operations and their platform-specific bindings.

### 2.4 Spatial Stability

Artifacts maintain their spatial position between visits. If the user placed a wireframe in the upper-left of the Experience canvas, it stays there. The system does not rearrange content. Spatial memory is the user's primary orientation mechanism — disrupting it destroys trust.

The system may *suggest* spatial arrangements (e.g., "these three components are related — want me to group them?") but never moves artifacts without consent.

---

## 3. Layer Specifications

Each layer is a **creative workspace with its own production pipeline** — artifacts within a layer generate, inform, and build on each other progressively.

### 3.1 Portfolio Layer (Layer 0)

**Purpose:** Overview of all active projects. The outermost zoom level.

**Visual language:** Projects appear as distinct regions or islands on the canvas. Each region conveys project health, activity level, and attention needs at a glance — without requiring the user to enter the project.

**What the user does here:**
- Prioritize and allocate attention across projects
- Spot cross-project patterns, resource conflicts, or shared risks
- Decide which project to enter and work on

**What the system does here:**
- Surfaces health summaries for each project
- Suggests rebalancing if a project is stalled or over-indexed
- Flags cross-project dependencies or conflicts
- Shows which projects have pending escalations

**Artifacts and their generative relationships:**
- Project tiles with status glyphs
- Comparative health indicators
- Activity heatmaps across projects
- Cross-project dependency lines

**Design note:** This layer is planned for post-v1.0 but the spatial model must not preclude it. The zoom stack must naturally extend one level outward.

### 3.2 Mission Layer (Layer 1)

**Purpose:** Define the strategic intent of a single project — what is being built, for whom, and why.

**Visual language:** Narrative-forward. Rich text, hero imagery, structured statements. This layer should feel like a living brief, not a dashboard.

**What the user does here:**
- Articulate the product vision in natural language
- Define the target customer and their core problem
- Set constraints (budget, timeline, technical, regulatory)
- Establish success criteria

**What the system does here:**
- Listens to the human (voice, text, sketch) and captures structured intent from unstructured expression
- Challenges assumptions — "You said local-first, but the Gmail integration requires network access. How should we handle that?"
- Suggests missing perspectives — "You haven't defined what happens when the user has no data yet"
- Identifies analogies and prior art relevant to the mission

**Artifacts and their generative relationships:**
- Mission narrative (rough idea → structured statement → refined brief)
- Customer personas (description → detailed persona → scenario set)
- Success criteria (intuition → measurable criteria → test plan)
- Constraints (stated limits → formalized constraints → tradeoff matrix)
- Competitive/analogous landscape (research → comparison → positioning)

Each artifact builds on its predecessors and siblings. The mission narrative informs persona creation; personas inform success criteria; constraints shape all of the above. The system uses existing artifacts at this layer to generate and refine new ones.

**Collaboration mode:** Primarily conversational. Voice and text dialogue where the system captures, structures, and reflects back. The human talks through their vision; the system writes it down as structured artifacts and asks clarifying questions.

### 3.3 Experience Layer (Layer 2)

**Purpose:** Define how the product feels to the user — flows, interactions, visual design, emotional tone.

**Visual language:** Visual and spatial. Wireframes, storyboards, journey maps, and mockups live directly on the canvas — not as linked files, but as native artifacts. This layer should look and feel like a design studio.

**What the user does here:**
- Sketch rough flows and layouts (pencil input)
- Describe how interactions should feel (voice input)
- Review and annotate system-generated wireframes and mockups
- Tell user stories and walk through scenarios
- Approve, redirect, or refine proposed UX

**What the system does here:**
- Generates wireframes from verbal descriptions or rough sketches
- Produces higher-fidelity mockups from wireframes
- Proposes alternate flows and interaction patterns
- Flags UX inconsistencies across the experience
- Shows analogous patterns from other products
- Generates interaction specs from annotated mockups
- Maintains consistency across sibling artifacts

**Artifacts and their generative relationships:**
- Rough sketches → wireframes → mockups → interactive prototypes
- User stories → journey maps → storyboards
- Interaction specs (generated from wireframes and mockups)
- Voice/tone guidelines
- Edge case flows (generated from happy-path flows)

This layer has the richest **within-layer generative pipeline**. A rough pencil sketch becomes input for a wireframe; the wireframe generates a mockup; the mockup informs interaction specs; the specs feed back into refining the wireframe. Each artifact is both output and input.

**Collaboration mode:** Visual. Pencil sketching that the system interprets and refines. Side-by-side "your sketch vs. system's interpretation." The system proposes, the human annotates and redirects.

### 3.4 Architecture Layer (Layer 3)

**Purpose:** Define how the system is built — components, data flow, APIs, technical decisions, and tradeoffs.

**Visual language:** Diagrammatic. System diagrams, dependency graphs, decision trees, data models. This layer should feel like a technical war room — clear, precise, and connected.

**What the user does here:**
- Make technical tradeoff decisions (presented as clear options with consequences)
- Define system boundaries and ownership
- Approve or redirect proposed approaches
- Flag technical risks based on their experience
- Annotate diagrams with questions or concerns

**What the system does here:**
- Proposes architecture options with explicit tradeoff analysis
- Identifies technical risks and maps dependencies
- Flags conflicts between architecture decisions and Experience-layer or Mission-layer artifacts
- Generates API contracts and data models from component diagrams
- Maintains consistency between architecture and higher layers

**Artifacts and their generative relationships:**
- Component sketches → system diagrams → detailed architecture docs
- API contracts (generated from component boundaries)
- Data models (generated from experience flows + system components)
- Decision records (option A vs B vs C, with tradeoffs and recommendation)
- Dependency maps (auto-generated from component relationships)
- Risk register (identified from architecture analysis)

**Collaboration mode:** Diagrammatic. The system generates diagrams and technical proposals; the human annotates, approves, or redirects. Keyboard input for precise specs and naming. Voice for discussing tradeoffs conversationally.

### 3.5 Implementation Layer (Layer 4)

**Purpose:** Execution — where the AI team builds, tests, and deploys. The human monitors, unblocks, and reviews.

**Visual language:** Dashboard + targeted detail. Progress indicators, test results, deployment status. When the human needs to go deep, specific code diffs and logs are surfaced — but the default view is operational, not code-level.

**What the user does here:**
- Monitor progress across the implementation
- Unblock the AI team when decisions or clarifications are needed
- Review critical changes the system has flagged for human eyes
- Approve deployments and releases
- Investigate when ambient signals suggest something is off

**What the system does here:**
- Executes implementation work (coding, testing, integration)
- Surfaces progress in real-time
- Escalates blockers, uncertainties, and risky changes
- Requests targeted review on specific changes (not everything — just what needs human judgment)
- Reports test results, performance metrics, and deployment status
- Maintains traceability from code back to architecture and experience decisions

**Artifacts and their generative relationships:**
- Implementation plans → code → tests → test results
- Deployment configurations → deployment status → monitoring dashboards
- Code diffs (surfaced for review with context linking back to architecture decisions)
- Performance metrics → optimization recommendations
- Bug reports (auto-generated from test failures, linked to relevant experience flows)

**Collaboration mode:** Dashboard + targeted review. The human does not read every line of code. The system knows which changes need human eyes and presents them with full context — why this change was made, what architecture decision it implements, what experience flow it affects.

---

## 4. Artifact System

### 4.1 Artifacts as Shared Context

Every artifact in Mica is simultaneously:

- **An output** of some process (human creation or AI generation)
- **An input** to other processes (context for AI work, reference for human decisions)
- **Shared context** between human and AI team

Artifacts flow in three directions:

- **Down** — informs lower layers (wireframe → architecture → code)
- **Up** — informs higher layers (technical constraint → revised experience → revised mission)
- **Across** — informs sibling artifacts at the same layer (one wireframe shapes the next, one API contract informs adjacent services)

### 4.2 Within-Layer Generative Loops

Artifacts at each layer are not static. They participate in **generative loops** where each artifact builds on previous artifacts to produce the next:

```
rough sketch → wireframe → mockup → interaction spec → prototype
     ↑                                                      |
     └──────────────── feedback/refinement ←────────────────┘
```

The system actively uses what exists at a layer to produce what's next. When the human creates or modifies an artifact, the system considers all sibling artifacts as context for its response.

### 4.3 Cross-Layer Traceability

Every artifact maintains links to related artifacts at other layers. These links are:

- **Automatic** — the system creates them as artifacts are produced
- **Visible on demand** — the user can see what informs/depends on any artifact
- **Actionable** — when an artifact changes, the system identifies which linked artifacts may need to adapt

Example: A wireframe at the Experience layer links to:
- The persona and user story that motivated it (Mission layer context)
- The API contracts it implies (Architecture layer output)
- The UI components that implement it (Implementation layer output)
- Sibling wireframes that share interaction patterns (same-layer context)

### 4.4 Native Rendering

Artifacts render in their native medium on the canvas. A wireframe is displayed as a wireframe, not as a card with a link to a wireframe. A system diagram is a diagram. Code is code. The canvas adapts its rendering to the artifact type, and each layer's canvas is optimized for its native artifact types.

---

## 5. Human-AI Collaboration Model

### 5.1 The System as Active Participant

Mica's AI is not a passive tool waiting for commands. It is an **active collaborator** that:

- **Proposes** — "Based on your mission, here are three experience flows worth considering"
- **Challenges** — "This architecture decision conflicts with your local-first constraint"
- **Generates** — produces artifacts from human input (sketches → wireframes, descriptions → diagrams)
- **Interprets** — structures unstructured human expression into formal artifacts
- **Maintains context** — uses all artifacts across all layers as working memory
- **Asks** — surfaces questions at the right level in the right medium

### 5.2 Modality Matching

The system communicates in whatever modality maximizes mutual comprehension:

- If the human is talking, the system **listens, then writes it down** as structured artifacts
- If the system needs to explain a tradeoff, it **draws a diagram and talks through it**
- If there's a quick yes/no decision, it presents **a tap target, not a conversation**
- If the human is sketching, the system **watches and offers a refined interpretation**

The system should also **suggest** input modes based on context — when at the Experience layer, subtly surface pencil tools; when at Mission layer, invite voice conversation.

There is no fixed mapping of modality to layer. The principle is pragmatic: **use whatever is fastest for shared understanding in the current moment.**

### 5.3 Multi-Modal Input

The human communicates through whatever input is natural in the moment:

| Input | Strengths | Example Use |
|-------|-----------|-------------|
| **Voice** | Expressing intent, vision, feelings, rapid ideation | "I want onboarding to feel like a conversation, not a form" |
| **Stylus** (Apple Pencil, Surface Pen, etc.) | Spatial thinking, sketching layouts, annotating, circling problems | Rough wireframe sketch, marking up a mockup |
| **Keyboard** | Precision — naming, specs, structured data, commands | API endpoint names, constraint definitions |
| **Touch/gesture** | Navigation, arrangement, approval/rejection, triage | Semantic zoom, tap to approve, swipe to dismiss |
| **Mouse/trackpad** | Precision pointing, desktop workflows, extended sessions | Architecture diagram editing, implementation review |

All input modes are available at all times. The system accepts and integrates them fluidly — a user might voice a description, sketch a layout, type a label, and tap to approve, all in one interaction sequence.

### 5.4 Layer Goals

Each layer has an optional **goal** — a statement of what "done" looks like at that level. The goal governs both human and AI behavior: what artifacts to produce, what quality bar to meet, and when the layer's context is ready for downstream use.

**Purpose:**
- Gives the AI team a clear target for what to generate, challenge, and verify
- Gives the human a clear sense of when their input is sufficient
- Enables the system to track progress and flag gaps against the goal
- Works identically whether the layer is human-heavy or AI-heavy

**Example goals:**

| Layer | Example Goal |
|-------|-------------|
| Mission | "Define the target user, core problem, 3 constraints, and 2 measurable success criteria" |
| Experience | "Produce wireframes for all primary flows, one mockup for the hero screen, and interaction specs for navigation" |
| Architecture | "Identify all components, define API contracts between them, and resolve all open technical decisions" |
| Implementation | "All components implemented, tests passing, deployment config validated" |

**Goal behavior:**
- The system tracks artifact completeness against the goal and surfaces a **context quality indicator** — showing what's complete, what's partial, and what's missing
- When all goal criteria are met, the system signals that the layer's context is ready: "Mission context is complete — Experience layer has what it needs to begin"
- Goals can be set by the human, suggested by the system, or defined by a working style template (see Section 5.5)
- Goals are not gates — the human can descend to lower layers before a goal is met, but the system will flag what's missing and how it affects downstream work

### 5.5 Adaptive Collaboration and Working Styles

The division of labor between human and AI is not fixed. It adapts based on **project complexity, ambiguity, and the human's working style.**

#### How Adaptation Works

The system continuously assesses its own confidence at each layer:

- **High confidence** (well-understood problem, clear patterns): The system leads — generating artifacts proactively, presenting completed work for approval, advancing generative loops rapidly. The human's role is primarily curation and selection.
- **Low confidence** (novel problem, ambiguous requirements, conflicting constraints): The system defers — asking questions, presenting options, flagging uncertainties, and waiting for human direction before generating. The human's role is primarily creation and decision-making.

This is not a mode the user selects. It emerges naturally from the quality and completeness of context at each layer. A vague mission produces low system confidence everywhere below it. A precise mission with clear constraints produces high system confidence.

#### UI Indicators of Collaboration Balance

The same UI elements communicate where human attention is needed:

| Indicator | AI-Heavy (Simple Product) | Human-Heavy (Complex Product) |
|-----------|--------------------------|------------------------------|
| **Context quality** | Green across the board | Amber/red, gaps flagged |
| **System panel tone** | "Here's what I've drafted — adjust?" | "I have questions before I can proceed" |
| **Generative loop speed** | Stages advance rapidly | Lingers, needs human input at each stage |
| **Artifact placeholders** | Few — system fills them | Visible dashed-border gaps |
| **Decision cards** | Few, obvious choices | Many, genuine tradeoffs |
| **Escalation frequency** | Rare | Frequent, some rising across layers |
| **Time at layer** | Seconds to minutes | Minutes to hours |

#### Working Style Templates

The layer stack (Mission → Experience → Architecture → Implementation) is fixed structure. But **how** you work within each layer is configurable through **working style templates**:

A working style template defines, per layer:
- **Default goal** — what "done" looks like
- **Required artifact types** — what must be produced before context is "ready"
- **AI initiative level** — how proactively the system generates vs. waits
- **Quality gates** — what checks must pass before the layer signals readiness

**Built-in templates:**

| Template | Description | Who It's For |
|----------|-------------|-------------|
| **Full Stack** | Thorough at every layer. Detailed personas, comprehensive wireframes, formal architecture docs, full test coverage. | Complex products, regulated industries, teams that value documentation |
| **Rapid Prototype** | Minimal at upper layers, fast at lower. Mission = one paragraph. Experience = rough sketches only. Architecture = auto-generated. Implementation = ship fast. | MVPs, hackathons, quick experiments |
| **Design-Led** | Heavy at Mission and Experience, lighter at Architecture and Implementation. Deep persona work, extensive wireframes and mockups, but the system handles technical details. | Consumer products, UX-focused teams |
| **Engineering-Led** | Light at Mission and Experience, heavy at Architecture and Implementation. Brief product description, but detailed system design and thorough implementation review. | Infrastructure, APIs, developer tools |
| **Custom** | Human defines goals and artifact requirements per layer. | Experienced users with their own workflow |

Templates are starting points, not constraints. The human can override any template setting at any time. The system adapts regardless.

#### Template Stacks

A **template stack** is the formal data structure that defines how each layer is instantiated when a project begins. It is the single configuration object that shapes the entire working environment.

**Structure:**

```yaml
template_stack:
  name: "Full Stack"
  version: 1
  layers:
    mission:
      goal: "Complete product brief with target users, constraints, success criteria"
      artifacts: [product_brief, persona_set, constraint_map]
      ai_initiative: moderate
      quality_gates: [brief_complete, personas_validated, constraints_acknowledged]
      cues:
        - kind: question
          text: "Who is the primary user, and what pain are they feeling?"
        - kind: exercise
          text: "Write one sentence: [User] needs [capability] so they can [outcome]."
        - kind: checklist
          text: "Does the brief cover: target user, core problem, desired outcome, scope?"
    experience:
      goal: "Full UX flow with wireframes for all primary paths"
      artifacts: [user_flows, wireframes, interaction_specs]
      ai_initiative: moderate
      quality_gates: [flows_cover_personas, wireframes_reviewed, consistency_check]
      cues:
        - kind: question
          text: "Walk through what the user does from open to satisfied."
        - kind: exercise
          text: "Sketch the happy path: 3-5 steps from trigger to outcome."
        - kind: question
          text: "What should the user never have to think about?"
    architecture:
      goal: "Component architecture with dependency map and API contracts"
      artifacts: [component_diagram, api_contracts, data_model, dependency_map]
      ai_initiative: high
      quality_gates: [components_traced_to_experience, contracts_defined, no_orphans]
      cues:
        - kind: question
          text: "What's the hardest technical bet here?"
        - kind: exercise
          text: "Name the 3 critical capabilities — what happens if each fails?"
    implementation:
      goal: "Deployed, tested product matching architecture"
      artifacts: [source_code, test_suite, deployment_config]
      ai_initiative: high
      quality_gates: [tests_pass, architecture_match, deployment_verified]
      cues:
        - kind: checklist
          text: "For each component: clear input, clear output, clear success metric?"
        - kind: question
          text: "What's the smallest thing we can build to validate the riskiest assumption?"
  # Future extension points
  style: null
```

#### Facilitation Cues — Workspace Furniture

Every layer in a template stack can include **facilitation cues** — lightweight prompts that guide the human and AI through productive work. Cues are **workspace furniture**: visible on the canvas near the layer goal bar, editable by the human, but NOT artifacts. They don't participate in cross-layer context flow, don't have quality indicators, and fade when addressed or when the layer's work is complete.

Think of cues as a facilitator's note cards pinned to the meeting room wall — everyone can see them, anyone can add or remove them, but nobody files them as deliverables.

**Four cue kinds** (lightest → most structured):

| Kind | Purpose | Example |
|------|---------|---------|
| **Question** | Socratic probe to deepen thinking | "Who feels the pain most acutely?" |
| **Prompt** | Suggestion to consider | "Think about offline scenarios" |
| **Exercise** | Mini-activity that produces an artifact | "Sketch the happy path in 3-5 steps" |
| **Checklist** | Short validation list | "Does the brief cover: user, problem, outcome, scope?" |

**Example cues per layer (Full Stack template):**

**Mission:**
- question: "Who is the primary user, and what pain are they feeling right now?"
- question: "What does success look like in 6 months?"
- exercise: "Write one sentence: [User] needs [capability] so they can [outcome]."
- checklist: "Does the brief cover: target user, core problem, desired outcome, what's out of scope?"

**Experience:**
- question: "Walk me through what the user does from the moment they open the app."
- exercise: "Sketch the happy path: list 3-5 steps from trigger to satisfied user."
- question: "What should the user never have to think about?"
- prompt: "Consider the error states — what happens when things go wrong?"

**Architecture:**
- question: "What's the hardest technical bet — the thing that could break the whole plan?"
- prompt: "Where does data live, who owns it, and what happens when it's wrong?"
- exercise: "Name the 3 most critical capabilities. For each, state what happens if it fails."
- question: "Are there constraints (privacy, latency, cost) that force a specific approach?"

**Implementation:**
- question: "What's the smallest thing we can build to validate the riskiest assumption?"
- checklist: "For each component: clear input, clear output, clear success metric?"

**How the AI uses cues:**

The AI treats cues as behavioral context, not as a script to execute. Three modes:

1. **Initialization** — When entering a layer, the AI reads the layer's cues to understand what the template author considered important. This shapes the AI's conversational tone and focus.
2. **Opportunistic** — The AI surfaces relevant cues when it detects gaps. If no persona has been defined and there's a cue about identifying the primary user, the AI weaves it into conversation naturally.
3. **On-demand** — The human asks "what should I think about next?" and the AI selects from remaining unaddressed cues.

Cues are not mandatory, not blocking, and not a wizard. Different templates have different cue density — "Full Stack" might have 4-5 per layer, "Rapid Prototype" might have 1-2, "Custom" starts with none.

**Key properties:**

- **Declarative**: A template stack describes *what* each layer should produce, not *how* to produce it. The system and human figure out the "how" collaboratively.
- **Swappable**: Switching template stacks mid-project is possible — the system maps existing artifacts to the new stack's expectations and identifies gaps.
- **Composable**: Template stacks can inherit from a base and override specific layers. A "Rapid Prototype" stack overrides the "Full Stack" defaults with lighter requirements.
- **Extensible**: The same stack structure will later be augmented to include **stylistic concerns** — visual design language, color schemes, typography, component library preferences, tone of voice, and brand guidelines. These flow down through the layers just as goals do, ensuring the AI team produces work that is stylistically coherent without the human having to repeat design preferences at every layer.

**Lifecycle:**

1. **Project creation** — Human selects or defines a template stack (or accepts the default)
2. **Layer instantiation** — Each layer is set up with the stack's goals, artifact slots, AI initiative level, and quality gates
3. **In-flight adjustment** — Human can modify any layer's configuration at any time; changes are tracked as stack overrides
4. **Stack evolution** — As the project matures, the human can save their modified stack as a new named template for future projects

**The v1 prototype ships with one template stack (Full Stack) as the default, but the architecture must support swappable stacks so others can be added. The style extension point is reserved for post-v1.**

---

## 6. Signal System

### 6.1 Two-Tier Attention Model

Mica uses two distinct signal types to communicate project state to the human:

#### Tier 1: Ambient Signals

Ambient signals are **spatial and visual**. They are the human's peripheral awareness — always present, never demanding. The human reads them with intuition and decides whether to engage. The system does not interpret these for the human.

**Structural signals** (the shape of work):
- **Disproportionate activity** — a region grows visually denser or heavier when the AI team has been working in one area too long relative to others
- **Circular activity** — overlapping trace lines show the AI team revisiting the same area repeatedly, suggesting it may be stuck or thrashing
- **Orphaned artifacts** — components not connected to anything, visually drifting at the edges of the canvas
- **Imbalanced depth** — one branch of the product is deeply specified while another remains shallow

**Deviation signals** (something unexpected):
- **Unexpected dependencies** — new connection lines appearing between regions that should be independent
- **Scope drift** — a component's visual boundary expanding beyond its original footprint
- **Confidence degradation** — areas where the AI team's certainty is dropping, shown as visual softening, fog, or reduced saturation
- **Unexpected code or resources** — the AI team checking out or referencing things outside the expected scope, shown as external connection indicators

**Health signals** (overall project pulse):
- Activity level across regions (even distribution vs. concentrated)
- Velocity trends (work accelerating, decelerating, or stalled)
- Dependency density (simple and clean vs. tangled web)

#### Tier 2: Explicit Escalations

Explicit escalations are **direct and actionable**. The system has identified something that requires human attention and says so clearly:

- **Decision needed** — "This approach requires choosing between A and B. Here are the tradeoffs." Presented with clear options and a recommendation.
- **Conflict detected** — "Your privacy constraint conflicts with the proposed API design. Here's the specific tension." Shown with links to both artifacts.
- **Blocked** — "I can't proceed on X until Y is resolved. Here's what's waiting." Shown with the dependency chain.
- **Uncertainty** — "I'm not confident in this approach and want your input before investing further." Shown with what the system has tried and why it's unsure.
- **Risk** — "This change affects a critical path. I want you to review before I proceed." Shown with the blast radius.

**Escalation behavior:**
- Escalations are **prioritized** — the system ranks them by impact and urgency
- Pending escalations **age visually** — they glow warmer over time (yellow → orange → red) so the human can see what's been waiting
- Escalations include **full context** — not just the question, but the relevant artifacts, the options considered, and a recommendation
- Downstream work visually **stacks up** behind a blocker, making the cost of delay spatially visible

### 6.2 Signal Layering

Ambient signals are visible at any zoom level — the human should be able to see project health from the Mission layer, not only when zoomed into Implementation. The signals aggregate as you zoom out:

- At Implementation: individual file-level activity, specific test failures
- At Architecture: component-level health, dependency tangles
- At Experience: flow completeness, consistency issues
- At Mission: overall project health, timeline risk, scope drift

---

## 7. Multi-Surface Architecture

### 7.1 Design Principle

Mica treats each connected display as a **surface** with unique capabilities. Rather than mirroring the same interface across screens, each surface plays to its strengths. The system is aware of all connected surfaces and orchestrates them as a unified workspace.

v1 supports two surfaces. The architecture assumes N surfaces, each declaring its capabilities (input methods, screen size, resolution, orientation) and receiving an appropriate view.

### 7.2 Surface Types and Strengths

| Surface | Primary Strength | Role in Mica |
|---------|-----------------|--------------|
| **Tablet** (iPad) | Maximum interactivity — touch, stylus, voice, keyboard | Primary collaboration surface. Where direct manipulation, sketching, and focused work happen. |
| **Large display** (TV/monitor) | Screen real estate, shared viewing | Expanded workspace for complex layouts. Context view showing broader surroundings of what the tablet is focused on. Independent reference that holds stable while the tablet navigates. |
| **Projection wall** | Massive real estate, ambient visibility | Portfolio-level overview. War room presentations. Ambient project health dashboard visible from across a room. |
| **Desktop** (Mac/PC) | Keyboard, precision, developer tools | Deep editing, implementation review, precise text-heavy work. Integration with local development environments. |
| **Phone** | Portability, always-on | Quick triage, escalation review, approvals on the go. Notification surface for urgent attention items. |

### 7.3 Surface Capabilities Declaration

Each surface registers its capabilities when it connects:

- **Input methods** — touch, stylus, keyboard, voice, mouse, trackpad
- **Screen characteristics** — size, resolution, pixel density, orientation
- **Interaction distance** — handheld (tablet/phone), desk distance (monitor), room distance (TV/projection)
- **Mobility** — stationary vs. portable

The system uses these capabilities to determine what content and controls to present. A projection wall at room distance shows large-scale health indicators, not small text. A phone shows actionable escalations, not full architecture diagrams.

### 7.4 Multi-Surface Coordination

When multiple surfaces are active, they are aware of each other and coordinate:

- **Synchronized mode** — surfaces show the same canvas at different zoom levels or viewport positions, scrolling in coordination
- **Split mode** — each surface shows a different layer, enabling the user to see Experience on the tablet and Architecture on the large display simultaneously
- **Extended mode** — surfaces form one continuous workspace, the canvas spanning across them (e.g., tablet + large display as one massive canvas for laying out a full architecture diagram)
- **Independent mode** — each surface navigates freely, for reference or multitasking

The user switches between modes fluidly via gesture or voice. The system may also suggest a mode — e.g., when reviewing architecture decisions, offer to show relevant experience flows on the second surface.

### 7.5 Voice Across Surfaces

Voice input is not bound to the tablet. Any surface with a microphone can receive voice — enabling hands-free interaction with the large display or projection while the user's hands are on the tablet. The system routes voice commands to the appropriate surface based on context.

### 7.6 Future Surface Considerations

The multi-surface architecture should not preclude:
- **AR/VR headsets** — spatial computing surfaces where layers could become literal spatial depth
- **E-ink displays** — persistent, low-power surfaces showing project status (like a wall-mounted dashboard)
- **Collaborative multi-tablet** — multiple humans each with their own tablet, seeing shared and private views

---

## 8. Wayfinding and Orientation

### 8.1 Breadcrumb Trail

Always visible. Shows the path from Portfolio (or Mission if single-project) through to the current position. Tappable — the user can jump to any ancestor layer.

Format: `Portfolio > Inbox Intelligence > Experience > Onboarding Flow`

### 8.2 Depth Indicator

A subtle visual indicator showing the current layer (0-4) and the user's position within the stack. This is the "altimeter" — always visible, never intrusive.

### 8.3 Depth Haze

Nested content that exists below the current layer appears with a slight darkening or softening, providing depth cues without obscuring the current workspace. This reinforces the spatial metaphor of layers beneath the surface.

### 8.4 Offscreen Indicators

Borrowed from open-world games. Small directional indicators at the edges of the viewport show what exists beyond the current view — artifacts, activity, or escalations that are off-screen but at the current layer. This prevents the "lost in white void" problem.

### 8.5 Spatial Bookmarks

User-created quick-jump points. The human can bookmark any position (layer + viewport) for rapid return. The system may also auto-create bookmarks for frequently visited areas.

### 8.6 Zoom to Fit

Double-tap empty canvas space to frame all content at the current layer. A fast way to reorient when lost.

---

## 9. Interaction Model

Mica defines interactions as **semantic operations** — what the user intends to do — independent of the physical gesture or input that triggers them. Each operation then has platform-specific bindings. This ensures the interaction model translates across surfaces and devices.

### 9.1 Semantic Operations

#### Navigation Operations

| Operation | Description |
|-----------|-------------|
| **Layer Descend** | Move deeper into the layer stack (toward Implementation). Content transforms at the boundary. Tactile feedback confirms the transition. |
| **Layer Ascend** | Move up the layer stack (toward Portfolio/Mission). Current layer dissolves, parent layer emerges. |
| **Pan** | Move the viewport across the current layer's canvas without changing semantic level. |
| **Geometric Zoom** | Zoom in/out within the current layer for closer inspection without crossing a layer boundary. |
| **Zoom to Fit** | Frame all content at the current layer in the viewport. Fast reorientation. |
| **Sibling Navigate** | Move sequentially between artifacts at the same level (next/previous). |
| **Jump to Layer** | Navigate directly to a specific layer (via breadcrumb, voice, or bookmark). |

#### Artifact Operations

| Operation | Description |
|-----------|-------------|
| **Select** | Focus on an artifact. Shows its connections, metadata, and available actions. |
| **Open/Enter** | Enter an artifact that contains sub-content (e.g., enter a flow to see its screens). |
| **Context Actions** | Reveal the set of actions available for a selected artifact (edit, link, version, delete, etc.). |
| **Artifact Carry** | Grab an artifact, navigate (pan, zoom, layer change) while holding it, and drop it in a new location. The system handles any necessary transformation (e.g., a wireframe dropped at Architecture generates a component spec). |
| **Annotate** | Add freeform marks, notes, or highlights to an artifact. |
| **Sketch** | Create new freeform visual content on the canvas (wireframes, diagrams, notes). |
| **Approve/Reject** | Act on a system proposal or escalation. Binary or multi-option response. |

#### System Operations

| Operation | Description |
|-----------|-------------|
| **Converse** | Open-ended dialogue with the system — express intent, ask questions, give direction. |
| **Command** | Direct instruction to the system — "show me the architecture," "compare these two." |
| **Checkpoint** | Capture the current state of the canvas for version history (see Section 12). |
| **Surface Switch** | Change coordination mode between connected surfaces. |

### 9.2 Platform Bindings

Each semantic operation maps to one or more physical inputs depending on the surface:

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
| Annotate | — (requires stylus/tablet input) | Text comment via keyboard |
| Sketch | — (requires stylus/tablet input) | — |
| Approve/Reject | Click action target | Keyboard shortcut |
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

### 9.3 Tactile Feedback

Operations that cross semantic boundaries include tactile feedback on surfaces that support it:

- **Layer boundary crossing** — a distinct haptic click when descending or ascending between layers
- **Checkpoint captured** — a confirmation haptic pulse
- **Escalation acknowledged** — a subtle feedback confirming the user's response registered
- **Artifact snapping** — light feedback when an artifact aligns to a grid or group during arrangement

### 9.4 Input Fluidity

All input modes are available simultaneously on surfaces that support them. A single interaction sequence might flow:

1. Voice: "I want the onboarding to feel conversational"
2. Pencil: sketches a rough three-screen flow
3. System: interprets and renders a wireframe
4. Touch: drags a wireframe to reposition it
5. Keyboard: types a precise label
6. Touch: taps "approve" on the system's interpretation
7. Voice: "Now show me how this connects to the architecture"

The system accepts and integrates all modalities without mode-switching friction.

---

## 10. Visual Design Principles

### 10.1 Dark Theme

Mica uses a dark theme as its primary palette. Dark backgrounds reduce visual fatigue during extended work sessions and make colored signals, health indicators, and artifact content stand out.

### 10.2 Layer Color Identity

Each layer has a subtle color identity that reinforces spatial orientation:

| Layer | Color Family | Rationale |
|-------|-------------|-----------|
| Portfolio | Neutral/silver | Overview, no single project identity |
| Mission | Deep blue | Strategy, depth, trust |
| Experience | Warm tones (amber/coral) | Human, emotional, user-facing |
| Architecture | Cool green/teal | Technical, structural, systematic |
| Implementation | Purple/violet | Execution, energy, activity |

These colors appear as subtle background gradients, border accents, and breadcrumb highlights — not as overwhelming theme changes.

### 10.3 Typography

- Primary: SF Pro Display (system font, optimized for Apple devices)
- Artifact content renders in the appropriate format (monospace for code, proportional for prose, etc.)
- Layer titles and navigation use consistent typographic hierarchy

### 10.4 Glassmorphic UI Elements

Toolbar, breadcrumbs, and overlay controls use translucent/glassmorphic styling — present but not occluding the canvas. The canvas content is always the primary visual element.

### 10.5 Animation Principles

- All layer transitions animate (200-300ms) to maintain spatial memory
- Artifacts entering or leaving the canvas fade and scale, never pop
- Ambient signals animate slowly and continuously (breathing, pulsing) — never abruptly
- Escalation aging (yellow → orange → red) is gradual, over minutes/hours, not seconds
- 120fps target for all gesture-driven animation — any latency breaks direct manipulation

---

## 11. The Blank Canvas Solution

### 11.1 Spatial Templates

New projects start from spatial templates — pre-structured canvas layouts that provide orientation without rigidity:

- **Standard product** — Mission brief centered, with placeholder regions for Experience, Architecture, and Implementation
- **API/service** — Architecture-heavy layout with API contract skeletons
- **Consumer app** — Experience-heavy layout with user journey templates
- **Custom** — Minimal starting point for experienced users

Templates are immediately rearrangeable. They exist to prevent the paralysis of a blank canvas, not to constrain the user.

### 11.2 System-Initiated Scaffolding

When the human expresses a mission (voice or text), the system proactively scaffolds lower layers:

- Mission statement → proposed persona stubs, suggested constraint categories
- Persona definition → proposed experience flow outlines
- Experience flows → suggested architecture components

The human can accept, modify, or discard any scaffolding. The system explains its reasoning for each proposal.

---

## 12. Version Management

### 12.1 Design Principle

GitHub is the **source of truth** for all project state — every layer, every artifact. The complete state of a Mica project must be reproducible from a repository clone.

Versioning should feel **natural to the medium at each layer** — not like a foreign "save/commit" workflow imposed on creative work. The whiteboard analogy: you don't "commit" a whiteboard. You reach a moment where the state feels worth preserving, and you snap a photo. The act is lightweight, contextual, and human-initiated.

### 12.2 Layer-Native Versioning Affordances

Each layer has a versioning metaphor that matches how people naturally checkpoint that type of work:

| Layer | Metaphor | Affordance | What It Feels Like |
|-------|----------|------------|-------------------|
| **Mission** | **Snapshot** | Stamp a date on the brief. "We've aligned on this." | Like writing a date on a whiteboard and taking a photo. |
| **Experience** | **Pin** | Pin a version of a design to the wall. Previous versions recede but remain accessible. | Like pinning a printout to a corkboard — this is the one we're going with. |
| **Architecture** | **Baseline** | Sign off on a blueprint. Creates a reference point that implementation builds against. Changes after baseline are visible as deltas. | Like signing off on architectural drawings before construction begins. |
| **Implementation** | **Commit / Branch / PR** | Standard git workflow. This is already solved — Mica surfaces it natively rather than reinventing it. | Familiar to anyone who has worked with code. |

The user never thinks in terms of git mechanics at the upper layers. They think:
- "Is this worth remembering?" → snapshot/pin/baseline
- "What did we decide last week?" → browse history
- "What changed since we baselined?" → see drift

### 12.3 Repository Structure

All Mica artifacts are serialized and stored in the repository:

```
project-repo/
├── .mica/
│   ├── mission/          # Mission layer artifacts (narratives, personas, constraints)
│   ├── experience/       # Experience layer artifacts (wireframes, storyboards, flows)
│   ├── architecture/     # Architecture layer artifacts (diagrams, contracts, decisions)
│   ├── canvas-state.json # Spatial positions, layer configuration, viewport state
│   └── history/          # Checkpoint metadata and descriptions
├── src/                  # Implementation layer — standard code
├── tests/
└── ...
```

The `.mica/` directory contains everything needed to reconstruct the canvas. Cloning the repo and opening Mica restores the full project state — mission through deployment.

### 12.4 The System's Role in Versioning

The system makes versioning **effortless and timely**:

- **Suggests checkpoints** — "You've made significant changes to the experience layer since your last pin. Want to capture this?" Triggered by amount of change, not elapsed time.
- **Auto-describes** — when the user checkpoints, the system generates a meaningful description of what changed: "Added onboarding flow, revised dashboard wireframe to include search."
- **Surfaces drift** — "The architecture baseline was set 3 days ago, but 4 experience artifacts have changed since. The architecture may need updating."
- **Coordinates cross-layer consistency** — when a checkpoint at one layer creates inconsistency with another layer's baseline, the system flags it.

### 12.5 Diff at Every Layer

Version comparison is not limited to code diffs. Each layer supports native diff visualization:

| Layer | Diff Visualization |
|-------|-------------------|
| **Mission** | Narrative diff — what language shifted, which constraints changed, highlighted additions/removals |
| **Experience** | Visual diff — overlay comparison of wireframes, side-by-side mockup versions, flow structure changes |
| **Architecture** | Structural diff — what components/connections changed, new/removed dependencies, altered data models |
| **Implementation** | Code diff — standard git diff, surfaced with context linking back to architecture and experience decisions |

### 12.6 Under the Hood

Translation to git happens invisibly at the upper layers:

- A **snapshot** (Mission) = a git commit of `.mica/mission/` with an auto-generated message
- A **pin** (Experience) = a git commit of `.mica/experience/` with the pinned artifacts tagged
- A **baseline** (Architecture) = a git commit of `.mica/architecture/` plus a git tag marking the baseline
- **Implementation** commits are standard git commits — the human sees them as commits because that's the native language of that layer

The system may batch multiple small changes into a single commit when the user triggers a checkpoint, or commit individual artifact changes granularly — this is an implementation detail the user does not need to manage.

### 12.7 Branching and Exploration

For exploratory work — "what if we took a completely different architecture approach?" — the system can create a branch under the hood. The user experiences this as a **parallel canvas**: a copy of the current state that they can modify freely, then merge back (accept) or abandon (discard). The branching metaphor is spatial, not git-mechanical:

- "Let me try something" → system creates a branch, canvas enters exploration mode (visually distinct)
- "I like this direction" → system merges the branch, canvas returns to main state with changes incorporated
- "Never mind" → system discards the branch, canvas reverts cleanly

At the Implementation layer, branches are visible as-is — standard git branches that the AI team works on and creates PRs from.

---

## 13. Dogfooding: Mica Builds Mica

Mica's own development is the standing test case for the system. The product must be able to represent:

- **Mission:** "Be the operating surface between human product-builders and AI teams"
- **Experience:** The UX specification in this document — wireframes for the layer navigation, mockups for the signal system, storyboards for the collaboration model
- **Architecture:** tldraw canvas, React component hierarchy, shape system, multi-device sync
- **Implementation:** The actual codebase, tests, deployment

If Mica cannot represent its own product development lifecycle, it is not general enough.

---

## 14. v1.0 Scope

### In Scope
- Layers 1-4 (Mission through Implementation) with semantic zoom navigation
- Native artifact rendering at each layer
- Within-layer generative loops (artifact → artifact)
- Cross-layer context flow (up, down, across)
- Layer goals with context quality tracking
- Adaptive collaboration (system confidence → division of labor)
- Two-tier signal system (ambient + explicit escalations)
- Multi-modal input (touch, stylus, voice, keyboard)
- Tablet as primary surface
- Two-surface coordination (tablet + large display)
- Hardcoded seed data demonstrating the full layer stack (Full Stack working style)
- Spatial templates for new project initiation
- Breadcrumb navigation and wayfinding aids
- GitHub-backed version management with layer-native affordances (snapshot, pin, baseline, commit)
- Abstract interaction model with tablet and desktop platform bindings
- Working style template architecture (ships with Full Stack default)

### Post v1.0
- Portfolio layer (Layer 0) — multi-project oversight
- Additional surface types (projection wall, phone, AR/VR)
- Additional working style templates (Rapid Prototype, Design-Led, Engineering-Led, Custom)
- Card carry across layers
- Spatial bookmarks
- Spatial audio cues
- AI team execution (live coding, testing, deployment through the canvas)
- Branch-based parallel canvas exploration
- Cross-project dependency tracking

### Design Language to Lock In for v1.0
- Semantic operations vocabulary (device-agnostic interaction definitions)
- Layer-specific visual languages and artifact types
- Layer goals and context quality indicators
- Adaptive system behavior (confident → leads; uncertain → asks)
- Ambient signal visual vocabulary
- Explicit escalation presentation
- System voice and collaboration patterns at each layer
- Layer-native versioning metaphors (snapshot, pin, baseline, commit)
- Dark theme, layer color identity, glassmorphic UI controls
- Multi-surface coordination modes (synchronized, split, extended, independent)
- Working style template structure

---

## 15. Open Questions

1. **Zoom continuity vs. discrete transitions.** Current proposal: continuous gesture with discrete content snaps. Should certain layer transitions (e.g., Architecture → Implementation) feel more like "entering a room" than "descending smoothly"?

2. **Collaboration history.** Should the canvas show the *history* of human-AI collaboration (what was tried, what was rejected) or only the current state? History adds context but also clutter.

3. **Multi-human collaboration.** The spec describes a single human or very small team. When two humans are on the canvas, how do they coordinate? Is this in scope?

4. **Offline capability.** If the AI team requires connectivity, what does the canvas experience look like when offline? Can the human still navigate, annotate, and sketch?

5. **Working style ecosystem.** Should working style templates be user-creatable and shareable? Could a community of Mica users develop and publish templates for specific domains (healthcare, fintech, gaming)?
