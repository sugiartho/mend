// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file's lines, its line break, and whether it ends with one (SPEC.md section 3). */
interface FileText {
  lines: string[];
  br: string;
  final: boolean;
}

function splitFile(text: string): FileText {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinFile(f: FileText): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

/** One line of a hunk or chunk body: context, old, or new, with a `\` line after it or not. */
interface BodyItem {
  kind: 'ctx' | 'old' | 'new';
  text: string;
  backslash: boolean;
}

const trailWs = (s: string): string => s.replace(/[ \t]+$/, '');
const trimWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
};

function tierEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trailWs(a) === trailWs(b);
  return trimWs(a) === trimWs(b);
}

/** Positions where O occurs in lines at one tier (occurrences may overlap). */
function occurrences(lines: string[], o: string[], tier: number, from = 0): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = Math.max(0, from); i + o.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (!tierEq(lines[i + j]!, o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, then 1, then 2; only 0 when strict) where O occurs, with its positions. */
function findTier(lines: string[], o: string[], strict: boolean, from = 0): { tier: number; pos: number[] } | null {
  const max = strict ? 0 : 2;
  for (let t = 0; t <= max; t++) {
    const pos = occurrences(lines, o, t, from);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

/** At tier 2, re-indent a non-context new line: replace leading P with F (SPEC.md section 5). */
function reindent(line: string, p: string, f: string): string {
  if (/^[ \t]*$/.test(line)) return line;
  if (!line.startsWith(p)) return line;
  return f + line.slice(p.length);
}

/**
 * The replacement lines for an O -> N replacement at position `at` in `lines`, at the given tier.
 * A context line is written as the file's own matched line; a new line is re-indented at tier 2.
 */
function buildReplacement(lines: string[], at: number, items: BodyItem[], tier: number): string[] {
  const o = items.filter((it) => it.kind !== 'new').map((it) => it.text);
  const p = o.length > 0 ? leadWs(o[0]!) : '';
  const f = leadWs(lines[at] ?? '');
  const out: string[] = [];
  let oIdx = 0;
  for (const it of items) {
    if (it.kind === 'ctx') {
      out.push(lines[at + oIdx]!);
      oIdx++;
    } else if (it.kind === 'old') {
      oIdx++;
    } else {
      out.push(tier === 2 ? reindent(it.text, p, f) : it.text);
    }
  }
  return out;
}

/** The last context or new item of a hunk or chunk, if any. */
function lastCtxNew(items: BodyItem[]): BodyItem | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i]!.kind !== 'old') return items[i]!;
  }
  return undefined;
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Successful moves, as [old, new] pairs, for the `R old -> new` report lines. */
  readonly moves: Array<[string, string]> = [];
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
}

type Edit = (tree: Tree) => void;

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

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
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
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
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

/** One hunk of a unified diff (SPEC.md section 6). */
interface Hunk {
  a: number;
  items: BodyItem[];
}

