/**
 * Calculator card class.
 *
 * calculator.json  — history only (primary file, re-renders card when = pressed)
 * .state.json      — current expr/display (dot-prefixed, never triggers re-render)
 *
 * Each button press writes only to .state.json and returns the new display values.
 * The browser updates the DOM directly from mica.call's return value.
 * Only pressing = writes to calculator.json (history), which re-renders the card.
 */

import fs from "fs";
import path from "path";

export const metadata = {
  extension: ".calculator",
  badge: "CALC",
  primaryFile: "calculator.json",
  defaultTitle: "Calculator",
};

const PROJECT_DIR = process.env.PROJECT_DIR || "/project";

export default function render(content, config) {
  // History from primary file
  let history = [];
  try { history = (JSON.parse(content || "{}").history) || []; } catch {}

  // Current display state from .state.json (does not trigger re-render)
  let expr = "", disp = "0";
  try {
    const st = JSON.parse(fs.readFileSync(
      path.join(PROJECT_DIR, config.filename, ".state.json"), "utf-8"
    ));
    expr = st.expr || ""; disp = st.disp || "0";
  } catch {}

  const histRows = history.slice(-8).reverse().map(h =>
    `<div style="display:flex;justify-content:space-between;padding:2px 0;border-bottom:1px solid rgba(255,255,255,0.05);">
      <span style="color:#8b949e;font-size:11px;font-family:monospace;">${esc(String(h.expr))}</span>
      <span style="color:#58a6ff;font-size:11px;font-family:monospace;">= ${esc(String(h.result))}</span>
    </div>`
  ).join("") || `<div style="color:#484f58;font-size:11px;text-align:center;padding:4px 0;">No history</div>`;

  const BTNS = [
    ["C","fn"], ["±","fn"], ["⌫","fn"], ["÷","op"],
    ["7","num"], ["8","num"], ["9","num"], ["×","op"],
    ["4","num"], ["5","num"], ["6","num"], ["−","op"],
    ["1","num"], ["2","num"], ["3","num"], ["+","op"],
    ["0","num","wide"], [".","num"], ["=","eq"],
  ];
  const COLORS = {
    num: ["#1c2128","#e6edf3"],
    op:  ["#1c2128","#58a6ff"],
    fn:  ["#1c2128","#8b949e"],
    eq:  ["#1d6045","#ffffff"],
  };

  const btnsHtml = BTNS.map(([label, type, wide]) => {
    const [bg, fg] = COLORS[type];
    const span = wide ? "grid-column:span 2;" : "";
    return `<button data-v="${esc(label)}" style="${span}background:${bg};color:${fg};border:none;cursor:pointer;font-size:17px;padding:0;font-family:inherit;">${esc(label)}</button>`;
  }).join("");

  const fs2 = disp.length > 12 ? "16px" : disp.length > 9 ? "20px" : "28px";

  return `
<div style="display:flex;flex-direction:column;height:100%;min-height:340px;background:#0d1117;font-family:-apple-system,BlinkMacSystemFont,system-ui,sans-serif;user-select:none;overflow:hidden;">

  <div style="padding:8px 12px;border-bottom:1px solid #21262d;min-height:52px;max-height:88px;overflow-y:auto;">
    <div id="calc-hist">${histRows}</div>
  </div>

  <div style="padding:10px 14px 6px;border-bottom:1px solid #21262d;flex-shrink:0;">
    <div id="calc-expr" style="color:#484f58;font-size:12px;font-family:monospace;text-align:right;min-height:16px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(expr)}</div>
    <div id="calc-disp" style="color:#e6edf3;font-size:${fs2};font-weight:300;font-family:monospace;text-align:right;line-height:1.2;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(disp)}</div>
  </div>

  <div style="flex:1;display:grid;grid-template-columns:repeat(4,1fr);gap:1px;background:#21262d;min-height:0;align-content:stretch;">
    ${btnsHtml}
  </div>
</div>

<script>
  const dispEl = container.querySelector('#calc-disp');
  const exprEl = container.querySelector('#calc-expr');

  container.querySelectorAll('[data-v]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const label = btn.getAttribute('data-v');
      const r = await mica.call('press', { label });
      if (r && r.disp !== undefined) {
        dispEl.textContent = r.disp;
        dispEl.style.fontSize = r.disp.length > 12 ? '16px' : r.disp.length > 9 ? '20px' : '28px';
        exprEl.textContent = r.expr || '';
      }
    });
  });

  const KEY = {
    '0':'0','1':'1','2':'2','3':'3','4':'4',
    '5':'5','6':'6','7':'7','8':'8','9':'9',
    '+':'+', '-':'−', '*':'×', '/':'÷', '.':'.',
    'Enter':'=', '=':'=', 'Backspace':'⌫', 'Escape':'C'
  };
  const onKey = e => {
    const m = KEY[e.key];
    if (!m) return;
    e.preventDefault();
    const btn = Array.prototype.find.call(
      container.querySelectorAll('[data-v]'),
      b => b.getAttribute('data-v') === m
    );
    if (btn) btn.click();
  };
  document.addEventListener('keydown', onKey);
  mica.onDestroy(() => document.removeEventListener('keydown', onKey));

  const unsub = mica.on('file-changed', e => {
    if (e.filename === mica.filename) mica.refresh();
  });
  mica.onDestroy(() => unsub());
</script>
`;
}

