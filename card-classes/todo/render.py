import mica
import re
from datetime import date


PRIORITIES = ["high", "medium", "low"]


def _parse_items(content):
    """Parse todo items from markdown content."""
    items = []
    section = "active"
    other_lines = []

    for line in content.split("\n"):
        lower = line.lower().strip()
        if lower.startswith("## active"):
            section = "active"
            other_lines.append(line)
        elif lower.startswith("## blocked"):
            section = "blocked"
            other_lines.append(line)
        elif lower.startswith("## done"):
            section = "done"
            other_lines.append(line)
        elif re.match(r"^- \[( |x)\]", line.strip(), re.IGNORECASE):
            checked = bool(re.match(r"^- \[x\]", line.strip(), re.IGNORECASE))
            text = re.sub(r"^- \[.\]\s*", "", line.strip())
            # Extract assignee
            assignee_match = re.match(r"@(\w+)\s+", text)
            assignee = assignee_match.group(1) if assignee_match else ""
            if assignee:
                text = text[len(assignee_match.group(0)):]
            # Extract priority (with or without em-dash prefix)
            pri_match = re.search(r"(?:\s*\u2014\s*|\s*)\*\*priority:\s*(\w+)\*\*", text)
            priority = pri_match.group(1).lower() if pri_match else ""
            # Extract done date
            done_match = re.search(r"(?:\s*\u2014\s*|\s*)\*\*done:\s*([^*]+)\*\*", text)
            done_date = done_match.group(1).strip() if done_match else ""
            # Strip all metadata from display text
            display_text = text
            display_text = re.sub(r"\s*(?:\u2014\s*)?\*\*priority:\s*\w+\*\*", "", display_text)
            display_text = re.sub(r"\s*(?:\u2014\s*)?\*\*done:\s*[^*]+\*\*", "", display_text)

            items.append({
                "index": len(items),
                "checked": checked,
                "assignee": assignee,
                "text": display_text.strip(),
                "priority": priority,
                "done_date": done_date,
                "section": section,
            })
        else:
            other_lines.append(line)

    return items, other_lines


def _rebuild_line(item):
    """Rebuild a single todo line from an item dict."""
    check = "x" if item["checked"] else " "
    prefix = f"@{item['assignee']} " if item["assignee"] else ""
    meta_parts = []
    if item["priority"]:
        meta_parts.append(f"**priority: {item['priority']}**")
    if item["done_date"]:
        meta_parts.append(f"**done: {item['done_date']}**")
    suffix = ""
    if meta_parts:
        suffix = " \u2014 " + " ".join(meta_parts)
    return f"- [{check}] {prefix}{item['text']}{suffix}"


def _rebuild_content(items, other_lines):
    """Rebuild the markdown from parsed items."""
    lines = []
    for line in other_lines:
        lines.append(line)
        lower = line.lower().strip()
        if lower.startswith("## active"):
            for item in items:
                if item["section"] == "active" and not item["checked"]:
                    lines.append(_rebuild_line(item))
        elif lower.startswith("## blocked"):
            for item in items:
                if item["section"] == "blocked" and not item["checked"]:
                    lines.append(_rebuild_line(item))
        elif lower.startswith("## done"):
            for item in items:
                if item["checked"]:
                    lines.append(_rebuild_line(item))
    return "\n".join(lines) + "\n"


def _priority_class(priority):
    if priority == "high":
        return "todo-pri--high"
    elif priority == "medium":
        return "todo-pri--med"
    elif priority == "low":
        return "todo-pri--low"
    return ""


def _priority_label(priority):
    if priority == "high":
        return "H"
    elif priority == "medium":
        return "M"
    elif priority == "low":
        return "L"
    return "\u2022"


