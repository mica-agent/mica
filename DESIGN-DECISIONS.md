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

An agent's identity is its `brief.md` file — a markdown document in the agent card's directory that defines role, personality, constraints, and instructions. The brief has two parts: agent-specific instructions (how the SDK works, what tools are available) that come from the card class template, and role-specific instructions (what the agent does) that the user customizes after creation.

Brief templates ship with the card class:
```
card-classes/claude-chat/brief-template.md   ← Claude-specific tool instructions
card-classes/pi-chat/brief-template.md       ← Pi-specific tool instructions
```

On instance creation, the template is copied into the card directory as `brief.md`. The user or an orchestrator edits it to specialize the agent. Swapping the card class (Claude → Pi) requires a different template because the SDK capabilities differ, but the role-specific part of the brief is agent-agnostic.

The agent's context is the canvas itself. Agents read the same cards humans see: goal, todo, documents, diagrams. There is no separate "agent memory" — the canvas is the shared context.

## Card class as back of the card

A card has two sides. The **front** is the instance — the user's conversation, the agent's brief, the accumulated state. The **back** is the card class — the `render.js` that defines how the card works, what SDK it connects to, how it renders. The class is the machinery; the instance is the work.

This maps cleanly to the file system: the card class lives in `card-classes/{name}/render.js` (or `.mica/.card-classes/{name}/render.js` for project-specific classes), and the card instance is a directory at the project root.

## Seed cards — `_` prefix convention in card class directories

Seed cards are initial cards created when a new card instance is set up. They're defined by the card class using a simple convention: files prefixed with `_` inside the card class directory are seeds.

```
card-classes/claude-chat/
├── render.js              ← card class code (not a seed)
├── _brief.md              ← seed: copied into new instances
├── _conversation.json     ← seed: initial empty history
└── README.md              ← documentation (not a seed)
```

Cards are created via `mica.createCard('my-agent.claude-chat')`. The system creates the directory and copies seed files automatically:

```
my-agent.claude-chat/
├── brief.md               ← copied from _brief.md
├── conversation.json      ← copied from _conversation.json
```

The agent doesn't need to know about seeds, directory structure, or primary files. One call, fully formed card. After creation, seed files are regular files — editable, deletable, no special treatment. The `_` convention exists only inside card class directories to tell the system what to copy.

Canvas card classes use the same mechanism. A `simple-project` card class has seeds that define the initial project canvas:

```
card-classes/simple-project/
├── render.js
├── _goal.goal/goals.md        ← seeds a goal.goal card
├── _todo.todo/tasks.md        ← seeds a todo.todo card
├── _brief.md/document.md      ← seeds a brief.md card
├── _log.md/document.md        ← seeds a log.md card
```

Different canvas types seed different cards. A hypothetical `sprint.canvas` class would seed `backlog.todo`, `sprint-goal.goal`, `retro.md`. No hardcoded names in the server — the card class owns its seeds.

## Cards as tools — mica.callCard()

Any card with exported functions can be called by other cards via `mica.callCard(cardName, fn, args)`. This turns cards into composable tools: an orchestrator agent delegates to specialist agents, a dashboard pulls from data cards, a workflow chains card operations.

Cards don't need to declare they are callable. Any named export in `render.js` is automatically callable. The render result includes the export list (`exports: ["screenshot", "summarize"]`). An agent discovers callable cards by listing the canvas and checking which cards have exports. No separate registration needed.

## Card classes are arbitrary Node programs

A card class's `render.js` runs inside the project's Docker container as a Node.js module. It can import anything — an AI SDK, a database driver, a web scraper, a machine learning library. It can spawn child processes, open network connections, and use any system package installed in the container.

A card class can wrap any Node program: a Jupyter kernel, a language server, a game engine, a media transcoder. The `render.js` is the adapter between the Mica bridge protocol and whatever the program needs. The container provides the sandbox — filesystem scoping, resource limits, network policy. The card class has full freedom within those boundaries.

## Open questions
- "Add to any project" model when cards live outside `.mica/`
- When to build the shared primitives library
- Card class versioning and breaking changes
- Container idle timeout and lifecycle management
- Card class system dependency declaration (`systemDeps` in manifest)
