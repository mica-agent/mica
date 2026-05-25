// Minimal LCS-based line diff. Produces a unified-style diff with
// elided runs of unchanged context — readable enough for an LLM to
// reason about, small enough to fit in a reactive-turn prompt.
//
// Hand-rolled to avoid pulling in the `diff` package as a direct
// dependency (it's a transitive dep today but not pinned). Quadratic
// in the larger of the two line counts — fine for spec-sized docs
// (a 600-line spec is ~360K ops, sub-millisecond).

const MAX_OUT_BYTES = 4096;
const CONTEXT_LINES = 2;          // unchanged lines kept around each change hunk
const ELISION_THRESHOLD = 5;      // collapse runs of unchanged > this

type Tag = " " | "-" | "+";

/** Compute a tagged line-diff. Returns an array of `{ tag, text }`
 *  where tag is ' ' (context), '-' (a only), or '+' (b only). */
function taggedDiff(a: string, b: string): Array<{ tag: Tag; text: string }> {
  const aLines = a.length > 0 ? a.split("\n") : [];
  const bLines = b.length > 0 ? b.split("\n") : [];
  const m = aLines.length;
  const n = bLines.length;

  // LCS length table, walked from bottom-right.
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = aLines[i] === bLines[j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const out: Array<{ tag: Tag; text: string }> = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (aLines[i] === bLines[j]) {
      out.push({ tag: " ", text: aLines[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ tag: "-", text: aLines[i] });
      i++;
    } else {
      out.push({ tag: "+", text: bLines[j] });
      j++;
    }
  }
  while (i < m) out.push({ tag: "-", text: aLines[i++] });
  while (j < n) out.push({ tag: "+", text: bLines[j++] });
  return out;
}

/** Format the tagged diff into a unified-style string. Long runs of
 *  unchanged context are collapsed; the total output is capped at
 *  ~MAX_OUT_BYTES with a truncation marker. */
export function formatLineDiff(before: string, after: string): string {
  const tagged = taggedDiff(before, after);

  // Walk and emit hunks: a hunk is a non-context block plus CONTEXT_LINES
  // of context on each side. Stretches of context longer than the elision
  // threshold collapse to "... (N unchanged) ...".
  const lines: string[] = [];

  // Find change positions to drive hunk emission.
  let i = 0;
  while (i < tagged.length) {
    if (tagged[i].tag === " ") {
      // Run of context — count it.
      let runEnd = i;
      while (runEnd < tagged.length && tagged[runEnd].tag === " ") runEnd++;
      const runLen = runEnd - i;
      if (runLen > ELISION_THRESHOLD) {
        // Trailing context for the previous hunk (if any).
        const trail = Math.min(CONTEXT_LINES, runLen);
        for (let k = 0; k < trail && lines.length > 0; k++) lines.push("  " + tagged[i + k].text);
        // Elision marker if the gap is meaningfully longer than the
        // context window we'd otherwise have shown on each side.
        const elided = runLen - trail - (runEnd < tagged.length ? CONTEXT_LINES : 0);
        if (elided > 0) lines.push(`@@ ... ${elided} unchanged line${elided === 1 ? "" : "s"} ... @@`);
        // Leading context for the next hunk (if any).
        const leadStart = runEnd - Math.min(CONTEXT_LINES, runLen);
        if (runEnd < tagged.length) {
          for (let k = leadStart; k < runEnd; k++) lines.push("  " + tagged[k].text);
        }
      } else {
        // Short run — keep it all.
        for (let k = i; k < runEnd; k++) lines.push("  " + tagged[k].text);
      }
      i = runEnd;
    } else {
      // Change line — emit as-is.
      lines.push((tagged[i].tag === "-" ? "- " : "+ ") + tagged[i].text);
      i++;
    }
  }

  // Cap the total output size. Truncate cleanly at a line boundary.
  let out = lines.join("\n");
  if (out.length > MAX_OUT_BYTES) {
    const cut = out.lastIndexOf("\n", MAX_OUT_BYTES);
    out = (cut > 0 ? out.slice(0, cut) : out.slice(0, MAX_OUT_BYTES)) +
      "\n... (diff truncated; read the file directly for the rest)";
  }
  return out;
}

/** True when the two strings differ. Cheaper than computing a full
 *  diff just to gate the [Draft revision] branch. */
export function hasChanges(before: string, after: string): boolean {
  return before !== after;
}
