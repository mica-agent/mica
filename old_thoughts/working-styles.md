# Archived from SPEC.md — 2026-03-27. Reference material, not current spec.

## Layer Goals, Working Styles & Template Stacks

### Layer Goals

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
- Goals can be set by the human, suggested by the system, or defined by a working style template
- Goals are not gates — the human can descend to lower layers before a goal is met, but the system will flag what's missing and how it affects downstream work

### Adaptive Collaboration and Working Styles

The division of labor between human and AI is not fixed. It adapts based on **project complexity, ambiguity, and the human's working style.**

#### How Adaptation Works

The system continuously assesses its own confidence at each layer:

- **High confidence** (well-understood problem, clear patterns): The system leads — generating artifacts proactively, presenting completed work for approval, advancing generative loops rapidly. The human's role is primarily curation and selection.
- **Low confidence** (novel problem, ambiguous requirements, conflicting constraints): The system defers — asking questions, presenting options, flagging uncertainties, and waiting for human direction before generating. The human's role is primarily creation and decision-making.

This is not a mode the user selects. It emerges naturally from the quality and completeness of context at each layer. A vague mission produces low system confidence everywhere below it. A precise mission with clear constraints produces high system confidence.

#### UI Indicators of Collaboration Balance

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

A **template stack** is the formal data structure that defines how each layer is instantiated when a project begins.

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
    architecture:
      goal: "Component architecture with dependency map and API contracts"
      artifacts: [component_diagram, api_contracts, data_model, dependency_map]
      ai_initiative: high
      quality_gates: [components_traced_to_experience, contracts_defined, no_orphans]
    implementation:
      goal: "Deployed, tested product matching architecture"
      artifacts: [source_code, test_suite, deployment_config]
      ai_initiative: high
      quality_gates: [tests_pass, architecture_match, deployment_verified]
  style: null
```

#### Facilitation Cues — Workspace Furniture

Every layer in a template stack can include **facilitation cues** — lightweight prompts that guide the human and AI through productive work. Cues are **workspace furniture**: visible on the canvas near the layer goal bar, editable by the human, but NOT artifacts.

**Four cue kinds** (lightest → most structured):

| Kind | Purpose | Example |
|------|---------|---------|
| **Question** | Socratic probe to deepen thinking | "Who feels the pain most acutely?" |
| **Prompt** | Suggestion to consider | "Think about offline scenarios" |
| **Exercise** | Mini-activity that produces an artifact | "Sketch the happy path in 3-5 steps" |
| **Checklist** | Short validation list | "Does the brief cover: user, problem, outcome, scope?" |

**How the AI uses cues:**

1. **Initialization** — When entering a layer, the AI reads the layer's cues to understand what the template author considered important.
2. **Opportunistic** — The AI surfaces relevant cues when it detects gaps.
3. **On-demand** — The human asks "what should I think about next?" and the AI selects from remaining unaddressed cues.

**Key properties:**
- **Declarative**: A template stack describes *what* each layer should produce, not *how* to produce it.
- **Swappable**: Switching template stacks mid-project is possible.
- **Composable**: Template stacks can inherit from a base and override specific layers.
- **Extensible**: The same stack structure will later be augmented to include stylistic concerns.
