// DOM elements
const gpuNameEl = container.querySelector('#gpu-name');
const gpuCanvas = container.querySelector('#gpu-graph');
const memCanvas = container.querySelector('#mem-graph');
const tempCanvas = container.querySelector('#temp-graph');
const powerCanvas = container.querySelector('#power-graph');
const gpuValueEl = container.querySelector('#gpu-value');
const memValueEl = container.querySelector('#mem-value');
const tempValueEl = container.querySelector('#temp-value');
const powerValueEl = container.querySelector('#power-value');

// Canvas 2D contexts
const gpuCtx = gpuCanvas.getContext('2d');
const memCtx = memCanvas.getContext('2d');
const tempCtx = tempCanvas.getContext('2d');
const powerCtx = powerCanvas.getContext('2d');

// Time-series data (rolling window, ~60 points = 60 seconds at 1s intervals)
const MAX_POINTS = 60;
const gpuHistory = [];
const memHistory = [];
const tempHistory = [];
const powerHistory = [];

// Process channel
const ch = mica.openChannel("session");

// Resize canvases to match container width
function resizeCanvas(canvas) {
  const rect = canvas.parentElement.getBoundingClientRect();
  const w = Math.floor(rect.width - 32); // account for padding
  canvas.width = Math.max(w, 200);
  canvas.height = 120;
}

// Color helper: green (<70%), yellow (70-90%), red (>90%)
function getColor(pct) {
  if (pct < 70) return '#4caf50';
  if (pct < 90) return '#ffb74d';
  return '#f44336';
}

// Color helper for temperature: green (<70°C), yellow (70-85°C), red (>85°C)
function getTempColor(temp) {
  if (temp < 70) return '#4caf50';
  if (temp < 85) return '#ffb74d';
  return '#f44336';
}

// Color helper for power draw (fixed 10-110W scale)
function getPowerColor(power) {
  const minW = 10, maxW = 110;
  const pct = (power - minW) / (maxW - minW);
  if (pct < 0.5) return '#4caf50';
  if (pct < 0.75) return '#ffb74d';
  return '#f44336';
}

// Draw placeholder text on canvas
function drawPlaceholder(ctx, canvas, text) {
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#1a1a1a';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#888';
  ctx.font = '13px system-ui';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, w / 2, h / 2);
}

// Parse temperature from nvidia-smi (handles 'N/A', empty, numeric)
function parseTemp(val) {
  if (val == null || val === 'N/A' || val === '') return null;
  const n = parseFloat(val);
  return isNaN(n) ? null : n;
}

// Parse power draw from nvidia-smi (handles 'N/A', empty, numeric)
function parsePower(val) {
  if (val == null || val === 'N/A' || val === '') return null;
  const n = parseFloat(val);
  return isNaN(n) ? null : n;
}

// Simple moving average — light pre-smoothing (window=3).
// Averages each point with its immediate neighbors to suppress 1-second noise
// before spline fitting. Keeps the curve responsive: a single spike still shows
// up within 1-2 seconds, just without the jagged edge.
function smooth(data, windowSize) {
  if (data.length < 3) return data.slice();
  windowSize = windowSize || 3;
  const half = Math.floor(windowSize / 2);
  const result = [];
  for (let i = 0; i < data.length; i++) {
    let sum = 0, count = 0;
    for (let j = Math.max(0, i - half); j <= Math.min(data.length - 1, i + half); j++) {
      sum += data[j];
      count++;
    }
    result.push(sum / count);
  }
  return result;
}

