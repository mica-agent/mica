/**
 * Todo card class — interactive to-do list with assignments, priorities, and agent integration.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";

export const metadata = { extension: ".todo", badge: "TODO", primaryFile: "tasks.md", seed: true, defaultTitle: "To Do" };

async function agentChat(mica, message) {
  let resultText = "";
  for await (const evt of query({ prompt: message, options: {
    systemPrompt: "You are a helpful assistant. Be concise.",
    tools: ["Bash", "Read", "Write", "Edit"],
    model: "claude-sonnet-4-6",
    maxTurns: 5,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
  }})) {
    if (evt.type === "assistant" && evt.message?.content) {
      for (const block of evt.message.content) {
        if (block.type === "text" && block.text) resultText = block.text;
      }
    }
    if (evt.type === "result" && "result" in evt) {
      resultText = evt.result || resultText;
    }
  }
  return { message: resultText, filesChanged: false };
}

const PRIORITIES = ["high", "medium", "low"];

function parseItems(content) {
  const items = [];
  let section = "active";
  const otherLines = [];

  for (const line of content.split("\n")) {
    const lower = line.toLowerCase().trim();
    if (lower.startsWith("## active")) {
      section = "active";
      otherLines.push(line);
    } else if (lower.startsWith("## blocked")) {
      section = "blocked";
      otherLines.push(line);
    } else if (lower.startsWith("## done")) {
      section = "done";
      otherLines.push(line);
    } else if (/^- \[( |x)\]/i.test(line.trim())) {
      const checked = /^- \[x\]/i.test(line.trim());
      let text = line.trim().replace(/^- \[.\]\s*/, "");
      // Extract assignee
      const assigneeMatch = text.match(/^@(\w+)\s+/);
      const assignee = assigneeMatch ? assigneeMatch[1] : "";
      if (assignee) text = text.slice(assigneeMatch[0].length);
      // Extract priority
      const priMatch = text.match(/(?:\s*\u2014\s*|\s*)\*\*priority:\s*(\w+)\*\*/);
      const priority = priMatch ? priMatch[1].toLowerCase() : "";
      // Extract done date
      const doneMatch = text.match(/(?:\s*\u2014\s*|\s*)\*\*done:\s*([^*]+)\*\*/);
      const doneDate = doneMatch ? doneMatch[1].trim() : "";
      // Strip metadata from display text
      let displayText = text;
      displayText = displayText.replace(/\s*(?:\u2014\s*)?\*\*priority:\s*\w+\*\*/, "");
      displayText = displayText.replace(/\s*(?:\u2014\s*)?\*\*done:\s*[^*]+\*\*/, "");

      items.push({
        index: items.length,
        checked,
        assignee,
        text: displayText.trim(),
        priority,
        doneDate,
        section,
      });
    } else {
      otherLines.push(line);
    }
  }

  return { items, otherLines };
}

function rebuildLine(item) {
  const check = item.checked ? "x" : " ";
  const prefix = item.assignee ? `@${item.assignee} ` : "";
  const metaParts = [];
  if (item.priority) metaParts.push(`**priority: ${item.priority}**`);
  if (item.doneDate) metaParts.push(`**done: ${item.doneDate}**`);
  const suffix = metaParts.length > 0 ? " \u2014 " + metaParts.join(" ") : "";
  return `- [${check}] ${prefix}${item.text}${suffix}`;
}

function rebuildContent(items, otherLines) {
  const lines = [];
  for (const line of otherLines) {
    lines.push(line);
    const lower = line.toLowerCase().trim();
    if (lower.startsWith("## active")) {
      for (const item of items) {
        if (item.section === "active" && !item.checked) lines.push(rebuildLine(item));
      }
    } else if (lower.startsWith("## blocked")) {
      for (const item of items) {
        if (item.section === "blocked" && !item.checked) lines.push(rebuildLine(item));
      }
    } else if (lower.startsWith("## done")) {
      for (const item of items) {
        if (item.checked) lines.push(rebuildLine(item));
      }
    }
  }
  return lines.join("\n") + "\n";
}

function priorityClass(priority) {
  if (priority === "high") return "todo-pri--high";
  if (priority === "medium") return "todo-pri--med";
  if (priority === "low") return "todo-pri--low";
  return "";
}

function priorityLabel(priority) {
  if (priority === "high") return "H";
  if (priority === "medium") return "M";
  if (priority === "low") return "L";
  return "\u2022";
}

