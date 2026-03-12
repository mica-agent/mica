# Mica UX Design Directions

Three distinct creative approaches to delivering the Mica spec. Each fulfills the same functional requirements but takes a fundamentally different design philosophy, spatial metaphor, and emotional tone.

---

## UX A: "Terrain" — The Cartographic Approach

### Core Metaphor
The product is a **landscape**. Layers are altitude. The user flies over terrain, descending to see finer detail. Projects are landmasses. Health is weather. Activity is movement on the ground.

### Visual Identity
- **Palette:** Dark topographic — deep navy/charcoal base with elevation-colored contour lines. Warm amber for human attention areas, cool cyan for AI activity. Muted earth tones for stable/complete artifacts.
- **Texture:** Subtle topographic contour lines in the background shift density based on layer depth. Mission level has sparse, sweeping contours. Implementation level has dense, fine-grained contours.
- **Typography:** Clean sans-serif (Inter or similar) for UI. Handwritten/sketch-style annotations for human input. Monospace for system-generated specs.

### Layer Experiences

**Mission (Altitude: Stratospheric)**
The mission occupies the canvas like a **continent viewed from space**. The narrative is rendered as large, readable text across the landscape — almost like text printed on the terrain itself. Constraints appear as geographic features: a mountain range labeled "Local-First Processing" that implementation must navigate around. Personas are depicted as **settlements** — small clusters of activity representing user populations.

The system collaborates by annotating the terrain: "There's a gap in your coastline here — no constraint covers data retention." The human responds by voice or text, and the constraint materializes as a new geographic feature.

**Experience (Altitude: Regional)**
Descending reveals **districts** within the landscape. Each district is a user journey or experience flow. Wireframes are rendered as **building floorplans** — top-down architectural layouts you can see from above. Storyboards appear as **pathways** connecting buildings, showing user movement through the experience.

Sketching with the stylus draws directly onto the terrain — rough strokes that the system interprets into structured floorplans. Mockups are higher-fidelity renderings of the same buildings, progressively detailed as you zoom closer.

The generative loop is visible: a rough sketch (pencil marks on terrain) → wireframe (clean floorplan) → mockup (rendered building) → prototype (building with animated occupants showing user flow). All coexist spatially, earlier versions fading to ghostly outlines behind the current version.

**Architecture (Altitude: City-level)**
Components are **infrastructure** — power grids, water systems, roads connecting the buildings above. Data flows are rivers and pipelines. API boundaries are district borders with controlled crossing points (gates = endpoints).

Decision records appear as **crossroads** — literal forks in the road with signage showing Option A, Option B, and the system's recommended direction. The human approves by "paving" one path; the other fades to a dotted trail.

Dependencies are visible as supply lines between components. A tangled web of dependencies looks like spaghetti infrastructure — visually uncomfortable, prompting cleanup.

**Implementation (Altitude: Street-level)**
At ground level, you see the **construction site**. Active work appears as animated construction activity. Completed components are solid structures. Code diffs are blueprint revisions pinned to the construction fence. Test results are inspection certificates posted on buildings.

The AI team's presence is workers moving between sites. Concentrated activity in one area is visible as a crowd. Blocked work shows a barricade with a sign explaining the blocker.

### Signal System
- **Ambient:** Weather. A region under heavy AI activity has "clouds" of activity. Stalled areas have still air. Circular/thrashing activity shows as a localized storm. Scope drift appears as terrain physically expanding, pushing borders outward.
- **Explicit escalations:** Red signal flares rising from the terrain. Visible from any altitude. The higher you are, the more you see them as pinpoints; descend and they become full escalation cards with context.
- **Aging:** Flares burn brighter and redder over time. Old unresolved escalations become "fires" that visually spread to adjacent areas.

### Versioning Feel
- **Snapshot (Mission):** Aerial photograph — literally a "satellite image" timestamped and filed. Previous snapshots viewable as a timeline of aerial photos showing how the continent evolved.
- **Pin (Experience):** Planting a flag on the terrain. Flagged versions are visible as small flag icons; tap to see that version's state.
- **Baseline (Architecture):** Laying foundation. The baselined architecture becomes solid ground; changes after baseline show as construction scaffolding on top of it.

### Multi-Surface Behavior
- **Tablet:** The pilot's cockpit. Intimate, hands-on. You steer through the terrain.
- **Large display:** The satellite view. Always showing broader context than the tablet. When the tablet descends to street level, the large display shows the city.
- **Projection wall:** Mission control. The full continent with real-time weather patterns across all projects.

