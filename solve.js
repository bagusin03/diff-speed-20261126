// A faster drop-in for makefun-diff 1.0.0.
//
// The same patch, by the same rule: common prefix, then common suffix, then
// Myers's greedy search with the deletion tie-break, then hunks of up to 3
// kept lines of context. The speed comes from the search itself:
//
// - Lines are interned to integer ids once per case, so the search compares
//   integers, never strings.
// - Instead of one linked-list path object per (d, k) step, the furthest x
//   reached on every diagonal of every depth is kept in one flat Int32Array,
//   and the script is recovered by walking that table backwards.
// - The search is banded: a cheap greedy common subsequence gives a valid
//   upper bound D_ub on the edit distance, and a shortest script's path at
//   depth d can only sit on a diagonal k with |k - K| <= D_ub - d, where
//   K = N - M is the final diagonal. Diagonals outside that band cannot
//   carry a shortest script, so they are never visited. If the bound ever
//   failed to contain a path to the end, the search falls back to the full
//   triangle, so the answer is never affected.
//
// No step's choice is changed, so the script — and the patch built from
// it — is identical to makefun-diff's. Everything is deterministic and
// allocation-light.

const KEEP = 0;
const DELETE = 1;
const INSERT = 2;
const CONTEXT = 3;

// The V table: V[d][k] is the furthest old-lines-consumed count reached on
// diagonal k after d edits and its following run of equal lines, or -1 when
// that diagonal was never reached. Depth d starts at flat offset d*d and
// holds 2d+1 diagonals, so the table is (D+1)^2 entries for a search of D
// edits. One buffer is kept across calls and only grown, never shrunk.
let vtab = new Int32Array(4097 * 4097);
let vcap = 4097;

function ensureV(d) {
  if (d + 1 > vcap) {
    let next = vcap;
    while (d + 1 > next) next *= 2;
    const grown = new Int32Array(next * next);
    grown.set(vtab.subarray(0, vcap * vcap));
    vtab = grown;
    vcap = next;
  }
}

/** A text's lines, each with its "\n" (the last one without, when the text does not end in one). */
function tokenize(text) {
  const lines = [];
  let start = 0;
  for (;;) {
    const i = text.indexOf('\n', start);
    if (i === -1) {
      if (start < text.length) lines.push(text.slice(start));
      return lines;
    }
    lines.push(text.slice(start, i + 1));
    start = i + 1;
  }
}

/**
 * An upper bound on the edit distance of a[pa..pa+N) into b[pb..pb+M):
 * (N - L) + (M - L), where L is the length of a common subsequence found
 * greedily — never below the true distance, since any common subsequence
 * gives a valid script of that length. `ids` is the number of distinct
 * line ids; a and b hold ids, so positions are indexed directly.
 *
 * The walk is anchored on lines unique in both texts: their single
 * occurrence in the new text is their true match, so they set the
 * alignment (and its drift). A repeated line only matches the occurrence
 * nearest its expected position (its index plus the drift), within 3
 * lines. Matching a repeated line to just any later occurrence would let
 * the walk jump ahead of the true alignment and then match nothing after
 * it, so the window is tight and every match is strictly increasing in
 * the new text — that is what makes the matched lines a subsequence.
 */
function upperBound(a, pa, N, b, pb, M, ids) {
  if (N === 0 || M === 0) return N + M;
  const cntA = new Int32Array(ids);
  const cntB = new Int32Array(ids);
  for (let i = 0; i < N; i++) cntA[a[pa + i]]++;
  for (let j = 0; j < M; j++) cntB[b[pb + j]]++;
  const head = new Int32Array(ids);
  head.fill(-1);
  const nxt = new Int32Array(M);
  for (let j = M - 1; j >= 0; j--) {
    const id = b[pb + j];
    nxt[j] = head[id];
    head[id] = j;
  }
  const uniqPos = new Int32Array(ids);
  uniqPos.fill(-1);
  for (let id = 0; id < ids; id++) if (cntB[id] === 1) uniqPos[id] = head[id];
  let j = 0;
  let drift = 0;
  let matched = 0;
  for (let i = 0; i < N; i++) {
    const id = a[pa + i];
    if (cntA[id] === 1 && cntB[id] === 1) {
      const p = uniqPos[id];
      if (p >= j && p - j <= 64) {
        matched++;
        j = p + 1;
        drift = p - i;
      }
    } else {
      const e = i + drift;
      let p = head[id];
      while (p !== -1 && p < j) {
        p = nxt[p];
        head[id] = p;
      }
      let q = p;
      while (q !== -1 && q < e - 3) q = nxt[q];
      if (q !== -1 && q - e <= 3) {
        matched++;
        if (q + 1 > j) j = q + 1;
        head[id] = nxt[q];
      }
    }
  }
  return (N - matched) + (M - matched);
}

