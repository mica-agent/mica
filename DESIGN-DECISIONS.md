# Mica — Design Decisions (April 2026)

Working decisions from architecture exploration sessions. These inform the next phase of implementation.

## Storage model — work lives outside `.mica/`

`.mica/` was holding both infrastructure and work. As the canvas becomes the primary work surface, the work should be first-class in the project directory.

```
my-project/
├── .mica/                      ← infrastructure
│   ├── .config.json            ← agent config, provider settings
│   ├── .chat-history.json      ← sidebar conversation
│   ├── .layout.json            ← card positions
│   └── card-classes/           ← custom card type definitions
│
├── _project.project            ← root canvas card
├── _goal.goal                  ← work cards — visible, first-class
├── _brief.brief
├── _todo.todo
├── roadmap.md
├── architecture.mmd
├── auth-module.agent
└── research/                   ← nested canvas
    ├── _project.project
    └── hypotheses.md
```

Cards are the work, not metadata. Card classes (the vocabulary) are infrastructure and stay in `.mica/`.

Mica projects are standalone for now. Overlaying on existing codebases is deferred.

## Card classes are project-wide

Card classes live in `.mica/card-classes/` and are available to all cards at any nesting level. Resolution: project > workspace > built-in.

## Agent architecture — accept duplication, extract later

Multiple agent types (orchestrator, card-builder, external coordinator) share plumbing (status, plan steps, blocker UI, channel protocol) but differ in rendering and backend behavior.

Approaches considered and set aside:
- Runtime-provided plumbing — risk of runtime bloating
- Delegation between card classes — burdens the providing card
- Templates — works for creation, breaks for maintenance
- Shared library — right idea, premature before patterns emerge

**Decision:** Let agents create card classes with the current system. Accept duplication. When patterns emerge, a maintenance agent extracts common code into shared primitives. If those stabilize, consider runtime integration.

Agents have the same maintenance problems as humans (copies drift) but a different strength (they read an entire codebase instantly). The shared library is the maintenance solution — but we build it from observed patterns, not upfront guessing.

## Orchestrator is the sidebar agent, evolved

The sidebar chat agent has full context and all tools. The orchestrator extension adds: `spawn_agent`, `check_agent`, `message_agent`. Specialist agents are agent cards with role-specific prompt augmentation, not a separate abstraction.

## Open questions
- "Add to any project" model when cards live outside `.mica/`
- When to build the shared primitives library
- Orchestrator as visible canvas card vs sidebar vs both
- Card class versioning and breaking changes