export default function render(content, config) {
  const { items } = parseItems(content);

  const active = items.filter(i => !i.checked && i.section === "active").length;
  const blocked = items.filter(i => !i.checked && i.section === "blocked").length;
  const done = items.filter(i => i.checked).length;

  const badges = [];
  if (active > 0) badges.push(`<span class="todo-badge todo-active">${active} active</span>`);
  if (blocked > 0) badges.push(`<span class="todo-badge todo-blocked">${blocked} blocked</span>`);
  if (done > 0) badges.push(`<span class="todo-badge todo-done">${done} done</span>`);

  const badgesHtml = badges.length > 0 ? `<div class="todo-badges">${badges.join("")}</div>` : "";

  let itemsHtml = "";
  let currentSection = null;
  for (const item of items) {
    if (item.section !== currentSection) {
      if (currentSection !== null) itemsHtml += "</ul>";
      const sectionLabel = item.section.charAt(0).toUpperCase() + item.section.slice(1);
      itemsHtml += `<h2>${sectionLabel}</h2><ul class="todo-list">`;
      currentSection = item.section;
    }

    const checkedAttr = item.checked ? "checked" : "";
    const checkedClass = item.checked ? "todo-item--done" : "";
    const priCls = priorityClass(item.priority);
    const priLbl = priorityLabel(item.priority);

    const assigneeVal = item.assignee || "";
    const humanActive = assigneeVal === "human" ? " todo-assign--active" : "";
    const agentActive = assigneeVal === "agent" ? " todo-assign--active" : "";
    const customActive = assigneeVal && assigneeVal !== "human" && assigneeVal !== "agent" ? " todo-assign--active" : "";
    const customLabel = customActive ? `@${assigneeVal}` : "\u270e";

    itemsHtml += `<li class="todo-item ${checkedClass}" data-index="${item.index}">
        <input type="checkbox" class="todo-checkbox" data-index="${item.index}" ${checkedAttr} />
        <button class="todo-pri-btn ${priCls}" data-index="${item.index}" title="Change priority">${priLbl}</button>
        <span class="todo-assign-group" data-index="${item.index}">
            <button class="todo-assign-btn todo-assign-human${humanActive}" data-index="${item.index}" data-assignee="human" title="Assign to human">\ud83d\udc64</button>
            <button class="todo-assign-btn todo-assign-agent${agentActive}" data-index="${item.index}" data-assignee="agent" title="Assign to agent">\ud83e\udd16</button>
            <button class="todo-assign-btn todo-assign-custom${customActive}" data-index="${item.index}" data-assignee="custom" title="Assign to...">${customLabel}</button>
        </span>
        <span class="todo-text">${item.text}</span>
        <span class="todo-actions">
            <button class="todo-btn todo-btn-discuss" data-index="${item.index}" title="Discuss with agent">&#x1f4ac;</button>
        </span>
    </li>`;
  }

  if (currentSection !== null) itemsHtml += "</ul>";

  const addHtml = `<div class="todo-add">
      <input type="text" class="todo-add-input" placeholder="Add a task..." />
      <button class="todo-btn todo-btn-add">+ Add</button>
  </div>`;

  return `
    <div class="card-todo card-todo--interactive">
        ${badgesHtml}
        ${itemsHtml}
        ${addHtml}
    </div>
    <style>
        .card-todo--interactive .todo-badges { display: flex; gap: 6px; margin-bottom: 6px; flex-wrap: wrap; }
        .card-todo--interactive .todo-list { list-style: none; padding: 0; margin: 0 0 8px 0; }
        .card-todo--interactive .todo-item {
            display: flex; align-items: center; gap: 6px;
            padding: 4px 0; border-bottom: 1px solid rgba(255,255,255,0.05);
        }
        .card-todo--interactive .todo-checkbox { cursor: pointer; accent-color: #4acaa0; flex-shrink: 0; }
        .card-todo--interactive .todo-text { flex: 1; }
        .card-todo--interactive .todo-item--done .todo-text { text-decoration: line-through; opacity: 0.5; }
        .card-todo--interactive .todo-assign-group {
            display: inline-flex; border-radius: 4px; overflow: hidden;
            border: 1px solid rgba(255,255,255,0.12); flex-shrink: 0;
        }
        .card-todo--interactive .todo-assign-btn {
            background: rgba(255,255,255,0.03); border: none; color: rgba(255,255,255,0.35);
            font-size: 0.7em; padding: 2px 5px; cursor: pointer; transition: all 0.15s;
            border-right: 1px solid rgba(255,255,255,0.08);
        }
        .card-todo--interactive .todo-assign-btn:last-child { border-right: none; }
        .card-todo--interactive .todo-assign-btn:hover { background: rgba(255,255,255,0.1); color: rgba(255,255,255,0.7); }
        .card-todo--interactive .todo-assign--active { background: rgba(138,170,255,0.15); color: #8af; }
        .card-todo--interactive .todo-assign-agent.todo-assign--active { background: rgba(74,202,160,0.15); color: #4acaa0; }
        .card-todo--interactive .todo-pri-btn {
            font-size: 0.65em; font-weight: 700; width: 18px; height: 18px;
            display: inline-flex; align-items: center; justify-content: center;
            border-radius: 3px; border: 1px solid rgba(255,255,255,0.15);
            background: rgba(255,255,255,0.05); color: #888; cursor: pointer;
            flex-shrink: 0;
        }
        .card-todo--interactive .todo-pri-btn:hover { border-color: rgba(255,255,255,0.4); }
        .card-todo--interactive .todo-pri--high { background: rgba(248,113,113,0.2); border-color: rgba(248,113,113,0.4); color: #f87171; }
        .card-todo--interactive .todo-pri--med { background: rgba(251,191,36,0.2); border-color: rgba(251,191,36,0.4); color: #fbbf24; }
        .card-todo--interactive .todo-pri--low { background: rgba(74,202,160,0.15); border-color: rgba(74,202,160,0.3); color: #4acaa0; }
        .card-todo--interactive .todo-actions { display: flex; gap: 2px; opacity: 0; transition: opacity 0.15s; }
        .card-todo--interactive .todo-item:hover .todo-actions { opacity: 1; }
        .card-todo--interactive .todo-btn {
            background: none; border: 1px solid rgba(255,255,255,0.15); color: #ccc;
            border-radius: 4px; padding: 2px 6px; cursor: pointer; font-size: 0.75em;
        }
        .card-todo--interactive .todo-btn:hover { background: rgba(255,255,255,0.1); color: #fff; }
        .card-todo--interactive .todo-add {
            display: flex; gap: 6px; margin-top: 8px; padding-top: 8px;
            border-top: 1px solid rgba(255,255,255,0.1);
        }
        .card-todo--interactive .todo-add-input {
            flex: 1; background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.15);
            color: #eee; padding: 4px 8px; border-radius: 4px; font-size: 0.85em;
        }
        .card-todo--interactive .todo-add-input::placeholder { color: rgba(255,255,255,0.3); }
        .card-todo--interactive .todo-btn-add { background: rgba(74,202,160,0.2); border-color: rgba(74,202,160,0.4); color: #4acaa0; }
        .card-todo--interactive h2 { font-size: 0.9em; margin: 10px 0 4px; color: rgba(255,255,255,0.6); }
    </style>
    <script>
    (function() {
        if (!container) return;
        const priorities = ['high', 'medium', 'low', ''];

        container.querySelectorAll('.todo-checkbox').forEach(cb => {
            cb.addEventListener('change', (e) => {
                e.stopPropagation();
                mica.call('toggle', { index: parseInt(cb.dataset.index) }).then(() => mica.refresh());
            });
        });

        container.querySelectorAll('.todo-pri-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                e.preventDefault();
                const current = btn.classList.contains('todo-pri--high') ? 'high'
                    : btn.classList.contains('todo-pri--med') ? 'medium'
                    : btn.classList.contains('todo-pri--low') ? 'low' : '';
                const nextIdx = (priorities.indexOf(current) + 1) % priorities.length;
                mica.call('set_priority', { index: parseInt(btn.dataset.index), priority: priorities[nextIdx] }).then(() => mica.refresh());
            });
        });

        container.querySelectorAll('.todo-assign-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                e.preventDefault();
                const idx = parseInt(btn.dataset.index);
                let assignee = btn.dataset.assignee;

                if (assignee === 'custom') {
                    const val = prompt('Assign to (name):');
                    if (!val || !val.trim()) return;
                    assignee = val.trim().replace('@', '');
                }

                const group = btn.closest('.todo-assign-group');
                if (assignee === 'agent') {
                    group.querySelectorAll('.todo-assign-btn').forEach(b => b.disabled = true);
                    const agentBtn = group.querySelector('.todo-assign-agent');
                    agentBtn.textContent = '\u231b';
                    agentBtn.title = 'Agent is evaluating...';
                }

                mica.call('reassign', { index: idx, assignee: assignee }).then(() => mica.refresh()).catch(() => {});
            });
        });

        container.querySelectorAll('.todo-btn-discuss').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                btn.textContent = '...';
                btn.disabled = true;
                mica.call('discuss', { index: parseInt(btn.dataset.index) }).then(result => {
                    btn.textContent = '\ud83d\udcac';
                    btn.disabled = false;
                    if (result && result.message) {
                        alert('Agent says:\\n\\n' + result.message);
                    }
                }).catch(() => {
                    btn.textContent = '\ud83d\udcac';
                    btn.disabled = false;
                });
            });
        });

        const addInput = container.querySelector('.todo-add-input');
        const addBtn = container.querySelector('.todo-btn-add');
        function addItem() {
            const text = addInput.value.trim();
            if (!text) return;
            addInput.value = '';
            mica.call('add_item', { text: text }).then(() => mica.refresh());
        }
        addBtn.addEventListener('click', (e) => { e.stopPropagation(); addItem(); });
        addInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.stopPropagation(); addItem(); }
        });
        addInput.addEventListener('click', (e) => e.stopPropagation());

        // Cross-window sync
        const unsub = mica.on('file-changed', (e) => {
            if (e.filename === mica.filename) mica.refresh();
        });
        mica.onDestroy(() => unsub());
    })();
    </script>
    `;
}

