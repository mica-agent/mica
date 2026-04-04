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
├── project.project             ← root canvas card
├── goal.goal                   ← work cards — visible, first-class
├── todo.todo
├── brief.md                    ← agent identity (markdown)
├── log.md                      ← activity log (markdown)
├── roadmap.md
├── architecture.mmd
├── auth-module.agent
└── research/                   ← nested canvas
    ├── project.project
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

## Agent context — brief as identity, canvas as context

An agent's identity is its `brief.md` file — a markdown document in the agent card's directory that defines role, personality, constraints, and instructions. The brief template ships with the card class and is copied on instance creation. Users and other agents can edit the brief to reshape behavior.

The agent's context is the canvas itself. Agents read the same cards humans see: goal, todo, documents, diagrams. There is no separate "agent memory" — the canvas is the shared context. This means agents and humans have a single source of truth, and any agent can be repointed at a different canvas to change what it knows.

## Card class as back of the card

A card has two sides. The **front** is the instance — the user's conversation, the agent's brief, the accumulated state. The **back** is the card class — the `render.js` that defines how the card works, what SDK it connects to, how it renders. The class is the machinery; the instance is the work.

This maps cleanly to the file system: the card class lives in `card-classes/{name}/render.js` (or `.mica/.card-classes/{name}/render.js` for project-specific classes), and the card instance is a directory at the project root.

## Cards as tools — mica.callCard()

Any card with exported functions can be called by other cards via `mica.callCard(cardName, fn, args)`. This turns cards into composable tools: an orchestrator agent delegates to specialist agents, a dashboard pulls from data cards, a workflow chains card operations.

This is the extension mechanism for tool use. Instead of building a registry of tools, every card *is* a potential tool. The card class defines the interface (its named exports); `mica.callCard()` provides the invocation path.

## Open questions
- "Add to any project" model when cards live outside `.mica/`
- When to build the shared primitives library
- Orchestrator as visible canvas card vs sidebar vs both
- Card class versioning and breaking changes
