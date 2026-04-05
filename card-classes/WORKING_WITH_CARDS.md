# Working with Cards

Cards are the fundamental unit of work in Mica. Every card is a **directory** with an extension that determines its type.

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

## Content format tips

- **`.mmd` cards**: Write raw mermaid syntax. Do NOT wrap in ` ```mermaid ``` ` fences — the card renders the content directly.
- **`.md` cards**: Write standard markdown.
- **`.todo` cards**: Use markdown checklist format (`- [ ] task`, `- [x] done`).
- **`.goal` cards**: Use markdown with `- [ ]` checklists for progress tracking.
