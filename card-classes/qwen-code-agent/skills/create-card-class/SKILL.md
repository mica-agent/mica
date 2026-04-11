---
name: create-card-class
description: Create a new Mica card class with render.js, spec.md, seed files, and verified rendering. Use when asked to create a new type of card.
---

# Create a New Card Class

## Steps

1. `mkdir -p /opt/mica/project-card-classes/{name}`
2. Write `spec.md` — what the card type does
3. Write `render.js` — **copy the reference template below and modify it**
4. Write `~data.json` (or `~config.json`) — seed data for new instances
5. Test: `curl -s -X POST $MICA_API_URL/api/card-classes/{name}/test -H 'Content-Type: application/json' -d '{"content":"{}"}'` — fix until error is null
6. Create instance: `curl -s -X POST $MICA_API_URL/api/projects/$MICA_PROJECT/canvases/_root/cards -H 'Content-Type: application/json' -d '{"name":"my-thing.{ext}"}'`

## Reference Template — copy and modify this

This is a complete, working card class. Copy it, then change the domain logic.
Every structural decision is correct — do not change the structure, only the content.

```javascript
// ═══════════════════════════════════════════════════════════════
// METADATA — describes the card type
// ═══════════════════════════════════════════════════════════════
export const metadata = {
  extension: ".my-card",       // unique extension for this card type
  badge: "CARD",               // short label shown in card header
  primaryFile: "data.json",    // ALWAYS use .json — never .mmd, .md, .txt
  defaultTitle: "My Card"
};

// ═══════════════════════════════════════════════════════════════
// CDN DEPENDENCIES — loaded as globals before scripts run
// Verify URLs work: curl -sI <url> | head -1
// These become window globals (THREE, Chart, d3, etc.)
// NEVER use <script type="module"> or import statements
// ═══════════════════════════════════════════════════════════════
export const dependencies = {
  scripts: [
    'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js'
  ]
};

// ═══════════════════════════════════════════════════════════════
// RENDER FUNCTION — returns HTML string with ONE script block
// Runs in Node.js. ${...} here is Node.js interpolation (OK).
// ═══════════════════════════════════════════════════════════════
export default function render(content, config) {
  var data = {};
  try { data = JSON.parse(content); } catch(e) {}

  // Server-side data preparation (Node.js — full JS works here)
  var labels = JSON.stringify(data.labels || ['Jan','Feb','Mar']);
  var values = JSON.stringify(data.values || [10, 20, 30]);

  return `
    <div style="display:flex;flex-direction:column;height:100%;min-height:0;">
      <div style="padding:8px 12px;border-bottom:1px solid #333;flex-shrink:0;">
        <strong style="color:#e6edf3;">My Chart</strong>
      </div>
      <div style="flex:1;min-height:0;padding:8px;">
        <canvas id="myChart" style="width:100%;height:100%;"></canvas>
      </div>
    </div>

    <script>
    // ═══════════════════════════════════════════════════════
    // ALL browser code goes in this ONE <script> block.
    //
    // RULES:
    // • Do NOT add <script type="module"> — it will not work
    // • Do NOT use import or require — CDN libs are globals
    // • Do NOT use backtick template literals here — they
    //   conflict with the outer render() template literal.
    //   Use string concatenation instead:
    //     WRONG:  el.innerHTML = \`<div>\${x}</div>\`
    //     RIGHT:  el.innerHTML = '<div>' + x + '</div>'
    // • Do NOT split code across multiple <script> tags
    // • Standard DOM APIs work: document.querySelector,
    //   getElementById, window.addEventListener('resize')
    // ═══════════════════════════════════════════════════════

    // DOM access — standard APIs work (auto-scoped to this card)
    var canvas = document.getElementById('myChart');

    // CDN library is available as a global (loaded via dependencies)
    var chart = new Chart(canvas, {
      type: 'bar',
      data: {
        labels: ${labels},
        datasets: [{
          label: 'Values',
          data: ${values},
          backgroundColor: 'rgba(74, 138, 255, 0.6)'
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false
      }
    });

    // Resize — window.addEventListener('resize') works for card resize
    // (the runtime shim redirects it to the card container automatically)
    window.addEventListener('resize', function() {
      chart.resize();
    });

    // Persist data — call server export functions
    // var result = await mica.call('update_data', { labels: ['A','B'], values: [1,2] });

    // React to external data changes (agent or another card updates data.json)
    mica.on('file-changed', function(e) {
      if (e.filename === mica.filename) mica.refresh();
    });
    </script>
  `;
}

// ═══════════════════════════════════════════════════════════════
// SERVER EXPORTS — called from browser via mica.call('name', args)
// Run in Node.js with full access to mica bridge
// ═══════════════════════════════════════════════════════════════
export async function update_data(content, args, mica) {
  // content = fresh read of primaryFile (re-read on each call)
  // args = arguments from browser mica.call()
  // mica = server bridge (read, write, exec, send, log, createCard)
  var data = {};
  try { data = JSON.parse(content); } catch(e) {}

  data.labels = args.labels || data.labels;
  data.values = args.values || data.values;

  await mica.write('data.json', JSON.stringify(data, null, 2));
  return { ok: true };
}
```

## What the runtime shim handles automatically

You do NOT need to handle these — they just work:
- `document.querySelector()` → auto-scoped to your card
- `window.addEventListener('resize')` → fires on card drag-resize
- `setInterval` / `setTimeout` / `requestAnimationFrame` → auto-cleaned on card removal
- Event listeners on `window` → auto-cleaned on card removal

## Three.js card pattern

For Three.js/WebGL cards, replace the Chart.js example with:
```javascript
export const dependencies = {
  scripts: ['https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js']
  // OrbitControls is NOT available as a CDN global in r128
  // Implement mouse drag controls manually (see template above)
};
```

In the script block:
```javascript
var el = document.getElementById('viewport');
var scene = new THREE.Scene();
var camera = new THREE.PerspectiveCamera(60, el.clientWidth/el.clientHeight, 0.1, 1000);
var renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(el.clientWidth, el.clientHeight);
el.appendChild(renderer.domElement);

// Mouse drag controls (OrbitControls not available in r128 CDN)
var drag=false, px=0, py=0, rx=0, ry=0.3;
renderer.domElement.addEventListener('mousedown', function(e) { drag=true; px=e.clientX; py=e.clientY; });
window.addEventListener('mouseup', function() { drag=false; });
window.addEventListener('mousemove', function(e) {
  if (!drag) return;
  rx += (e.clientX-px)*0.005;
  ry = Math.max(-1.5, Math.min(1.5, ry+(e.clientY-py)*0.005));
  px = e.clientX; py = e.clientY;
  var d = camera.position.length();
  camera.position.set(d*Math.sin(rx)*Math.cos(ry), d*Math.sin(ry), d*Math.cos(rx)*Math.cos(ry));
  camera.lookAt(0,0,0);
});

// Resize — shim handles window resize → card resize
window.addEventListener('resize', function() {
  camera.aspect = el.clientWidth / el.clientHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(el.clientWidth, el.clientHeight);
});

// Animation loop (auto-cleaned by shim on card removal)
(function loop() {
  requestAnimationFrame(loop);
  // update scene...
  renderer.render(scene, camera);
})();

// Data sync
mica.on('file-changed', function(e) {
  if (e.filename === mica.filename) mica.refresh();
});
```

## Browser bridge (mica)

| Method | Description |
|--------|-------------|
| `await mica.call(fn, args)` | Call server export, returns Promise |
| `mica.on(event, cb)` | Subscribe to events. Returns unsubscribe fn |
| `mica.refresh()` | Re-render card with fresh data |
| `mica.onDestroy(cb)` | Cleanup callback (rarely needed — shim auto-cleans) |
| `mica.filename` | Card filename (string) |

## Server bridge (mica)

| Method | Description |
|--------|-------------|
| `await mica.read(filename)` | Read file from card directory |
| `await mica.write(filename, content)` | Write file to card directory |
| `await mica.exec(command)` | Run shell command. Returns `{ stdout, stderr, exitCode }` |
| `mica.send(data)` | Broadcast to all browsers |
| `await mica.log(message)` | Append to activity log |
| `await mica.createCard(name)` | Create new card on canvas |
