---
name: create-card-class
description: Build, create, or implement a card, widget, visualization, chart, dashboard, calculator, game, 3D scene, or any interactive UI component. Use when asked to build, create, make, or implement anything visual or interactive. Covers design, planning, and implementation.
---

# Create a Card Class

## 1. Understand

Read the canvas cards for context:
- `goal.goal` — project goals
- `todo.todo` — existing tasks
- `architecture.mmd` — system architecture
- `brief.md` — project identity

Ask the user clarifying questions about what they want. Update canvas cards with the plan:
- Add the objective to `goal.goal`
- Add tasks to `todo.todo` with `@agent` and `@user` assignments
- Update `architecture.mmd` if relevant

## 2. Initialize the card class

Use the helper script — it creates the directory, copies the template, and sets metadata:

```bash
bash /opt/mica/card-classes/qwen-code-agent/skills/create-card-class/init-card-class.sh {name} {BADGE} "{Title}"
```

Example: `bash /opt/mica/card-classes/qwen-code-agent/skills/create-card-class/init-card-class.sh moon-orbit 3D "Moon Orbit"`

This creates the directory with render.js and ~data.json ready to go. Do NOT create these files manually.

## 3. Write card.html

This is where ALL your UI code goes. Write a standard HTML file — normal HTML, CSS, JavaScript.

**Before using any CDN library**, use `web_fetch` to look up its API docs for the specific version you're loading. Do NOT assume API signatures from memory — they may be wrong for that version. Example: `web_fetch https://threejs.org/docs/#api/en/math/Color`

The runtime provides these globals:
- `CARD_DATA` — the card's data (JSON string from data.json)
- `mica.call(fn, args)` — call server exports (returns Promise)
- `mica.on('file-changed', cb)` — react when data changes externally
- `mica.refresh()` — re-render card with fresh data
- `mica.filename` — card filename

Standard DOM APIs work: `document.querySelector`, `getElementById`, `window.addEventListener('resize')`, template literals, ES6+, everything.

### Example card.html:

```html
<!DOCTYPE html>
<html>
<head>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js"></script>
  <style>
    body { margin: 0; display: flex; flex-direction: column; height: 100vh; font-family: system-ui; background: #0d1117; color: #e6edf3; }
    .header { padding: 8px 12px; border-bottom: 1px solid #333; }
    .content { flex: 1; padding: 8px; min-height: 0; }
    canvas { width: 100% !important; height: 100% !important; }
    button { background: #238636; color: #fff; border: none; border-radius: 4px; padding: 4px 12px; cursor: pointer; }
  </style>
</head>
<body>
  <div class="header">
    <strong>Sales Dashboard</strong>
    <button id="add-btn">Add Random</button>
  </div>
  <div class="content">
    <canvas id="chart"></canvas>
  </div>

  <script>
    var data = {};
    try { data = JSON.parse(CARD_DATA); } catch(e) {}
    var labels = data.labels || ['Jan', 'Feb', 'Mar', 'Apr'];
    var values = data.values || [10, 20, 15, 25];

    var chart = new Chart(document.getElementById('chart'), {
      type: 'bar',
      data: {
        labels: labels,
        datasets: [{ label: 'Sales', data: values, backgroundColor: 'rgba(74, 138, 255, 0.6)' }]
      },
      options: { responsive: true, maintainAspectRatio: false }
    });

    document.getElementById('add-btn').addEventListener('click', async function() {
      labels.push('M' + (labels.length + 1));
      values.push(Math.floor(Math.random() * 50) + 5);
      chart.update();
      await mica.call('save', { labels: labels, values: values });
    });

    mica.on('file-changed', function(e) {
      if (e.filename === mica.filename) mica.refresh();
    });
  </script>
</body>
</html>
```

### Three.js card.html:

```html
<!DOCTYPE html>
<html>
<head>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"></script>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { width: 100%; height: 100%; overflow: hidden; background: #000; }
    #viewport { display: block; width: 100%; height: 100%; }
  </style>
</head>
<body>
  <div id="viewport"></div>
  <script>
    // Use a div container, not a canvas — let Three.js create and size the canvas
    var el = document.getElementById('viewport');
    var w = el.clientWidth || window.innerWidth;
    var h = el.clientHeight || window.innerHeight;

    var scene = new THREE.Scene();
    scene.background = new THREE.Color(0x050510);
    var camera = new THREE.PerspectiveCamera(60, w / h, 0.1, 1000);
    camera.position.set(0, 2, 5);
    var renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(w, h);
    el.appendChild(renderer.domElement);

    var sphere = new THREE.Mesh(
      new THREE.SphereGeometry(1, 32, 32),
      new THREE.MeshPhongMaterial({ color: 0x4488ff })
    );
    scene.add(sphere);
    scene.add(new THREE.DirectionalLight(0xffffff, 1));
    scene.add(new THREE.AmbientLight(0x333333));

    // Mouse drag (OrbitControls not in r128 CDN)
    var drag = false, px = 0, py = 0, rx = 0, ry = 0.3;
    renderer.domElement.addEventListener('mousedown', function(e) { drag = true; px = e.clientX; py = e.clientY; });
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

    // Resize — fires on card drag-resize (shim handles it)
    window.addEventListener('resize', function() {
      var w = el.clientWidth || window.innerWidth;
      var h = el.clientHeight || window.innerHeight;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    });

    (function loop() {
      requestAnimationFrame(loop);
      sphere.rotation.y += 0.01;
      renderer.render(scene, camera);
    })();

    mica.on('file-changed', function(e) {
      if (e.filename === mica.filename) mica.refresh();
    });
  </script>
</body>
</html>
```

## 4. Add server exports (if needed)

Add export functions to render.js for data persistence:
```javascript
export async function save(content, args, mica) {
  await mica.write('data.json', JSON.stringify(args, null, 2));
  return { ok: true };
}
```

## 5. Test and deploy

Test: `bash /opt/mica/card-classes/qwen-code-agent/skills/create-card-class/test-card-class.sh {name}`

Deploy: `bash /opt/mica/card-classes/qwen-code-agent/skills/create-card-class/deploy-card.sh {name} {instance-name}`

## mica API reference

**Browser (in card.html):**
`mica.call(fn, args)` → Promise | `mica.on(event, cb)` → unsubscribe | `mica.refresh()` | `mica.filename`

**Server (in render.js exports):**
`mica.read(f)` | `mica.write(f, content)` | `mica.exec(cmd)` → {stdout, stderr, exitCode} | `mica.send(data)` | `mica.log(msg)` | `mica.createCard(name)`
