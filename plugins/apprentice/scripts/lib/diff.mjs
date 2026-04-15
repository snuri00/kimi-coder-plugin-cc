// Myers (1986) line-diff + unified-diff formatter.
// Zero dependencies, self-contained. ~140 lines.

function splitLines(text) {
  if (!text) return [];
  const lines = text.split("\n");
  // Avoid an empty trailing entry from a terminating newline.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

// Myers O((N+M)·D) diff. Returns edit script over lines.
//   edits[] = { type: "equal" | "delete" | "insert", line: string }
function myersEdits(aLines, bLines) {
  const N = aLines.length;
  const M = bLines.length;
  const MAX = N + M;
  if (MAX === 0) return [];

  const V = new Array(2 * MAX + 1).fill(0);
  const trace = [];

  for (let D = 0; D <= MAX; D++) {
    trace.push(V.slice());
    for (let k = -D; k <= D; k += 2) {
      let x;
      if (k === -D || (k !== D && V[MAX + k - 1] < V[MAX + k + 1])) {
        x = V[MAX + k + 1];
      } else {
        x = V[MAX + k - 1] + 1;
      }
      let y = x - k;
      while (x < N && y < M && aLines[x] === bLines[y]) {
        x++;
        y++;
      }
      V[MAX + k] = x;
      if (x >= N && y >= M) {
        return backtrack(trace, aLines, bLines, N, M);
      }
    }
  }
  return [];
}

function backtrack(trace, aLines, bLines, N, M) {
  const edits = [];
  let x = N;
  let y = M;

  for (let D = trace.length - 1; D > 0; D--) {
    const V = trace[D];
    const MAX = (V.length - 1) / 2;
    const k = x - y;
    const prevK =
      k === -D || (k !== D && V[MAX + k - 1] < V[MAX + k + 1]) ? k + 1 : k - 1;
    const prevX = V[MAX + prevK];
    const prevY = prevX - prevK;

    while (x > prevX && y > prevY) {
      edits.unshift({ type: "equal", line: aLines[x - 1] });
      x--;
      y--;
    }
    if (x === prevX) {
      edits.unshift({ type: "insert", line: bLines[prevY] });
    } else if (y === prevY) {
      edits.unshift({ type: "delete", line: aLines[prevX] });
    }
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) {
    edits.unshift({ type: "equal", line: aLines[x - 1] });
    x--;
    y--;
  }
  while (x > 0) {
    edits.unshift({ type: "delete", line: aLines[x - 1] });
    x--;
  }
  while (y > 0) {
    edits.unshift({ type: "insert", line: bLines[y - 1] });
    y--;
  }
  return edits;
}

// Group consecutive edits into hunks with surrounding context lines.
function groupIntoHunks(edits, contextLines) {
  const hunks = [];
  let current = null;
  let oldLine = 1;
  let newLine = 1;

  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i];
    const isChange = edit.type !== "equal";

    if (isChange) {
      if (!current) {
        const start = Math.max(0, i - contextLines);
        const leading = edits.slice(start, i).filter((e) => e.type === "equal");
        let leadOld = oldLine - leading.length;
        let leadNew = newLine - leading.length;
        current = { oldStart: leadOld, newStart: leadNew, entries: [...leading] };
      }
      current.entries.push(edit);
    } else if (current) {
      current.entries.push(edit);
      // Peek ahead for another change within 2*contextLines; otherwise close.
      let gap = 0;
      let j = i + 1;
      while (j < edits.length && edits[j].type === "equal" && gap < contextLines * 2) {
        gap++;
        j++;
      }
      if (j >= edits.length || edits[j].type === "equal") {
        // No more changes in sight — close after contextLines trailing equals.
        const trailingNeeded = Math.max(0, contextLines - 1);
        while (
          current.entries.length > 0 &&
          current.entries[current.entries.length - 1].type === "equal" &&
          trailingTail(current.entries) > trailingNeeded
        ) {
          current.entries.pop();
        }
        hunks.push(current);
        current = null;
      }
    }

    if (edit.type !== "insert") oldLine++;
    if (edit.type !== "delete") newLine++;
  }
  if (current) hunks.push(current);
  return hunks;
}

function trailingTail(entries) {
  let n = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].type === "equal") n++;
    else break;
  }
  return n;
}

function renderHunks(hunks) {
  const out = [];
  for (const h of hunks) {
    const oldLen = h.entries.filter((e) => e.type !== "insert").length;
    const newLen = h.entries.filter((e) => e.type !== "delete").length;
    const oldStart = oldLen === 0 ? 0 : h.oldStart;
    const newStart = newLen === 0 ? 0 : h.newStart;
    out.push(`@@ -${oldStart},${oldLen} +${newStart},${newLen} @@`);
    for (const e of h.entries) {
      const sigil = e.type === "insert" ? "+" : e.type === "delete" ? "-" : " ";
      out.push(`${sigil}${e.line}`);
    }
  }
  return out.join("\n");
}

export function unifiedLineDiff(oldText, newText, { contextLines = 3, maxLines = 60 } = {}) {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  const edits = myersEdits(a, b);
  if (edits.length === 0 || edits.every((e) => e.type === "equal")) {
    return "";
  }
  const hunks = groupIntoHunks(edits, contextLines);
  const full = renderHunks(hunks);
  if (!full) return "";
  if (!Number.isFinite(maxLines) || maxLines <= 0) return full;

  const lines = full.split("\n");
  if (lines.length <= maxLines) return full;
  const kept = lines.slice(0, maxLines);
  const omitted = lines.length - maxLines;
  return `${kept.join("\n")}\n... [truncated ${omitted} more lines]`;
}

// Format an Edit (str_replace) for display without running a full diff —
// the old_string and new_string are already known.
export function formatStrReplace(oldString, newString, { maxLines = 40 } = {}) {
  const oldLines = splitLines(oldString);
  const newLines = splitLines(newString);
  const out = [];
  for (const line of oldLines) out.push(`- ${line}`);
  for (const line of newLines) out.push(`+ ${line}`);
  if (!Number.isFinite(maxLines) || maxLines <= 0 || out.length <= maxLines) {
    return out.join("\n");
  }
  const kept = out.slice(0, maxLines);
  const omitted = out.length - maxLines;
  return `${kept.join("\n")}\n... [truncated ${omitted} more lines]`;
}