/**
 * The forward search: the smallest d whose search reaches both ends, or -1
 * when no path inside the band does (the caller then retries unbanded).
 * `band` is an upper bound on the edit distance; a shortest script's path
 * at depth d sits on a diagonal k with |k - K| <= band - d, K = N - M, so
 * only those diagonals are visited. band = Infinity visits the whole
 * triangle. The furthest x per diagonal per depth is left in the V table
 * for the backtrack.
 */
function forward(a, pa, N, b, pb, M, band) {
  const K = N - M;
  let x = 0;
  let y = 0;
  while (x < N && y < M && a[pa + x] === b[pb + y]) { x++; y++; }
  let V = vtab;
  V[0] = x;
  if (x >= N && y >= M) return 0;
  for (let d = 1; ; d++) {
    if (d > band) return -1;
    ensureV(d);
    V = vtab;
    const base = d * d;
    const prevBase = (d - 1) * (d - 1);
    let kLo = -d;
    const blo = K - (band - d);
    if (blo > kLo) kLo = blo;
    let kHi = d;
    const bhi = K + (band - d);
    if (bhi < kHi) kHi = bhi;
    if ((kLo - d) % 2 !== 0) kLo++;
    if (kLo > kHi) continue;
    // delIdx/insIdx/wIdx advance by 2 as k advances by 2.
    let delIdx = prevBase + kLo + d - 2;
    let insIdx = prevBase + kLo + d;
    let wIdx = base + kLo + d;
    for (let k = kLo; k <= kHi; k += 2) {
      // Deletion candidate: from diagonal k-1 at depth d-1, one old line
      // further; insertion candidate: from diagonal k+1, same old count.
      // A move past either text's end is no candidate. The deletion wins
      // ties, as makefun-diff's rule says.
      let xDel = -2;
      let xIns = -2;
      if (k > -d) {
        const xp = V[delIdx];
        if (xp >= 0 && xp < N) xDel = xp + 1;
      }
      if (k < d) {
        const xp = V[insIdx];
        if (xp >= 0 && xp - k <= M) xIns = xp;
      }
      if (xDel < 0 && xIns < 0) {
        V[wIdx] = -1;
      } else {
        x = xDel >= xIns ? xDel : xIns;
        y = x - k;
        while (x < N && y < M && a[pa + x] === b[pb + y]) { x++; y++; }
        V[wIdx] = x;
        if (x >= N && y >= M) return d;
      }
      delIdx += 2;
      insIdx += 2;
      wIdx += 2;
    }
  }
}

/**
 * The edit script of the trimmed lines a[pa..pa+N) into b[pb..pb+M), as
 * runs [{kind, count}] in order, by the header's rule. a and b are the
 * interned line ids. Returns the runs of the middle only; the caller adds
 * the kept prefix and suffix.
 */
function editRuns(a, pa, N, b, pb, M, ids) {
  if (N === 0 && M === 0) return [];
  let D = forward(a, pa, N, b, pb, M, upperBound(a, pa, N, b, pb, M, ids));
  if (D < 0) D = forward(a, pa, N, b, pb, M, Infinity);
  const V = vtab;

  // Walk the table backwards from (N, M): at each depth, the predecessor
  // endpoint recorded in V[d-1] bounds the run of equal lines to undo —
  // undoing by line equality alone could step past it when the line before
  // the run happens to equal a deleted or inserted line — then undo the
  // edit that led into it, choosing the predecessor by the same
  // furthest-into-the-old-text rule (deletion on ties).
  const ops = [];
  let x = N;
  let y = M;
  for (let d = D; d > 0; d--) {
    const k = x - y;
    const prevBase = (d - 1) * (d - 1);
    let xDel = -2;
    let xIns = -2;
    if (k > -d) {
      const xp = V[prevBase + k + d - 2];
      if (xp >= 0 && xp < N) xDel = xp + 1;
    }
    if (k < d) {
      const xp = V[prevBase + k + d];
      if (xp >= 0 && xp - k <= M) xIns = xp;
    }
    if (xDel >= xIns) {
      const px = V[prevBase + k + d - 2];
      const xEdit = px + 1;
      while (x > xEdit) { ops.push(KEEP); x--; y--; }
      ops.push(DELETE);
      x--;
    } else {
      const px = V[prevBase + k + d];
      const xEdit = px;
      while (x > xEdit) { ops.push(KEEP); x--; y--; }
      ops.push(INSERT);
      y--;
    }
  }
  while (x > 0) { ops.push(KEEP); x--; y--; }

  // Merge the reversed single steps into runs, in order.
  const runs = [];
  for (let i = ops.length - 1; i >= 0; i--) {
    const kind = ops[i];
    const last = runs[runs.length - 1];
    if (last !== undefined && last.kind === kind) last.count++;
    else runs.push({ kind, count: 1 });
  }
  return runs;
}

