// main.ts — mend, the command-line tool SPEC.md specifies. Node 22, standard library alone.
// Run as `node main.ts [options] [PATCH]` with the working directory as the root of a tree
// of text files. It reads a patch in one of four formats (unified diff, SEARCH/REPLACE
// blocks, V4A, JSON edits), finds the lines each edit names at the first of three matching
// tiers, and writes every change or none, printing what it changed or why it failed.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this
// file hands over to runner.ts (the last lines below): keep that hand-over and runner.ts
// as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** An exit-2 outcome: exactly one line on stdout, nothing written. */
class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** One failed edit: its code and the path the failure concerns. */
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

/** A patch's lines: its text split at `\n`, each with one trailing `\r` removed, and
 *  without the empty piece after a final `\n`. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** A path is safe when it is not empty, does not start with `/`, holds no `\`, and none
 *  of its `/`-separated segments is empty, `.` or `..`. */
function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file as lines: its line break, its lines, and whether it ends with a line break.
 *  The break is CRLF when the file's first line feed follows a carriage return, LF
 *  otherwise. An empty file has no lines and does not end with a line break. */
interface Doc {
  lines: string[];
  br: string;
  eol: boolean;
}

function readDoc(text: string): Doc {
  if (text === '') return { lines: [], br: '\n', eol: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const eol = text.endsWith(br);
  if (eol) parts.pop();
  return { lines: parts, br, eol };
}

function writeDoc(d: Doc): string {
  if (d.lines.length === 0) return '';
  return d.lines.join(d.br) + (d.eol ? d.br : '');
}

/** The leading spaces and tabs of a line. */
function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

/** A line as a tier sees it: tier 0 exact, tier 1 without trailing spaces and tabs,
 *  tier 2 without leading and trailing spaces and tabs. */
function tierLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Every 0-based position where O occurs in lines at a tier; occurrences may overlap. */
function occurrences(lines: string[], old: string[], tier: number): number[] {
  const out: number[] = [];
  const n = old.length;
  if (n === 0) return out;
  for (let i = 0; i + n <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < n; j++) {
      if (tierLine(lines[i + j], tier) !== tierLine(old[j], tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, then 1, then 2; only 0 with --strict) at which O occurs at least
 *  once in lines, with its occurrences; null when O occurs at no tier. */
function findTier(lines: string[], old: string[], strict: boolean): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(lines, old, t);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** One body line of a hunk or chunk: a context line (in both old and new), a line the
 *  edit removes (old only), or a line it adds (new only). */
type Op = { kind: 'ctx' | 'del' | 'add'; text: string };

/** The old lines of a body (its context and removed lines, in order). */
function oldOf(ops: Op[]): string[] {
  return ops.filter((o) => o.kind !== 'add').map((o) => o.text);
}

/** The new lines of a body, as they are written when the body replaces the file's lines
 *  at `pos`: a context line is written as the file's own matched line, never the patch's;
 *  at tier 2 every other line is re-indented, the leading spaces and tabs of O's first
 *  line swapped for those of the file's first matched line. */
function newOf(ops: Op[], fileLines: string[], pos: number, tier: number): string[] {
  const old = oldOf(ops);
  const p = old.length > 0 ? leadingWs(old[0]) : '';
  const f = old.length > 0 ? leadingWs(fileLines[pos]) : '';
  const out: string[] = [];
  let oi = 0;
  for (const op of ops) {
    if (op.kind === 'ctx') {
      out.push(fileLines[pos + oi]);
      oi += 1;
    } else if (op.kind === 'del') {
      oi += 1;
    } else {
      let t = op.text;
      if (tier === 2 && t !== '' && t.trim() !== '' && t.startsWith(p)) t = f + t.slice(p.length);
      out.push(t);
    }
  }
  return out;
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest
 *  read from disk. `moves` records a move edit's new path to its old path, so the
 *  output can print one `R old -> new` line instead of a `D` and an `A`. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves = new Map<string, string>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
  /** The file's lines as a Doc, or null when it does not exist. */
  doc(p: string): Doc | null {
    const t = this.get(p);
    return t === null ? null : readDoc(t);
  }
  /** Write a Doc back at a path (null deletes it). */
  setDoc(p: string, d: Doc | null): void {
    this.now.set(p, d === null ? null : writeDoc(d));
  }
}

type Edit = (tree: Tree) => void;

/** Guard an edit's paths: every path it names is checked for safety before anything
 *  else about it. */
function guardPaths(paths: string[]): void {
  for (const p of paths) {
    if (!safe(p)) throw new Fail('unsafe', p);
  }
}

/* ------------------------------------------------------------------ */
/* Section 6: unified diffs                                            */
/* ------------------------------------------------------------------ */

/** One hunk: its old start line A (1-based), its body, and whether a `\` line follows
 *  its last context or `+` line (no line break at the end). */
interface Hunk {
  a: number;
  ops: Op[];
  noEol: boolean;
}

interface Section {
  oldPath: string | null;
  newPath: string | null;
  create: boolean;
  remove: boolean;
  hunks: Hunk[];
}

/** A path from a `--- ` or `+++ ` line: the text after the four characters, up to the
 *  first tab, with surrounding spaces removed, a leading `a/` or `b/` removed. */
function headerPath(line: string): string {
  let p = line.slice(4).split('\t')[0].trim();
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

const DIFF_GIT = /^diff --git a\/(\S+) b\/(\S+)$/;
const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Parse one hunk body starting after its header at index `i`. Returns the hunk and
 *  the index just past the body. A `\` line refers to the body line before it; the
 *  hunk ends with no line break when one follows its last context or `+` line. */
function parseHunk(lines: string[], i: number): { hunk: Hunk; next: number } {
  const a = Number(HUNK_HEAD.exec(lines[i - 1])![1]);
  const ops: Op[] = [];
  const afterSlash: boolean[] = [];
  const n = lines.length;
  while (i < n) {
    const b = lines[i];
    // A hunk body ends at a `diff --git ` line, at a `--- ` line followed by a
    // `+++ ` line, or at the first other line (a `--- ` line followed by `+++ `
    // starts with `-`, so this check must come before the body-line checks).
    if (b.startsWith('diff --git ')) break;
    if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
    if (b === '' || b.startsWith(' ') || b.startsWith('-') || b.startsWith('+') || b.startsWith('\\')) {
      if (b === '') {
        ops.push({ kind: 'ctx', text: '' });
        afterSlash.push(false);
      } else if (b.startsWith(' ')) {
        ops.push({ kind: 'ctx', text: b.slice(1) });
        afterSlash.push(false);
      } else if (b.startsWith('-')) {
        ops.push({ kind: 'del', text: b.slice(1) });
        afterSlash.push(false);
      } else if (b.startsWith('+')) {
        ops.push({ kind: 'add', text: b.slice(1) });
        afterSlash.push(false);
      } else if (ops.length > 0) {
        afterSlash[ops.length - 1] = true;
      }
      i += 1;
      continue;
    }
    break;
  }
  // Empty lines at the end of a body are not part of it.
  while (ops.length > 0 && ops[ops.length - 1].kind === 'ctx' && ops[ops.length - 1].text === '') {
    ops.pop();
    afterSlash.pop();
  }
  let noEol = false;
  for (let q = ops.length - 1; q >= 0; q--) {
    if (ops[q].kind === 'ctx' || ops[q].kind === 'add') {
      noEol = afterSlash[q];
      break;
    }
  }
  return { hunk: { a, ops, noEol }, next: i };
}

/** Parse the hunks of a section starting at index `i` (just after its header).
 *  Returns the index just past the last hunk. */
function parseHunks(lines: string[], i: number, sec: Section): number {
  const n = lines.length;
  while (i < n) {
    const h = lines[i];
    if (h.startsWith('@@')) {
      if (HUNK_HEAD.exec(h) === null) throw new Exit2(`error: parse ${i + 1}`);
      const { hunk, next } = parseHunk(lines, i + 1);
      sec.hunks.push(hunk);
      i = next;
      continue;
    }
    break;
  }
  return i;
}

/** Parse a unified patch into its sections' edits. */
function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    if (line.startsWith('diff --git ')) {
      const m = DIFF_GIT.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const sec: Section = { oldPath: m[1], newPath: m[2], create: false, remove: false, hunks: [] };
      sections.push(sec);
      i += 1;
      // Header: lines until the first hunk or a new `diff --git` section. A
      // `--- ` line followed by `+++ ` here is this section's own pair.
      while (i < n) {
        const h = lines[i];
        if (h.startsWith('@@')) break;
        if (h.startsWith('diff --git ')) break;
        if (h.startsWith('--- ')) {
          if (!(lines[i + 1] ?? '').startsWith('+++ ')) throw new Exit2(`error: parse ${i + 2}`);
          const oldP = headerPath(h);
          const newP = headerPath(lines[i + 1]);
          sec.oldPath = oldP === '/dev/null' ? null : oldP;
          sec.newPath = newP === '/dev/null' ? null : newP;
          i += 2;
          continue;
        }
        if (h.startsWith('rename from ')) sec.oldPath = h.slice('rename from '.length).trim();
        else if (h.startsWith('rename to ')) sec.newPath = h.slice('rename to '.length).trim();
        else if (h.startsWith('new file mode')) sec.create = true;
        else if (h.startsWith('deleted file mode')) sec.remove = true;
        i += 1;
      }
      i = parseHunks(lines, i, sec);
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const sec: Section = { oldPath: null, newPath: null, create: false, remove: false, hunks: [] };
      sections.push(sec);
      const oldP = headerPath(line);
      const newP = headerPath(lines[i + 1]);
      sec.oldPath = oldP === '/dev/null' ? null : oldP;
      sec.newPath = newP === '/dev/null' ? null : newP;
      i += 2;
      i = parseHunks(lines, i, sec);
      continue;
    }
    if (line.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
    i += 1;
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((sec) => unifiedEdit(sec, strict));
}

/** Apply one hunk to a Doc, with the section's cumulative line delta `d`; returns the
 *  updated delta. */
function applyHunk(doc: Doc, hunk: Hunk, d: number, strict: boolean): number {
  const old = oldOf(hunk.ops);
  const lines = doc.lines;
  if (old.length === 0) {
    const at = Math.min(hunk.a + d, lines.length);
    const add = hunk.ops.filter((o) => o.kind === 'add').map((o) => o.text);
    const atEnd = at === lines.length;
    lines.splice(at, 0, ...add);
    if (atEnd && add.length > 0) doc.eol = !hunk.noEol;
    return d + add.length;
  }
  const found = findTier(lines, old, strict);
  if (found === null) throw new Fail('no-match', '');
  const target = hunk.a - 1 + d;
  let best = found.occ[0];
  let bestDist = Math.abs(best - target);
  for (const p of found.occ) {
    const dist = Math.abs(p - target);
    if (dist < bestDist) {
      best = p;
      bestDist = dist;
    }
  }
  const pos = best;
  const replacement = newOf(hunk.ops, lines, pos, found.tier);
  const runsToEnd = pos + old.length === lines.length;
  lines.splice(pos, old.length, ...replacement);
  if (runsToEnd) doc.eol = !hunk.noEol;
  return d + (replacement.length - old.length);
}

/** One section is one edit. */
function unifiedEdit(sec: Section, strict: boolean): Edit {
  return (tree: Tree) => {
    const oldP = sec.oldPath;
    const newP = sec.newPath;
    if (sec.create || (oldP === null && newP !== null)) {
      // A creation: the new path does not exist; the file is the `+` lines of all
      // its hunks, in order, and ends with a line break unless a `\` line follows
      // its last `+` line.
      const p = newP!;
      guardPaths([p]);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const made: string[] = [];
      let eol = true;
      for (const h of sec.hunks) {
        const adds = h.ops.filter((o) => o.kind === 'add').map((o) => o.text);
        made.push(...adds);
        if (adds.length > 0) eol = !h.noEol;
      }
      tree.now.set(p, made.length === 0 ? '' : made.join('\n') + (eol ? '\n' : ''));
      return;
    }
    if (sec.remove || (newP === null && oldP !== null)) {
      // A deletion: the old path exists; it is deleted, and its hunks are not read.
      const p = oldP!;
      guardPaths([p]);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    if (oldP !== null && newP !== null && oldP !== newP) {
      // A move: the old path exists, the new path does not; the hunks are applied
      // to the old file's lines and the result is written at the new path.
      guardPaths([oldP, newP]);
      const before = tree.get(oldP);
      if (before === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const doc = readDoc(before);
      let d = 0;
      try {
        for (const h of sec.hunks) d = applyHunk(doc, h, d, strict);
      } catch (e) {
        if (e instanceof Fail && e.path === '') throw new Fail(e.code, oldP);
        throw e;
      }
      tree.now.set(oldP, null);
      tree.now.set(newP, writeDoc(doc));
      tree.moves.set(newP, oldP);
      return;
    }
    // A change of the one path, which exists.
    const p = (oldP ?? newP)!;
    guardPaths([p]);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    const doc = readDoc(before);
    let d = 0;
    try {
      for (const h of sec.hunks) d = applyHunk(doc, h, d, strict);
    } catch (e) {
      if (e instanceof Fail && e.path === '') throw new Fail(e.code, p);
      throw e;
    }
    tree.now.set(p, writeDoc(doc));
  };
}

/* ------------------------------------------------------------------ */
/* Section 7: SEARCH/REPLACE blocks                                    */
/* ------------------------------------------------------------------ */

/** Parse SEARCH/REPLACE blocks into edits. */
function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  const n = lines.length;
  let i = 0;
  let prevPath: string | null = null;
  let prevEnd = 0; // index just past the previous block's `>>>>>>> REPLACE` line
  while (i < n) {
    if (lines[i].trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i + 1; // 1-based
    // The path is the nearest line before the SEARCH line, and after the previous
    // block's REPLACE line (or the start of the patch), that is not blank and,
    // with its surrounding whitespace removed, does not start with three backticks.
    let path: string | null = null;
    for (let j = i - 1; j >= prevEnd; j--) {
      const t = lines[j].trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchLine}`);
    // The old lines, up to `=======`; then the new lines, up to `>>>>>>> REPLACE`.
    const oldLines: string[] = [];
    let j = i + 1;
    let foundEq = false;
    while (j < n) {
      if (lines[j].trimEnd() === '=======') {
        foundEq = true;
        break;
      }
      if (lines[j].trimEnd() === '>>>>>>> REPLACE') break;
      oldLines.push(lines[j]);
      j += 1;
    }
    if (!foundEq) throw new Exit2(`error: parse ${searchLine}`);
    const newLines: string[] = [];
    j += 1;
    let foundEnd = false;
    while (j < n) {
      if (lines[j].trimEnd() === '>>>>>>> REPLACE') {
        foundEnd = true;
        break;
      }
      newLines.push(lines[j]);
      j += 1;
    }
    if (!foundEnd) throw new Exit2(`error: parse ${searchLine}`);
    edits.push(searchReplaceEdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevEnd = j + 1;
    i = j + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

/** One block is one edit. */
function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree: Tree) => {
    guardPaths([path]);
    if (oldLines.length === 0) {
      // The file is created with the new lines.
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const doc = readDoc(before);
    const found = findTier(doc.lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const pos = found.occ[0];
    const ops: Op[] = oldLines.map((t) => ({ kind: 'del' as const, text: t }));
    for (const t of newLines) ops.push({ kind: 'add' as const, text: t });
    const replacement = newOf(ops, doc.lines, pos, found.tier);
    doc.lines.splice(pos, oldLines.length, ...replacement);
    tree.now.set(path, writeDoc(doc));
  };
}

/* ------------------------------------------------------------------ */
/* Section 8: V4A patches                                              */
/* ------------------------------------------------------------------ */

/** One chunk of an Update File section: its anchor (null: none), its body, and
 *  whether it is anchored to the end of the file. */
interface Chunk {
  anchor: string | null;
  ops: Op[];
  eof: boolean;
}

interface V4ASection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  lines: string[];
  chunks: Chunk[];
}

/** The first line at or after `from` equal to `target` at the first tier where one
 *  is (both sides a single line); -1 when there is none. */
function findAnchorLine(lines: string[], target: string, from: number, strict: boolean): number {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    for (let i = from; i < lines.length; i++) {
      if (tierLine(lines[i], t) === tierLine(target, t)) return i;
    }
  }
  return -1;
}

/** Parse a V4A patch into its sections' edits. */
function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const n = lines.length;
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0 || lines[first].trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first < 0 ? 1 : first + 1}`);
  const last = (() => {
    for (let k = n - 1; k >= 0; k--) if (!blank(lines[k])) return k;
    return -1;
  })();
  if (lines[last].trim() !== '*** End Patch') throw new Exit2(`error: parse ${n + 1}`);
  const sections: V4ASection[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i];
    if (blank(line)) {
      i += 1;
      continue;
    }
    let kind: 'add' | 'delete' | 'update' | null = null;
    let path = '';
    if (line.startsWith('*** Add File: ')) {
      kind = 'add';
      path = line.slice('*** Add File: '.length).trim();
    } else if (line.startsWith('*** Delete File: ')) {
      kind = 'delete';
      path = line.slice('*** Delete File: '.length).trim();
    } else if (line.startsWith('*** Update File: ')) {
      kind = 'update';
      path = line.slice('*** Update File: '.length).trim();
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const sec: V4ASection = { kind, path, moveTo: null, lines: [], chunks: [] };
    sections.push(sec);
    i += 1;
    // Collect the section's lines, up to the next section or `*** End Patch`.
    // Blank lines at the end of a section are not part of it.
    const start = i;
    let end = i;
    while (end < last) {
      const l = lines[end];
      if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) break;
      end += 1;
    }
    let body = lines.slice(start, end);
    while (body.length > 0 && blank(body[body.length - 1])) body.pop();
    i = end;
    if (kind === 'add') {
      for (const l of body) {
        if (l.startsWith('+')) sec.lines.push(l.slice(1));
        else if (l === '') sec.lines.push('');
        else throw new Exit2(`error: parse ${start + body.indexOf(l) + 1}`);
      }
    } else if (kind === 'delete') {
      if (body.length > 0) throw new Exit2(`error: parse ${start + 1}`);
    } else {
      // Update File: an optional `*** Move to:` first, then chunks.
      let j = 0;
      if (body.length > 0 && body[0].startsWith('*** Move to: ')) {
        sec.moveTo = body[0].slice('*** Move to: '.length).trim();
        j = 1;
      }
      let cur: Chunk | null = null;
      const flush = (): void => {
        if (cur !== null) {
          sec.chunks.push(cur);
          cur = null;
        }
      };
      while (j < body.length) {
        const l = body[j];
        if (l === '*** End of File') {
          if (cur === null) cur = { anchor: null, ops: [], eof: true };
          else cur.eof = true;
          flush();
          j += 1;
          continue;
        }
        if (l.startsWith('@@')) {
          flush();
          cur = { anchor: l.slice(2).trim(), ops: [], eof: false };
          if (cur.anchor === '') cur.anchor = null;
          j += 1;
          continue;
        }
        if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l === '') {
          if (cur === null) cur = { anchor: null, ops: [], eof: false };
          if (l === '') cur.ops.push({ kind: 'ctx', text: '' });
          else if (l.startsWith(' ')) cur.ops.push({ kind: 'ctx', text: l.slice(1) });
          else if (l.startsWith('-')) cur.ops.push({ kind: 'del', text: l.slice(1) });
          else cur.ops.push({ kind: 'add', text: l.slice(1) });
          j += 1;
          continue;
        }
        throw new Exit2(`error: parse ${start + j + 1}`);
      }
      flush();
      if (sec.chunks.length === 0 && sec.moveTo === null) throw new Exit2(`error: parse ${start}`);
    }
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((sec) => v4aEdit(sec, strict));
}

/** One V4A section is one edit. */
function v4aEdit(sec: V4ASection, strict: boolean): Edit {
  return (tree: Tree) => {
    if (sec.kind === 'add') {
      guardPaths([sec.path]);
      if (tree.get(sec.path) !== null) throw new Fail('exists', sec.path);
      tree.now.set(sec.path, sec.lines.length === 0 ? '' : sec.lines.join('\n') + '\n');
      return;
    }
    if (sec.kind === 'delete') {
      guardPaths([sec.path]);
      if (tree.get(sec.path) === null) throw new Fail('missing', sec.path);
      tree.now.set(sec.path, null);
      return;
    }
    // Update File.
    const paths = sec.moveTo === null ? [sec.path] : [sec.path, sec.moveTo];
    guardPaths(paths);
    const before = tree.get(sec.path);
    if (before === null) throw new Fail('missing', sec.path);
    if (sec.moveTo !== null && tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
    const doc = readDoc(before);
    let cursor = 0;
    for (const chunk of sec.chunks) {
      if (chunk.anchor !== null) {
        const at = findAnchorLine(doc.lines, chunk.anchor, cursor, strict);
        if (at < 0) throw new Fail('no-match', sec.path);
        cursor = at + 1;
      }
      const old = oldOf(chunk.ops);
      if (old.length === 0) {
        const add = chunk.ops.filter((o) => o.kind === 'add').map((o) => o.text);
        const at = chunk.eof ? doc.lines.length : cursor;
        doc.lines.splice(at, 0, ...add);
        cursor = at + add.length;
        continue;
      }
      const found = findTierFrom(doc.lines, old, cursor, strict);
      if (found === null) throw new Fail('no-match', sec.path);
      let pos = -1;
      if (chunk.eof) {
        // An end-of-file chunk takes only an occurrence that ends at the file's
        // last line.
        for (const p of found.occ) {
          if (p + old.length === doc.lines.length) {
            pos = p;
            break;
          }
        }
        if (pos < 0) throw new Fail('no-match', sec.path);
      } else {
        pos = found.occ[0];
      }
      const replacement = newOf(chunk.ops, doc.lines, pos, found.tier);
      doc.lines.splice(pos, old.length, ...replacement);
      cursor = pos + replacement.length;
    }
    if (sec.moveTo !== null) {
      tree.now.set(sec.path, null);
      tree.now.set(sec.moveTo, writeDoc(doc));
      tree.moves.set(sec.moveTo, sec.path);
    } else {
      tree.now.set(sec.path, writeDoc(doc));
    }
  };
}

/** The first tier at which O occurs at or after `from`, with its occurrences there. */
function findTierFrom(lines: string[], old: string[], from: number, strict: boolean): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(lines, old, t).filter((p) => p >= from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Section 9: JSON edits                                               */
/* ------------------------------------------------------------------ */

/** One JSON edit object (section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const read = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (
    o.command === 'str_replace' &&
    typeof o.old_str === 'string' &&
    o.old_str !== '' &&
    (o.new_str === undefined || typeof o.new_str === 'string')
  ) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = read(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const norm = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = norm(before);
      const old = norm(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + norm(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (
    o.command === 'insert' &&
    typeof o.insert_line === 'number' &&
    Number.isInteger(o.insert_line) &&
    typeof o.new_str === 'string'
  ) {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = read(tree);
      const doc = readDoc(before);
      if (line < 0 || line > doc.lines.length) throw new Fail('no-match', p);
      doc.lines.splice(line, 0, ...add);
      tree.now.set(p, writeDoc(doc));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* ------------------------------------------------------------------ */
/* Section 4: detecting the format                                     */
/* ------------------------------------------------------------------ */

/** With `--format=auto` the format is the first of these that holds. */
function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/* ------------------------------------------------------------------ */
/* Sections 1, 2 and 10: invocation, output and exit codes, order      */
/* ------------------------------------------------------------------ */

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = new Map(tree.moves);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.clear();
      for (const [k, v] of beforeMoves) tree.moves.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  }
  const movedFrom = new Set<string>(tree.moves.values());
  const rows: string[] = [];
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (movedFrom.has(p)) {
      // The old path of a move: deleted from disk, but no row of its own.
      if (!check && now === null) rmSync(p, { force: true });
      continue;
    }
    if (tree.moves.has(p)) rows.push(`R ${tree.moves.get(p)} -> ${p}`);
    else rows.push(`${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`);
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