@mica.render
def render(content, config):
    """Render interactive to-do card."""
    items, _ = _parse_items(content)

    active = sum(1 for i in items if not i["checked"] and i["section"] == "active")
    blocked = sum(1 for i in items if not i["checked"] and i["section"] == "blocked")
    done = sum(1 for i in items if i["checked"])

    badges = []
    if active > 0:
        badges.append(f'<span class="todo-badge todo-active">{active} active</span>')
    if blocked > 0:
        badges.append(f'<span class="todo-badge todo-blocked">{blocked} blocked</span>')
    if done > 0:
        badges.append(f'<span class="todo-badge todo-done">{done} done</span>')

    badges_html = f'<div class="todo-badges">{"".join(badges)}</div>' if badges else ""

    # Build interactive item list
    items_html = ""
    current_section = None
    for item in items:
        if item["section"] != current_section:
            if current_section is not None:
                items_html += "</ul>"
            section_label = item["section"].capitalize()
            items_html += f'<h2>{section_label}</h2><ul class="todo-list">'
            current_section = item["section"]

        checked_attr = "checked" if item["checked"] else ""
        checked_class = "todo-item--done" if item["checked"] else ""
        pri_cls = _priority_class(item["priority"])
        pri_lbl = _priority_label(item["priority"])

        assignee_val = item["assignee"] or ""
        human_active = " todo-assign--active" if assignee_val == "human" else ""
        agent_active = " todo-assign--active" if assignee_val == "agent" else ""
        custom_active = " todo-assign--active" if assignee_val and assignee_val not in ("human", "agent") else ""
        custom_label = f"@{assignee_val}" if custom_active else "\u270e"

        items_html += f'''<li class="todo-item {checked_class}" data-index="{item["index"]}">
            <input type="checkbox" class="todo-checkbox" data-index="{item["index"]}" {checked_attr} />
            <button class="todo-pri-btn {pri_cls}" data-index="{item["index"]}" title="Change priority">{pri_lbl}</button>
            <span class="todo-assign-group" data-index="{item["index"]}">
                <button class="todo-assign-btn todo-assign-human{human_active}" data-index="{item["index"]}" data-assignee="human" title="Assign to human">\U0001f464</button>
                <button class="todo-assign-btn todo-assign-agent{agent_active}" data-index="{item["index"]}" data-assignee="agent" title="Assign to agent">\U0001f916</button>
                <button class="todo-assign-btn todo-assign-custom{custom_active}" data-index="{item["index"]}" data-assignee="custom" title="Assign to...">{custom_label}</button>
            </span>
            <span class="todo-text">{item["text"]}</span>
            <span class="todo-actions">
                <button class="todo-btn todo-btn-discuss" data-index="{item["index"]}" title="Discuss with agent">&#x1f4ac;</button>
            </span>
        </li>'''

    if current_section is not None:
        items_html += "</ul>"

    # Add new item input
    add_html = '''<div class="todo-add">
        <input type="text" class="todo-add-input" placeholder="Add a task..." />
        <button class="todo-btn todo-btn-add">+ Add</button>
    </div>'''

    return f'''
    <div class="card-todo card-todo--interactive">
        {badges_html}
        {items_html}
        {add_html}
    </div>
    <style>
        .card-todo--interactive .todo-badges {{ display: flex; gap: 6px; margin-bottom: 6px; flex-wrap: wrap; }}
        .card-todo--interactive .todo-list {{ list-style: none; padding: 0; margin: 0 0 8px 0; }}
        .card-todo--interactive .todo-item {{
            display: flex; align-items: center; gap: 6px;
            padding: 4px 0; border-bottom: 1px solid rgba(255,255,255,0.05);
        }}
        .card-todo--interactive .todo-checkbox {{ cursor: pointer; accent-color: #4acaa0; flex-shrink: 0; }}
        .card-todo--interactive .todo-text {{ flex: 1; }}
        .card-todo--interactive .todo-item--done .todo-text {{ text-decoration: line-through; opacity: 0.5; }}
        .card-todo--interactive .todo-assign-group {{
            display: inline-flex; border-radius: 4px; overflow: hidden;
            border: 1px solid rgba(255,255,255,0.12); flex-shrink: 0;
        }}
        .card-todo--interactive .todo-assign-btn {{
            background: rgba(255,255,255,0.03); border: none; color: rgba(255,255,255,0.35);
            font-size: 0.7em; padding: 2px 5px; cursor: pointer; transition: all 0.15s;
            border-right: 1px solid rgba(255,255,255,0.08);
        }}
        .card-todo--interactive .todo-assign-btn:last-child {{ border-right: none; }}
        .card-todo--interactive .todo-assign-btn:hover {{ background: rgba(255,255,255,0.1); color: rgba(255,255,255,0.7); }}
        .card-todo--interactive .todo-assign--active {{ background: rgba(138,170,255,0.15); color: #8af; }}
        .card-todo--interactive .todo-assign-agent.todo-assign--active {{ background: rgba(74,202,160,0.15); color: #4acaa0; }}
        .card-todo--interactive .todo-pri-btn {{
            font-size: 0.65em; font-weight: 700; width: 18px; height: 18px;
            display: inline-flex; align-items: center; justify-content: center;
            border-radius: 3px; border: 1px solid rgba(255,255,255,0.15);
            background: rgba(255,255,255,0.05); color: #888; cursor: pointer;
            flex-shrink: 0;
        }}
        .card-todo--interactive .todo-pri-btn:hover {{ border-color: rgba(255,255,255,0.4); }}
        .card-todo--interactive .todo-pri--high {{ background: rgba(248,113,113,0.2); border-color: rgba(248,113,113,0.4); color: #f87171; }}
        .card-todo--interactive .todo-pri--med {{ background: rgba(251,191,36,0.2); border-color: rgba(251,191,36,0.4); color: #fbbf24; }}
        .card-todo--interactive .todo-pri--low {{ background: rgba(74,202,160,0.15); border-color: rgba(74,202,160,0.3); color: #4acaa0; }}
        .card-todo--interactive .todo-actions {{ display: flex; gap: 2px; opacity: 0; transition: opacity 0.15s; }}
        .card-todo--interactive .todo-item:hover .todo-actions {{ opacity: 1; }}
        .card-todo--interactive .todo-btn {{
            background: none; border: 1px solid rgba(255,255,255,0.15); color: #ccc;
            border-radius: 4px; padding: 2px 6px; cursor: pointer; font-size: 0.75em;
        }}
        .card-todo--interactive .todo-btn:hover {{ background: rgba(255,255,255,0.1); color: #fff; }}
        .card-todo--interactive .todo-add {{
            display: flex; gap: 6px; margin-top: 8px; padding-top: 8px;
            border-top: 1px solid rgba(255,255,255,0.1);
        }}
        .card-todo--interactive .todo-add-input {{
            flex: 1; background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.15);
            color: #eee; padding: 4px 8px; border-radius: 4px; font-size: 0.85em;
        }}
        .card-todo--interactive .todo-add-input::placeholder {{ color: rgba(255,255,255,0.3); }}
        .card-todo--interactive .todo-btn-add {{ background: rgba(74,202,160,0.2); border-color: rgba(74,202,160,0.4); color: #4acaa0; }}
        .card-todo--interactive h2 {{ font-size: 0.9em; margin: 10px 0 4px; color: rgba(255,255,255,0.6); }}
    </style>
    <script>
    (function() {{
        // mica and container are injected by WidgetRuntime
        if (!container) return;
        const priorities = ['high', 'medium', 'low', ''];

        // Toggle checkbox
        container.querySelectorAll('.todo-checkbox').forEach(cb => {{
            cb.addEventListener('change', (e) => {{
                e.stopPropagation();
                mica.call('toggle', {{ index: parseInt(cb.dataset.index) }});
            }});
        }});

        // Priority cycle button
        container.querySelectorAll('.todo-pri-btn').forEach(btn => {{
            btn.addEventListener('click', (e) => {{
                e.stopPropagation();
                e.preventDefault();
                const current = btn.classList.contains('todo-pri--high') ? 'high'
                    : btn.classList.contains('todo-pri--med') ? 'medium'
                    : btn.classList.contains('todo-pri--low') ? 'low' : '';
                const nextIdx = (priorities.indexOf(current) + 1) % priorities.length;
                mica.call('set_priority', {{ index: parseInt(btn.dataset.index), priority: priorities[nextIdx] }});
            }});
        }});

        // Assign buttons — human, agent, or custom
        container.querySelectorAll('.todo-assign-btn').forEach(btn => {{
            btn.addEventListener('click', (e) => {{
                e.stopPropagation();
                e.preventDefault();
                const idx = parseInt(btn.dataset.index);
                let assignee = btn.dataset.assignee;

                if (assignee === 'custom') {{
                    const val = prompt('Assign to (name):');
                    if (!val || !val.trim()) return;
                    assignee = val.trim().replace('@', '');
                }}

                // Show working state if assigning to agent
                const group = btn.closest('.todo-assign-group');
                if (assignee === 'agent') {{
                    group.querySelectorAll('.todo-assign-btn').forEach(b => b.disabled = true);
                    const agentBtn = group.querySelector('.todo-assign-agent');
                    agentBtn.textContent = '\u231b';
                    agentBtn.title = 'Agent is evaluating...';
                }}

                mica.call('reassign', {{ index: idx, assignee: assignee }}).then(() => {{}}).catch(() => {{}});
            }});
        }});

        // Discuss button
        container.querySelectorAll('.todo-btn-discuss').forEach(btn => {{
            btn.addEventListener('click', (e) => {{
                e.stopPropagation();
                btn.textContent = '...';
                btn.disabled = true;
                mica.call('discuss', {{ index: parseInt(btn.dataset.index) }}).then(result => {{
                    btn.textContent = '💬';
                    btn.disabled = false;
                    if (result && result.message) {{
                        alert('Agent says:\\n\\n' + result.message);
                    }}
                }}).catch(() => {{
                    btn.textContent = '💬';
                    btn.disabled = false;
                }});
            }});
        }});

        // Add new item
        const addInput = container.querySelector('.todo-add-input');
        const addBtn = container.querySelector('.todo-btn-add');
        function addItem() {{
            const text = addInput.value.trim();
            if (!text) return;
            addInput.value = '';
            mica.call('add_item', {{ text: text }});
        }}
        addBtn.addEventListener('click', (e) => {{ e.stopPropagation(); addItem(); }});
        addInput.addEventListener('keydown', (e) => {{
            if (e.key === 'Enter') {{ e.stopPropagation(); addItem(); }}
        }});
        addInput.addEventListener('click', (e) => e.stopPropagation());
    }})();
    </script>
    '''


