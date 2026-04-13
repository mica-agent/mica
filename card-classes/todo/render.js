/**
 * Todo card class -- interactive task list with assignments and priorities.
 * All logic runs client-side. Saves directly via /api/files.
 *
 * Markdown format (readable by any tool):
 *   ## Active
 *   - [ ] @alice Task description **priority: high**
 *   - [ ] @agent Another task
 *   ## Done
 *   - [x] @agent Completed task **done: 2026-04-12**
 */

export const metadata = { extension: ".todo", badge: "TODO", primaryFile: "tasks.md", defaultTitle: "To Do" };

export const dependencies = {};

// -- Parsing and rebuilding run server-side for initial render --

var PRIORITIES = ["high", "medium", "low", ""];

function parseItems(content) {
  var items = [];
  var section = "active";
  var otherLines = [];
  var lines = content.split("\n");

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    var lower = line.toLowerCase().trim();
    if (lower.startsWith("## active")) { section = "active"; otherLines.push(line); }
    else if (lower.startsWith("## done")) { section = "done"; otherLines.push(line); }
    else if (/^- \[( |x)\]/i.test(line.trim())) {
      var checked = /^- \[x\]/i.test(line.trim());
      var text = line.trim().replace(/^- \[.\]\s*/, "");
      var assigneeMatch = text.match(/^@(\S+)\s+/);
      var assignee = assigneeMatch ? assigneeMatch[1] : "";
      if (assignee) text = text.slice(assigneeMatch[0].length);
      var priMatch = text.match(/\s*\*\*priority:\s*(\w+)\*\*/);
      var priority = priMatch ? priMatch[1].toLowerCase() : "";
      var doneMatch = text.match(/\s*\*\*done:\s*([^*]+)\*\*/);
      var doneDate = doneMatch ? doneMatch[1].trim() : "";
      var displayText = text.replace(/\s*\*\*priority:\s*\w+\*\*/, "").replace(/\s*\*\*done:\s*[^*]+\*\*/, "").trim();
      items.push({ index: items.length, checked: checked, assignee: assignee, text: displayText, priority: priority, doneDate: doneDate, section: section });
    } else {
      otherLines.push(line);
    }
  }
  return { items: items, otherLines: otherLines };
}

function rebuildLine(item) {
  var check = item.checked ? "x" : " ";
  var prefix = item.assignee ? "@" + item.assignee + " " : "";
  var meta = [];
  if (item.priority) meta.push("**priority: " + item.priority + "**");
  if (item.doneDate) meta.push("**done: " + item.doneDate + "**");
  var suffix = meta.length > 0 ? " " + meta.join(" ") : "";
  return "- [" + check + "] " + prefix + item.text + suffix;
}

function rebuildContent(items, otherLines) {
  var lines = [];
  for (var i = 0; i < otherLines.length; i++) {
    var line = otherLines[i];
    lines.push(line);
    var lower = line.toLowerCase().trim();
    if (lower.startsWith("## active")) {
      for (var j = 0; j < items.length; j++) {
        if (!items[j].checked && items[j].section === "active") lines.push(rebuildLine(items[j]));
      }
    } else if (lower.startsWith("## done")) {
      for (var k = 0; k < items.length; k++) {
        if (items[k].checked) lines.push(rebuildLine(items[k]));
      }
    }
  }
  return lines.join("\n") + "\n";
}

function escHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export default function render(content, config) {
  var parsed = parseItems(content);
  var items = parsed.items;
  var active = items.filter(function(i) { return !i.checked; }).length;
  var done = items.filter(function(i) { return i.checked; }).length;

  var badges = '';
  if (active > 0) badges += '<span class="todo-badge todo-active">' + active + ' active</span>';
  if (done > 0) badges += '<span class="todo-badge todo-done">' + done + ' done</span>';
  var badgesHtml = badges ? '<div class="todo-badges">' + badges + '</div>' : '';

  var itemsHtml = '';
  var currentSection = null;
  for (var i = 0; i < items.length; i++) {
    var item = items[i];
    if (item.section !== currentSection) {
      if (currentSection !== null) itemsHtml += '</ul>';
      var label = item.section === 'done' ? 'Done' : 'Active';
      itemsHtml += '<h2 class="todo-section-header">' + label + '</h2><ul class="todo-list">';
      currentSection = item.section;
    }

    var checkedAttr = item.checked ? 'checked' : '';
    var checkedClass = item.checked ? 'todo-item--done' : '';
    var priCls = item.priority === 'high' ? 'todo-pri--high' : item.priority === 'medium' ? 'todo-pri--med' : item.priority === 'low' ? 'todo-pri--low' : '';
    var priLbl = item.priority === 'high' ? 'H' : item.priority === 'medium' ? 'M' : item.priority === 'low' ? 'L' : '-';
    var humanActive = item.assignee === 'human' ? ' todo-assign--active' : '';
    var agentActive = item.assignee === 'agent' ? ' todo-assign--active' : '';
    var isCustom = item.assignee && item.assignee !== 'human' && item.assignee !== 'agent';
    var customActive = isCustom ? ' todo-assign--active' : '';
    var customLabel = isCustom ? '@' + escHtml(item.assignee) : '...';

    itemsHtml += '<li class="todo-item ' + checkedClass + '" data-index="' + item.index + '">' +
      '<input type="checkbox" class="todo-checkbox" data-index="' + item.index + '" ' + checkedAttr + ' />' +
      '<button class="todo-pri-btn ' + priCls + '" data-index="' + item.index + '" title="Priority">' + priLbl + '</button>' +
      '<span class="todo-assign-group" data-index="' + item.index + '">' +
        '<button class="todo-assign-btn todo-assign-human' + humanActive + '" data-index="' + item.index + '" data-assignee="human" title="User">U</button>' +
        '<button class="todo-assign-btn todo-assign-agent' + agentActive + '" data-index="' + item.index + '" data-assignee="agent" title="Agent">A</button>' +
        '<button class="todo-assign-btn todo-assign-custom' + customActive + '" data-index="' + item.index + '" data-assignee="custom" title="Other">' + customLabel + '</button>' +
      '</span>' +
      '<span class="todo-text">' + escHtml(item.text) + '</span>' +
    '</li>';
  }
  if (currentSection !== null) itemsHtml += '</ul>';

  // Embed parsed data for client-side mutations
  var dataJson = JSON.stringify({ items: items, otherLines: parsed.otherLines })
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  return '<div class="card-todo">' +
    badgesHtml + itemsHtml +
    '<div class="todo-add">' +
      '<input type="text" class="todo-add-input" placeholder="Add a task..." />' +
      '<button class="todo-btn todo-btn-add">+ Add</button>' +
    '</div>' +
    '<div id="todo-data" style="display:none" data-items="' + dataJson + '"></div>' +
  '</div>' +

  '<style>' +
    '.card-todo { padding: 8px; }' +
    '.todo-badges { display: flex; gap: 6px; margin-bottom: 6px; }' +
    '.todo-badge { font-size: 11px; padding: 2px 8px; border-radius: 10px; }' +
    '.todo-active { background: rgba(96,165,250,0.2); color: #60a5fa; }' +
    '.todo-done { background: rgba(74,222,128,0.15); color: #4ade80; }' +
    '.todo-section-header { font-size: 12px; margin: 10px 0 4px; color: rgba(255,255,255,0.5); text-transform: uppercase; letter-spacing: 1px; }' +
    '.todo-list { list-style: none; padding: 0; margin: 0 0 8px; }' +
    '.todo-item { display: flex; align-items: center; gap: 6px; padding: 4px 0; border-bottom: 1px solid rgba(255,255,255,0.05); }' +
    '.todo-checkbox { cursor: pointer; accent-color: #4acaa0; flex-shrink: 0; }' +
    '.todo-text { flex: 1; font-size: 13px; }' +
    '.todo-item--done .todo-text { text-decoration: line-through; opacity: 0.4; }' +
    '.todo-assign-group { display: inline-flex; border-radius: 4px; overflow: hidden; border: 1px solid rgba(255,255,255,0.12); flex-shrink: 0; }' +
    '.todo-assign-btn { background: rgba(255,255,255,0.03); border: none; color: rgba(255,255,255,0.25); font-size: 11px; padding: 2px 6px; cursor: pointer; border-right: 1px solid rgba(255,255,255,0.08); opacity: 0.5; }' +
    '.todo-assign-btn:last-child { border-right: none; }' +
    '.todo-assign-btn:hover { background: rgba(255,255,255,0.1); color: rgba(255,255,255,0.8); opacity: 1; }' +
    '.todo-assign--active { background: rgba(96,165,250,0.25); color: #60a5fa; opacity: 1; box-shadow: inset 0 0 0 1px rgba(96,165,250,0.4); }' +
    '.todo-assign-agent.todo-assign--active { background: rgba(74,222,128,0.25); color: #4ade80; box-shadow: inset 0 0 0 1px rgba(74,222,128,0.4); }' +
    '.todo-pri-btn { font-size: 10px; font-weight: 700; width: 18px; height: 18px; display: inline-flex; align-items: center; justify-content: center; border-radius: 3px; border: 1px solid rgba(255,255,255,0.15); background: rgba(255,255,255,0.05); color: #888; cursor: pointer; flex-shrink: 0; }' +
    '.todo-pri--high { background: rgba(248,113,113,0.2); border-color: rgba(248,113,113,0.4); color: #f87171; }' +
    '.todo-pri--med { background: rgba(251,191,36,0.2); border-color: rgba(251,191,36,0.4); color: #fbbf24; }' +
    '.todo-pri--low { background: rgba(74,202,160,0.15); border-color: rgba(74,202,160,0.3); color: #4acaa0; }' +
    '.todo-add { display: flex; gap: 6px; margin-top: 8px; padding-top: 8px; border-top: 1px solid rgba(255,255,255,0.1); }' +
    '.todo-add-input { flex: 1; background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.15); color: #eee; padding: 4px 8px; border-radius: 4px; font-size: 13px; font-family: inherit; }' +
    '.todo-add-input::placeholder { color: rgba(255,255,255,0.3); }' +
    '.todo-btn { background: none; border: 1px solid rgba(255,255,255,0.15); color: #ccc; border-radius: 4px; padding: 2px 8px; cursor: pointer; font-size: 12px; }' +
    '.todo-btn-add { background: rgba(74,202,160,0.2); border-color: rgba(74,202,160,0.4); color: #4acaa0; }' +
  '</style>' +

  '<script>' +
  '(function() {' +
    'var priorities = ["high", "medium", "low", ""];' +

    // Parse/rebuild functions duplicated client-side for mutations
    'function parseLine(line) {' +
      'var checked = /^- \\[x\\]/i.test(line.trim());' +
      'var text = line.trim().replace(/^- \\[.\\]\\s*/, "");' +
      'var am = text.match(/^@(\\S+)\\s+/);' +
      'var assignee = am ? am[1] : "";' +
      'if (assignee) text = text.slice(am[0].length);' +
      'var pm = text.match(/\\s*\\*\\*priority:\\s*(\\w+)\\*\\*/);' +
      'var priority = pm ? pm[1].toLowerCase() : "";' +
      'var dm = text.match(/\\s*\\*\\*done:\\s*([^*]+)\\*\\*/);' +
      'var doneDate = dm ? dm[1].trim() : "";' +
      'text = text.replace(/\\s*\\*\\*priority:\\s*\\w+\\*\\*/, "").replace(/\\s*\\*\\*done:\\s*[^*]+\\*\\*/, "").trim();' +
      'return { checked: checked, assignee: assignee, text: text, priority: priority, doneDate: doneDate };' +
    '}' +

    'function buildLine(item) {' +
      'var c = item.checked ? "x" : " ";' +
      'var p = item.assignee ? "@" + item.assignee + " " : "";' +
      'var meta = [];' +
      'if (item.priority) meta.push("**priority: " + item.priority + "**");' +
      'if (item.doneDate) meta.push("**done: " + item.doneDate + "**");' +
      'var s = meta.length > 0 ? " " + meta.join(" ") : "";' +
      'return "- [" + c + "] " + p + item.text + s;' +
    '}' +

    // Load embedded data
    'var dataEl = container.querySelector("#todo-data");' +
    'var data = JSON.parse(dataEl.dataset.items.replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&quot;/g,\'"\'));' +
    'var items = data.items;' +
    'var otherLines = data.otherLines;' +

    'function rebuildNow() {' +
      'var lines = [];' +
      'for (var i = 0; i < otherLines.length; i++) {' +
        'lines.push(otherLines[i]);' +
        'var lower = otherLines[i].toLowerCase().trim();' +
        'if (lower.startsWith("## active")) {' +
          'for (var j = 0; j < items.length; j++) {' +
            'if (!items[j].checked && items[j].section === "active") lines.push(buildLine(items[j]));' +
          '}' +
        '} else if (lower.startsWith("## done")) {' +
          'for (var k = 0; k < items.length; k++) {' +
            'if (items[k].checked) lines.push(buildLine(items[k]));' +
          '}' +
        '}' +
      '}' +
      'return lines.join("\\n") + "\\n";' +
    '}' +

    'var saveTimer = null;' +
    'function saveAll() {' +
      'if (saveTimer) clearTimeout(saveTimer);' +
      'saveTimer = setTimeout(function() {' +
        'var content = rebuildNow();' +
        'fetch("/api/files/" + encodeURIComponent(mica.filename), {' +
          'method: "PUT",' +
          'headers: { "Content-Type": "application/json" },' +
          'body: JSON.stringify({ content: content, source: mica.windowId })' +
        '}).catch(function(err) { console.error("[todo] save failed:", err); });' +
      '}, 300);' +
    '}' +

    // Checkbox toggle -- optimistic UI
    'container.querySelectorAll(".todo-checkbox").forEach(function(cb) {' +
      'cb.addEventListener("change", function(e) {' +
        'e.stopPropagation();' +
        'var idx = parseInt(cb.dataset.index);' +
        'items[idx].checked = cb.checked;' +
        'if (cb.checked) {' +
          'items[idx].doneDate = new Date().toISOString().split("T")[0];' +
          'items[idx].section = "done";' +
        '} else {' +
          'items[idx].doneDate = "";' +
          'items[idx].section = "active";' +
        '}' +
        'var li = cb.closest(".todo-item");' +
        'if (li) { if (cb.checked) li.classList.add("todo-item--done"); else li.classList.remove("todo-item--done"); }' +
        'if (saveTimer) clearTimeout(saveTimer);' +
        'var content = rebuildNow();' +
        'fetch("/api/files/" + encodeURIComponent(mica.filename), {' +
          'method: "PUT",' +
          'headers: { "Content-Type": "application/json" },' +
          'body: JSON.stringify({ content: content, source: mica.windowId })' +
        '}).then(function() { mica.refresh(); })' +
        '.catch(function(err) { console.error("[todo] save failed:", err); });' +
      '});' +
    '});' +

    // Priority cycle -- optimistic UI
    'var priClasses = { high: "todo-pri--high", medium: "todo-pri--med", low: "todo-pri--low" };' +
    'var priLabels = { high: "H", medium: "M", low: "L", "": "-" };' +
    'container.querySelectorAll(".todo-pri-btn").forEach(function(btn) {' +
      'btn.addEventListener("click", function(e) {' +
        'e.stopPropagation();' +
        'var idx = parseInt(btn.dataset.index);' +
        'var cur = items[idx].priority || "";' +
        'var ni = (priorities.indexOf(cur) + 1) % priorities.length;' +
        'items[idx].priority = priorities[ni];' +
        'btn.className = "todo-pri-btn " + (priClasses[priorities[ni]] || "");' +
        'btn.textContent = priLabels[priorities[ni]] || "-";' +
        'saveAll();' +
      '});' +
    '});' +

    // Assignee buttons -- optimistic UI
    'container.querySelectorAll(".todo-assign-btn").forEach(function(btn) {' +
      'btn.addEventListener("click", function(e) {' +
        'e.stopPropagation();' +
        'var idx = parseInt(btn.dataset.index);' +
        'var assignee = btn.dataset.assignee;' +
        'if (assignee === "custom") {' +
          'var val = prompt("Assign to (name):");' +
          'if (!val || !val.trim()) return;' +
          'assignee = val.trim().replace("@", "");' +
        '}' +
        'items[idx].assignee = assignee;' +
        'var group = btn.closest(".todo-assign-group");' +
        'group.querySelectorAll(".todo-assign-btn").forEach(function(b) { b.classList.remove("todo-assign--active"); });' +
        'if (assignee === "human") group.querySelector(".todo-assign-human").classList.add("todo-assign--active");' +
        'else if (assignee === "agent") group.querySelector(".todo-assign-agent").classList.add("todo-assign--active");' +
        'else {' +
          'var cb = group.querySelector(".todo-assign-custom");' +
          'cb.textContent = "@" + assignee;' +
          'cb.classList.add("todo-assign--active");' +
        '}' +
        'saveAll();' +
      '});' +
    '});' +

    // Add task -- needs refresh to render new DOM element
    'var addInput = container.querySelector(".todo-add-input");' +
    'var addBtn = container.querySelector(".todo-btn-add");' +
    'function addItem() {' +
      'var text = addInput.value.trim();' +
      'if (!text) return;' +
      'addInput.value = "";' +
      'var assignee = "human";' +
      'if (text.charAt(0) === "@") {' +
        'var sp = text.indexOf(" ");' +
        'if (sp > 0) { assignee = text.substring(1, sp); text = text.substring(sp + 1).trim(); }' +
      '}' +
      'items.push({ index: items.length, checked: false, assignee: assignee, text: text, priority: "medium", doneDate: "", section: "active" });' +
      'var content = rebuildNow();' +
      'fetch("/api/files/" + encodeURIComponent(mica.filename), {' +
        'method: "PUT",' +
        'headers: { "Content-Type": "application/json" },' +
        'body: JSON.stringify({ content: content, source: mica.windowId })' +
      '}).then(function() { mica.refresh(); })' +
      '.catch(function(err) { console.error("[todo] save failed:", err); });' +
    '}' +
    'addBtn.addEventListener("click", function(e) { e.stopPropagation(); addItem(); });' +
    'addInput.addEventListener("keydown", function(e) { if (e.key === "Enter") { e.stopPropagation(); addItem(); } });' +
    'addInput.addEventListener("click", function(e) { e.stopPropagation(); });' +

    // Sync from other browsers -- only refresh if someone else changed the file
    'var unsub = mica.on("file-changed", function(e) {' +
      'if (e.filename === mica.filename && e.source !== mica.windowId) mica.refresh();' +
    '});' +
    'mica.onDestroy(function() { unsub(); if (saveTimer) clearTimeout(saveTimer); });' +
  '})();' +
  '</script>';
}
