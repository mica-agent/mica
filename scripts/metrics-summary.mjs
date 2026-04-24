#!/usr/bin/env node
// metrics-summary.mjs — aggregate turn + subagent JSONL into a CLI report.
//
// Usage: node scripts/metrics-summary.mjs <project-path>
//
// Reads:
//   <project-path>/.mica/metrics/turns.jsonl
//   <project-path>/.mica/metrics/subagents.jsonl
//
// Prints turn counts, duration/TTFT/token distributions, subagent fan-out,
// tool-call breakdown, and cursor-advance count. Run before + after a
// tuning change (e.g. --cache-ram) to compare.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";

const projectPath = process.argv[2];
if (!projectPath) {
  console.error("Usage: node scripts/metrics-summary.mjs <project-path>");
  process.exit(1);
}

async function readJsonl(path) {
  try {
    const raw = await readFile(path, "utf-8");
    return raw.split("\n").filter(Boolean).map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
}

function quantile(sorted, q) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(Math.floor(sorted.length * q), sorted.length - 1);
  return sorted[idx];
}

function stats(values) {
  if (values.length === 0) return { avg: 0, p50: 0, p95: 0, max: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((s, v) => s + v, 0);
  return {
    avg: Math.round(sum / sorted.length),
    p50: quantile(sorted, 0.50),
    p95: quantile(sorted, 0.95),
    max: sorted[sorted.length - 1],
  };
}

function fmtRow(label, { avg, p50, p95, max }, unit = "ms") {
  const pad = (n) => String(n).padStart(7);
  return `  ${label.padEnd(14)} avg ${pad(avg)}${unit}   p50 ${pad(p50)}${unit}   p95 ${pad(p95)}${unit}   max ${pad(max)}${unit}`;
}

const turnsPath = join(projectPath, ".mica", "metrics", "turns.jsonl");
const subagentsPath = join(projectPath, ".mica", "metrics", "subagents.jsonl");

const [turns, subagents] = await Promise.all([
  readJsonl(turnsPath),
  readJsonl(subagentsPath),
]);

if (turns.length === 0) {
  console.log(`No turns recorded at ${turnsPath}`);
  process.exit(0);
}

const successTurns = turns.filter((t) => t.input_tokens > 0 || t.output_tokens > 0 || t.baseline_tokens > 0);
const ttftValues = turns.map((t) => t.ttft_ms).filter((v) => typeof v === "number");

console.log(`Turns: ${turns.length} total (${successTurns.length} with token data, ${turns.length - successTurns.length} error/empty)`);
console.log(`Subagents: ${subagents.length} invocations`);
console.log();

console.log("Timing:");
console.log(fmtRow("duration", stats(turns.map((t) => t.duration_ms))));
console.log(fmtRow("ttft", stats(ttftValues)));
console.log();

console.log("Tokens (success turns):");
console.log(fmtRow("input", stats(successTurns.map((t) => t.input_tokens)), " "));
console.log(fmtRow("output", stats(successTurns.map((t) => t.output_tokens)), " "));
console.log(fmtRow("baseline", stats(successTurns.map((t) => t.baseline_tokens)), " "));
const totalIn = successTurns.reduce((s, t) => s + (t.input_tokens || 0), 0);
const totalOut = successTurns.reduce((s, t) => s + (t.output_tokens || 0), 0);
console.log(`  total          input ${totalIn}   output ${totalOut}`);
console.log();

const fanOut = { 0: 0, 1: 0, 2: 0, "3+": 0 };
for (const t of turns) {
  const c = t.subagent_count || 0;
  if (c === 0) fanOut[0]++;
  else if (c === 1) fanOut[1]++;
  else if (c === 2) fanOut[2]++;
  else fanOut["3+"]++;
}
console.log("Subagent fan-out per turn:");
for (const [k, v] of Object.entries(fanOut)) {
  const pct = turns.length > 0 ? Math.round((v / turns.length) * 100) : 0;
  console.log(`  ${String(k).padEnd(4)} ${String(v).padStart(4)} turns  (${pct}%)`);
}
console.log();

if (subagents.length > 0) {
  console.log("Subagent durations:");
  console.log(fmtRow("subagent", stats(subagents.map((s) => s.duration_ms))));
  const byName = new Map();
  for (const s of subagents) {
    byName.set(s.subagent_name, (byName.get(s.subagent_name) || 0) + 1);
  }
  console.log("  by name:");
  for (const [name, count] of [...byName.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${name.padEnd(20)} ${count}`);
  }
  console.log();
}

const toolTotals = new Map();
for (const t of turns) {
  for (const [name, count] of Object.entries(t.tool_calls || {})) {
    toolTotals.set(name, (toolTotals.get(name) || 0) + count);
  }
}
if (toolTotals.size > 0) {
  console.log("Tool calls (totals across all turns):");
  for (const [name, count] of [...toolTotals.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${name.padEnd(20)} ${count}`);
  }
  console.log();
}

const cursorAdvances = turns.filter((t) => t.cursor_advanced).length;
const arcCompletes = turns.filter((t) => t.arc_complete).length;
console.log("Context cursor:");
console.log(`  arc-complete markers: ${arcCompletes} turns`);
console.log(`  cursor advanced:      ${cursorAdvances} turns`);
if (successTurns.length > 0) {
  const capacities = successTurns.map((t) => t.capacity).filter((c) => c > 0);
  if (capacities.length > 0) {
    const capStats = stats(capacities.map((c) => Math.round(c * 100)));
    console.log(`  capacity (%):         avg ${capStats.avg}   p50 ${capStats.p50}   p95 ${capStats.p95}   max ${capStats.max}`);
  }
}