@mica.export
def toggle(content, args):
    """Toggle a todo item's checked state."""
    index = args.get("index", -1)
    items, other_lines = _parse_items(content)

    if 0 <= index < len(items):
        item = items[index]
        item["checked"] = not item["checked"]
        if item["checked"]:
            item["done_date"] = date.today().isoformat()
            item["section"] = "done"
        else:
            item["done_date"] = ""
            item["section"] = "active"

    new_content = _rebuild_content(items, other_lines)
    mica.write(new_content)
    return {"ok": True}


@mica.export
def set_priority(content, args):
    """Set priority on a todo item. Cycles: high -> medium -> low -> none."""
    index = args.get("index", -1)
    priority = args.get("priority", "").strip().lower()
    items, other_lines = _parse_items(content)

    if 0 <= index < len(items):
        if priority in PRIORITIES:
            items[index]["priority"] = priority
        else:
            items[index]["priority"] = ""

    new_content = _rebuild_content(items, other_lines)
    mica.write(new_content)
    return {"ok": True}


@mica.export
def reassign(content, args):
    """Reassign a todo item. If reassigned to @agent, the agent immediately evaluates it."""
    index = args.get("index", -1)
    assignee = args.get("assignee", "").strip()
    items, other_lines = _parse_items(content)

    if 0 <= index < len(items):
        items[index]["assignee"] = assignee
        new_content = _rebuild_content(items, other_lines)
        mica.write(new_content)

        # If reassigned to agent, trigger immediate evaluation
        if assignee == "agent":
            item = items[index]
            response = mica.agent.chat(
                f'A task has been assigned to you from the to-do list: "{item["text"]}"\n\n'
                f"Priority: {item['priority'] or 'not set'}\n"
                f"Section: {item['section']}\n\n"
                f"Please evaluate this task:\n"
                f"1. If you can do it now using your tools (write files, create artifacts, etc.), DO IT immediately.\n"
                f"2. If it's blocked or needs human input, move it to the Blocked section in _todo.md and explain what's needed.\n"
                f"3. When done, mark it complete in _todo.md.\n\n"
                f"Take action — don't just discuss."
            )
            return {
                "ok": True,
                "agentActed": True,
                "message": response.get("message", ""),
                "filesChanged": response.get("filesChanged", False),
            }

    else:
        new_content = _rebuild_content(items, other_lines)
        mica.write(new_content)

    return {"ok": True}