/** One section of a unified diff, with its header fields as parsed. */
interface UniSection {
  diffOld: string | undefined;
  diffNew: string | undefined;
  pairOld: string | null;
  pairNew: string | null;
  hasPair: boolean;
  renameOld: string | undefined;
  renameNew: string | undefined;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
  oldP: string | null;
  newP: string | null;
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** The path a `--- ` or `+++ ` header line names (null: /dev/null, no file). */
function headerPath(l: string): string | null {
  let t = l.slice(4);
  const tab = t.indexOf('\t');
  if (tab >= 0) t = t.slice(0, tab);
  t = t.trim();
  if (t === '/dev/null') return null;
  if (t.startsWith('a/') || t.startsWith('b/')) t = t.slice(2);
  return t;
}

/** A `diff --git a/<X> b/<Y>` line's paths, or null when it is not of that form. */
function diffGitPaths(l: string): { oldP: string; newP: string } | null {
  const rest = l.slice('diff --git '.length);
  if (!rest.startsWith('a/')) return null;
  const k = rest.indexOf(' b/');
  if (k < 0) return null;
  return { oldP: rest.slice(2, k), newP: rest.slice(k + 3) };
}

function parseUnified(lines: string[]): UniSection[] {
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  let inHeader = false;
  const startSection = (diffOld: string | undefined, diffNew: string | undefined): void => {
    cur = {
      diffOld,
      diffNew,
      pairOld: null,
      pairNew: null,
      hasPair: false,
      renameOld: undefined,
      renameNew: undefined,
      newFile: false,
      deletedFile: false,
      hunks: [],
      oldP: null,
      newP: null,
    };
    sections.push(cur);
    inHeader = true;
  };
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const dg = diffGitPaths(l);
      if (dg === null) throw new Exit2(`error: parse ${i + 1}`);
      startSection(dg.oldP, dg.newP);
      i++;
      continue;
    }
    if (l.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = HUNK_RE.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const hunk: Hunk = { a: parseInt(m[1]!, 10), items: [] };
      cur.hunks.push(hunk);
      inHeader = false;
      i++;
      while (i < lines.length) {
        const b = lines[i]!;
        if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('@@')) break;
        if (b === '' || b.startsWith(' ') || b.startsWith('-') || b.startsWith('+') || b.startsWith('\\')) {
          if (b.startsWith('\\')) {
            for (let k = hunk.items.length - 1; k >= 0; k--) {
              hunk.items[k]!.backslash = true;
              break;
            }
          } else if (b === '') {
            hunk.items.push({ kind: 'ctx', text: '', backslash: false });
          } else if (b.startsWith(' ')) {
            hunk.items.push({ kind: 'ctx', text: b.slice(1), backslash: false });
          } else if (b.startsWith('-')) {
            hunk.items.push({ kind: 'old', text: b.slice(1), backslash: false });
          } else {
            hunk.items.push({ kind: 'new', text: b.slice(1), backslash: false });
          }
          i++;
        } else {
          break;
        }
      }
      while (hunk.items.length > 0) {
        const last = hunk.items[hunk.items.length - 1]!;
        if (last.kind === 'ctx' && last.text === '') hunk.items.pop();
        else break;
      }
      continue;
    }
    if (l.startsWith('--- ')) {
      if (inHeader && cur !== null) {
        if ((lines[i + 1] ?? '').startsWith('+++ ')) {
          if (!cur.hasPair) {
            cur.pairOld = headerPath(l);
            cur.pairNew = headerPath(lines[i + 1]!);
            cur.hasPair = true;
          } else {
            startSection(undefined, undefined);
            cur!.pairOld = headerPath(l);
            cur!.pairNew = headerPath(lines[i + 1]!);
            cur!.hasPair = true;
          }
          i += 2;
          continue;
        }
        throw new Exit2(`error: parse ${i + 2}`);
      }
      if ((lines[i + 1] ?? '').startsWith('+++ ')) {
        startSection(undefined, undefined);
        cur!.pairOld = headerPath(l);
        cur!.pairNew = headerPath(lines[i + 1]!);
        cur!.hasPair = true;
        i += 2;
        continue;
      }
      i++;
      continue;
    }
    if (inHeader && cur !== null) {
      if (l.startsWith('rename from ')) cur.renameOld = l.slice('rename from '.length).trim();
      else if (l.startsWith('rename to ')) cur.renameNew = l.slice('rename to '.length).trim();
      else if (l.startsWith('new file mode')) cur.newFile = true;
      else if (l.startsWith('deleted file mode')) cur.deletedFile = true;
      i++;
      continue;
    }
    i++;
  }
  for (const sec of sections) {
    sec.oldP = sec.hasPair ? sec.pairOld : sec.renameOld !== undefined ? sec.renameOld : (sec.diffOld ?? null);
    sec.newP = sec.hasPair ? sec.pairNew : sec.renameNew !== undefined ? sec.renameNew : (sec.diffNew ?? null);
  }
  return sections;
}

