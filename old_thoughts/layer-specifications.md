# Archived from SPEC.md — 2026-03-27. Reference material, not current spec.

## Layer Specifications

Each layer is a **creative workspace with its own production pipeline** — artifacts within a layer generate, inform, and build on each other progressively.

### Portfolio Layer (Layer 0)

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

### Mission Layer (Layer 1)

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

### Experience Layer (Layer 2)

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

### Architecture Layer (Layer 3)

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

### Implementation Layer (Layer 4)

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
