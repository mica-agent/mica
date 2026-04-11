---
name: create-card-class
description: Build, create, or implement a card, widget, visualization, chart, dashboard, calculator, game, 3D scene, or any interactive UI component. Use when writing HTML, CSS, JavaScript, Three.js, D3, or Chart.js code for a card. ALWAYS use this skill when coding a card — never write card code without it.
---

# Create a New Card Class

## Steps

1. `mkdir -p /opt/mica/project-card-classes/{name}`
2. Write `spec.md` — what the card does
3. Copy the template render.js: `cp /opt/mica/card-classes/qwen-code-agent/skills/create-card-class/template-render.js /opt/mica/project-card-classes/{name}/render.js`
4. Edit render.js — change ONLY the metadata (extension, badge, title). Do NOT modify the render function.
5. Write `card.html` — your card UI as a **standard HTML file** (this is where ALL your UI code goes)
6. Write `~data.json` — seed data for new instances (e.g. `{}`)
7. Add server exports to render.js if needed (mica.call targets)
8. Test: `curl -s -X POST $MICA_API_URL/api/card-classes/{name}/test -H 'Content-Type: application/json' -d '{"content":"{}"}'` — fix until error is null
9. Create instance: `curl -s -X POST $MICA_API_URL/api/projects/$MICA_PROJECT/canvases/_root/cards -H 'Content-Type: application/json' -d '{"name":"my-thing.{ext}"}'`

## card.html — write standard HTML

This is a normal HTML file. Write it exactly as you would for a standalone web page.
Standard DOM APIs, template literals, ES6+, everything works.

The runtime provides:
- `CARD_DATA` — global variable with the card's data (JSON string from data.json)
- `mica.call(fn, args)` — call server export functions (returns Promise)
- `mica.on('file-changed', cb)` — react to data changes
- `mica.refresh()` — re-render with fresh data
- `document.querySelector()` — auto-scoped to this card
- `window.addEventListener('resize')` — fires on card resize (auto-handled)
- Timers/listeners — auto-cleaned on card removal

### Example: Interactive Chart

```html
<!DOCTYPE html>
<html>
<head>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js"></script>
  <style>
    body { margin: 0; display: flex; flex-direction: column; height: 100vh; font-family: system-ui; background: #0d1117; color: #e6edf3; }
    .header { padding: 8px 12px; border-bottom: 1px solid #333; }
    .chart-area { flex: 1; padding: 8px; min-height: 0; }
    canvas { width: 100% !important; height: 100% !important; }
    button { background: #238636; color: #fff; border: none; border-radius: 4px; padding: 4px 12px; cursor: pointer; }
  </style>
</head>
<body>
  <div class="header">
    <strong>Sales Dashboard</strong>
    <button id="add-btn">Add Random</button>
  </div>
  <div class="chart-area">
    <canvas id="chart"></canvas>
  </div>

  <script>
    // Parse card data
    var data = {};
    try { data = JSON.parse(CARD_DATA); } catch(e) {}
    var labels = data.labels || ['Jan', 'Feb', 'Mar', 'Apr'];
    var values = data.values || [10, 20, 15, 25];

    // Create chart
    var chart = new Chart(document.getElementById('chart'), {
      type: 'bar',
      data: {
        labels: labels,
        datasets: [{ label: 'Sales', data: values, backgroundColor: 'rgba(74, 138, 255, 0.6)' }]
      },
      options: { responsive: true, maintainAspectRatio: false }
    });

    // Add random data point
    document.getElementById('add-btn').addEventListener('click', async function() {
      var month = 'M' + (labels.length + 1);
      labels.push(month);
      values.push(Math.floor(Math.random() * 50) + 5);
      chart.update();
      // Persist to server
      await mica.call('save', { labels: labels, values: values });
    });

    // Refresh when data changes externally
    mica.on('file-changed', function(e) {
      if (e.filename === mica.filename) mica.refresh();
    });
  </script>
</body>
</html>
```

### Example: Three.js 3D Scene

```html
<!DOCTYPE html>
<html>
<head>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"></script>
  <style>
    body { margin: 0; overflow: hidden; background: #000; }
    canvas { display: block; width: 100%; height: 100vh; }
  </style>
</head>
<body>
  <canvas id="viewport"></canvas>

  <script>
    var canvas = document.getElementById('viewport');
    var scene = new THREE.Scene();
    scene.background = new THREE.Color(0x050510);
    var camera = new THREE.PerspectiveCamera(60, canvas.clientWidth / canvas.clientHeight, 0.1, 1000);
    camera.position.set(0, 2, 5);
    var renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true });
    renderer.setSize(canvas.clientWidth, canvas.clientHeight);

    // Add objects
    var geometry = new THREE.SphereGeometry(1, 32, 32);
    var material = new THREE.MeshPhongMaterial({ color: 0x4488ff });
    var sphere = new THREE.Mesh(geometry, material);
    scene.add(sphere);
    scene.add(new THREE.DirectionalLight(0xffffff, 1).position.set(5, 5, 5));
    scene.add(new THREE.AmbientLight(0x333333));

    // Mouse drag controls (OrbitControls not available in r128 CDN)
    var drag = false, px = 0, py = 0, rx = 0, ry = 0.3;
    canvas.addEventListener('mousedown', function(e) { drag = true; px = e.clientX; py = e.clientY; });
    window.addEventListener('mouseup', function() { drag = false; });
    window.addEventListener('mousemove', function(e) {
      if (!drag) return;
      rx += (e.clientX - px) * 0.005;
      ry = Math.max(-1.5, Math.min(1.5, ry + (e.clientY - py) * 0.005));
      px = e.clientX; py = e.clientY;
      var d = camera.position.length();
      camera.position.set(d * Math.sin(rx) * Math.cos(ry), d * Math.sin(ry), d * Math.cos(rx) * Math.cos(ry));
      camera.lookAt(0, 0, 0);
    });

    // Resize
    window.addEventListener('resize', function() {
      camera.aspect = canvas.clientWidth / canvas.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(canvas.clientWidth, canvas.clientHeight);
    });

    // Animation loop
    (function loop() {
      requestAnimationFrame(loop);
      sphere.rotation.y += 0.01;
      renderer.render(scene, camera);
    })();

    // Data sync
    mica.on('file-changed', function(e) {
      if (e.filename === mica.filename) mica.refresh();
    });
  </script>
</body>
</html>
```

## Server exports (in render.js)

Add export functions to render.js for data persistence:

```javascript
export async function save(content, args, mica) {
  await mica.write('data.json', JSON.stringify(args, null, 2));
  return { ok: true };
}
```

Browser calls them via `await mica.call('save', { labels: [...], values: [...] })`.

## mica bridge (available in card.html scripts)

| Method | Description |
|--------|-------------|
| `await mica.call(fn, args)` | Call server export, returns Promise |
| `mica.on(event, cb)` | Subscribe to events. Returns unsubscribe fn |
| `mica.refresh()` | Re-render card with fresh data |
| `mica.filename` | Card filename (string) |

## Server bridge (in render.js exports)

| Method | Description |
|--------|-------------|
| `await mica.read(filename)` | Read file from card directory |
| `await mica.write(filename, content)` | Write file to card directory |
| `await mica.exec(command)` | Run shell command. Returns `{ stdout, stderr, exitCode }` |
| `mica.send(data)` | Broadcast to all browsers |
| `await mica.log(message)` | Append to activity log |