/** A line as the patch writes it, pushed as pieces (no per-line string built). */
function pushWritten(out, op, line) {
  if (line.endsWith('\n')) {
    out.push(op, line);
  } else {
    out.push(op, line, '\n%\n');
  }
}

/** make.fun's own patch of input.old into input.new, as one string. */
export function run(input) {
  if (input === null || typeof input !== 'object' || typeof input.old !== 'string' || typeof input.new !== 'string') {
    throw new TypeError('makefun-diff: the input is { old, new }, two strings');
  }
  const a = tokenize(input.old);
  const b = tokenize(input.new);
  const n = a.length;
  const m = b.length;
  // Intern every distinct line to an integer id, shared by both texts, so
  // the search compares integers, never strings.
  const ids = new Map();
  let nextId = 0;
  const ai = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    let id = ids.get(a[i]);
    if (id === undefined) { id = nextId++; ids.set(a[i], id); }
    ai[i] = id;
  }
  const bi = new Int32Array(m);
  for (let i = 0; i < m; i++) {
    let id = ids.get(b[i]);
    if (id === undefined) { id = nextId++; ids.set(b[i], id); }
    bi[i] = id;
  }
  let prefix = 0;
  while (prefix < n && prefix < m && ai[prefix] === bi[prefix]) prefix++;
  let suffix = 0;
  while (suffix < n - prefix && suffix < m - prefix && ai[n - 1 - suffix] === bi[m - 1 - suffix]) suffix++;
  const runs = [];
  if (prefix > 0) runs.push({ kind: KEEP, count: prefix });
  const middle = editRuns(ai, prefix, n - prefix - suffix, bi, prefix, m - prefix - suffix, nextId);
  for (let i = 0; i < middle.length; i++) runs.push(middle[i]);
  if (suffix > 0) runs.push({ kind: KEEP, count: suffix });

  // The change runs: each a stretch of deletions and insertions between two kept lines.
  const changes = [];
  let o = 0;
  let p = 0;
  let deleted = 0;
  let inserted = 0;
  for (let r = 0; r < runs.length; r++) {
    const run = runs[r];
    if (run.kind === KEEP) {
      o += run.count;
      p += run.count;
      continue;
    }
    let c = changes[changes.length - 1];
    if (c === undefined || c.o + c.dels !== o || c.p + c.ins !== p) {
      c = { o, p, dels: 0, ins: 0 };
      changes.push(c);
    }
    if (run.kind === DELETE) {
      c.dels += run.count;
      o += run.count;
      deleted += run.count;
    } else {
      c.ins += run.count;
      p += run.count;
      inserted += run.count;
    }
  }

  // The hunks: change runs at most 2 * CONTEXT kept lines apart share one.
  const hunks = [];
  for (let i = 0; i < changes.length; i++) {
    const c = changes[i];
    const h = hunks[hunks.length - 1];
    const prev = h !== undefined ? h[h.length - 1] : undefined;
    if (prev !== undefined && c.o - (prev.o + prev.dels) <= 2 * CONTEXT) h.push(c);
    else hunks.push([c]);
  }

  const out = [`makefun-diff/1 old=${n} new=${m} hunks=${hunks.length} deleted=${deleted} inserted=${inserted}\n`];
  for (let hi = 0; hi < hunks.length; hi++) {
    const h = hunks[hi];
    const first = h[0];
    const last = h[h.length - 1];
    const oldStart = Math.max(0, first.o - CONTEXT);
    const newStart = first.p - (first.o - oldStart);
    const after = Math.min(CONTEXT, n - (last.o + last.dels));
    const oldEnd = last.o + last.dels + after;
    const newEnd = last.p + last.ins + after;
    out.push(`@ ${oldStart + 1} ${oldEnd - oldStart} ${newStart + 1} ${newEnd - newStart}\n`);
    let at = oldStart;
    for (let ci = 0; ci < h.length; ci++) {
      const c = h[ci];
      for (; at < c.o; at++) pushWritten(out, '=', a[at]);
      for (let i = 0; i < c.dels; i++) pushWritten(out, '-', a[c.o + i]);
      for (let i = 0; i < c.ins; i++) pushWritten(out, '+', b[c.p + i]);
      at = c.o + c.dels;
    }
    for (; at < oldEnd; at++) pushWritten(out, '=', a[at]);
  }
  return out.join('');
}