export async function toggle(content, args, mica) {
  const index = args.index ?? -1;
  const { items, otherLines } = parseItems(content);

  if (index >= 0 && index < items.length) {
    const item = items[index];
    item.checked = !item.checked;
    if (item.checked) {
      item.doneDate = new Date().toISOString().split("T")[0];
      item.section = "done";
    } else {
      item.doneDate = "";
      item.section = "active";
    }
  }

  const newContent = rebuildContent(items, otherLines);
  await mica.write('tasks.md', newContent);
  return { ok: true };
}

export async function set_priority(content, args, mica) {
  const index = args.index ?? -1;
  const priority = (args.priority || "").trim().toLowerCase();
  const { items, otherLines } = parseItems(content);

  if (index >= 0 && index < items.length) {
    items[index].priority = PRIORITIES.includes(priority) ? priority : "";
  }

  const newContent = rebuildContent(items, otherLines);
  await mica.write('tasks.md', newContent);
  return { ok: true };
}

export async function reassign(content, args, mica) {
  const index = args.index ?? -1;
  const assignee = (args.assignee || "").trim();
  const { items, otherLines } = parseItems(content);

  if (index >= 0 && index < items.length) {
    items[index].assignee = assignee;
    const newContent = rebuildContent(items, otherLines);
    await mica.write('tasks.md', newContent);

    if (assignee === "agent") {
      const item = items[index];
      const response = await agentChat(mica,
        `A task has been assigned to you from the to-do list: "${item.text}"\n\n` +
        `Priority: ${item.priority || "not set"}\n` +
        `Section: ${item.section}\n\n` +
        `Please evaluate this task:\n` +
        `1. If you can do it now using your tools (write files, create artifacts, etc.), DO IT immediately.\n` +
        `2. If it's blocked or needs human input, move it to the Blocked section in _todo.todo and explain what's needed.\n` +
        `3. When done, mark it complete in _todo.todo.\n\n` +
        `Take action \u2014 don't just discuss.`
      );
      return {
        ok: true,
        agentActed: true,
        message: response?.message || "",
        filesChanged: response?.filesChanged || false,
      };
    }
  } else {
    const newContent = rebuildContent(items, otherLines);
    await mica.write('tasks.md', newContent);
  }

  return { ok: true };
}

