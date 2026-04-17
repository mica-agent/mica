// Skills card — browse, edit, create global skills (mica/skills/<category>/<name>/SKILL.md)

var listEl = container.querySelector('#skills-list');
var searchEl = container.querySelector('#skills-search');
var newBtn = container.querySelector('#skills-new');
var editorEl = container.querySelector('#skills-editor');
var editTitleEl = container.querySelector('#skills-edit-title');
var contentEl = container.querySelector('#skills-content');
var saveBtn = container.querySelector('#skills-save');
var deleteBtn = container.querySelector('#skills-delete');
var backBtn = container.querySelector('#skills-back');
var statusEl = container.querySelector('#skills-status');
var promoteBtn = container.querySelector('#skills-promote');

var skills = [];           // [{ category, name, description, hasContent }]
var expanded = {};         // { category: bool }
var current = null;        // { category, name } when editing
var editor = null;         // Toast UI Editor instance (lazy-init)

function ensureEditor() {
  if (editor) return editor;
  editor = new toastui.Editor({
    el: contentEl,
    height: '100%',
    initialEditType: 'wysiwyg',
    previewStyle: 'vertical',
    initialValue: '',
    theme: 'dark',
    usageStatistics: false,
    autofocus: false,
    toolbarItems: [
      ['heading', 'bold', 'italic', 'strike'],
      ['ul', 'ol', 'task'],
      ['table', 'link'],
      ['code', 'codeblock']
    ],
  });
  return editor;
}

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function loadSkills() {
  fetch('/api/skills').then(function(r) { return r.json(); }).then(function(data) {
    skills = data || [];
    render();
  }).catch(function(err) {
    listEl.innerHTML = '<div style="padding:16px;color:#f87171;font-size:12px">Failed to load skills</div>';
    console.error('[skills] load failed:', err);
  });
}

function render() {
  var filter = (searchEl.value || '').toLowerCase().trim();
  var filtered = filter
    ? skills.filter(function(s) {
        return s.name.toLowerCase().indexOf(filter) >= 0
            || s.category.toLowerCase().indexOf(filter) >= 0
            || (s.description || '').toLowerCase().indexOf(filter) >= 0;
      })
    : skills;

  if (filtered.length === 0) {
    listEl.innerHTML = '<div style="padding:16px;color:#8b949e;font-size:12px;text-align:center">No skills' + (filter ? ' match filter' : ' yet') + '</div>';
    return;
  }

  // Group by category
  var byCat = {};
  for (var i = 0; i < filtered.length; i++) {
    var s = filtered[i];
    if (!byCat[s.category]) byCat[s.category] = [];
    byCat[s.category].push(s);
  }

  var html = '';
  var cats = Object.keys(byCat).sort();
  for (var ci = 0; ci < cats.length; ci++) {
    var cat = cats[ci];
    var items = byCat[cat];
    // Auto-expand when filtering
    var isExpanded = !!expanded[cat] || !!filter;
    var arrow = isExpanded ? '▼' : '▶';
    html += '<div style="padding:4px 12px;color:#8b949e;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;cursor:pointer;user-select:none" data-cat="' + escHtml(cat) + '">' +
      arrow + ' ' + escHtml(cat) + ' (' + items.length + ')' +
      '</div>';
    if (isExpanded) {
      for (var si = 0; si < items.length; si++) {
        var item = items[si];
        var desc = item.description || '<em style="color:#6e7681">no description</em>';
        html += '<div data-category="' + escHtml(item.category) + '" data-name="' + escHtml(item.name) + '" ' +
          'style="padding:6px 12px 6px 28px;cursor:pointer;border-left:2px solid transparent" ' +
          'onmouseover="this.style.background=\'rgba(255,255,255,0.04)\';this.style.borderLeftColor=\'#3b82f6\'" ' +
          'onmouseout="this.style.background=\'transparent\';this.style.borderLeftColor=\'transparent\'">' +
          '<div style="color:#e6edf3;font-size:13px;font-weight:500">' + escHtml(item.name) + '</div>' +
          '<div style="color:#8b949e;font-size:11px;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + desc + '</div>' +
          '</div>';
      }
    }
  }
  listEl.innerHTML = html;

  // Wire category toggle
  var catEls = listEl.querySelectorAll('[data-cat]');
  for (var ki = 0; ki < catEls.length; ki++) {
    catEls[ki].addEventListener('click', function(e) {
      var c = e.currentTarget.getAttribute('data-cat');
      expanded[c] = !expanded[c];
      render();
    });
  }
  // Wire skill click to edit
  var skEls = listEl.querySelectorAll('[data-name]');
  for (var ji = 0; ji < skEls.length; ji++) {
    skEls[ji].addEventListener('click', function(e) {
      e.stopPropagation();
      openSkill(e.currentTarget.getAttribute('data-category'), e.currentTarget.getAttribute('data-name'));
    });
  }
}