### Strengths of This Direction
- The altitude metaphor maps perfectly to semantic zoom — it's the most literal interpretation
- Weather/terrain signals are immediately intuitive — everyone understands "storm brewing"
- Rich visual vocabulary for health, activity, and risk
- Strong spatial memory — terrain is the most natural thing for humans to remember spatially

### Risks of This Direction
- Could feel too literal/skeuomorphic — terrain textures might fight with artifact readability
- Wireframes-as-floorplans might strain the metaphor — not all artifacts map cleanly to geography
- Risk of visual clutter with contour lines + artifacts + weather + signals all competing
- May feel more like a game than a professional tool (could be a pro or a con)

---

## UX B: "Darkroom" — The Cinematic Approach

### Core Metaphor
The product is a **film production**. Layers are stages of production: concept → storyboard → production design → principal photography → post-production. The user is the **director**. The AI team is the **crew**. Artifacts are production materials — scripts, storyboards, set designs, dailies.

The canvas is a **darkroom/editing suite** — a focused, controlled environment where creative material is developed, reviewed, and refined. Dark, calm, intentional.

### Visual Identity
- **Palette:** True black background (#000000) with artifacts illuminated as if by focused light. Content glows against the void. Layer identity expressed through light temperature: Mission is warm golden light (like candlelight over a script). Experience is soft white (like a light table for storyboards). Architecture is cool blue-white (like technical drafting light). Implementation is sharp green (like terminal phosphor).
- **Texture:** None. Pure black negative space. Artifacts float, illuminated. The darkness is the organizing principle — it focuses attention on what's lit.
- **Typography:** Serif for narrative content (Georgia, Source Serif). Clean sans-serif for technical content. The typographic shift reinforces the layer change.

### Layer Experiences

**Mission (The Script)**
The mission is presented as a **screenplay/treatment**. The canvas shows the narrative formatted like a film treatment — title, logline, character descriptions (personas), story beats (success criteria). It reads as a compelling document, not a set of fields.

The system collaborates as a **script doctor**: "Your second act is weak — you've defined what the user sees but not what they feel when they see it. Let's develop the emotional arc." Human and AI refine the treatment together through conversation, with the document evolving on-canvas in real-time.

Constraints appear as **production notes** in the margins — practical limitations that shape the creative vision. "Budget: indie" or "Location: local-only (no cloud)" written in a production manager's hand.

**Experience (The Storyboard)**
The canvas becomes a **light table** — a bright, even surface where storyboard panels are laid out. Each panel is a screen or interaction moment. Panels connect with drawn arrows showing flow. The arrangement is flexible — the human drags panels to reorder the story.

Sketching with the stylus produces **storyboard panels** — rough frames that the system can progressively refine. The generative loop is cinematic: rough thumbnail → pencil sketch → inked panel → colored frame → animated animatic. Each stage exists on the light table, with the current version on top and previous stages peeling back like layers of tracing paper.

Wireframes, mockups, and prototypes are all frames in the storyboard — progressively higher fidelity versions of the same story moment. The system generates them as a storyboard artist would: "Here's how I see this scene playing out" — presented as a sequence of panels for the director to review.

**Architecture (Production Design)**
The canvas shifts to **technical blueprints on a dark drafting table**. Components are rendered as precise technical drawings with clean lines and labeled dimensions. The aesthetic is engineering elegance — not diagrams in boxes, but beautifully drafted plans.

Data flows are drawn as **circuit-style traces** — clean paths with right-angle turns, labeled at junctions. The visual language borrows from electronics schematics and architectural blueprints.

Decision records are presented as **director's notes** — "We can shoot this scene two ways. Here's a rough cut of each approach." The system presents options as side-by-side comparisons with clear annotations of what each choice costs and enables.

**Implementation (Post-Production)**
The canvas becomes an **editing timeline** — horizontal tracks showing parallel workstreams. Each track is a component being built. Progress is shown as filled regions on the timeline. Active work has a playhead indicator showing where the AI team is currently focused.

Code reviews are presented as **dailies** — the day's footage for the director to review. The system curates what to show: "Here are today's key shots — the authentication flow and the data pipeline. The authentication has a continuity issue I want your eyes on."

Test results are **quality checks** — green for approved, red for needs reshooting.

### Signal System
- **Ambient:** Illumination intensity. Active areas glow brighter. Stalled areas dim. A region where the AI team is struggling flickers — like a faulty light. Balanced work has even illumination across the canvas.
- **Explicit escalations:** A **spotlight** snaps on, illuminating the issue against the dark background. Impossible to miss, but not jarring — it's a focused beam, not an alarm. The spotlight contains the full escalation context.
- **Aging:** Spotlights on unresolved escalations slowly widen their beam, illuminating more of the surrounding area — showing the growing blast radius of inaction.

### Versioning Feel
- **Snapshot (Mission):** "Lock the script." Like locking a screenplay draft — Draft 1, Draft 2, Final Draft. Previous drafts accessible in a revision stack.
- **Pin (Experience):** "Approve the storyboard." Panels get a small "approved" stamp. Previous versions are accessible as "previous boards."
- **Baseline (Architecture):** "Sign off on the blueprints." The blueprint gets a formal approval mark. Changes after sign-off are drawn in red ink over the blue original.

### Multi-Surface Behavior
- **Tablet:** The director's chair. Review storyboards on a light table, mark up dailies, annotate blueprints with a pencil.
- **Large display:** The screening room. Show the full storyboard sequence, play back animatics and prototypes, review the editing timeline at full width.
- **Projection wall:** The production office wall — all storyboards, reference images, and schedules pinned up for the whole team to see.

### Strengths of This Direction
- The darkness creates extreme focus — artifacts pop against void, zero visual noise
- Film production is a deeply understood creative workflow — director/crew maps cleanly to human/AI
- The light table + storyboard metaphor is exceptional for the Experience layer
- "Dailies" for code review is a powerful framing — the AI shows you what it filmed today
- Typography and light temperature shifts make layer transitions feel dramatic and intentional
- Feels premium and professional without feeling corporate

### Risks of This Direction
- The film metaphor might feel forced at the Architecture and Implementation layers
- Pure black backgrounds may cause eye strain in extended sessions (or may not — depends on ambient lighting)
- The metaphor might not scale to the Portfolio layer well — what's the film equivalent of multiple productions? (A studio slate, perhaps)
- Storyboard panels impose a somewhat linear structure that might fight the spatial freedom of an infinite canvas

---

## UX C: "Layers" — The Geological Approach

### Core Metaphor
The product is a **living organism viewed in cross-section** — like a geological core sample or a biological specimen under a microscope. Each layer is a literal stratum. The user moves through layers by adjusting depth, like focusing a microscope or drilling into rock.

The key visual idea: **translucency**. Higher layers are always subtly visible beneath lower ones, like looking through frosted glass or layers of tissue. You're never fully disconnected from the layers above and below — they're always present as ghostly context.

### Visual Identity
- **Palette:** Each layer has a distinct hue at low saturation, creating a subtle color shift as you descend. Mission: warm ivory. Experience: soft rose. Architecture: pale teal. Implementation: light lavender. The active layer is full saturation; adjacent layers are desaturated ghosts visible through the translucent surface.
- **Texture:** Smooth, matte surfaces with subtle grain — like high-quality paper or frosted glass. No hard edges. Artifacts have soft drop shadows that deepen with importance.
- **Typography:** One typeface family at different weights — light for ambient info, regular for content, bold for titles, heavy for escalations. Consistency across layers reinforces that it's one unified system, not five separate views.

### Layer Experiences

**Mission (Surface Layer)**
The topmost layer. Clean, spacious, almost meditative. The mission narrative is centered, large, and readable — like the opening page of a beautiful book. Personas and constraints are arranged around it as supporting elements, each on its own **card** that feels like a thick, tactile paper stock.

The system's voice here is **gentle and probing** — it appears as text that fades in near relevant artifacts: "What happens when..." or "Have you considered..." These prompts feel like marginalia in a thoughtful book, not UI notifications.

When the human speaks, their words appear as flowing text that the system gradually organizes into structured artifacts — like watching handwriting resolve into typeset text.

**Experience (Second Layer)**
Descending one layer, the Mission content remains visible above as a faintly translucent overlay — you can still read the mission statement ghosted behind your wireframes. This constant visibility of the "why" while working on the "what" is the key differentiator of this direction.

The canvas is a **design surface**. Wireframes are rendered as clean, minimal line drawings on the layer's rose-tinted surface. Mockups are more saturated, detailed versions of the same drawings. The generative loop shows as **progressive rendering** — the artifact literally becomes more detailed and saturated as it evolves from sketch to wireframe to mockup to prototype, like a developing photograph.

Storyboards are horizontal sequences of frames, connected by subtle arrows. Journey maps are vertical timelines. Both use the same minimal line-drawing aesthetic.

**Architecture (Third Layer)**
Looking down through two translucent layers above, you can see both the mission and the experience artifacts as faint outlines — a constant reminder of what this architecture serves. New connection lines appear linking architecture components to the wireframes above, visible as lines passing through the translucent layers.

Components are **clean rectangles** with rounded corners, connected by thin lines showing data flow. The aesthetic is closer to a refined technical diagram than an illustration — precise, measured, elegant. But the translucent layers above provide context that typical architecture diagrams lack.

Decision records appear as **cards that split** — one card divides into two or three options, each slightly overlapping, with the system's recommendation having a slightly brighter edge.

**Architecture (Third Layer)**
Looking down through two translucent layers above, you can see both the mission and the experience artifacts as faint outlines — a constant reminder of what this architecture serves. New connection lines appear linking architecture components to the wireframes above, visible as lines passing through the translucent layers.

**Implementation (Deepest Layer)**
The deepest stratum. All three layers above are faintly visible as ghostly outlines — mission, experience, architecture — providing constant context for implementation decisions. When a piece of code relates to a specific wireframe, you can see the connection line stretching upward through all layers.

Active work is shown as **regions of activity** — softly pulsing areas where the AI team is working. Completed areas have a settled, solid appearance. The overall aesthetic is calm and measured, even when significant work is happening.

Code is surfaced in **focused panels** that rise slightly above the canvas surface — like a card lifted off a desk for closer reading. The human reviews these elevated panels and can push them back down (dismiss) or annotate them.

### Signal System
- **Ambient:** **Saturation and clarity.** Healthy areas have crisp, clear rendering. Troubled areas become slightly blurred or desaturated — like looking through turbid water. Disproportionate activity shows as one region being more vivid than its neighbors. Orphaned artifacts lose saturation entirely, becoming nearly invisible.
- **Explicit escalations:** An artifact **rises through the layers** — literally floats upward through the translucent strata toward the user's current depth. If you're at Mission level and an Implementation issue needs attention, you see it ascending through Architecture and Experience as a glowing card, arriving at your layer with full context. The visual is striking — something physically moving through the geological layers to reach you.
- **Aging:** Escalation cards that have been waiting accumulate a visible **edge glow** that broadens over time, like a mineral deposit forming around a foreign object in rock.

### Versioning Feel
- **Snapshot (Mission):** **Fossilize.** The current state is preserved as a geological record — always accessible by "drilling" into the version history, which appears as a timeline along the edge of the canvas, layered like actual strata.
- **Pin (Experience):** **Crystallize.** The pinned version becomes visually more defined — sharper edges, slightly elevated — distinguishing it from work-in-progress artifacts. Previous crystallized versions are visible in the version strata.
- **Baseline (Architecture):** **Bedrock.** The baselined architecture literally becomes the foundation. It shifts downward and becomes the surface that implementation builds upon. Changes after baseline are visible as new sediment deposited on top of bedrock.

### Cross-Layer Visibility — The Signature Feature
This is the defining characteristic of UX C. At any layer, the other layers are **always faintly visible**:

- Working on a wireframe? The mission narrative ghosts above you. The architecture components ghost below.
- Working on architecture? The wireframes ghost above, the code activity ghosts below.
- Looking at mission? The entire stack is visible below — experience, architecture, implementation — like looking down into a clear lake and seeing the bottom.

**The depth of translucency is adjustable.** The user can increase or decrease how visible other layers are — from fully opaque (see only current layer) to highly transparent (see all layers simultaneously). This is controlled by a simple slider or gesture.

Cross-layer connections are always visible as **lines that pass through layers** — a wireframe connected to its implementing code shows as a subtle vertical line descending through architecture into implementation. These connection lines create a **web of traceability** that's spatially intuitive.

### Multi-Surface Behavior
- **Tablet:** Focused on one layer at full opacity, with translucent layers providing context. The primary workspace for direct manipulation.
- **Large display:** Shows the **cross-section view** — all layers visible simultaneously from the side, like a geological core sample. The human can see the full depth of their product at once. Tapping a layer on the large display brings it to focus on the tablet.
- **Projection wall:** The full cross-section at room scale — a wall-sized view of every layer, every connection, every signal. The complete product visible as one unified structure.

### Strengths of This Direction
- **Cross-layer context is always visible** — this is the single biggest UX innovation. You never lose sight of why you're building what you're building.
- The translucency model elegantly solves the "artifacts as context for all layers" requirement — they're literally visible from any layer
- Escalations physically rising through layers is a powerful, intuitive visual
- The large display showing a geological cross-section is a unique and powerful multi-surface use
- Versioning as geological strata (fossilize, crystallize, bedrock) is deeply coherent with the metaphor
- The adjustable translucency slider gives the user control over information density
- Minimal visual decoration — the translucency IS the design language, not textures or illustrations
- Scales cleanly to Portfolio layer (the "surface" above Mission, showing the landscape of all core samples)

### Risks of This Direction
- Translucency rendering is computationally expensive — may struggle to hit 120fps on iPad
- Risk of visual confusion when multiple translucent layers overlap — especially with dense artifact canvases
- The metaphor is less immediately intuitive than terrain or film — "geological layers" is more abstract
- May feel cold or clinical compared to the warmth of the other directions
- The cross-section large-display view might be beautiful but not practically useful for daily work

---

## Comparison Matrix

| Dimension | UX A: Terrain | UX B: Darkroom | UX C: Layers |
|-----------|--------------|----------------|--------------|
| **Core metaphor** | Geography/cartography | Film production | Geology/microscopy |
| **Emotional tone** | Adventurous, exploratory | Focused, cinematic, premium | Calm, precise, scientific |
| **Layer transition feel** | Flying down to terrain | Changing stage of production | Focusing deeper into specimen |
| **AI team presence** | Workers on construction sites | Film crew shooting footage | Activity regions pulsing in strata |
| **Escalation visual** | Signal flare rising from terrain | Spotlight snapping on | Card rising through translucent layers |
| **Ambient signals** | Weather patterns | Illumination intensity | Saturation/clarity changes |
| **Strongest layer** | Mission (continent metaphor) | Experience (storyboard/light table) | Architecture (cross-layer connections) |
| **Weakest layer** | Implementation (construction site stretches metaphor) | Architecture (blueprints are fine but not distinctive) | Mission (clean but not inspiring) |
| **Sketch/stylus feel** | Drawing on terrain | Sketching on a light table | Drawing on frosted glass |
| **Versioning metaphor** | Aerial photographs | Script drafts / locked cuts | Geological fossilization |
| **Multi-surface signature** | Satellite → city → street level | Light table → screening room | Cross-section core sample |
| **Cross-layer context** | Altitude provides natural overview | Minimal — layers are separate stages | Translucency shows all layers simultaneously |
| **Information density** | High (terrain + weather + artifacts) | Low (dark void focuses attention) | Medium (translucency adjustable) |
| **Risk of visual clutter** | High | Low | Medium |
| **Performance concern** | Moderate (terrain rendering) | Low (simple geometry + lighting) | High (translucency compositing) |
| **Novelty** | Familiar (maps are well-understood) | Moderate (film metaphor applied to software) | High (translucent layer stack is new) |
| **Portfolio layer fit** | Excellent (multiple continents) | Good (studio with multiple productions) | Excellent (surface above all core samples) |

---

## Hybrid Possibilities

These directions are not mutually exclusive. Some combinations worth considering:

### B + C: "Darkroom Layers"
Take UX B's dark void and focused illumination as the visual foundation, but add UX C's translucent cross-layer visibility. Artifacts glow against black, and you can see ghostly outlines of other layers. Escalations rise through dark translucent strata as illuminated cards. This combines B's focus and cinematic quality with C's cross-layer context.

### A + B: "Terrain Cinematics"
Use UX A's terrain metaphor for the spatial model and navigation, but apply UX B's lighting and dark aesthetic. The terrain is dark and atmospheric (like satellite imagery at night), with activity shown as illumination — city lights for active areas, darkness for inactive. Weather signals from A, spotlight escalations from B.

### C with A's Signals
Take UX C's translucent layer model as the core interaction, but borrow UX A's weather-based ambient signals for project health. Weather visible through translucent layers from any depth.

---

## Recommendation

No recommendation yet — this document is for evaluation. Each direction has genuine strengths:

- **Choose A** if the priority is intuitive spatial navigation and rich ambient health signals
- **Choose B** if the priority is focused creative work with minimal visual noise and a premium feel
- **Choose C** if the priority is cross-layer context visibility and the "artifacts inform everything" philosophy

The user's feedback will determine direction.
