// Line diff for spec sections — what a change actually did to the state it
// points at, shown the way a diff shows it.
//
// The section-level link says "#341 is about tasks#spec-registry" and the block
// marks say which bullets it wrote. Neither says what those bullets REPLACED,
// and a spec delta is very often a rewrite: the old wording is half the
// information, and it exists nowhere else once the file is saved.
//
// Written here rather than pulled in: the input is two strings capped by the
// section budget (README §7, ~120 lines), so plain LCS is fast enough at this
// size and the rendering wants its own shape anyway. Nothing about it is
// spec-specific, but nothing else in the app diffs text either.
export type DiffOp = "+" | "-" | " ";

export interface DiffLine {
  op: DiffOp;
  text: string;
}

export interface DiffHunk {
  beforeStart: number;
  afterStart: number;
  lines: DiffLine[];
}

const split = (s: string): string[] => {
  const t = String(s ?? "").replace(/\r\n?/g, "\n");
  return t === "" ? [] : t.split("\n");
};

// Longest common subsequence over whole lines. A section is bullets and short
// paragraphs, so a line is the right grain: word-level diffing inside a
// rewritten bullet reads worse than seeing the two versions whole.
export function diffLines(before: string, after: string): DiffLine[] {
  const a = split(before);
  const b = split(after);
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ op: " ", text: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push({ op: "-", text: a[i++] });
    } else {
      out.push({ op: "+", text: b[j++] });
    }
  }
  while (i < n) out.push({ op: "-", text: a[i++] });
  while (j < m) out.push({ op: "+", text: b[j++] });
  return out;
}

// Changed runs plus a little context. A section that had one bullet rewritten
// should show that bullet, not ninety unchanged lines with three marks in them
// — the whole section is already on screen above.
export function diffHunks(lines: DiffLine[], context = 2): DiffHunk[] {
  const keep = lines.map(
    (l, i) =>
      l.op !== " " ||
      lines.slice(Math.max(0, i - context), i + context + 1).some((x) => x.op !== " "),
  );
  const hunks: DiffHunk[] = [];
  let current: DiffHunk | null = null;
  let bLine = 1;
  let aLine = 1;
  lines.forEach((l, i) => {
    if (keep[i]) {
      if (!current) {
        current = { beforeStart: bLine, afterStart: aLine, lines: [] };
        hunks.push(current);
      }
      current.lines.push(l);
    } else {
      current = null;
    }
    if (l.op !== "+") bLine++;
    if (l.op !== "-") aLine++;
  });
  return hunks;
}

export function diffStat(lines: DiffLine[]): { added: number; removed: number } {
  return {
    added: lines.filter((l) => l.op === "+").length,
    removed: lines.filter((l) => l.op === "-").length,
  };
}