function openSkill(category, name) {
  current = { category: category, name: name };
  editTitleEl.textContent = category + ' / ' + name;
  statusEl.textContent = 'Loading...';
  editorEl.style.display = 'flex';
  // Show promote button only for project-source skills
  promoteBtn.style.display = category === '(project)' ? '' : 'none';
  ensureEditor();
  editor.setMarkdown('');
  fetch('/api/skills/' + encodeURIComponent(category) + '/' + encodeURIComponent(name))
    .then(function(r) { return r.text(); })
    .then(function(text) {
      editor.setMarkdown(text);
      statusEl.textContent = '';
    })
    .catch(function() { statusEl.textContent = 'Failed to load'; });
}

function promoteSkill() {
  if (!current || current.category !== '(project)') return;
  var cat = prompt('Move to which global category? (e.g. "coding", "research", "general")', 'general');
  if (!cat) return;
  cat = cat.trim();
  if (!cat) return;
  statusEl.textContent = 'Promoting...';
  fetch('/api/skills/promote', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: current.name, category: cat }),
  }).then(function(r) {
    if (!r.ok) return r.json().then(function(j) { throw new Error(j.error || 'Promote failed'); });
    statusEl.textContent = 'Promoted to ' + cat;
    closeEditor();
    loadSkills();
  }).catch(function(err) { statusEl.textContent = 'Error: ' + err.message; });
}

function closeEditor() {
  current = null;
  editorEl.style.display = 'none';
}

function saveSkill() {
  if (!current || !editor) return;
  statusEl.textContent = 'Saving...';
  fetch('/api/skills/' + encodeURIComponent(current.category) + '/' + encodeURIComponent(current.name), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: editor.getMarkdown() }),
  }).then(function(r) {
    if (!r.ok) throw new Error('Save failed');
    statusEl.textContent = 'Saved';
    loadSkills();
  }).catch(function(err) {
    statusEl.textContent = 'Error: ' + err.message;
  });
}

function deleteSkill() {
  if (!current) return;
  if (!confirm('Delete skill ' + current.category + '/' + current.name + '?')) return;
  fetch('/api/skills/' + encodeURIComponent(current.category) + '/' + encodeURIComponent(current.name), {
    method: 'DELETE',
  }).then(function() { closeEditor(); loadSkills(); })
    .catch(function(err) { statusEl.textContent = 'Delete failed: ' + err.message; });
}

function newSkill() {
  var name = prompt('Skill name (e.g. "code-review"):');
  if (!name) return;
  name = name.trim();
  if (!name) return;
  var category = prompt('Category (e.g. "coding", "research", "general"):', 'general');
  if (!category) return;
  category = category.trim();
  if (!category) return;
  var stub = '# ' + name + '\n\n## Description\n\n## When to use\n\n## How to apply\n';
  fetch('/api/skills/' + encodeURIComponent(category) + '/' + encodeURIComponent(name), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: stub }),
  }).then(function() {
    expanded[category] = true;
    loadSkills();
    setTimeout(function() { openSkill(category, name); }, 100);
  }).catch(function(err) { console.error('[skills] create failed:', err); });
}

searchEl.addEventListener('input', function(e) { e.stopPropagation(); render(); });
searchEl.addEventListener('click', function(e) { e.stopPropagation(); });
newBtn.addEventListener('click', function(e) { e.stopPropagation(); newSkill(); });
saveBtn.addEventListener('click', function(e) { e.stopPropagation(); saveSkill(); });
deleteBtn.addEventListener('click', function(e) { e.stopPropagation(); deleteSkill(); });
promoteBtn.addEventListener('click', function(e) { e.stopPropagation(); promoteSkill(); });
backBtn.addEventListener('click', function(e) { e.stopPropagation(); closeEditor(); });

mica.onDestroy(function() {
  if (editor) { try { editor.destroy(); } catch (e) {} editor = null; }
});

loadSkills();