export async function add_item(content, args, mica) {
  let text = (args.text || "").trim();
  if (!text) return { ok: false, error: "No text provided" };

  let assignee = "human";
  if (text.startsWith("@")) {
    const parts = text.split(" ", 1);
    assignee = parts[0].replace("@", "");
    text = text.slice(parts[0].length).trim();
  }

  const { items, otherLines } = parseItems(content);
  items.push({
    index: items.length,
    checked: false,
    assignee,
    text,
    priority: "medium",
    doneDate: "",
    section: "active",
  });

  const newContent = rebuildContent(items, otherLines);
  await mica.write('tasks.md', newContent);
  return { ok: true };
}

export async function discuss(content, args, mica) {
  const index = args.index ?? -1;
  const { items } = parseItems(content);

  if (index >= 0 && index < items.length) {
    const item = items[index];
    const prefix = item.assignee ? `@${item.assignee} ` : "";
    const taskText = `${prefix}${item.text}`;
    const response = await agentChat(mica,
      `Let's discuss this task from the to-do list: "${taskText}". ` +
      `What's the best approach? Any blockers or dependencies I should know about? ` +
      `Keep it brief \u2014 2-3 sentences.`
    );
    return { message: response?.message || "No response from agent." };
  }

  return { message: "Item not found." };
}
