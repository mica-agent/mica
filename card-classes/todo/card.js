// Todo card — interactive task list with assignments and priorities
// container and mica are provided by CARD_SHIM

const PRIORITIES = ['high', 'medium', 'low', ''];
const PRI_CLASSES = { high: 'todo-pri--high', medium: 'todo-pri--med', low: 'todo-pri--low' };
const PRI_LABELS = { high: 'H', medium: 'M', low: 'L', '': '-' };

// Item state markers in the on-disk .todo file:
//   [ ]  pending  — not started
//   [~]  active   — agent (or user) is working on it right now
//   [x]  done     — completed
//   [!]  failed   — agent attempt failed; user should review/retry
// Only [ ] and [x] are user-toggleable via checkbox; [~] and [!] are
// agent-managed and surface as transient status icons. Backwards
// compatible — existing .todo files using only [ ] / [x] continue to
// work without change.
const STATE_BY_CHAR = { ' ': 'pending', 'x': 'done', '~': 'active', '!': 'failed' };
const CHAR_BY_STATE = { pending: ' ', done: 'x', active: '~', failed: '!' };

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
    } else if (/^- \[( |x|~|!)\]/i.test(line.trim())) {
      const markerMatch = line.trim().match(/^- \[( |x|~|!)\]/i);
      const markerChar = markerMatch ? markerMatch[1].toLowerCase() : ' ';
      const state = STATE_BY_CHAR[markerChar] || 'pending';
      const checked = state === 'done';
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
        index: items.length, checked, state, assignee, text: displayText,
        priority, doneDate, section
      });
    } else {
      otherLines.push(line);
    }
  }
  return { items, otherLines };
}

function buildLine(item) {
  const c = CHAR_BY_STATE[item.state] || (item.checked ? 'x' : ' ');
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
  const inProgress = items.filter(i => i.state === 'active').length;
  const failed = items.filter(i => i.state === 'failed').length;
  const pending = items.filter(i => i.state === 'pending' || (!i.state && !i.checked)).length;
  const done = items.filter(i => i.state === 'done' || (!i.state && i.checked)).length;
  let html = '';
  if (inProgress > 0) html += `<span class="todo-badge todo-inprogress">${inProgress} in progress</span>`;
  if (failed > 0) html += `<span class="todo-badge todo-failed">${failed} failed</span>`;
  if (pending > 0) html += `<span class="todo-badge todo-active">${pending} pending</span>`;
  if (done > 0) html += `<span class="todo-badge todo-done">${done} done</span>`;
  return html;
}

function renderLeadingCell(item) {
  const state = item.state || (item.checked ? 'done' : 'pending');
  if (state === 'active') {
    return `<span class="todo-status todo-status--active" title="Agent is working on this">●</span>`;
  }
  if (state === 'failed') {
    return `<span class="todo-status todo-status--failed" title="Agent attempt failed; click to reset">!</span>`;
  }
  const checkedAttr = state === 'done' ? 'checked' : '';
  return `<input type="checkbox" class="todo-checkbox" data-index="${item.index}" ${checkedAttr} />`;
}

function renderItemHtml(item) {
  const state = item.state || (item.checked ? 'done' : 'pending');
  const stateClass = 'todo-item--' + state;
  const priCls = PRI_CLASSES[item.priority] || '';
  const priLbl = PRI_LABELS[item.priority] || '-';
  const humanActive = item.assignee === 'human' ? ' todo-assign--active' : '';
  const agentActive = item.assignee === 'agent' ? ' todo-assign--active' : '';
  const isCustom = item.assignee && item.assignee !== 'human' && item.assignee !== 'agent';
  const customActive = isCustom ? ' todo-assign--active' : '';
  const customLabel = isCustom ? '@' + escHtml(item.assignee) : '...';

  // For pending/done items: render an interactive checkbox the user can toggle.
  // For active/failed items (agent-managed): render a status glyph instead —
  // a pulsing dot for in-progress, an exclamation for failed. The user can
  // still interact via priority/assignee buttons, just not the state.
  return `<li class="todo-item ${stateClass}" data-index="${item.index}">` +
    renderLeadingCell(item) +
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

// Checkbox toggle — optimistic UI. Only fires for pending/done items
// (agent-managed states render a glyph, not a checkbox).
itemsContainer.addEventListener('change', function(e) {
  const cb = e.target;
  if (!cb.classList.contains('todo-checkbox')) return;
  e.stopPropagation();
  const idx = parseInt(cb.dataset.index);
  items[idx].checked = cb.checked;
  items[idx].state = cb.checked ? 'done' : 'pending';
  if (cb.checked) {
    items[idx].doneDate = new Date().toISOString().split('T')[0];
    items[idx].section = 'done';
  } else {
    items[idx].doneDate = '';
    items[idx].section = 'active';
  }
  saveAndRefresh();
});

// Failed-state glyph: clicking it resets the item to pending so the user
// can ask the agent to retry. Active-state glyph isn't clickable — the
// user has to wait for the agent (or kill the turn) to clear it.
itemsContainer.addEventListener('click', function(e) {
  const t = e.target;
  if (!t.classList.contains('todo-status--failed')) return;
  e.stopPropagation();
  const li = t.closest('.todo-item');
  if (!li) return;
  const idx = parseInt(li.dataset.index);
  items[idx].state = 'pending';
  items[idx].checked = false;
  items[idx].section = 'active';
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
    index: items.length, checked: false, state: 'pending', assignee, text,
    priority: 'medium', doneDate: '', section: 'active'
  });
  saveAndRefresh();
}

