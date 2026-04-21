// Todo card — interactive task list with assignments and priorities
// container and mica are provided by CARD_SHIM

const PRIORITIES = ['high', 'medium', 'low', ''];
const PRI_CLASSES = { high: 'todo-pri--high', medium: 'todo-pri--med', low: 'todo-pri--low' };
const PRI_LABELS = { high: 'H', medium: 'M', low: 'L', '': '-' };

// --- Parsing ---

function parseItems(content) {
  const items = [];
  let section = 'active';
  const otherLines = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lower = line.toLowerCase().trim();
    if (lower.startsWith('## active')) {
      section = 'active';
      otherLines.push(line);
    } else if (lower.startsWith('## done')) {
      section = 'done';
      otherLines.push(line);
    } else if (/^- \[( |x)\]/i.test(line.trim())) {
      const checked = /^- \[x\]/i.test(line.trim());
      let text = line.trim().replace(/^- \[.\]\s*/, '');
      const assigneeMatch = text.match(/^@(\S+)\s+/);
      const assignee = assigneeMatch ? assigneeMatch[1] : '';
      if (assignee) text = text.slice(assigneeMatch[0].length);
      const priMatch = text.match(/\s*\*\*priority:\s*(\w+)\*\*/);
      const priority = priMatch ? priMatch[1].toLowerCase() : '';
      const doneMatch = text.match(/\s*\*\*done:\s*([^*]+)\*\*/);
      const doneDate = doneMatch ? doneMatch[1].trim() : '';
      const displayText = text
        .replace(/\s*\*\*priority:\s*\w+\*\*/, '')
        .replace(/\s*\*\*done:\s*[^*]+\*\*/, '')
        .trim();
      items.push({
        index: items.length, checked, assignee, text: displayText,
        priority, doneDate, section
      });
    } else {
      otherLines.push(line);
    }
  }
  return { items, otherLines };
}

function buildLine(item) {
  const c = item.checked ? 'x' : ' ';
  const prefix = item.assignee ? '@' + item.assignee + ' ' : '';
  const meta = [];
  if (item.priority) meta.push('**priority: ' + item.priority + '**');
  if (item.doneDate) meta.push('**done: ' + item.doneDate + '**');
  const suffix = meta.length > 0 ? ' ' + meta.join(' ') : '';
  return `- [${c}] ${prefix}${item.text}${suffix}`;
}

function rebuildContent(items, otherLines) {
  const lines = [];
  for (let i = 0; i < otherLines.length; i++) {
    lines.push(otherLines[i]);
    const lower = otherLines[i].toLowerCase().trim();
    if (lower.startsWith('## active')) {
      for (let j = 0; j < items.length; j++) {
        if (!items[j].checked && items[j].section === 'active') lines.push(buildLine(items[j]));
      }
    } else if (lower.startsWith('## done')) {
      for (let k = 0; k < items.length; k++) {
        if (items[k].checked) lines.push(buildLine(items[k]));
      }
    }
  }
  return lines.join('\n') + '\n';
}

function escHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// --- Initialize from content ---

const content = await mica.getContent();
const parsed = parseItems(content);
const items = parsed.items;
const otherLines = parsed.otherLines;

// --- Render initial HTML ---

function renderBadges() {
  const active = items.filter(i => !i.checked).length;
  const done = items.filter(i => i.checked).length;
  let html = '';
  if (active > 0) html += `<span class="todo-badge todo-active">${active} active</span>`;
  if (done > 0) html += `<span class="todo-badge todo-done">${done} done</span>`;
  return html;
}

function renderItemHtml(item) {
  const checkedAttr = item.checked ? 'checked' : '';
  const checkedClass = item.checked ? 'todo-item--done' : '';
  const priCls = PRI_CLASSES[item.priority] || '';
  const priLbl = PRI_LABELS[item.priority] || '-';
  const humanActive = item.assignee === 'human' ? ' todo-assign--active' : '';
  const agentActive = item.assignee === 'agent' ? ' todo-assign--active' : '';
  const isCustom = item.assignee && item.assignee !== 'human' && item.assignee !== 'agent';
  const customActive = isCustom ? ' todo-assign--active' : '';
  const customLabel = isCustom ? '@' + escHtml(item.assignee) : '...';

  return `<li class="todo-item ${checkedClass}" data-index="${item.index}">` +
    `<input type="checkbox" class="todo-checkbox" data-index="${item.index}" ${checkedAttr} />` +
    `<button class="todo-pri-btn ${priCls}" data-index="${item.index}" title="Priority">${priLbl}</button>` +
    `<span class="todo-assign-group" data-index="${item.index}">` +
      `<button class="todo-assign-btn todo-assign-human${humanActive}" data-index="${item.index}" data-assignee="human" title="User">U</button>` +
      `<button class="todo-assign-btn todo-assign-agent${agentActive}" data-index="${item.index}" data-assignee="agent" title="Agent">A</button>` +
      `<button class="todo-assign-btn todo-assign-custom${customActive}" data-index="${item.index}" data-assignee="custom" title="Other">${customLabel}</button>` +
    `</span>` +
    `<span class="todo-text">${escHtml(item.text)}</span>` +
  `</li>`;
}

