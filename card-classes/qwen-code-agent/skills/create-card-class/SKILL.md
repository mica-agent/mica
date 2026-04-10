---
name: create-card-class
description: Create a new Mica card class with render.js, spec.md, seed files, and verified rendering
---

# Create a New Card Class

Follow this exact workflow to create a working card class.

## Steps

1. **Read the reference**: `cat /opt/mica/card-classes/CARD_CLASS_QUICKREF.md`
2. **Read a working example**: `cat /opt/mica/card-classes/todo/render.js`
3. **Create the directory**: `mkdir -p /opt/mica/project-card-classes/{name}`
4. **Write spec.md**: Describe what the card type does
5. **Write render.js**: Use the template below as your starting point
6. **Write seed file**: `~{primaryFile}` with sensible default content (e.g. `~data.json` with `{}`)
7. **Test**: Run this command and check the output:
   ```bash
   curl -s -X POST $MICA_API_URL/api/card-classes/{name}/test \
     -H 'Content-Type: application/json' -d '{"content":"{}"}'
   ```
   If `error` is not null, read the error, fix render.js, and re-test. Repeat until clean.
8. **Create an instance**:
   ```bash
   curl -s -X POST $MICA_API_URL/api/projects/$MICA_PROJECT/canvases/_root/cards \
     -H 'Content-Type: application/json' -d '{"name": "my-thing.{ext}"}'
   ```

## render.js Template

```javascript
export const metadata = {
  extension: ".my-card",
  badge: "CARD",
  primaryFile: "data.json"
};

// Optional: CDN libraries (verify URLs with curl -sI first)
export const dependencies = {
  scripts: ['https://cdn.example.com/lib.min.js']
};

export default function render(content, config) {
  // content = string from primaryFile, config = { project, canvas, filename }
  var data = {};
  try { data = JSON.parse(content); } catch(e) {}

  return `
    <div style="display:flex;flex-direction:column;height:100%;min-height:0;">
      <div id="output" style="flex:1;min-height:0;overflow:auto;padding:16px;"></div>
    </div>
    <script>
      // container is pre-defined — NEVER redeclare it
      // Use container.querySelector() — NEVER document.querySelector()
      var el = container.querySelector('#output');
      el.textContent = 'Hello';

      // Call server exports: mica.call('my_export', { key: 'value' })
      // Always clean up timers, listeners, observers
      mica.onDestroy(function() { /* cleanup */ });
    </script>
  `;
}

// Optional: server-side export callable from browser via mica.call('save', {...})
export async function save(content, args, mica) {
  await mica.write('data.json', JSON.stringify(args.data));
  return { ok: true };
}
```

## Sizing: fill the card

Cards are placed on a resizable canvas. Your root element MUST expand to fill the card's dimensions:

```html
<!-- Root element: flex column, height 100% -->
<div style="display:flex;flex-direction:column;height:100%;min-height:0;">
  <!-- Content area: flex:1 fills remaining space -->
  <div id="content" style="flex:1;min-height:0;overflow:auto;"></div>
</div>
```

For canvas/WebGL/Three.js cards, the container and renderer MUST resize with the card:
```javascript
var el = container.querySelector('#canvas-container');
var renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(el.clientWidth, el.clientHeight);
el.appendChild(renderer.domElement);

// CRITICAL: use ResizeObserver, NOT window.addEventListener('resize')
// Cards are resized by dragging on the canvas — this does NOT fire window resize events.
var ro = new ResizeObserver(function() {
  if (el.clientWidth > 0 && el.clientHeight > 0) {
    camera.aspect = el.clientWidth / el.clientHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(el.clientWidth, el.clientHeight);
  }
});
ro.observe(el);

// Always clean up animation frames, observers, and renderer
var animFrame;
function animate() {
  animFrame = requestAnimationFrame(animate);
  renderer.render(scene, camera);
}
animate();

mica.onDestroy(function() {
  ro.disconnect();
  cancelAnimationFrame(animFrame);
  renderer.dispose();
});
```

Do NOT use `window.addEventListener('resize')` — it only fires for browser window resize, not card resize.
Do NOT use fixed pixel widths/heights.
Do NOT skip `mica.onDestroy()` cleanup — animation frames and observers leak without it.

## Common mistakes to avoid

- `document.querySelector()` — use `container.querySelector()` instead
- `const container = ...` — container is already defined, redeclaring it crashes
- `import x from 'y'` in browser scripts — use `dependencies.scripts` for CDN libs
- Calling undefined functions — all functions must be defined in the same file
- Untested CDN URLs — verify with `curl -sI <url> | head -1` before using
- Skipping the test step — always test before creating an instance
- `window.addEventListener('resize')` — WRONG for cards, use `ResizeObserver` on the container
- Missing `mica.onDestroy()` — animation frames, observers, event listeners all leak without cleanup
- Fixed pixel dimensions — use `height:100%;flex:1` to fill the card
