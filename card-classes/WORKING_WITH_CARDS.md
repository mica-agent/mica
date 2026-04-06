# Working with Cards

Cards are the fundamental unit of work in Mica. Every card is a **directory** with an extension that determines its type.

## Project structure

```
~/mica-projects/my-project/
  .mica/                              # Infrastructure (not cards)
    .config.json                      # Project config (canvasCard, settings)
  my-project.project/                 # Canvas card — contains all cards
    project.md                        # Canvas primary file (title/description)
    .layout.json                      # Card positions on the canvas
    goal.goal/                        # Card: project goals
      goals.md                        #   primary file
    todo.todo/                        # Card: task list
      tasks.md
    brief.md/                         # Card: agent instructions
      document.md
    welcome.md/                       # Card: markdown document
      document.md
    architecture.mmd/                 # Card: mermaid diagram
      diagram.mmd
    chat-abc123.claude-chat/          # Card: Claude chat agent
      brief.md/                       #   agent's own brief (also a card)
        document.md
      conversation.json               #   chat history
    my-terminal.terminal/             # Card: terminal session
      transcript.log
```

The canvas card directory (`my-project.project/`) IS the canvas. Its extension (`.project`) determines which card class renders the canvas layout. All child cards live inside it.

## Spec and Brief

Every card has two configuration files:

- **`spec.md`** (class-level) — what this type of card does. Shared by all cards of the same type. Lives in the card class directory. This is the blueprint — an agent can read it to understand or regenerate the card's code.

- **`brief.md`** (instance-level) — what THIS specific card is for. Optional. Lives in the card's own directory. This is the assignment — it tells agents the card's purpose and how to maintain it.

Example: A markdown card's spec says "renders rich text with Toast UI editor." An instance's brief might say "this is the project requirements doc — keep it aligned with goals."

**Reactive briefs:** Writing a brief on any card turns it into a reactive participant. Agents on the canvas read briefs to understand each card's role. A brief like "when goals change, update this document" tells agents to maintain the card when related cards change. The brief is an agent-readable contract.

## Creating cards

Use the `create_card` tool (or `mica.createCard(name)` bridge method):
```
create_card({ name: "my-notes.md" })       → markdown card
create_card({ name: "backend.todo" })       → todo list
create_card({ name: "shell.terminal" })     → terminal
create_card({ name: "agent.claude-chat" })  → Claude chat agent
```

The extension determines the card class. Seed files from the class are copied automatically.

## Reading and writing card content

Use the `read_file` and `write_file` tools:
```
read_file({ filename: "my-notes.md" })      → reads the primary content
write_file({ filename: "my-notes.md", content: "# Hello" })  → updates content
```

These operate on the card's primary file inside its directory. You don't need to know the internal structure.

## Important: do NOT create cards with shell commands

**Wrong:** `echo "content" > my-notes.md` — creates a flat file, not a card directory
**Right:** `create_card({ name: "my-notes.md" })` then `write_file({ filename: "my-notes.md", content: "..." })`

Cards are directories. The tools handle the directory structure. Raw file operations bypass the card system and create broken entries.

## Listing cards

Use `list_files` to see what cards are on the canvas. Each entry is a card directory name with its extension.

## Card types

| Extension | Type | Content |
|-----------|------|---------|
| `.md` | Markdown | Rich text document |
| `.todo` | Todo | Interactive checklist |
| `.goal` | Goal | Project goals with progress |
| `.mmd` | Mermaid | Diagram (raw mermaid syntax — NO markdown fences) |
| `.txt` | Text | Plain text |
| `.html` | HTML | Raw HTML |
| `.terminal` | Terminal | Shell session |
| `.claude-chat` | Claude Chat | AI chat agent |
| `.llama-chat` | Llama Chat | Local LLM chat agent |
| `.project` | Project | Canvas layout (freeform card surface) |
| `.canvas` | Canvas | Nested canvas |

## Content format tips

- **`.mmd` cards**: Write raw mermaid syntax. Do NOT wrap in ` ```mermaid ``` ` fences — the card renders the content directly.
- **`.md` cards**: Write standard markdown.
- **`.todo` cards**: Use markdown checklist format (`- [ ] task`, `- [x] done`).
- **`.goal` cards**: Use markdown with `- [ ]` checklists for progress tracking.
- **`.html` cards**: Write HTML fragments (not full documents). If you write `<!DOCTYPE>`, the body content will be extracted automatically.