function esc(s) {
  return String(s)
    .replace(/&/g,"&amp;").replace(/</g,"&lt;")
    .replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

// ── Server-side logic ─────────────────────────────────────

function isOp(c) { return c === "+" || c === "−" || c === "×" || c === "÷"; }

function applyPress(state, label) {
  let { expr, disp, evaled } = state;

  if (label === "C") {
    expr = ""; disp = "0"; evaled = false;

  } else if (label === "⌫") {
    if (evaled) {
      expr = ""; disp = "0"; evaled = false;
    } else if (expr.length > 0) {
      expr = expr.slice(0, -1);
      if (expr.length === 0) {
        disp = "0";
      } else {
        const last = expr[expr.length - 1];
        if (isOp(last)) {
          disp = last;
        } else {
          // extract last number segment without lookbehind
          let seg = "";
          for (let i = expr.length - 1; i >= 0; i--) {
            if (isOp(expr[i])) break;
            seg = expr[i] + seg;
          }
          disp = seg || "0";
        }
      }
    }

  } else if (label === "±") {
    if (disp !== "0" && !isOp(disp)) {
      if (disp[0] === "-") { disp = disp.slice(1); expr = expr.slice(1); }
      else { disp = "-" + disp; expr = "-" + expr; }
    }

  } else if (label === "=") {
    if (!expr) return { expr, disp, evaled };
    try {
      const js = expr
        .replace(/×/g, "*").replace(/÷/g, "/").replace(/−/g, "-");
      if (!/^[0-9+\-*/.() ]+$/.test(js)) throw new Error("invalid");
      // eslint-disable-next-line no-new-func
      const result = (new Function("return (" + js + ")"))();
      if (typeof result !== "number" || !isFinite(result)) throw new Error("bad result");
      const fmt = parseFloat(result.toPrecision(10)).toString();
      return { expr: fmt, disp: fmt, evaled: true, histEntry: { expr, result: fmt } };
    } catch {
      return { expr: "", disp: "Error", evaled: false };
    }

  } else if (isOp(label)) {
    evaled = false;
    if (expr.length === 0) {
      expr = "0" + label;
    } else if (isOp(expr[expr.length - 1])) {
      expr = expr.slice(0, -1) + label;
    } else {
      expr += label;
    }
    disp = label;

  } else if (label === ".") {
    evaled = false;
    // find last number segment
    let lastNum = "";
    for (let i = expr.length - 1; i >= 0; i--) {
      if (isOp(expr[i])) break;
      lastNum = expr[i] + lastNum;
    }
    if (lastNum.includes(".")) {
      // already has decimal — do nothing
    } else if (expr === "" || isOp(expr[expr.length - 1])) {
      expr += "0."; disp = "0.";
    } else {
      expr += "."; disp += ".";
    }

  } else {
    // digit
    if (evaled) {
      expr = label; disp = label; evaled = false;
    } else if (expr === "" || isOp(expr[expr.length - 1])) {
      expr += label; disp = label;
    } else if (disp === "0" && expr.length > 0 && !isOp(expr[expr.length - 1])) {
      expr = expr.slice(0, -1) + label; disp = label;
    } else {
      expr += label; disp += label;
    }
  }

  return { expr, disp, evaled };
}

export async function press(content, args, mica) {
  // Read current calc state from .state.json (not primary file — no re-render)
  let state = { expr: "", disp: "0", evaled: false };
  try {
    state = JSON.parse(await mica.read(".state.json"));
  } catch {}

  const next = applyPress(state, args.label);

  // Write state — .state.json is NOT the primary file, so no re-render
  await mica.write(".state.json", JSON.stringify({
    expr: next.expr,
    disp: next.disp,
    evaled: next.evaled,
  }));

  // If = produced a result, append to history in calculator.json (triggers re-render)
  if (next.histEntry) {
    let history = [];
    try { history = JSON.parse(content || "{}").history || []; } catch {}
    history.push(next.histEntry);
    if (history.length > 50) history = history.slice(-50);
    await mica.write("calculator.json", JSON.stringify({ history }, null, 2));
  }

  return { disp: next.disp, expr: next.expr };
}