/** Apply one section's hunks in order to a file's lines (SPEC.md section 6). */
function applyHunks(f: FileText, hunks: Hunk[], strict: boolean, path: string): FileText {
  let lines = [...f.lines];
  let finalBreak = f.final;
  let d = 0;
  for (const h of hunks) {
    const o = h.items.filter((it) => it.kind !== 'new').map((it) => it.text);
    if (o.length === 0) {
      const nLines = h.items.filter((it) => it.kind === 'new').map((it) => it.text);
      let p = h.a + d;
      if (p < 0) p = 0;
      if (p > lines.length) p = lines.length;
      const atEnd = p === lines.length;
      lines = [...lines.slice(0, p), ...nLines, ...lines.slice(p)];
      if (atEnd && nLines.length > 0) {
        const lastNew = lastCtxNew(h.items);
        finalBreak = !(lastNew?.backslash ?? false);
      }
      d += nLines.length;
    } else {
      const found = findTier(lines, o, strict);
      if (found === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = found.pos[0]!;
      let bestDist = Math.abs(best - target);
      for (const p of found.pos) {
        const dist = Math.abs(p - target);
        if (dist < bestDist) {
          best = p;
          bestDist = dist;
        }
      }
      const at = best;
      const repl = buildReplacement(lines, at, h.items, found.tier);
      const reachesEOF = at + o.length === lines.length;
      lines = [...lines.slice(0, at), ...repl, ...lines.slice(at + o.length)];
      if (reachesEOF) {
        if (repl.length === 0) {
          finalBreak = lines.length > 0;
        } else {
          const lastNew = lastCtxNew(h.items);
          finalBreak = !(lastNew?.backslash ?? false);
        }
      }
      d += repl.length - o.length;
    }
  }
  return { lines, br: f.br, final: finalBreak };
}

/** One unified section as one edit (SPEC.md section 6). */
function uniSectionEdit(sec: UniSection, strict: boolean): Edit {
  return (tree: Tree): void => {
    const oldP = sec.oldP;
    const newP = sec.newP;
    if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
    if (oldP === null || sec.newFile) {
      if (newP === null) return;
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const content: string[] = [];
      let lastPlus: BodyItem | undefined;
      for (const h of sec.hunks) {
        for (const it of h.items) {
          if (it.kind === 'new') {
            content.push(it.text);
            lastPlus = it;
          }
        }
      }
      const text = content.length === 0 ? '' : content.join('\n') + (lastPlus?.backslash ? '' : '\n');
      tree.now.set(newP, text);
      return;
    }
    if (newP === null || sec.deletedFile) {
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    if (oldP !== newP) {
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const f = splitFile(tree.get(oldP)!);
      const result = applyHunks(f, sec.hunks, strict, oldP);
      tree.now.set(newP, joinFile(result));
      tree.now.set(oldP, null);
      tree.moves.push([oldP, newP]);
      return;
    }
    if (tree.get(oldP) === null) throw new Fail('missing', oldP);
    const f = splitFile(tree.get(oldP)!);
    const result = applyHunks(f, sec.hunks, strict, oldP);
    tree.now.set(oldP, joinFile(result));
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  return parseUnified(lines).map((sec) => uniSectionEdit(sec, strict));
}

/** One SEARCH/REPLACE block (SPEC.md section 7). */
interface SRBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function parseSR(lines: string[]): SRBlock[] {
  const blocks: SRBlock[] = [];
  let i = 0;
  let prevReplaceEnd = -1;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() === '<<<<<<< SEARCH') {
      const searchLine = i + 1;
      let path: string | null = null;
      for (let j = i - 1; j > prevReplaceEnd; j--) {
        const t = lines[j]!.trim();
        if (t === '') continue;
        if (t.startsWith('```')) continue;
        path = t;
        break;
      }
      if (path === null) {
        if (blocks.length > 0) path = blocks[blocks.length - 1]!.path;
        else throw new Exit2(`error: parse ${searchLine}`);
      }
      let eq = -1;
      for (let j = i + 1; j < lines.length; j++) {
        const t = lines[j]!.trimEnd();
        if (t === '<<<<<<< SEARCH') break;
        if (t === '=======') {
          eq = j;
          break;
        }
      }
      if (eq === -1) throw new Exit2(`error: parse ${searchLine}`);
      let rep = -1;
      for (let j = eq + 1; j < lines.length; j++) {
        const t = lines[j]!.trimEnd();
        if (t === '<<<<<<< SEARCH') break;
        if (t === '>>>>>>> REPLACE') {
          rep = j;
          break;
        }
      }
      if (rep === -1) throw new Exit2(`error: parse ${searchLine}`);
      blocks.push({ path, oldLines: lines.slice(i + 1, eq), newLines: lines.slice(eq + 1, rep) });
      prevReplaceEnd = rep;
      i = rep + 1;
    } else {
      i++;
    }
  }
  return blocks;
}

/** One SEARCH/REPLACE block as one edit (SPEC.md section 7). */
function srBlockEdit(b: SRBlock, strict: boolean): Edit {
  return (tree: Tree): void => {
    if (!safe(b.path)) throw new Fail('unsafe', b.path);
    if (b.oldLines.length === 0) {
      if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
      tree.now.set(b.path, b.newLines.length === 0 ? '' : b.newLines.join('\n') + '\n');
      return;
    }
    const cur = tree.get(b.path);
    if (cur === null) throw new Fail('missing', b.path);
    const f = splitFile(cur);
    const found = findTier(f.lines, b.oldLines, strict);
    if (found === null) throw new Fail('no-match', b.path);
    if (found.pos.length > 1) throw new Fail('ambiguous', b.path);
    const at = found.pos[0]!;
    const items: BodyItem[] = [
      ...b.oldLines.map((t): BodyItem => ({ kind: 'old', text: t, backslash: false })),
      ...b.newLines.map((t): BodyItem => ({ kind: 'new', text: t, backslash: false })),
    ];
    const repl = buildReplacement(f.lines, at, items, found.tier);
    const lines = [...f.lines.slice(0, at), ...repl, ...f.lines.slice(at + b.oldLines.length)];
    tree.now.set(b.path, joinFile({ lines, br: f.br, final: f.final }));
  };
}

function srEdits(lines: string[], strict: boolean): Edit[] {
  return parseSR(lines).map((b) => srBlockEdit(b, strict));
}

/** One chunk of a V4A Update File section (SPEC.md section 8). */
interface V4AChunk {
  anchor: string | null;
  eof: boolean;
  items: BodyItem[];
}

/** One section of a V4A patch (SPEC.md section 8). */
interface V4ASection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  line: number;
  moveTo: string | null;
  lines: string[];
  chunks: V4AChunk[];
}