// Tangent limiter — clamp the maximum slope at each data point.
// Prevents the spline from producing sharp spikes by limiting how steep
// the tangent can be at each point. Uses the data's overall slope range
// as a reference: if a local slope exceeds 2x the average absolute slope,
// it gets clamped down.
function limitTangents(points, maxSlopeFactor) {
  maxSlopeFactor = maxSlopeFactor || 2.0;
  if (points.length < 3) return points;

  // Compute average absolute slope across all segments
  let totalSlope = 0, count = 0;
  for (let i = 1; i < points.length; i++) {
    const dx = points[i].x - points[i - 1].x;
    const dy = points[i].y - points[i - 1].y;
    if (dx > 0) {
      totalSlope += Math.abs(dy / dx);
      count++;
    }
  }
  const avgSlope = count > 0 ? totalSlope / count : 0;
  const maxSlope = avgSlope * maxSlopeFactor;

  // Compute tangents at each point (central difference for interior, forward/backward for endpoints)
  const tangents = [];
  for (let i = 0; i < points.length; i++) {
    let dx, dy;
    if (i === 0) {
      dx = points[1].x - points[0].x;
      dy = points[1].y - points[0].y;
    } else if (i === points.length - 1) {
      dx = points[i].x - points[i - 1].x;
      dy = points[i].y - points[i - 1].y;
    } else {
      dx = points[i + 1].x - points[i - 1].x;
      dy = points[i + 1].y - points[i - 1].y;
    }
    let slope = dx > 0 ? dy / dx : 0;

    // Clamp to max slope
    if (Math.abs(slope) > maxSlope) {
      slope = Math.sign(slope) * maxSlope;
    }

    tangents.push({ x: dx, y: dy, slope: slope });
  }

  // Return points with clamped tangents baked into the Catmull-Rom control
  // We'll modify the control point computation in catmullRom to use these
  return tangents;
}

// Centripetal Catmull-Rom spline interpolation — C1 continuous, passes through all points.
// Uses α=1.0 (centripetal) to minimize overshoot on sharp peaks and valleys.
// Pre-smoothing and tangent limiting are applied in updateUI before calling this.
function catmullRom(points, numSegments, tangents) {
  numSegments = numSegments || 24;
  if (points.length < 2) return points.slice();

  function dist(p1, p2) {
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  const result = [];
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(points.length - 1, i + 2)];

    const dt0 = dist(p0, p1);
    const dt1 = dist(p1, p2);
    const dt2 = dist(p2, p3);

    // Centripetal time parameters (alpha=1.0)
    const t0 = dt0 > 0 ? -dt0 : -dt1;
    const t1 = 0;
    const t2 = dt1;
    const t3 = dt1 + dt2;

    for (let s = 0; s < numSegments; s++) {
      const t = (s / numSegments) * dt1;

      // Lagrange interpolation with centripetal time values
      const d0 = (t0 - t1) * (t0 - t2) * (t0 - t3);
      const d1 = (t1 - t0) * (t1 - t2) * (t1 - t3);
      const d2 = (t2 - t0) * (t2 - t1) * (t2 - t3);
      const d3 = (t3 - t0) * (t3 - t1) * (t3 - t2);

      const a0 = ((t - t1) * (t - t2) * (t - t3)) / d0;
      const a1 = ((t - t0) * (t - t2) * (t - t3)) / d1;
      const a2 = ((t - t0) * (t - t1) * (t - t3)) / d2;
      const a3 = ((t - t0) * (t - t1) * (t - t2)) / d3;

      const x = a0 * p0.x + a1 * p1.x + a2 * p2.x + a3 * p3.x;
      const y = a0 * p0.y + a1 * p1.y + a2 * p2.y + a3 * p3.y;

      result.push({ x, y });
    }
  }
  result.push(points[points.length - 1]);
  return result;
}

// Pulse animation state per graph
const pulseState = { gpu: 0, mem: 0, temp: 0, power: 0 };