@mica.export
def add_item(content, args):
    """Add a new todo item."""
    text = args.get("text", "").strip()
    if not text:
        return {"ok": False, "error": "No text provided"}

    if not text.startswith("@"):
        assignee = "human"
    else:
        parts = text.split(" ", 1)
        assignee = parts[0].replace("@", "")
        text = parts[1] if len(parts) > 1 else ""

    items, other_lines = _parse_items(content)
    items.append({
        "index": len(items),
        "checked": False,
        "assignee": assignee,
        "text": text,
        "priority": "medium",
        "done_date": "",
        "section": "active",
    })

    new_content = _rebuild_content(items, other_lines)
    mica.write(new_content)
    return {"ok": True}


@mica.export
def discuss(content, args):
    """Ask the layer agent to discuss a specific todo item."""
    index = args.get("index", -1)
    items, _ = _parse_items(content)

    if 0 <= index < len(items):
        item = items[index]
        prefix = f"@{item['assignee']} " if item["assignee"] else ""
        task_text = f"{prefix}{item['text']}"
        response = mica.agent.chat(
            f"Let's discuss this task from the to-do list: \"{task_text}\". "
            f"What's the best approach? Any blockers or dependencies I should know about? "
            f"Keep it brief \u2014 2-3 sentences."
        )
        return {"message": response.get("message", "No response from agent.")}

    return {"message": "Item not found."}