function renderItems() {
  let html = '';
  let currentSection = null;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.section !== currentSection) {
      if (currentSection !== null) html += '</ul>';
      const label = item.section === 'done' ? 'Done' : 'Active';
      html += `<h2 class="todo-section-header">${label}</h2><ul class="todo-list">`;
      currentSection = item.section;
    }
    html += renderItemHtml(item);
  }
  if (currentSection !== null) html += '</ul>';
  return html;
}

const badgesEl = container.querySelector('.todo-badges');
const itemsContainer = container.querySelector('.todo-items-container');
badgesEl.innerHTML = renderBadges();
itemsContainer.innerHTML = renderItems();

// --- Save ---

let saveTimer = null;

function saveAll() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(function() {
    const content = rebuildContent(items, otherLines);
    mica.files.write(mica.filename, content)
      .catch(function(err) { console.error('[todo] save failed:', err); });
  }, 300);
}

function saveAndRefresh() {
  if (saveTimer) clearTimeout(saveTimer);
  const content = rebuildContent(items, otherLines);
  mica.files.write(mica.filename, content)
    .then(function() { mica.refresh(); })
    .catch(function(err) { console.error('[todo] save failed:', err); });
}

// --- Event delegation ---

// Checkbox toggle — optimistic UI
itemsContainer.addEventListener('change', function(e) {
  const cb = e.target;
  if (!cb.classList.contains('todo-checkbox')) return;
  e.stopPropagation();
  const idx = parseInt(cb.dataset.index);
  items[idx].checked = cb.checked;
  if (cb.checked) {
    items[idx].doneDate = new Date().toISOString().split('T')[0];
    items[idx].section = 'done';
  } else {
    items[idx].doneDate = '';
    items[idx].section = 'active';
  }
  const li = cb.closest('.todo-item');
  if (li) {
    if (cb.checked) li.classList.add('todo-item--done');
    else li.classList.remove('todo-item--done');
  }
  saveAndRefresh();
});

// Priority cycle — optimistic UI
itemsContainer.addEventListener('click', function(e) {
  const btn = e.target;
  if (!btn.classList.contains('todo-pri-btn')) return;
  e.stopPropagation();
  const idx = parseInt(btn.dataset.index);
  const cur = items[idx].priority || '';
  const ni = (PRIORITIES.indexOf(cur) + 1) % PRIORITIES.length;
  items[idx].priority = PRIORITIES[ni];
  btn.className = 'todo-pri-btn ' + (PRI_CLASSES[PRIORITIES[ni]] || '');
  btn.textContent = PRI_LABELS[PRIORITIES[ni]] || '-';
  saveAll();
});

// Assignee buttons — optimistic UI
itemsContainer.addEventListener('click', function(e) {
  const btn = e.target;
  if (!btn.classList.contains('todo-assign-btn')) return;
  e.stopPropagation();
  const idx = parseInt(btn.dataset.index);
  let assignee = btn.dataset.assignee;
  if (assignee === 'custom') {
    const val = prompt('Assign to (name):');
    if (!val || !val.trim()) return;
    assignee = val.trim().replace('@', '');
  }
  items[idx].assignee = assignee;
  const group = btn.closest('.todo-assign-group');
  group.querySelectorAll('.todo-assign-btn').forEach(function(b) {
    b.classList.remove('todo-assign--active');
  });
  if (assignee === 'human') {
    group.querySelector('.todo-assign-human').classList.add('todo-assign--active');
  } else if (assignee === 'agent') {
    group.querySelector('.todo-assign-agent').classList.add('todo-assign--active');
  } else {
    const cb = group.querySelector('.todo-assign-custom');
    cb.textContent = '@' + assignee;
    cb.classList.add('todo-assign--active');
  }
  saveAll();
});

// Add task
const addInput = container.querySelector('.todo-add-input');
const addBtn = container.querySelector('.todo-btn-add');

function addItem() {
  let text = addInput.value.trim();
  if (!text) return;
  addInput.value = '';
  let assignee = 'human';
  if (text.charAt(0) === '@') {
    const sp = text.indexOf(' ');
    if (sp > 0) {
      assignee = text.substring(1, sp);
      text = text.substring(sp + 1).trim();
    }
  }
  items.push({
    index: items.length, checked: false, assignee, text,
    priority: 'medium', doneDate: '', section: 'active'
  });
  saveAndRefresh();
}

addBtn.addEventListener('click', function(e) { e.stopPropagation(); addItem(); });
addInput.addEventListener('keydown', function(e) {
  if (e.key === 'Enter') { e.stopPropagation(); addItem(); }
});
addInput.addEventListener('click', function(e) { e.stopPropagation(); });

// Sync from other browsers — only refresh if someone else changed the file
const unsub = mica.on('file-changed', function(e) {
  if (e.filename === mica.filename && !mica.isSelfEcho(e)) mica.refresh();
});

mica.onDestroy(function() {
  unsub();
  if (saveTimer) clearTimeout(saveTimer);
});
