# How to author `.mmd` files

A `.mmd` file is **raw Mermaid source — nothing else**. Do NOT wrap it in
markdown headings, code fences, or commentary. The card class passes the entire
file content directly to `mermaid.render()`.

## Correct

```
flowchart TD
    A[Start] --> B{Decide}
    B -->|yes| C[Do thing]
    B -->|no| D[Skip]
```

(That's the literal file content — first line is `flowchart TD`, no fences.)

## Wrong (do not write files like this)

````
# My UX flow

```mmd
flowchart TD
    A --> B
```

```mmd
sequenceDiagram
    User->>Browser: click
```
````

Two problems: (1) markdown wrapping breaks Mermaid's parser, (2) `.mmd` holds
exactly one diagram. If you need multiple, write multiple files
(`flow.mmd`, `seq.mmd`).

## Tips
- Mermaid keywords that start a diagram: `flowchart`, `graph`, `sequenceDiagram`,
  `classDiagram`, `stateDiagram`, `erDiagram`, `gantt`, `pie`, `mindmap`,
  `timeline`, `gitGraph`, `quadrantChart`.
- Avoid emoji or box-drawing chars (╔═╝) inside node labels — they confuse the
  parser. Use plain text.
- Long node labels: use `\n` for line breaks inside `["..."]`.