// Draw a time-series line graph on canvas
function drawGraph(ctx, canvas, data, color, opts) {
  opts = opts || {};
  const minVal = opts.minVal != null ? opts.minVal : 0;
  const maxVal = opts.maxVal != null ? opts.maxVal : 100;
  const labelFn = opts.labelFn || function(v) { return v.toFixed(0) + '%'; };
  const yTicks = opts.yTicks || [0, 0.25, 0.5, 0.75, 1.0];
  const graphId = opts.graphId || '';

  const w = canvas.width;
  const h = canvas.height;
  const pad = { top: 16, right: 12, bottom: 20, left: 40 };
  const graphW = w - pad.left - pad.right;
  const graphH = h - pad.top - pad.bottom;

  // Clear
  ctx.clearRect(0, 0, w, h);

  // Background
  ctx.fillStyle = '#1a1a1a';
  ctx.fillRect(0, 0, w, h);

  // Grid lines
  ctx.strokeStyle = '#2a2a2a';
  ctx.lineWidth = 1;
  yTicks.forEach(level => {
    const y = pad.top + graphH * (1 - level);
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(w - pad.right, y);
    ctx.stroke();

    // Y-axis labels
    ctx.fillStyle = '#666';
    ctx.font = '10px system-ui';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText(labelFn(minVal + level * (maxVal - minVal)), pad.left - 6, y);
  });

  if (data.length < 2) {
    // Not enough data yet — show placeholder
    ctx.fillStyle = '#555';
    ctx.font = '12px system-ui';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('waiting for data...', w / 2, h / 2);
    return;
  }

  // Pre-smooth the raw data (light moving average)
  const smoothedData = smooth(data);

  // Convert data to {x, y} points
  const points = smoothedData.map((val, i) => {
    const x = pad.left + (i / (smoothedData.length - 1)) * graphW;
    const clampedVal = Math.max(0, Math.min(val, maxVal));
    const y = pad.top + graphH * (1 - (clampedVal - minVal) / (maxVal - minVal));
    return { x, y };
  });

  // Draw filled area under the Catmull-Rom curve
  const curvePoints = catmullRom(points, 24);
  const gradient = ctx.createLinearGradient(0, pad.top, 0, pad.top + graphH);
  gradient.addColorStop(0, color + '40');
  gradient.addColorStop(1, color + '05');
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.moveTo(pad.left, pad.top + graphH);
  ctx.lineTo(curvePoints[0].x, curvePoints[0].y);
  for (let i = 1; i < curvePoints.length; i++) {
    ctx.lineTo(curvePoints[i].x, curvePoints[i].y);
  }
  ctx.lineTo(pad.left + graphW, pad.top + graphH);
  ctx.closePath();
  ctx.fill();

  // Draw the monotone cubic curve
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(curvePoints[0].x, curvePoints[0].y);
  for (let i = 1; i < curvePoints.length; i++) {
    ctx.lineTo(curvePoints[i].x, curvePoints[i].y);
  }
  ctx.stroke();

  // Draw current value dot — use the same smoothed value the line uses,
  // otherwise the dot sits at the raw value while the curve is smoothed.
  const lastSmoothedVal = smoothedData[smoothedData.length - 1];
  const clampedLast = Math.max(0, Math.min(lastSmoothedVal, maxVal));
  const dotX = pad.left + graphW;
  const dotY = pad.top + graphH * (1 - (clampedLast - minVal) / (maxVal - minVal));

  // Pulse: scale up and fade the dot each cycle
  const pulseKey = graphId || 'default';
  const pulseScale = 1 + pulseState[pulseKey] * 0.5;
  const pulseAlpha = 1 - pulseState[pulseKey] * 0.6;

  // Outer glow ring
  ctx.beginPath();
  ctx.arc(dotX, dotY, 8 * pulseScale, 0, Math.PI * 2);
  ctx.fillStyle = color + Math.round(pulseAlpha * 40).toString(16).padStart(2, '0');
  ctx.fill();

  // Main dot
  ctx.beginPath();
  ctx.arc(dotX, dotY, 4 * pulseScale, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Decay pulse over time
  if (pulseState[pulseKey] > 0) {
    pulseState[pulseKey] = Math.max(0, pulseState[pulseKey] - 0.05);
  }

  // Time labels on X-axis
  ctx.fillStyle = '#555';
  ctx.font = '9px system-ui';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const labelCount = Math.min(5, data.length);
  const step = Math.max(1, Math.floor(data.length / (labelCount - 1 || 1)));
  for (let i = 0; i < data.length; i += step) {
    const x = pad.left + (i / (data.length - 1)) * graphW;
    const secondsAgo = (data.length - 1 - i) * 1;
    ctx.fillText(secondsAgo === 0 ? 'now' : '-' + secondsAgo + 's', x, pad.top + graphH + 6);
  }
}

// Render the "no GPU detected" state. The bash loop probes for
// nvidia-smi at startup and emits {"no_gpu":true} on hosts without
// it (CPU-only dev boxes, generic VMs). Surface it clearly rather
// than letting the graphs sit at "—" indefinitely.
let noGpuRendered = false;
function renderNoGpu(reason) {
  if (noGpuRendered) return;
  noGpuRendered = true;
  gpuNameEl.textContent = "No GPU detected";
  gpuNameEl.style.color = "#888";
  for (const [ctx, canvas] of [
    [gpuCtx, gpuCanvas], [memCtx, memCanvas],
    [tempCtx, tempCanvas], [powerCtx, powerCanvas],
  ]) {
    resizeCanvas(canvas);
    drawPlaceholder(ctx, canvas, reason || "nvidia-smi not on PATH");
  }
  for (const el of [gpuValueEl, memValueEl, tempValueEl, powerValueEl]) {
    el.textContent = "—";
    el.style.color = "#555";
  }
}

// Update UI from JSON data
function updateUI(data) {
  if (data && data.no_gpu) {
    renderNoGpu(data.reason);
    return;
  }
  const gpuUtil = parseFloat(data.gpu_util) || 0;
  const memPct = parseFloat(data.mem_pct) || 0;
  const memUsedMB = parseInt(data.mem_used) || 0;
  const memTotalMB = parseInt(data.mem_total) || 0;
  const temperature = parseTemp(data.temperature);
  const powerDraw = parsePower(data.power_draw);

  // Push to history (roll off old points)
  gpuHistory.push(gpuUtil);
  memHistory.push(memPct);
  if (gpuHistory.length > MAX_POINTS) gpuHistory.shift();
  if (memHistory.length > MAX_POINTS) memHistory.shift();
  if (temperature != null) {
    tempHistory.push(temperature);
    if (tempHistory.length > MAX_POINTS) tempHistory.shift();
  }
  if (powerDraw != null) {
    powerHistory.push(powerDraw);
    if (powerHistory.length > MAX_POINTS) powerHistory.shift();
  }

  const gpuColor = getColor(gpuUtil);
  const memColor = getColor(memPct);

  // Resize canvases to fit container
  resizeCanvas(gpuCanvas);
  resizeCanvas(memCanvas);
  resizeCanvas(tempCanvas);
  resizeCanvas(powerCanvas);

  // Trigger pulse animation on each graph
  pulseState.gpu = 1;
  pulseState.mem = 1;
  pulseState.temp = 1;
  pulseState.power = 1;

  // Draw graphs
  drawGraph(gpuCtx, gpuCanvas, gpuHistory, gpuColor, { graphId: 'gpu' });
  drawGraph(memCtx, memCanvas, memHistory, memColor, { graphId: 'mem' });
  if (temperature != null && tempHistory.length >= 2) {
    const tempColor = getTempColor(temperature);
    drawGraph(tempCtx, tempCanvas, tempHistory, tempColor, {
      minVal: 0,
      maxVal: 100,
      labelFn: function(v) { return v.toFixed(0) + '°C'; },
      graphId: 'temp',
    });
  } else {
    drawPlaceholder(tempCtx, tempCanvas, 'N/A');
  }

  const tempColor = temperature != null ? getTempColor(temperature) : '#555';
  if (powerDraw != null && powerHistory.length >= 2) {
    const powerColor = getPowerColor(powerDraw);
    drawGraph(powerCtx, powerCanvas, powerHistory, powerColor, {
      minVal: 10,
      maxVal: 110,
      labelFn: function(v) { return v.toFixed(0) + ' W'; },
      graphId: 'power',
    });
  } else {
    drawPlaceholder(powerCtx, powerCanvas, 'N/A');
  }

  // Current value text (small, next to label)
  gpuValueEl.textContent = gpuUtil.toFixed(0) + '%';
  gpuValueEl.style.color = gpuColor;

  const memUsedGB = (memUsedMB / 1024 / 1024).toFixed(0);
  const memTotalGB = (memTotalMB / 1024 / 1024).toFixed(0);
  memValueEl.innerHTML = memPct.toFixed(0) + '% used <br>' + memUsedGB + ' GB<br>' + memTotalGB + ' GB total';
  memValueEl.style.color = memColor;

  if (temperature != null) {
    const tempF = (temperature * 9 / 5 + 32).toFixed(1);
    tempValueEl.innerHTML = temperature.toFixed(0) + '°C<br>' + tempF + '°F';
    tempValueEl.style.color = tempColor;
  } else {
    tempValueEl.innerHTML = '—';
    tempValueEl.style.color = '#555';
  }

  const powerColor = powerDraw != null ? getPowerColor(powerDraw) : '#555';
  if (powerDraw != null) {
    powerValueEl.textContent = powerDraw.toFixed(2) + ' W';
    powerValueEl.style.color = powerColor;
  } else {
    powerValueEl.textContent = '—';
    powerValueEl.style.color = '#555';
  }

  // GPU name
  if (data.gpu_name) {
    gpuNameEl.textContent = data.gpu_name;
  }
}

// Handle process messages
ch.onData((msg) => {
  if (msg.type === "idle") {
    gpuValueEl.textContent = '—';
    memValueEl.textContent = '—';
  }
  if (msg.type === "started") {
    // Process started, wait for data
  }
  if (msg.type === "stdout") {
    try {
      const data = JSON.parse(msg.data.trim());
      updateUI(data);
    } catch (e) {
      // Ignore parse errors
    }
  }
  if (msg.type === "exit") {
    gpuValueEl.textContent = 'Exited';
    memValueEl.textContent = 'Exited';
  }
  if (msg.type === "error") {
    gpuValueEl.textContent = 'Error';
    memValueEl.textContent = 'Error';
  }
});

// Start the monitoring process (after onData is registered).
//
// Bash flow:
//   1. Probe nvidia-smi once. If absent, emit {"no_gpu":true} with a
//      reason and exit cleanly. card.js's renderNoGpu() turns the
//      graphs into a "No GPU detected" placeholder rather than
//      letting them sit at "—" indefinitely on hosts without an
//      NVIDIA GPU (CPU-only dev boxes, generic VMs).
//   2. Otherwise enter the 1-second poll loop emitting JSON-per-line.
ch.send({
  type: "start",
  command: "/usr/bin/bash",
  args: ["-c", "if ! command -v nvidia-smi >/dev/null 2>&1; then echo '{\"no_gpu\":true,\"reason\":\"nvidia-smi not found on PATH\"}'; exit 0; fi; if ! nvidia-smi -L >/dev/null 2>&1; then echo '{\"no_gpu\":true,\"reason\":\"nvidia-smi present but no GPU visible\"}'; exit 0; fi; while true; do gpu_info=$(nvidia-smi --query-gpu=utilization.gpu,name,temperature.gpu,power.draw --format=csv,noheader,nounits 2>/dev/null); gpu_util=$(echo \"$gpu_info\" | cut -d',' -f1 | tr -d ' '); gpu_name=$(echo \"$gpu_info\" | cut -d',' -f2 | tr -d ' '); temperature=$(echo \"$gpu_info\" | cut -d',' -f3 | tr -d ' '); power_draw=$(echo \"$gpu_info\" | cut -d',' -f4 | tr -d ' '); mem_total=$(awk '/MemTotal/ {print $2}' /proc/meminfo 2>/dev/null || echo 0); mem_avail=$(awk '/MemAvailable/ {print $2}' /proc/meminfo 2>/dev/null || echo 0); mem_used=$((mem_total - mem_avail)); mem_pct=0; if [ \"$mem_total\" -gt 0 ] 2>/dev/null; then mem_pct=$((mem_used * 100 / mem_total)); fi; echo \"{\\\"gpu_util\\\":$gpu_util,\\\"gpu_name\\\":\\\"$gpu_name\\\",\\\"temperature\\\":\\\"$temperature\\\",\\\"power_draw\\\":\\\"$power_draw\\\",\\\"mem_pct\\\":$mem_pct,\\\"mem_used\\\":$mem_used,\\\"mem_total\\\":$mem_total}\"; sleep 1; done"],
});

// Cleanup
mica.onDestroy(() => {
  try { ch.close(); } catch {}
});