function parseV4A(lines: string[]): V4ASection[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: V4ASection[] = [];
  let cur: V4ASection | null = null;
  let curChunk: V4AChunk | null = null;
  let seenBody = false;
  let afterEof = false;
  const finishSection = (): void => {
    if (cur === null) return;
    if (cur.kind === 'update') {
      if (curChunk !== null) {
        while (curChunk.items.length > 0) {
          const it = curChunk.items[curChunk.items.length - 1]!;
          if (it.kind === 'ctx' && it.text === '') curChunk.items.pop();
          else break;
        }
      }
      if (cur.chunks.length === 0 && cur.moveTo === null) throw new Exit2(`error: parse ${cur.line}`);
    }
    if (cur.kind === 'add') {
      while (cur.lines.length > 0 && cur.lines[cur.lines.length - 1] === '') cur.lines.pop();
    }
    cur = null;
    curChunk = null;
    seenBody = false;
    afterEof = false;
  };
  for (let i = first + 1; i < last; i++) {
    const l = lines[i]!;
    if (l.startsWith('*** Add File:') || l.startsWith('*** Delete File:') || l.startsWith('*** Update File:')) {
      finishSection();
      const kind = l.startsWith('*** Add File:') ? 'add' : l.startsWith('*** Delete File:') ? 'delete' : 'update';
      const prefix = kind === 'add' ? '*** Add File:' : kind === 'delete' ? '*** Delete File:' : '*** Update File:';
      cur = { kind, path: l.slice(prefix.length).trim(), line: i + 1, moveTo: null, lines: [], chunks: [] };
      sections.push(cur);
      curChunk = null;
      seenBody = false;
      afterEof = false;
      continue;
    }
    if (cur === null) {
      if (blank(l)) continue;
      throw new Exit2(`error: parse ${i + 1}`);
    }
    if (cur.kind === 'add') {
      if (l === '') {
        cur.lines.push('');
        continue;
      }
      if (l.startsWith('+')) {
        cur.lines.push(l.slice(1));
        continue;
      }
      throw new Exit2(`error: parse ${i + 1}`);
    }
    if (cur.kind === 'delete') {
      if (blank(l)) continue;
      throw new Exit2(`error: parse ${i + 1}`);
    }
    if (!seenBody && l.startsWith('*** Move to:')) {
      cur.moveTo = l.slice('*** Move to:'.length).trim();
      seenBody = true;
      continue;
    }
    if (l === '*** End of File') {
      if (curChunk !== null) {
        curChunk.eof = true;
        curChunk = null;
        afterEof = true;
      }
      continue;
    }
    if (l.startsWith('@@')) {
      const anchorText = l.slice(2).trim();
      curChunk = { anchor: anchorText === '' ? null : anchorText, eof: false, items: [] };
      cur.chunks.push(curChunk);
      seenBody = true;
      afterEof = false;
      continue;
    }
    if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
      if (l === '' && curChunk === null && cur.chunks.length === 0 && cur.moveTo === null) continue;
      if (l === '' && afterEof) continue;
      if (afterEof) throw new Exit2(`error: parse ${i + 1}`);
      if (curChunk === null) {
        curChunk = { anchor: null, eof: false, items: [] };
        cur.chunks.push(curChunk);
        seenBody = true;
      }
      if (l === '') curChunk.items.push({ kind: 'ctx', text: '', backslash: false });
      else if (l.startsWith(' ')) curChunk.items.push({ kind: 'ctx', text: l.slice(1), backslash: false });
      else if (l.startsWith('-')) curChunk.items.push({ kind: 'old', text: l.slice(1), backslash: false });
      else curChunk.items.push({ kind: 'new', text: l.slice(1), backslash: false });
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  finishSection();
  return sections;
}

/** One V4A section as one edit (SPEC.md section 8). */
function v4aSectionEdit(sec: V4ASection, strict: boolean): Edit {
  return (tree: Tree): void => {
    if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
    if (sec.kind === 'add') {
      if (tree.get(sec.path) !== null) throw new Fail('exists', sec.path);
      tree.now.set(sec.path, sec.lines.length === 0 ? '' : sec.lines.join('\n') + '\n');
      return;
    }
    if (sec.kind === 'delete') {
      if (tree.get(sec.path) === null) throw new Fail('missing', sec.path);
      tree.now.set(sec.path, null);
      return;
    }
    const cur = tree.get(sec.path);
    if (sec.moveTo !== null && !safe(sec.moveTo)) throw new Fail('unsafe', sec.moveTo);
    if (cur === null) throw new Fail('missing', sec.path);
    if (sec.moveTo !== null && tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
    const f = splitFile(cur);
    let lines = [...f.lines];
    let cursor = 0;
    for (const ch of sec.chunks) {
      if (ch.anchor !== null) {
        const found = findTier(lines, [ch.anchor], strict, cursor);
        if (found === null) throw new Fail('no-match', sec.path);
        cursor = found.pos[0]! + 1;
      }
      const o = ch.items.filter((it) => it.kind !== 'new').map((it) => it.text);
      if (o.length === 0) {
        const nLines = ch.items.filter((it) => it.kind === 'new').map((it) => it.text);
        const p = ch.eof ? lines.length : cursor;
        lines = [...lines.slice(0, p), ...nLines, ...lines.slice(p)];
        cursor = p + nLines.length;
      } else {
        const found = findTier(lines, o, strict, cursor);
        if (found === null) throw new Fail('no-match', sec.path);
        let at: number | undefined;
        if (ch.eof) {
          at = found.pos.find((p) => p + o.length === lines.length);
          if (at === undefined) throw new Fail('no-match', sec.path);
        } else {
          at = found.pos[0]!;
        }
        const repl = buildReplacement(lines, at, ch.items, found.tier);
        lines = [...lines.slice(0, at), ...repl, ...lines.slice(at + o.length)];
        cursor = at + repl.length;
      }
    }
    const out = joinFile({ lines, br: f.br, final: f.final });
    if (sec.moveTo !== null) {
      tree.now.set(sec.moveTo, out);
      tree.now.set(sec.path, null);
      tree.moves.push([sec.path, sec.moveTo]);
    } else {
      tree.now.set(sec.path, out);
    }
  };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  return parseV4A(lines).map((sec) => v4aSectionEdit(sec, strict));
}

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
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? srEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = beforeMoves;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  const covered = new Set<string>();
  const rows: { key: string; text: string }[] = [];
  for (const [oldP, newP] of tree.moves) {
    if (tree.original(oldP) !== null && tree.get(oldP) === null && tree.original(newP) === null && tree.get(newP) !== null) {
      rows.push({ key: newP, text: `R ${oldP} -> ${newP}` });
      covered.add(oldP);
      covered.add(newP);
    }
  }
  for (const p of [...tree.now.keys()]) {
    if (covered.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const out = rows.map((r) => r.text);
  return { code: 0, out: [...out, `ok: ${out.length} ${out.length === 1 ? 'file' : 'files'}`] };
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