addBtn.addEventListener('click', function(e) { e.stopPropagation(); addItem(); });
addInput.addEventListener('keydown', function(e) {
  if (e.key === 'Enter') { e.stopPropagation(); addItem(); }
});
addInput.addEventListener('click', function(e) { e.stopPropagation(); });

// External-change sync — fetch updated content and patch the DOM in place.
// We deliberately do NOT call mica.refresh() here, which would tear down
// and reconstruct the entire card. Repeated rebuilds (e.g. agent flipping
// 18 plan items in sequence) restart every CSS animation from frame 0
// (the in-progress dot flashes "erratically") AND reset scrollTop on the
// items container (the user's scroll fights the agent's writes). The
// in-place patcher updates only the cells that changed, leaving other
// items' animations and scroll position untouched.
function patchItemInPlace(li, item) {
  const state = item.state || (item.checked ? 'done' : 'pending');
  // Update state class without disturbing other classList entries.
  const classes = li.className.split(/\s+/).filter(c => !c.startsWith('todo-item--') || c === 'todo-item');
  classes.push('todo-item--' + state);
  li.className = classes.join(' ');
  // Replace just the leading cell (checkbox or glyph) so an unchanged
  // pulsing dot keeps animating without restart.
  const oldLeading = li.firstElementChild;
  const tmp = window.document.createElement('div');
  tmp.innerHTML = renderLeadingCell(item);
  const newLeading = tmp.firstChild;
  if (oldLeading && newLeading) li.replaceChild(newLeading, oldLeading);
  // Priority button — patch label + class only when changed (cheap to always do).
  const priBtn = li.querySelector('.todo-pri-btn');
  if (priBtn) {
    priBtn.className = 'todo-pri-btn ' + (PRI_CLASSES[item.priority] || '');
    priBtn.textContent = PRI_LABELS[item.priority] || '-';
  }
}

function applyExternalChange(content) {
  const scroll = itemsContainer.scrollTop;
  const parsed = parseItems(content);
  const newItems = parsed.items;

  // Per-item patch is safe only when structural shape (count, sectioning,
  // text, assignee) is unchanged — i.e., the only deltas are state /
  // priority / doneDate. When the agent moves an item between Active and
  // Done sections, or adds / removes an item, fall back to a full
  // re-render of the items container (still cheaper than mica.refresh
  // because the card-shim, channels, and listeners stay alive).
  let canPatch = newItems.length === items.length;
  if (canPatch) {
    for (let i = 0; i < newItems.length; i++) {
      if (newItems[i].section !== items[i].section
          || newItems[i].text !== items[i].text
          || newItems[i].assignee !== items[i].assignee) {
        canPatch = false; break;
      }
    }
  }

  if (canPatch) {
    for (let i = 0; i < newItems.length; i++) {
      const oi = items[i];
      const ni = newItems[i];
      if (oi.state === ni.state && oi.priority === ni.priority && oi.checked === ni.checked) continue;
      const li = itemsContainer.querySelector('.todo-item[data-index="' + i + '"]');
      if (li) patchItemInPlace(li, ni);
      items[i] = ni;
    }
  } else {
    items.length = 0;
    for (let i = 0; i < newItems.length; i++) items.push(newItems[i]);
    otherLines.length = 0;
    for (let i = 0; i < parsed.otherLines.length; i++) otherLines.push(parsed.otherLines[i]);
    itemsContainer.innerHTML = renderItems();
  }

  badgesEl.innerHTML = renderBadges();
  itemsContainer.scrollTop = scroll;
}

const unsub = mica.on('file-changed', function(e) {
  if (e.filename !== mica.filename || mica.isSelfEcho(e)) return;
  mica.files.read(mica.filename)
    .then(applyExternalChange)
    .catch(function(err) { console.error('[todo] external sync failed:', err); });
});

mica.onDestroy(function() {
  unsub();
  if (saveTimer) clearTimeout(saveTimer);
});
