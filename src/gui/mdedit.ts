/**
 * Live-preview Markdown editor, reusable for any text input of the GUI.
 *
 * The DOM always holds the raw Markdown source, so `texts()` is lossless by construction: no md -> HTML -> md
 * round trip ever rewrites the user's syntax. Styling comes from re-tokenizing the source on every input.
 * Syntax markers (`**`, `## `, `- `, `[`, `](url)`) take no layout space: they are absolutely positioned outside
 * the text they mark (opening ones to its left, closing ones to its right), hidden until the caret is inside or
 * next to their element. Focusing therefore never moves text; only the frame and the shared toolbox appear.
 *
 * The tokenizer is pure and nothing touches `document` at import time, so node tests can import this module.
 */

import { show } from './motion.js';

// ---- Types ----

/** Inline element: `[start, open)` is the opening marker, `[close, end)` the closing one, `kids` lie in between. */
export interface Inl { kind: 'strong' | 'em' | 'strike' | 'code' | 'link'; start: number; open: number; close: number; end: number; url?: string; kids: Inl[] }

/**
 * Table cell: `[start, open)` is its opening marker, `[close, end)` its closing one. A middle `|` and the spaces around
 * it are one marker, opening the cell right of it (the left cell's `close === end`); the first cell opens with
 * indentation and the leading `|`, the last closes with the trailing `|`. A row's cells cover it exactly.
 * Blank content stays text (caret target).
 */
export interface Cell { start: number; open: number; close: number; end: number; align?: 'l' | 'c' | 'r'; inl: Inl[] }

/** One source line (`end` excludes the newline). `[start, mark)` is its block marker (`## `, `- [ ] `, `> `). */
export interface Line {
  start: number; end: number; mark: number;
  block: 'p' | 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6' | 'li' | 'ol' | 'quote' | 'fence' | 'code' | 'th' | 'tsep' | 'td';
  depth: number;                     // list nesting (2 columns per level)
  check?: string;                    // task-list checkbox state: ' ' or 'x'
  cells?: Cell[];                    // table rows (th, tsep, td) only; their `inl` stays empty
  join?: 'soft' | 'hard';            // continues the previous line's paragraph: after a plain newline, or a hard break
  br?: number;                       // length of its hard break's text ending it (2+ spaces, or `\` with the spaces before it): a closing marker
  inl: Inl[];
}

export interface EditorOpts {
  mode: 'line' | 'block';            // block: taller, drag-resizable, full toolbox
  /** Text parts with widgets between them (description: text, link list, text ...). Plain fields pass one string. */
  parts: (string | HTMLElement)[];
  multiline?: boolean;               // false: newlines can never be typed or pasted (title). Default true.
  placeholder?: string;              // shown while empty; only without widgets (an empty gap between lists is normal)
  label?: string;                    // aria-label of the text parts
  className?: string;                // extra frame class
  onInput?: () => void;              // any change; callers mark the page dirty
  onConfirm?: () => void;            // Ctrl+Enter, the toolbox checkmark, Enter on one line in line mode; default: blur
}

export interface Editor {
  el: HTMLElement;
  /** Source of each text part, in order; edited hard-wrapped paragraphs are rewrapped as shown (`rewrap`). */
  texts(): string[];
  /** Replaces all text parts and clears their undo history; widgets stay. */
  set(texts: string[]): void;
}

// ---- Tokenizer (pure) ----

const HEADING = /^(#{1,6})[ \t]+/, QUOTE = /^[ \t]*>[ \t]?/, FENCE = /^[ \t]*(`{3,}|~{3,})/;
const LIST = /^([ \t]*)([-*+]|\d{1,9}[.)])[ \t]+(?:\[([ xX])\][ \t]+)?/;
const PIPE = /(?:^|[^\\])\|/, DELIM = /^:?-+:?$/;

/**
 * Cells of the row `[start, end)`: split at unescaped `|` (code spans split too, as in GFM), contents trimmed into the
 * markers unless blank. `aligns` comes from the table's delimiter row.
 */
function cells(src: string, start: number, end: number, aligns: Cell['align'][] = []): Cell[] {
  const pipes: number[] = [];
  for (let k = start; k < end; k++) { if (src[k] === '\\') k++; else if (src[k] === '|') pipes.push(k); }
  const text = src.slice(start, end), lead = pipes[0] === start + text.search(/\S/);
  const trail = pipes.length > +lead && pipes.at(-1) === start + text.trimEnd().length - 1;
  const starts = (lead ? pipes : [start, ...pipes]).slice(0, trail ? -1 : undefined);
  const out = starts.map((s, i) => {
    const last = i === starts.length - 1, e = last ? end : starts[i + 1];
    const cs = src[s] === '|' ? s + 1 : s, ce = last && trail ? pipes.at(-1)! : e, raw = src.slice(cs, ce);
    let open = cs + raw.search(/\S|$/), close = cs + raw.trimEnd().length;
    if (open >= close) [open, close] = [cs, ce];
    return { start: s, open, close, end: e, align: aligns[i], inl: inline(src, open, close) };
  });
  // Middle pipes: the left cell's trailing spaces join the right cell's opening marker
  for (let i = 1; i < out.length; i++) out[i].start = out[i - 1].end = out[i - 1].close;
  return out;
}

/**
 * Splits source into lines and classifies blocks; inside fences nothing is parsed. Unknown syntax stays plain text.
 * Tables follow GFM: a header row (with an unescaped `|`) directly followed by a delimiter row with as many cells,
 * then body rows until a blank line or another block starts.
 * Line breaks follow CommonMark: a nonblank text line (`p`, or `quote` after a quote) right after a paragraph, list
 * item or quote line continues it (`join`). The break is soft (a space when rendered) unless the previous line ends
 * with 2+ spaces or a backslash (hard; that text is the line's `br`). shortcut: a backslash before any newline is a break
 * marker, even before a blank line, where CommonMark keeps it literal; it saves the backslash flashing up while
 * Shift+Enter starts a line.
 */
export function tokenize(src: string): Line[] {
  const out: Line[] = [], texts = src.split('\n');
  let fence: string | null = null, at = 0, aligns: Cell['align'][] | null = null, sep = false;
  for (const [i, text] of texts.entries()) {
    const start = at, end = at + text.length, f = FENCE.exec(text);
    at = end + 1;
    const line = (block: Line['block'], mark = start, depth = 0): Line => ({ start, end, mark, block, depth, inl: [] });
    const row = (block: Line['block']) => ({ ...line(block), cells: cells(src, start, end, aligns!) });
    if (fence) {
      const closes = !!f && f[1][0] === fence[0] && f[1].length >= fence.length;
      out.push(line(closes ? 'fence' : 'code'));
      if (closes) fence = null;
      continue;
    }
    if (sep) { sep = false; out.push(row('tsep')); continue; }
    if (aligns) {
      if (text.trim() && !f && !HEADING.test(text) && !QUOTE.test(text) && !LIST.test(text)) { out.push(row('td')); continue; }
      aligns = null;
    }
    if (f) { fence = f[1]; out.push(line('fence')); continue; }

    // Table header: decided by the next line, which is then emitted as the delimiter row
    const next = texts[i + 1];
    if (next !== undefined && PIPE.test(text) && PIPE.test(next)) {
      const d = cells(src, end + 1, end + 1 + next.length), h = cells(src, start, end);
      if (h.length === d.length && d.every(c => DELIM.test(src.slice(c.open, c.close)))) {
        aligns = d.map(c => { const v = src.slice(c.open, c.close), l = v[0] === ':', r = v.endsWith(':'); return l && r ? 'c' : r ? 'r' : l ? 'l' : undefined; });
        sep = true;
        out.push(row('th'));
        continue;
      }
    }

    let l: Line, m: RegExpExecArray | null;
    if ((m = HEADING.exec(text))) l = line(`h${m[1].length}` as Line['block'], start + m[0].length);
    else if ((m = LIST.exec(text))) {
      // A tab is one nesting level (2 columns), as Tab inserts it
      l = line(/\d/.test(m[2]) ? 'ol' : 'li', start + m[0].length, Math.floor(m[1].replace(/\t/g, '  ').length / 2));
      if (m[3]) l.check = m[3].toLowerCase();
    } else if ((m = QUOTE.exec(text))) l = line('quote', start + m[0].length);
    else l = line('p');
    const body = src.slice(l.mark, end), prev = out.at(-1), TEXT = /^(p|li|ol|quote)$/;
    if (TEXT.test(l.block) && i < texts.length - 1 && /(?:^|[^\\])(?:\\\\)*\\$/.test(body)) l.br = /[ \t]*\\$/.exec(body)![0].length;
    if (prev && TEXT.test(prev.block) && /\S/.test(src.slice(prev.mark, prev.end)) && /\S/.test(body) && (l.block === 'p' || (l.block === 'quote' && prev.block === 'quote'))) {
      // Trailing spaces end no inline element, so `prev.inl` stays valid when they become its break
      prev.br ??= / {2,}$/.exec(src.slice(prev.mark, prev.end))?.[0].length;
      l.join = prev.br ? 'hard' : 'soft';
    }
    l.inl = inline(src, l.mark, end - (l.br ?? 0));
    out.push(l);
  }
  return out;
}

/** Length of the run of `c` at `i` (bounded by `to`). */
function run(src: string, i: number, to: number, c: string): number {
  let k = i;
  while (k < to && src[k] === c) k++;
  return k - i;
}

/** Start of the next backtick run of exactly `n` after `from`, or -1: closes a code span. */
function codeClose(src: string, from: number, to: number, n: number): number {
  for (let k = from; k < to; k++) {
    if (src[k] !== '`') continue;
    const r = run(src, k, to, '`');
    if (r === n) return k;
    k += r - 1;
  }
  return -1;
}

/**
 * Closing delimiter `d` for an emphasis opened before `from`: a run of exactly `d.length` not preceded by
 * whitespace, skipping escapes and code spans (they shield their content). `_` must not continue a word.
 * A run of three closes with its tail, so the inner emphasis closes with its head (`**a *b***`).
 */
function emClose(src: string, from: number, to: number, d: string): number {
  for (let k = from; k < to; k++) {
    const c = src[k];
    if (c === '\\') { k++; continue; }
    if (c === '`') { const r = run(src, k, to, '`'), j = codeClose(src, k + r, to, r); k = (j < 0 ? k + r : j + r) - 1; continue; }
    if (c !== d[0]) continue;
    const r = run(src, k, to, c);
    if ((r === d.length || r === 3) && k > from && !/\s/.test(src[k - 1]) && (c !== '_' || !/\w/.test(src[k + r] ?? ''))) return k + r - d.length;
    k += r - 1;
  }
  return -1;
}

/**
 * Inline elements of `[from, to)`: code spans, links `[text](url)`, `**`/`__` strong, `*`/`_` em, `~~` strike.
 * Unclosed delimiters stay plain text. shortcut: a subset of CommonMark (no `***` openers, no nested brackets in links,
 * no autolinks); extend here if real notes need more.
 */
export function inline(src: string, from: number, to: number): Inl[] {
  const out: Inl[] = [];
  for (let i = from; i < to; i++) {
    const c = src[i];
    if (c === '\\') { i++; continue; }
    if (c === '`') {
      const r = run(src, i, to, '`'), j = codeClose(src, i + r, to, r);
      if (j >= 0) { out.push({ kind: 'code', start: i, open: i + r, close: j, end: j + r, kids: [] }); i = j + r - 1; }
      else i += r - 1;
      continue;
    }
    if (c === '[') {
      const m = /^\[((?:\\.|[^\]\\])*)\]\(([^()\s]*)\)/.exec(src.slice(i, to));
      if (m) {
        const close = i + 1 + m[1].length;
        out.push({ kind: 'link', start: i, open: i + 1, close, end: i + m[0].length, url: m[2], kids: inline(src, i + 1, close) });
        i += m[0].length - 1;
      }
      continue;
    }
    if (c !== '*' && c !== '_' && c !== '~') continue;
    const r = run(src, i, to, c);
    const ok = (c === '~' ? r === 2 : r <= 2) && i + r < to && !/\s/.test(src[i + r]) && (c !== '_' || !/\w/.test(src[i - 1] ?? ''));
    const j = ok ? emClose(src, i + r, to, c.repeat(r)) : -1;
    if (j >= 0) {
      out.push({ kind: c === '~' ? 'strike' : r === 2 ? 'strong' : 'em', start: i, open: i + r, close: j, end: j + r, kids: inline(src, i + r, j) });
      i = j + r - 1;
    } else i += r - 1;
  }
  return out;
}

/**
 * Edit a list key makes at caret `at` (no selection) as `[a, b, text, caret]`: `[a, b)` becomes `text`; null when the
 * key keeps its default (not a list line, caret inside the marker, Tab/Backspace away from the item's text start).
 * - Enter continues the list (next number, unchecked box); on an empty item it acts as Shift+Tab.
 * - Tab at the text start indents by one `\t`; Shift+Tab outdents one level, or turns an unindented item into text.
 * - Backspace at the text start joins the text to the previous line, keeping one space between nonempty sides.
 */
export function listEdit(src: string, at: number, key: 'Enter' | 'Tab' | 'Backspace', shift = false): [number, number, string, number] | null {
  const l = tokenize(src).find(l => l.start <= at && at <= l.end);
  if (!l || (l.block !== 'li' && l.block !== 'ol') || at < l.mark || (key !== 'Enter' && at > l.mark)) return null;
  const pre = src.slice(l.start, l.mark), ind = /^[ \t]*/.exec(pre)![0];
  if (key === 'Enter' && l.mark < l.end) {
    const next = '\n' + pre.replace(/\d+(?=[.)])/, n => String(+n + 1)).replace(/\[[xX]\]/, '[ ]');
    return [at, at, next, at + next.length];
  }
  if (key === 'Tab' && !shift) return [l.start, l.start, '\t', at + 1];
  if (key !== 'Backspace') {
    if (!ind) return [l.start, l.mark, '', l.start];
    const less = ind.replace(/(\t| {1,2})$/, '');
    return [l.start, l.start + ind.length, less, at - ind.length + less.length];
  }
  if (!l.start) return [0, l.mark, '', 0];
  const gap = src[l.start - 2] && !/\s/.test(src[l.start - 2]) && l.mark < l.end ? ' ' : '';
  return [l.start - 1, l.mark, gap, l.start - 1 + gap.length];
}

/**
 * Text Enter inserts at `at` when no list or table edit applies: code and table rows take a raw newline; otherwise
 * Shift+Enter makes a hard break (`\` + newline) and Enter in a nonblank paragraph or quote starts a new paragraph,
 * since a plain newline there is a soft break, rendered as a space.
 */
export function enterText(src: string, at: number, shift: boolean): string {
  const l = tokenize(src).find(l => l.start <= at && at <= l.end)!;
  if (l.block === 'code' || l.block === 'fence' || l.cells) return '\n';
  if (shift) return '\\\n';
  return (l.block === 'p' || l.block === 'quote') && /\S/.test(src.slice(l.mark, l.end)) ? '\n\n' : '\n';
}

/**
 * Edit a table key makes at caret `at` as `[a, b, text, selA, selB]` (`[a, b)` becomes `text`); a move edits nothing.
 * Null when not in a table row, or Shift+Tab in its first cell (focus moves on).
 * - Tab/Shift+Tab select the next/previous cell's content (a blank cell gets the caret after its first space), skipping
 *   the delimiter row; Tab past the last cell appends an empty row.
 * - Enter adds an empty row below the caret's row (below the delimiter row in the header); on a blank body row it
 *   blanks the line, which ends the table.
 * New rows have the header's cell count.
 */
export function tableEdit(src: string, at: number, key: 'Enter' | 'Tab', shift = false): [number, number, string, number, number] | null {
  const ls = tokenize(src), i = ls.findIndex(l => l.start <= at && at <= l.end), l = ls[i];
  if (!l?.cells) return null;
  let h = i, z = i;
  while (ls[h].block !== 'th') h--;
  while (ls[z + 1]?.cells && ls[z + 1].block !== 'th') z++;
  const blank = (c: Cell) => !src.slice(c.open, c.close).trim();
  const add = (after: number): [number, number, string, number, number] => {
    const e = ls[after].end;
    return [e, e, '\n|' + '   |'.repeat(ls[h].cells!.length), e + 3, e + 3];
  };
  if (key === 'Enter') return l.block === 'td' && l.cells.every(blank) ? [l.start, l.end, '', l.start, l.start] : add(l.block === 'td' ? i : h + 1);

  // Cells of the whole table in reading order; the caret's cell is the first ending at or after it
  const all = ls.slice(h, z + 1).flatMap(r => r.block === 'tsep' ? [] : r.cells!);
  // On the delimiter row the caret sits between the header and the body
  let k = l.block === 'tsep' ? all.indexOf(ls[h].cells!.at(-1)!) + +shift : all.indexOf(l.cells.find(c => at <= c.end) ?? l.cells.at(-1)!);
  k += shift ? -1 : 1;
  if (k < 0) return null;
  if (k >= all.length) return add(z);
  const c = all[k], [a, b] = blank(c) ? [Math.min(c.open + 1, c.close), Math.min(c.open + 1, c.close)] : [c.open, c.close];
  return [at, at, '', a, b];
}

// ---- Rewrapping (pure) ----

/** Soft-break groups of `ls` as `[first, last]` line indices: a paragraph's lines joined by plain newlines (one `div.grp` each). */
function groups(ls: Line[]): [number, number][] {
  const out: [number, number][] = [];
  ls.forEach((l, i) => {
    if (l.join !== 'soft') return;
    const g = out.at(-1);
    if (g && g[1] === i - 1) g[1] = i; else out.push([i - 1, i]);
  });
  return out;
}

/** Source texts of the soft-break groups of `src`: the unedited ones `rewrap` keeps. */
export function groupTexts(src: string): Set<string> {
  const ls = tokenize(src);
  return new Set(groups(ls).map(([a, b]) => src.slice(ls[a].start, ls[b].end)));
}

/**
 * Source to save: each soft-break group not in `keep` (an edited hard-wrapped paragraph) gets its newlines where the
 * editor shows it wrapping. `box(off)` is the screen `[top, height]` of the first visible character at source offset
 * `off`; one lower by over half a line starts a visual line. Without layout (null) the group stays as typed.
 * Breaks replace whole whitespace runs outside inline elements (the tokenizer reads those per line), and only where
 * the new line still continues the paragraph (not a list item, quote, table row or hard break); old newlines that
 * no longer fall at a wrap become spaces. Continuation lines get the group's second line's prefix (`> `, indentation).
 */
export function rewrap(src: string, keep: Set<string>, box: (off: number) => [number, number] | null): string {
  const ls = tokenize(src);
  const lead = (l: Line) => l.mark + /^[ \t]*/.exec(src.slice(l.mark, l.end))![0].length;
  const tail = (l: Line) => l.mark + src.slice(l.mark, l.end).trimEnd().length;

  /** Rewrapped text of the group `[a, b]`, or null without layout. */
  const group = (a: number, b: number): string | null => {
    // Candidate runs `[ws, we, join]`: between lines (trailing blanks, newline, prefix, leading blanks) and inside them
    const runs: [number, number, boolean][] = [];
    for (let i = a; i <= b; i++) {
      const l = ls[i], bs = lead(l);
      if (i > a) runs.push([tail(ls[i - 1]), bs, true]);
      for (const m of src.slice(bs, tail(l)).matchAll(/[ \t]+/g)) {
        const ws = bs + m.index;
        if (!l.inl.some(n => n.start < ws && ws < n.end)) runs.push([ws, ws + m[0].length, false]);
      }
    }
    const pre = src.slice(ls[a + 1].start, lead(ls[a + 1]));
    let res = '', from = ls[a].start, last = box(lead(ls[a]));
    if (!last) return null;
    for (const [ws, we, join] of runs) {
      const t = box(we);
      if (!t) return null;
      if (t[0] > last[0] + last[1] / 2) {
        last = t;
        // Valid only if the tokenizer still joins the new line softly to the current one
        const done = res + src.slice(from, ws), cur = done.slice(done.lastIndexOf('\n') + 1), eol = src.indexOf('\n', we);
        const two = tokenize(cur + '\n' + pre + src.slice(we, eol < 0 ? src.length : eol));
        if (two.length === 2 && two[1].join === 'soft') { res = done + '\n' + pre; from = we; continue; }
      }
      if (join) { res += src.slice(from, ws) + ' '; from = we; }
    }
    return res + src.slice(from, ls[b].end);
  };

  let out = '', at = 0;
  for (const [a, b] of groups(ls)) {
    const s = ls[a].start, e = ls[b].end;
    if (keep.has(src.slice(s, e))) continue;
    const g = group(a, b);
    if (g === null) continue;
    out += src.slice(at, s) + g;
    at = e;
  }
  return out + src.slice(at);
}

// ---- Clipboard (pure) ----

/** Inline elements of a line (its cells' for table rows). */
const inlOf = (l: Line) => l.cells ? l.cells.flatMap(c => c.inl) : l.inl;

/** Visits inline trees; `post` visits children before their parent. */
function walk(inl: Inl[], f: (n: Inl) => void, post = false) {
  for (const n of inl) { if (!post) f(n); walk(n.kids, f, post); if (post) f(n); }
}

/**
 * Markdown copied for the selection `[a, b)` as `[a, b, md]`, where `[a, b)` is the source range the selection stands
 * for (cut deletes it). The copy is self-contained Markdown, rendering like what the user sees selected:
 * - An edge inside a hidden marker, or at the text edge of an element, moves out to include the whole marker; a
 *   selection starting at a line's text includes its block marker (`## `, `- [ ] `).
 * - Elements cut by the selection get their missing markers added (`**bo` from `**bold**` copies as `**bo**`).
 * - Across lines, a table copies whole rows plus its header and delimiter rows, and a code block keeps its fences.
 * shortcut: a selection ending right after an opening fence line copies an empty code block; trim it if it ever matters.
 */
export function clip(src: string, a: number, b: number): [number, number, string] {
  const ls = tokenize(src), at = (x: number) => ls.findIndex(l => l.start <= x && x <= l.end);
  const ia = at(a), ib = at(b), la = ls[ia], lb = ls[ib], row = (l: Line) => src.slice(l.start, l.end);
  let pre = '', post = '';

  // Block context
  if (a <= la.mark) a = la.start;
  if (ia !== ib) {
    if (la.cells) {
      a = la.start;
      let h = ia;
      while (ls[h].block !== 'th') h--;
      if (h < ia) pre = row(ls[h]) + '\n' + (la.block === 'td' ? row(ls[h + 1]) + '\n' : '');
    }
    if (lb.cells) { b = lb.end; if (lb.block === 'th') post = '\n' + row(ls[ib + 1]); }
    if (la.block === 'code') { let f = ia; while (ls[f].block !== 'fence') f--; pre = row(ls[f]) + '\n'; }
    if (lb.block === 'code') { const f = ls.findIndex((l, i) => i > ib && l.block === 'fence'); if (f >= 0) post = '\n' + row(ls[f]); }
  }

  // Edges in or next to markers move out, innermost first, so an outer element sees the moved edge
  const snap = (x: number, n: Inl) => n.start < x && x <= n.open ? n.start : n.close <= x && x < n.end ? n.end : x;
  walk(inlOf(la), n => { a = snap(a, n); }, true);
  walk(inlOf(lb), n => { b = snap(b, n); }, true);

  // Elements cut by an edge: reopen the ones `a` is inside of (outermost first), close the ones `b` is inside of
  let open = '', close = '';
  walk(inlOf(la), n => { if (n.start < a && a < n.close) open += src.slice(n.start, n.open); });
  walk(inlOf(lb), n => { if (n.open < b && b < n.close) close = src.slice(n.close, n.end) + close; });
  return [a, b, pre + open + src.slice(a, b) + close + post];
}

// ---- Caret (pure) ----

/** Per source char: 0 text, 1 inside an opening marker (block, cell, inline), 2 inside a closing one. */
export function markMask(src: string): Uint8Array {
  const m = new Uint8Array(src.length), fill = (s: number, e: number, v: number) => m.fill(v, s, e);
  for (const l of tokenize(src)) {
    fill(l.start, l.mark, 1);
    if (l.br) fill(l.end - l.br, l.end, 3);
    l.cells?.forEach(c => { fill(c.start, c.open, 1); fill(c.close, c.end, 2); });
    walk(inlOf(l), n => { fill(n.start, n.open, 1); fill(n.close, n.end, 2); });
  }
  return m;
}

const eol = (src: string, i: number) => i === src.length || src[i] === '\n';
const bol = (src: string, i: number) => i === 0 || src[i - 1] === '\n';

/** Start of the hard break text (`markMask` 3) `x` is in or right after, else `x`: the caret's line end before it. */
function brStart(m: Uint8Array, x: number): number {
  while (m[x - 1] === 3) x--;
  return x;
}

/**
 * Caret offset one arrow step (`d`) from `x`: marker chars (`m`, see `markMask`) are skipped fully, so a step moves
 * over one visible grapheme. Line ends are stops even when markers hide them from the text (`**b**|`): crossing those
 * markers is a step of its own. A hard break's text is the exception: the line end stops before it (typing after a
 * `\` would undo the break), and the next step crosses it with the newline. Moving right onto a new line also skips
 * its block marker.
 */
export function caretStep(src: string, m: Uint8Array, x: number, d: 1 | -1): number {
  const seg = new Intl.Segmenter().segment(src);
  let y = x;
  if (d > 0) {
    while (y < src.length && m[y] && m[y] !== 3) y++;
    if (m[y] === 3) {
      if (y > x) return y;
      while (m[y] === 3) y++;
      for (y++; y < src.length && m[y]; y++);
      return y;
    }
    if ((y > x && eol(src, y)) || y === src.length) return y;
    const g = seg.containing(y)!;
    y = g.index + g.segment.length;
    if (src[y - 1] === '\n') while (y < src.length && m[y]) y++;
    return y;
  }
  while (y > 0 && m[y - 1]) y--;
  if ((y < x && eol(src, x) && !bol(src, y)) || y === 0) return y;
  return brStart(m, seg.containing(y - 1)!.index);
}

/**
 * Caret offset `x` left by a native move (Home, End, Up, Down, word jumps) or a click on text, corrected like
 * `caretStep`: to the line end when only markers follow it (before a hard break's text), out of a block marker it
 * precedes, out of a marker it is inside of (to the text side).
 */
export function caretSnap(src: string, m: Uint8Array, x: number): number {
  if (m[x - 1] === 3) return brStart(m, x);
  let y = x;
  while (y < src.length && m[y] && m[y] !== 3) y++;
  if (m[y] === 3) return y;
  if (eol(src, y) || bol(src, x) || (m[x] === 1 && m[x - 1])) return y;
  if (m[x] !== 2 || !m[x - 1]) return x;
  while (m[x - 1]) x--;
  return x;
}

/**
 * `[src, caret]` after replacing `[a, b)` with `text` (caret after it). Markers of elements only partly inside the
 * range stay, so deleting never breaks syntax. An element goes whole once its content is covered: inline elements
 * (even when their markers are outside the range), a line's block marker or a table row's pipes when the line's text
 * is covered or the line break before it goes while text before the range stays (the marker would land mid-line).
 */
export function cut(src: string, a: number, b: number, text = ''): [string, number] {
  const del = new Uint8Array(src.length).fill(1, a, b), keep = (s: number, e: number) => del.fill(0, s, e);
  for (const l of tokenize(src)) {
    if (l.end < a || l.start > b) continue;
    // Block markers: a row's cells' pipes, or the line's prefix
    const c = l.cells, open = c ? c[0].open : l.mark, close = c ? c.at(-1)!.close : l.end;
    const v = (a <= open && close <= b) || (a < l.start && !bol(src, a)) ? 1 : 0;
    for (const [s, e] of c ? c.flatMap(k => [[k.start, k.open], [k.close, k.end]]) : [[l.start, l.mark]]) del.fill(v, s, e);
    // Inline elements, outermost first: an inner one covered goes whole even when its parent keeps its markers
    walk(inlOf(l), n => { if (a <= n.open && n.close <= b) del.fill(1, n.start, n.end); else { keep(n.start, n.open); keep(n.close, n.end); } });
    // A hard break's text goes with its newline (a backslash would stay literal)
    if (l.br && a <= l.end && l.end < b) del.fill(1, l.end - l.br, l.end);
  }
  let out = '', at = 0;
  for (let i = 0; i <= src.length; i++) {
    if (i === a) { out += text; at = out.length; }
    if (i < src.length && !del[i]) out += src[i];
  }
  return [out, at];
}

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
const esc = (s: string) => s.replace(/[&<>"]/g, c => ESC[c]);
/** Text outside code: backslash escapes of ASCII punctuation drop their backslash. */
const text = (s: string) => esc(s.replace(/\\([!-/:-@[-`{-~])/g, '$1'));
const TAG = { strong: 'strong', em: 'em', strike: 's', code: 'code', link: 'a' };

function inlineHtml(src: string, from: number, to: number, inl: Inl[]): string {
  let out = '';
  for (const n of inl) {
    const body = n.kind === 'code' ? esc(src.slice(n.open, n.close)) : inlineHtml(src, n.open, n.close, n.kids);
    out += text(src.slice(from, n.start));
    // Same schemes Ctrl+click follows; other links keep only their text
    if (n.kind === 'link') out += /^(https?:|mailto:)/i.test(n.url!) ? `<a href="${esc(n.url!)}">${body}</a>` : body;
    else out += `<${TAG[n.kind]}>${body}</${TAG[n.kind]}>`;
    from = n.end;
  }
  return out + text(src.slice(from, to));
}

/**
 * HTML rendering of Markdown for rich-text paste targets: semantic tags only (no classes or styles besides table
 * alignment), so each target applies its own look. Continuation lines join their paragraph, list item or quote with
 * a newline (soft break) or `<br>` (hard break), as do a quote's other lines; nested lists follow item depth; task items get disabled checkboxes, as GitHub renders them.
 */
export function toHtml(src: string): string {
  const ls = tokenize(src), out: string[] = [];
  const body = (l: Line) => inlineHtml(src, l.mark, l.end - (l.br ?? 0), l.inl);
  /** A continuation line with its break before it. */
  const cont = (l: Line) => (l.join === 'soft' ? '\n' : '<br>') + body(l);
  const cell = (tag: string, c: Cell) => `<${tag}${c.align ? ` style="text-align:${{ l: 'left', c: 'center', r: 'right' }[c.align]}"` : ''}>${inlineHtml(src, c.open, c.close, c.inl)}</${tag}>`;
  const blank = (l: Line) => l.block === 'p' && !src.slice(l.start, l.end).trim();
  for (let i = 0; i < ls.length;) {
    const l = ls[i];
    /** Lines from `i` on while `ok` holds; advances `i` past them. */
    const take = (ok: (l: Line) => boolean) => { const g: Line[] = []; while (i < ls.length && ok(ls[i])) g.push(ls[i++]); return g; };
    if (blank(l)) i++;
    else if (l.block[0] === 'h') { out.push(`<${l.block}>${body(l)}</${l.block}>`); i++; }
    else if (l.block === 'p' || l.block === 'quote') {
      const [h, ...g] = take(x => x === l || !!x.join || (l.block === 'quote' && x.block === 'quote')), t = body(h) + g.map(cont).join('');
      out.push(l.block === 'p' ? `<p>${t}</p>` : `<blockquote><p>${t}</p></blockquote>`);
    } else if (l.block === 'fence') {
      i++;
      const code = take(x => x.block === 'code').map(x => src.slice(x.start, x.end)).join('\n');
      if (ls[i]?.block === 'fence') i++;
      const lang = /^[ \t]*[`~]+[ \t]*([^\s`]*)/.exec(src.slice(l.start, l.end))![1];
      out.push(`<pre><code${lang ? ` class="language-${esc(lang)}"` : ''}>${esc(code)}</code></pre>`);
    } else if (l.cells) {
      // Only reached at a header row: body rows and the delimiter row always follow one
      const [h, , ...rows] = take(x => !!x.cells && (x === l || x.block !== 'th'));
      out.push(`<table><thead><tr>${h.cells!.map(c => cell('th', c)).join('')}</tr></thead>`
        + `<tbody>${rows.map(r => `<tr>${r.cells!.map(c => cell('td', c)).join('')}</tr>`).join('')}</tbody></table>`);
    } else {
      // Lists: `stack` holds the open list tags; an item opens a nested list inside the previous, still open, item
      const stack: string[] = [], base = l.depth;
      let s = '';
      for (const x of take(x => x.block === 'li' || x.block === 'ol' || (x.block === 'p' && !!x.join))) {
        if (x.block === 'p') { s += cont(x); continue; }
        const tag = x.block === 'ol' ? 'ol' : 'ul', d = Math.min(Math.max(0, x.depth - base), stack.length);
        while (stack.length > d + 1) s += `</li></${stack.pop()}>`;
        if (stack.length === d + 1 && stack[d] === tag) s += '</li>';
        else {
          if (stack.length === d + 1) s += `</li></${stack.pop()}>`;
          const n = tag === 'ol' ? parseInt(src.slice(x.start, x.mark).trim()) : 1;
          s += n === 1 ? `<${tag}>` : `<${tag} start="${n}">`;
          stack.push(tag);
        }
        s += `<li>${x.check ? `<input type="checkbox" disabled${x.check === 'x' ? ' checked' : ''}> ` : ''}${body(x)}`;
      }
      while (stack.length) s += `</li></${stack.pop()}>`;
      out.push(s);
    }
  }
  return out.join('');
}

// ---- Paste: HTML to Markdown (pure) ----

/** The DOM surface `fromHtml` reads: DOM nodes fit it, and node tests build plain objects. */
export interface HNode { nodeType: number; nodeName: string; nodeValue: string | null; childNodes: ArrayLike<HNode>; getAttribute?(name: string): string | null }

/** Inline formatting of a text run; `href` is a link target. */
interface Marks { strong?: boolean; em?: boolean; strike?: boolean; code?: boolean; href?: string }
/** Text with its marks; `'\n'` alone is a line break. */
interface Run { text: string; m: Marks }

const SKIP = /^(HEAD|SCRIPT|STYLE|TEMPLATE|NOSCRIPT|TITLE|META|LINK|INPUT|BUTTON|SELECT|TEXTAREA|IMG|SVG|CANVAS|VIDEO|AUDIO|IFRAME|OBJECT)$/;
const BLOCK = /^(P|DIV|H[1-6]|UL|OL|LI|BLOCKQUOTE|PRE|TABLE|THEAD|TBODY|TFOOT|TR|TH|TD|CAPTION|HR|SECTION|ARTICLE|HEADER|FOOTER|NAV|ASIDE|MAIN|FIGURE|FIGCAPTION|DL|DT|DD|ADDRESS|DETAILS|SUMMARY|BODY|HTML|FORM|FIELDSET|CENTER)$/;

const kids = (n: HNode) => Array.from(n.childNodes);
const tagOf = (n: HNode) => n.nodeName.toUpperCase();
const attr = (n: HNode | undefined, a: string) => n?.getAttribute?.(a) ?? '';
/** Last value of a CSS property in an inline style: editors repeat properties as fallbacks (`pre; pre-wrap`). */
const css = (n: HNode | undefined, p: string) => [...attr(n, 'style').toLowerCase().matchAll(new RegExp(`(?:^|;)\\s*${p}\\s*:\\s*([^;]+)`, 'g'))].at(-1)?.[1].trim();
const mkey = (m: Marks) => `${+!!m.strong}${+!!m.em}${+!!m.strike}${+!!m.code}${m.href ?? ''}`;

/** Markdown joined into one line: line breaks, hard ones with their backslash, become spaces. */
const oneLine = (md: string) => md.replace(/\\?\s*\n\s*/g, ' ');

/** Raw text of a node (`pre` content): `br` is a newline. */
const raw = (n: HNode): string => n.nodeType === 3 ? n.nodeValue ?? '' : tagOf(n) === 'BR' ? '\n' : kids(n).map(raw).join('');

/** Text escaped to show literally; `_` only at word edges (intraword it never marks), line starts are left to `mdLine`. */
const mdEsc = (s: string) => s.replace(/\\(?=[!-/:-@[-`{-~]|$)|[`*[]|~(?=~)|(?<!\w)_|_(?!\w)/g, '\\$&');

/**
 * Marks of `n`'s content: tags set them, inline styles set or clear them (Google Docs marks only with styles and wraps
 * everything in a `<b style="font-weight:normal">`). Links keep the schemes Ctrl+click follows.
 */
function marks(n: HNode, tag: string, m: Marks): Marks {
  const r = { ...m }, w = css(n, 'font-weight'), st = css(n, 'font-style');
  if (tag === 'B' || tag === 'STRONG') r.strong = true;
  if (w) r.strong = w === 'bold' || w === 'bolder' || +w >= 600;
  if (/^(I|EM|CITE|VAR|DFN)$/.test(tag)) r.em = true;
  if (st) r.em = st !== 'normal';
  if (/^(S|DEL|STRIKE)$/.test(tag) || /line-through/.test(css(n, 'text-decoration(?:-line)?') ?? '')) r.strike = true;
  if (/^(CODE|KBD|SAMP|TT)$/.test(tag) || /mono|courier|consolas/.test(css(n, 'font-family') ?? '')) r.code = true;
  if (tag === 'A' && /^(https?:|mailto:)/i.test(attr(n, 'href'))) r.href = attr(n, 'href');
  return r;
}

/**
 * Markdown of one line of runs. Marks open as late and close as early as possible, edge spaces staying outside the
 * markers (the tokenizer needs markers to hug text); a mark lasting longer opens outermost. An emphasis opening right
 * after a `*` uses `_` (`***` cannot open in the tokenizer).
 */
function mdLine(runs: Run[]): string {
  let out = '';
  const stack: { k: 'href' | 'strike' | 'strong' | 'em'; v: unknown; close: string }[] = [];
  /** Closes the stack down to `n` marks, moving trailing spaces after the closers. */
  const closeTo = (n: number) => {
    const ws = /\s*$/.exec(out)![0];
    out = out.slice(0, out.length - ws.length);
    while (stack.length > n) out += stack.pop()!.close;
    out += ws;
  };
  for (let i = 0; i < runs.length; i++) {
    const { text, m } = runs[i], [, lead, core, trail] = /^(\s*)(.*?)(\s*)$/s.exec(text)!;
    if (!core) { out += text; continue; }
    // A dropped mark closes the marks opened after it too; still active ones reopen below
    const drop = stack.findIndex(s => m[s.k] !== s.v);
    if (drop >= 0) closeTo(drop);
    out += lead;
    const lasts = (k: keyof Marks) => { let j = i; while (j < runs.length && runs[j].m[k] === m[k]) j++; return j; };
    for (const k of (['href', 'strike', 'strong', 'em'] as const).filter(k => m[k] && !stack.some(s => s.k === k)).sort((x, y) => lasts(y) - lasts(x))) {
      const star = out.endsWith('*'), o = k === 'href' ? '[' : k === 'strike' ? '~~' : k === 'strong' ? (star ? '__' : '**') : star ? '_' : '*';
      out += o;
      stack.push({ k, v: m[k], close: k === 'href' ? `](${m.href!.replace(/[ ()]/g, c => '%' + c.charCodeAt(0).toString(16))})` : o });
    }
    if (m.code) {
      // Fence longer than any backtick run inside; a backtick at an edge needs a space between it and the fence
      const f = '`'.repeat(Math.max(0, ...(core.match(/`+/g) ?? []).map(r => r.length)) + 1), pad = /^`|`$/.test(core) ? ' ' : '';
      out += f + pad + core + pad + f;
    } else out += mdEsc(core);
    out += trail;
  }
  closeTo(0);
  // Text that would start a block at the line start: `#`, `>`, `-`, `+`, `1.` (`*` and backticks are always escaped)
  return out.trim().replace(/^(?:>|[#+-](?=\s|$))/, '\\$&').replace(/^(\d{1,9})([.)])(?=\s)/, '$1\\$2');
}

/**
 * Markdown of inline runs: lines split at breaks, equal neighbors merged (split code spans would collide). A break
 * between text lines is hard (`\`), as a plain newline would render as a space; an empty line splits paragraphs.
 */
function mdRuns(runs: Run[]): string {
  const lines: Run[][] = [[]];
  for (const r of runs) {
    const l = lines.at(-1)!, p = l.at(-1);
    if (r.text === '\n') lines.push([]);
    else if (p && mkey(p.m) === mkey(r.m)) p.text += r.text;
    else l.push({ ...r });
  }
  return lines.map(mdLine).join('\n').replace(/^\n+|\n+$/g, '').replace(/(?<=[^\n])\n(?=[^\n])/g, '\\\n');
}

/** First task checkbox of a list item (not of its sublists): `'x'`, `' '` or null. */
function checkbox(n: HNode): string | null {
  for (const k of kids(n)) {
    const t = tagOf(k);
    if (t === 'INPUT' && attr(k, 'type').toLowerCase() === 'checkbox') return k.getAttribute?.('checked') != null ? 'x' : ' ';
    const r = k.nodeType === 1 && t !== 'UL' && t !== 'OL' ? checkbox(k) : null;
    if (r) return r;
  }
  return null;
}

/** Text of the first `mso-list: Ignore` element in `n`: a Word list item's marker. */
function msoMarker(n: HNode): string {
  for (const k of kids(n)) {
    if (k.nodeType !== 1) continue;
    if (css(k, 'mso-list') === 'ignore') return raw(k);
    const r = msoMarker(k);
    if (r) return r;
  }
  return '';
}

/**
 * Markdown blocks of the nodes `ns`. Paragraph-like blocks are separated by blank lines, but consecutive `div`s of
 * inline content join with one newline: many editors (Gmail, contenteditable apps) make each line such a `div`, and an
 * empty one (`<div><br></div>`) is their blank line. Word's lists are paragraphs styled `mso-list: lN levelN` whose
 * marker (`·`, `o`, `1.`, `a)`) sits in a `mso-list: Ignore` span: they become list items, numbered per level.
 */
function mdBlocks(ns: HNode[], m: Marks): string[] {
  const out: string[] = [];
  // `join`: kind of the last block; a block of the same nonempty kind joins it on the next line (line divs: hard break)
  let runs: Run[] = [], join = '', nums: number[] = [];
  const push = (md: string, kind = '') => {
    if (kind && kind === join) out[out.length - 1] += (kind === 'div' ? '\\\n' : '\n') + md; else out.push(md);
    join = kind;
    if (kind !== 'mso') nums = [];
  };
  const flush = () => { const md = mdRuns(runs); runs = []; if (md.trim()) push(md); };
  const visit = (n: HNode, m: Marks) => {
    if (n.nodeType === 3) {
      // HTML whitespace collapses, across neighboring text nodes too
      let t = (n.nodeValue ?? '').replace(/\s+/g, ' ');
      if (t[0] === ' ' && (runs.at(-1)?.text ?? ' ').endsWith(' ')) t = t.slice(1);
      if (t) runs.push({ text: t, m });
      return;
    }
    const tag = tagOf(n);
    if (n.nodeType !== 1 || SKIP.test(tag) || css(n, 'mso-list') === 'ignore') return;
    if (tag === 'BR') { runs.push({ text: '\n', m }); return; }
    const mm = marks(n, tag, m);
    // Inline elements may hold blocks (Google Docs' outer `<b>`): they only pass their marks down
    if (!BLOCK.test(tag)) { for (const k of kids(n)) visit(k, mm); return; }
    flush();
    const lvl = tag === 'P' ? +(/level(\d+)/.exec(css(n, 'mso-list') ?? '')?.[1] ?? 0) : 0;
    if (lvl) {
      // Word list item: digits keep their number, letters and roman numerals count per level (deeper levels restart)
      const mk = msoMarker(n).replace(/\s+/g, ''), d = /^\(?(\d+)[.)]$/.exec(mk);
      nums.length = lvl;
      nums[lvl - 1] = (nums[lvl - 1] ?? 0) + 1;
      const item = d || /^\(?[a-z]{1,4}[.)]$/i.test(mk) ? `${d ? +d[1] : nums[lvl - 1]}. ` : '- ';
      push('\t'.repeat(lvl - 1) + item + oneLine(mdBlocks(kids(n), mm).join(' ')), 'mso');
      return;
    }
    const bs = mdBlock(n, tag, mm);
    if (tag !== 'DIV' || kids(n).some(k => BLOCK.test(tagOf(k)))) for (const b of bs) push(b);
    else if (bs.length) push(bs.join('\n\n'), 'div');
    else join = '';
  };
  for (const n of ns) visit(n, m);
  flush();
  return out;
}

/** Markdown blocks of the block element `n`. */
function mdBlock(n: HNode, tag: string, m: Marks): string[] {
  const inner = () => mdBlocks(kids(n), m);
  /** Content as one line (headings, cells). */
  const flat = (x: HNode) => oneLine(mdBlocks(kids(x), m).join(' '));
  if (/^H[1-6]$/.test(tag)) { const t = flat(n); return t ? ['#'.repeat(+tag[1]) + ' ' + t] : []; }
  if (tag === 'HR') return ['---'];
  if (tag === 'PRE') {
    const code = raw(n).replace(/\n$/, ''), lang = /language-([\w+#.-]+)/.exec(`${attr(n, 'class')} ${kids(n).map(k => attr(k, 'class')).join(' ')}`)?.[1] ?? '';
    const f = '`'.repeat(Math.max(3, ...(code.match(/`+/g) ?? []).map(r => r.length + 1)));
    return [`${f}${lang}\n${code}\n${f}`];
  }
  if (tag === 'BLOCKQUOTE') {
    const md = inner().join('\n\n');
    return md ? [md.split('\n').map(l => l ? '> ' + l : '>').join('\n')] : [];
  }
  if (tag === 'UL' || tag === 'OL') {
    // An item's lines after its first (sublists, more paragraphs) indent one level; a blank line would end the list
    const lines: string[] = [], start = parseInt(attr(n, 'start'));
    let i = Number.isFinite(start) ? start : 1;
    for (const k of kids(n)) {
      if (k.nodeType !== 1) continue;
      const li = tagOf(k) === 'LI', md = mdBlocks(li ? kids(k) : [k], m).join('\n').split('\n').filter(l => l.trim());
      // A list nested directly in a list (no `li` around it) belongs to the previous item
      if (!li) { lines.push(...md.map(l => '\t' + l)); continue; }
      const box = checkbox(k);
      lines.push((tag === 'OL' ? `${i++}. ` : '- ') + (box ? `[${box}] ` : '') + (md[0] ?? ''), ...md.slice(1).map(l => '\t' + l));
    }
    return lines.length ? [lines.join('\n')] : [];
  }
  if (tag === 'TABLE') {
    // Rows of this table, not of nested ones; the first is the header, short rows pad with blank cells
    const rows: HNode[][] = [];
    const find = (x: HNode) => {
      for (const k of kids(x)) {
        if (tagOf(k) === 'TR') rows.push(kids(k).filter(c => /^T[HD]$/.test(tagOf(c))));
        else if (k.nodeType === 1 && tagOf(k) !== 'TABLE') find(k);
      }
    };
    find(n);
    const w = Math.max(0, ...rows.map(r => r.length));
    if (!w) return [];
    const pad = (r: HNode[]) => Array.from({ length: w }, (_, i) => r[i] as HNode | undefined);
    const row = (cs: string[]) => '| ' + cs.join(' | ') + ' |';
    const cell = (c?: HNode) => (c && flat(c).replace(/\|/g, '\\|')) || ' ';
    const align = (c?: HNode) => ({ left: ':--', center: ':-:', right: '--:' })[(css(c, 'text-align') ?? attr(c, 'align')).toLowerCase()] ?? '---';
    const [h, ...body] = rows;
    return [[row(pad(h).map(cell)), row(pad(h).map(align)), ...body.map(r => row(pad(r).map(cell)))].join('\n')];
  }
  return inner();
}

/**
 * Markdown of pasted HTML (`root` is its body), or null when the HTML is source text: all of it inside `pre` or
 * `white-space: pre`, as code editors (VSCode, JetBrains) copy. Their plain text is the exact source, while their
 * HTML only styles it (a bold `**x**` would paste as `**\*\*x\*\***`).
 */
export function fromHtml(root: HNode): string | null {
  let text = false;
  const source = (n: HNode, pre: boolean): boolean => {
    if (n.nodeType === 3) { if (/\S/.test(n.nodeValue ?? '')) { if (!pre) return false; text = true; } return true; }
    if (n.nodeType !== 1 || SKIP.test(tagOf(n))) return true;
    const p = pre || tagOf(n) === 'PRE' || css(n, 'white-space') === 'pre';
    return kids(n).every(k => source(k, p));
  };
  return source(root, false) && text ? null : mdBlocks(kids(root), {}).join('\n\n');
}

// ---- DOM helpers ----

/** Element with classes; the editor builds its DOM by hand to stay independent of the app's helpers. */
function el(tag: string, cls: string, ...kids: (Node | string)[]): HTMLElement {
  const e = document.createElement(tag);
  e.className = cls;
  e.append(...kids);
  return e;
}

/** Element spanning source `[s, e]`; `reveal` shows its markers while the selection touches that range. */
function ranged<T extends HTMLElement>(e: T, s: number, end: number): T {
  e.dataset.s = String(s);
  e.dataset.e = String(end);
  return e;
}

/** Marker bubble showing its source text (spaces included); an all-blank marker (indentation, a row's trailing spaces) is never shown. */
function marker(text: string, side: 'o' | 'c'): HTMLElement {
  return el('span', `mk ${side}${text.trim() ? '' : ' blank'}`, text);
}

/** Soft-break group: the lines of one paragraph joined by plain newlines, flowing inline in one block (see `paint`). */
const isGrp = (n: Node | null): n is HTMLElement => n instanceof HTMLElement && n.classList.contains('grp');

/** Line elements of a part in source order: its children, each soft-break group replaced by its lines. */
const rows = (part: HTMLElement): Node[] => Array.from(part.childNodes).flatMap(n => isGrp(n) ? Array.from(n.childNodes) : [n]);

/** Appends text and inline elements of `[from, to)` to `parent`. */
function paintInline(parent: HTMLElement, src: string, from: number, to: number, inl: Inl[]) {
  for (const n of inl) {
    if (n.start > from) parent.append(src.slice(from, n.start));
    const span = ranged(el('span', `k-${n.kind}`, marker(src.slice(n.start, n.open), 'o')), n.start, n.end);
    if (n.kind === 'code') span.append(src.slice(n.open, n.close));
    else paintInline(span, src, n.open, n.close, n.kids);
    span.append(marker(src.slice(n.close, n.end), 'c'));
    if (n.url) span.dataset.href = n.url;
    parent.append(span);
    from = n.end;
  }
  if (to > from) parent.append(src.slice(from, to));
}

// ---- Mermaid diagrams ----

/** Diagram of one closed ```mermaid block. `rows` are the block's source elements its Source button shows and hides. */
interface Fig { el: HTMLElement; img: HTMLImageElement; open: boolean; code?: string; rows: HTMLElement[] }

let mermaidLib: Promise<any> | undefined;

/**
 * Loads `mermaid.min.js` (5 MB) on first use only, from beside this module: the server's route in the browser, a
 * webview URI in VSCode. A failed load stays failed until the page reloads.
 */
function mermaid(): Promise<any> {
  return mermaidLib ??= new Promise((ok, fail) => {
    const s = document.createElement('script');
    s.src = new URL('mermaid.min.js', import.meta.url).href;
    s.onload = () => {
      const m = (globalThis as any).mermaid;
      // `neutral` is grayscale, so the dark-mode CSS inversion keeps it readable
      m.initialize({ startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true, theme: 'neutral',
        fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--sans') });
      ok(m);
    };
    s.onerror = fail;
    document.head.append(s);
  });
}

let renders = 0;

/**
 * Renders `code` into the figure's image unless it already shows it. The SVG goes into an `<img>`: it cannot run
 * script, carries its own `<style>`, and keeps no text in the part (lines map to child text). Results of outdated
 * code are dropped; an error keeps the last good image and puts the message in the tooltip.
 */
function draw(f: Fig, code: string) {
  if (f.code === code) return;
  f.code = code;
  mermaid().then(m => m.render(`mmd${++renders}`, code)).then(({ svg }: { svg: string }) => {
    if (f.code !== code) return;
    // Mermaid sizes the root SVG `width="100%"`, which an <img> cannot resolve: the viewBox width is its natural one
    f.img.style.width = (/viewBox="\S+ \S+ ([\d.]+)/.exec(svg.slice(0, svg.indexOf('>')))?.[1] ?? '') + 'px';
    f.img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    f.el.classList.remove('err');
    f.el.removeAttribute('title');
  }, (e: unknown) => {
    if (f.code !== code) return;
    f.el.classList.add('err');
    f.el.title = e instanceof Error ? e.message : String(e);
  });
}

/**
 * Figure with the diagram and its Source button, non-editable and without text (the label is CSS content from
 * `aria-label`), so the line holding it reads as pure source. The button toggles the block's source rows.
 */
function figure(open: boolean): Fig {
  const img = el('img', '') as HTMLImageElement, b = el('button', '');
  img.alt = 'Mermaid diagram';
  b.setAttribute('aria-label', 'Source');
  b.setAttribute('aria-pressed', String(open));
  const f: Fig = { el: el('div', 'mmd', img, b), img, open, rows: [] };
  f.el.contentEditable = 'false';
  // The part's own mouse handlers would move the caret
  b.addEventListener('mousedown', e => { e.preventDefault(); e.stopPropagation(); });
  b.addEventListener('click', e => {
    e.stopPropagation();
    f.open = !f.open;
    b.setAttribute('aria-pressed', String(f.open));
    f.rows.forEach(r => show(r, f.open));
  });
  return f;
}

/**
 * Rebuilds a part's DOM: one `div.ln` per source line, so lines map 1:1 to the part's `rows`. Lines joined by soft
 * breaks go into one `div.grp` taking the first line's block look, where they flow inline, the newline shown as a
 * space after the previous line. A hard break's text (`\` or spaces) is a closing marker followed by `↵` (CSS content,
 * so the line's text stays pure source), shown only while the caret is at its line's text end or in the next line.
 * A closed ```mermaid
 * block also gets a figure in its opening line; its source rows start hidden, except for blocks a `fresh` repaint
 * (an edit) creates, whose author is still typing them.
 * shortcut: full re-render per change; switch to per-line diffing if descriptions get very long.
 * shortcut: figures are matched to blocks by order, so adding a diagram above others shifts their Source states.
 */
function paint(p: Part, fresh = false) {
  const src = p.src, ls = tokenize(src);
  let k = 0, fig: Fig | undefined, close = -1;   // the diagram block being painted and its closing line
  const look = (e: HTMLElement, l: Line) => {
    if (l.depth) e.style.setProperty('--d', String(l.depth));
    if (l.check) e.dataset.cb = l.check;
    return e;
  };
  const divs = ls.map((l, i) => {
    const div = look(ranged(el('div', `ln ${l.block}`), l.start, l.end), l);
    if (l.mark > l.start) div.append(marker(src.slice(l.start, l.mark), 'o'));
    if (l.cells) div.append(...l.cells.map(c => {
      const cell = ranged(el('span', 'cell'), c.start, c.end);
      if (c.align) cell.dataset.a = c.align;
      if (c.open > c.start) cell.append(marker(src.slice(c.start, c.open), 'o'));
      paintInline(cell, src, c.open, c.close, c.inl);
      if (c.end > c.close) cell.append(marker(src.slice(c.close, c.end), 'c'));
      return cell;
    }));
    else if (l.block === 'code' || l.block === 'fence') div.append(src.slice(l.start, l.end));
    else paintInline(div, src, l.mark, l.end - (l.br ?? 0), l.inl);
    if (l.br) div.append(ranged(el('span', 'mk c br', src.slice(l.end - l.br, l.end)), l.end - l.br, ls[i + 1]?.end ?? l.end));
    if (l.start === l.end) div.append(document.createElement('br'));

    // Mermaid: an opening fence whose block closes gets the figure, its text and the following rows the Source toggle
    if (fig && i <= close) { div.hidden = !fig.open; fig.rows.push(div); }
    else if (l.block === 'fence' && /^[ \t]*[`~]+[ \t]*mermaid\s*$/i.test(src.slice(l.start, l.end))) {
      let j = i + 1;
      while (ls[j]?.block === 'code') j++;
      if (ls[j]?.block === 'fence') {
        fig = p.figs[k++] ??= figure(fresh);
        draw(fig, ls.slice(i + 1, j).map(x => src.slice(x.start, x.end)).join('\n'));
        close = j;
        const text = el('span', 'fsrc', ...Array.from(div.childNodes));
        text.hidden = !fig.open;
        fig.rows = [text];
        div.classList.add('mmd-ln');
        div.append(fig.el, text);
      }
    }
    return div;
  });
  // Soft breaks: a joined line goes into its previous line's group, created on the first join
  const out: HTMLElement[] = [];
  divs.forEach((d, i) => {
    if (ls[i].join !== 'soft') { out.push(d); return; }
    if (!isGrp(out.at(-1)!)) out.push(look(el('div', `grp ${ls[i - 1].block}`, out.pop()!), ls[i - 1]));
    out.at(-1)!.append(d);
  });
  p.el.replaceChildren(...out);
  p.figs.length = k;
  p.el.toggleAttribute('data-empty', !src);
}

/** Source text of a part. Each row is one line (the browser may merge or add nodes before `paint` runs). */
const read = (part: HTMLElement) => rows(part).map(n => n.textContent ?? '').join('\n');

/** Source offset of a DOM point inside a part. */
function offsetOf(part: HTMLElement, node: Node, off: number): number {
  const ls = rows(part), before = (i: number) => ls.slice(0, i).reduce((a, n) => a + (n.textContent ?? '').length + 1, 0);
  // Between children of the part or a group: the start of the next child's first line, else the end of the last line
  if (node === part || isGrp(node)) {
    const k = node.childNodes[off], z = node.lastChild;
    if (k) return before(ls.indexOf(isGrp(k) ? k.firstChild! : k));
    return z ? before(ls.indexOf(isGrp(z) ? z.lastChild! : z) + 1) - 1 : 0;
  }
  let ln = node;
  while (ln.parentNode !== part && !isGrp(ln.parentNode)) ln = ln.parentNode!;
  const r = document.createRange();
  r.setStart(ln, 0);
  r.setEnd(node, off);
  return before(ls.indexOf(ln)) + r.toString().length;
}

/** DOM point of a source offset. At a boundary between a marker and text, the text side wins (typing lands there). */
function pointOf(part: HTMLElement, off: number): [Node, number] {
  for (const ln of rows(part)) {
    const len = (ln.textContent ?? '').length;
    if (off > len) { off -= len + 1; continue; }
    const w = document.createTreeWalker(ln, NodeFilter.SHOW_TEXT);
    let first: [Node, number] | null = null;
    for (let t = w.nextNode(), p = 0; t && p <= off; p += t.textContent!.length, t = w.nextNode()) {
      if (off > p + t.textContent!.length) continue;
      if (!t.parentElement!.closest('.mk')) return [t, off - p];
      first ??= [t, off - p];
    }
    return first ?? [ln, 0];
  }
  return [part, part.childNodes.length];
}

/** Element holding a DOM point (a text node's parent), to test it against classes like `.mk` or `.cell`. */
const elOf = (n: Node) => (n instanceof Element ? n : n.parentElement)!;

/**
 * Screen box `[x, top, bottom]` of a caret at a DOM point, from the character after it (else before it). A collapsed
 * range's own rect is ambiguous at a soft wrap: it may sit at the end of the upper line while the caret is drawn at
 * the start of the lower one.
 */
function caretBox(n: Node, o: number): [number, number, number] | null {
  if (!(n instanceof Text) || !n.length) return null;
  const r = document.createRange(), next = o < n.length;
  r.setStart(n, next ? o : o - 1);
  r.setEnd(n, next ? o + 1 : o);
  const b = r.getClientRects()[0];
  return b ? [next ? b.left : b.right, b.top, b.bottom] : null;
}

/** Screen `[top, height]` of the first non-marker character at or after source offset `off` in its line (`rewrap`). */
function boxAt(part: HTMLElement, off: number): [number, number] | null {
  for (const ln of rows(part)) {
    const len = (ln.textContent ?? '').length;
    if (off > len) { off -= len + 1; continue; }
    const w = document.createTreeWalker(ln, NodeFilter.SHOW_TEXT);
    for (let t = w.nextNode() as Text | null, p = 0; t; p += t.length, t = w.nextNode() as Text | null) {
      if (p + t.length <= off || t.parentElement!.closest('.mk')) continue;
      const r = document.createRange(), i = Math.max(0, off - p);
      r.setStart(t, i);
      r.setEnd(t, i + 1);
      const b = r.getClientRects()[0];
      return b ? [b.top, b.height] : null;
    }
    return null;
  }
  return null;
}

/** Current selection as sorted source offsets, or null when it is not inside the part. */
function getSel(part: HTMLElement): [number, number] | null {
  const s = getSelection();
  if (!s?.rangeCount || !part.contains(s.anchorNode) || !part.contains(s.focusNode)) return null;
  const a = offsetOf(part, s.anchorNode!, s.anchorOffset), b = offsetOf(part, s.focusNode!, s.focusOffset);
  return a < b ? [a, b] : [b, a];
}

function setSel(part: HTMLElement, a: number, b = a) {
  const r = document.createRange();
  r.setStart(...pointOf(part, a));
  r.setEnd(...pointOf(part, b));
  getSelection()?.removeAllRanges();
  getSelection()?.addRange(r);
}

/** Shows the markers of every element the selection is inside of or next to. */
function reveal(part: HTMLElement) {
  const sel = getSel(part);
  part.querySelectorAll<HTMLElement>('[data-s]').forEach(e =>
    e.classList.toggle('near', !!sel && Number(e.dataset.s) <= sel[1] && sel[0] <= Number(e.dataset.e)));
}

// ---- Editing ----

interface Snap { src: string; at: number }
/** `keep`: soft-break groups of the source as set, saved unchanged (`rewrap`). */
interface Part { el: HTMLElement; src: string; keep: Set<string>; undo: Snap[]; redo: Snap[]; last: number; figs: Fig[] }
interface State { frame: HTMLElement; o: EditorOpts; parts: Part[]; cur: Part | null }

/** Records the part's current source for undo; keystrokes closer than 800 ms coalesce into one step. */
function snapshot(p: Part, at: number, force = false) {
  const now = Date.now();
  if (force || now - p.last > 800) { p.undo.push({ src: p.src, at }); if (p.undo.length > 200) p.undo.shift(); }
  p.redo = [];
  p.last = force ? 0 : now;
}

/** Replaces the part's whole source, repaints and puts the selection at `[a, b]`. */
function commit(st: State, p: Part, src: string, a: number, b = a) {
  p.src = st.o.multiline === false ? src.replace(/\n/g, ' ') : src;
  paint(p, true);
  setSel(p.el, Math.min(a, p.src.length), Math.min(b, p.src.length));
  reveal(p.el);
  place();
  st.o.onInput?.();
}

/** Replaces source `[a, b)` with `text` as one undo step and selects `[selA, selB]` (default: after the text). */
function splice(st: State, p: Part, a: number, b: number, text: string, selA = a + text.length, selB = selA) {
  snapshot(p, a, true);
  commit(st, p, p.src.slice(0, a) + text + p.src.slice(b), selA, selB);
}

function history(st: State, p: Part, from: Snap[], to: Snap[]) {
  const s = from.pop();
  if (!s) return;
  to.push({ src: p.src, at: getSel(p.el)?.[0] ?? s.at });
  p.last = 0;
  commit(st, p, s.src, s.at);
}

function confirm(st: State) {
  if (st.o.onConfirm) st.o.onConfirm();
  else (document.activeElement as HTMLElement | null)?.blur();
}

/** Toggles inline delimiters around the selection (removes them if the selection is already wrapped). */
function wrap(st: State, d: string) {
  const p = st.cur, sel = p && getSel(p.el);
  if (!p || !sel) return;
  const [a, b] = sel, n = d.length;
  if (p.src.slice(a - n, a) === d && p.src.slice(b, b + n) === d) splice(st, p, a - n, b + n, p.src.slice(a, b), a - n, b - n);
  else splice(st, p, a, b, d + p.src.slice(a, b) + d, a + n, b + n);
}

function link(st: State) {
  const p = st.cur, sel = p && getSel(p.el);
  if (!p || !sel) return;
  const [a, b] = sel, text = p.src.slice(a, b) || 'text', url = a + text.length + 3;
  splice(st, p, a, b, `[${text}](https://)`, url, url + 8);
}

/** Block prefixes the toolbox toggles, with the pattern recognizing each one (after indentation). */
const PREFIX: Record<string, [string, RegExp]> = {
  ul: ['- ', /^[-*+] (?!\[[ xX]\] )/],
  ol: ['1. ', /^\d{1,9}[.)] /],
  task: ['- [ ] ', /^[-*+] \[[ xX]\] /],
  quote: ['> ', /^> ?/],
};
const ANY_LIST = /^(?:[-*+] (?:\[[ xX]\] )?|\d{1,9}[.)] )/;

/**
 * Rewrites the lines the selection touches: list/quote kinds toggle (removed when every line has it, otherwise
 * set, replacing another list kind), `h` cycles the heading level none > 1 > 2 > 3 > none, `fence` wraps in ```.
 */
function lines(st: State, kind: string) {
  const p = st.cur, sel = p && getSel(p.el);
  if (!p || !sel) return;
  const src = p.src, a = src.lastIndexOf('\n', sel[0] - 1) + 1, e = src.indexOf('\n', sel[1]), b = e < 0 ? src.length : e;
  const ls = src.slice(a, b).split('\n');
  let out: string[];
  if (kind === 'fence') out = ['```', ...ls, '```'];
  else if (kind === 'h') {
    const lvl = HEADING.exec(ls[0])?.[1].length ?? 0, mark = lvl < 3 ? '#'.repeat(lvl + 1) + ' ' : '';
    out = ls.map(l => mark + l.replace(HEADING, ''));
  } else {
    const [mark, re] = PREFIX[kind], all = ls.every(l => re.test(l.trimStart()));
    out = ls.map(l => {
      const ind = /^[ \t]*/.exec(l)![0], rest = l.slice(ind.length);
      return all ? ind + rest.replace(re, '') : ind + mark + (kind === 'quote' ? rest : rest.replace(ANY_LIST, ''));
    });
  }
  const text = out.join('\n');
  splice(st, p, a, b, text, a, a + text.length);
}

/** Inserts a 2x2 table template after the caret's line (replacing it when blank), blank lines separating it from text. */
function table(st: State) {
  const p = st.cur, sel = p && getSel(p.el);
  if (!p || !sel) return;
  const src = p.src, e = src.indexOf('\n', sel[1]), b = e < 0 ? src.length : e, a = src.lastIndexOf('\n', b - 1) + 1;
  const blank = !src.slice(a, b).trim(), pre = blank ? '' : '\n\n', post = e >= 0 && src.slice(b + 1).split('\n', 1)[0].trim() ? '\n' : '';
  const at = (blank ? a : b) + pre.length + 2;
  splice(st, p, blank ? a : b, b, pre + '| A | B |\n| --- | --- |\n|   |   |' + post, at, at + 1);
}

// ---- Toolbox ----

/** Controls: [label, title, action, block-mode only]. */
const TOOLS: [string, string, (st: State) => void, boolean][] = [
  ['B', 'Bold (Ctrl+B)', st => wrap(st, '**'), false],
  ['I', 'Italic (Ctrl+I)', st => wrap(st, '*'), false],
  ['S', 'Strikethrough', st => wrap(st, '~~'), false],
  ['</>', 'Code', st => wrap(st, '`'), false],
  ['🔗', 'Link (Ctrl+click opens)', link, false],
  ['H', 'Heading level', st => lines(st, 'h'), true],
  ['•', 'Bullet list', st => lines(st, 'ul'), true],
  ['1.', 'Numbered list', st => lines(st, 'ol'), true],
  ['☐', 'Checklist', st => lines(st, 'task'), true],
  ['❝', 'Quote', st => lines(st, 'quote'), true],
  ['{ }', 'Code block', st => lines(st, 'fence'), true],
  ['▦', 'Table', table, true],
];

let tools: HTMLElement | null = null, active: State | null = null;

/**
 * One toolbox shared by all editors, fixed-positioned on top of everything at the focused editor.
 * Buttons act on `mousedown` with preventDefault, so the editor keeps focus and selection.
 */
function toolbox(): HTMLElement {
  if (tools) return tools;
  const btn = (label: string, title: string, act: (st: State) => void, cls = '') => {
    const b = el('button', cls, label);
    Object.assign(b, { type: 'button', title, tabIndex: -1 });
    b.addEventListener('mousedown', e => { e.preventDefault(); if (active) act(active); });
    return b;
  };
  // Two bubbles: formatting controls (scroll only if the screen is too narrow) and the confirm button
  tools = el('div', 'mdtools', el('div', 'bar', ...TOOLS.map(([l, t, act, blk]) => btn(l, t, act, blk ? 'blk' : ''))), el('div', 'bar', btn('✓', 'Confirm (Ctrl+Enter)', confirm, 'ok')));
  // A plain mouse wheel only scrolls vertically: turn it into horizontal scrolling of the squeezed controls
  const bar = tools.firstElementChild as HTMLElement;
  bar.addEventListener('wheel', e => {
    if (e.deltaX || bar.scrollWidth <= bar.clientWidth) return;
    bar.scrollLeft += e.deltaY; e.preventDefault();
  }, { passive: false });
  tools.hidden = true;
  document.body.append(tools);
  addEventListener('scroll', place, { capture: true, passive: true });
  addEventListener('resize', place);
  document.addEventListener('selectionchange', () => { if (active?.cur) reveal(active.cur.el); });
  return tools;
}

/**
 * Vertically: above the frame; below it when that would leave the viewport; pinned to the top when neither fits.
 * Horizontally: spans the frame (controls left, confirm right). When the bubbles need more room, they are centered
 * on the frame instead, shifted to stay on screen and squeezed (the controls scroll) only past the screen width.
 */
function place() {
  if (!active || !tools || tools.hidden) return;
  // Rects and the viewport are in screen px, the toolbox's sizes and styles in zoomed CSS px (VSCode tab zoom)
  const z = tools.currentCSSZoom, R = active.frame.getBoundingClientRect(), vw = innerWidth / z, vh = innerHeight / z;
  const r = { left: R.left / z, top: R.top / z, bottom: R.bottom / z, width: R.width / z };
  const h = tools.offsetHeight, [bar, ok] = Array.from(tools.children) as HTMLElement[];
  const need = bar.scrollWidth + bar.offsetWidth - bar.clientWidth + 6 + ok.offsetWidth, w = Math.min(Math.max(need, r.width), vw - 8);
  const left = need <= r.width ? r.left : Math.min(Math.max(4, r.left + (r.width - w) / 2), vw - w - 4);
  let top = r.top - h - 4;
  if (top < 0) top = r.bottom + 4 + h <= vh ? r.bottom + 4 : 0;
  Object.assign(tools.style, { left: `${left}px`, top: `${top}px`, width: `${w}px` });
}

// ---- Editor ----

/** Builds the frame: one contenteditable `div.part` per text part, the widgets between them. */
export function mdEditor(o: EditorOpts): Editor {
  const frame = el('div', `mdedit ${o.mode}${o.className ? ' ' + o.className : ''}`);
  const st: State = { frame, o, parts: [], cur: null };

  for (const x of o.parts) {
    if (typeof x !== 'string') { x.classList.add('mdwidget'); frame.append(x); continue; }
    const part = el('div', 'part');
    Object.assign(part, { contentEditable: 'true', spellcheck: true });
    part.setAttribute('role', 'textbox');
    if (o.multiline !== false) part.setAttribute('aria-multiline', 'true');
    if (o.label) part.setAttribute('aria-label', o.label);
    if (o.placeholder && o.parts.length === 1) part.dataset.ph = o.placeholder;
    const p: Part = { el: part, src: x, keep: groupTexts(x), undo: [], redo: [], last: 0, figs: [] };
    st.parts.push(p);
    paint(p);
    frame.append(part);
    listen(st, p);
  }

  // Clicks on the frame's empty space (padding, the area below the text) edit the end of the last part
  frame.addEventListener('mousedown', e => {
    const p = st.parts.at(-1);
    if (e.target !== frame || !p) return;
    e.preventDefault();
    p.el.focus();
    setSel(p.el, p.src.length);
  });

  // Focus: the toolbox follows the focused part; focus moving into a widget hides it
  frame.addEventListener('focusin', e => {
    const p = st.parts.find(p => p.el === e.target);
    if (!p) { if (active === st) show(toolbox(), false); return; }
    st.cur = p;
    active = st;
    const tb = toolbox();
    tb.classList.toggle('line', o.mode === 'line');
    show(tb, true);
    place();
  });
  frame.addEventListener('focusout', e => {
    const p = st.parts.find(p => p.el === e.target);
    p?.el.querySelectorAll('.near').forEach(n => n.classList.remove('near'));
    if (active === st && !st.parts.some(p => p.el === e.relatedTarget)) { show(toolbox(), false); active = null; }
  });

  return {
    el: frame,
    texts: () => st.parts.map(p => rewrap(p.src, p.keep, off => boxAt(p.el, off))),
    set(texts) { st.parts.forEach((p, i) => { p.src = texts[i] ?? ''; p.keep = groupTexts(p.src); p.undo = []; p.redo = []; p.figs = []; paint(p); }); },
  };
}

/** Keys, paste, browser edits and link clicks of one part. */
function listen(st: State, p: Part) {
  const { o } = st, part = p.el, multi = o.multiline !== false;
  /** Replaces `[a, b)` with `text` keeping partly deleted markers (`cut`); `force` makes it its own undo step. */
  const replace = (a: number, b: number, text: string, force = true) => {
    const [src, at] = cut(p.src, a, b, text);
    if (src === p.src) return;
    snapshot(p, a, force);
    commit(st, p, src, at);
  };
  const insert = (text: string) => { const s = getSel(part); if (s) replace(s[0], s[1], text); };
  /** Inserts what Enter (`hard`: Shift+Enter) makes at the selection (`enterText`). */
  const insertBreak = (hard: boolean) => { const s = getSel(part); if (s) insert(enterText(p.src, s[0], hard)); };
  /**
   * Deletes the selection, or from a caret: the browser's range for word and line deletes, otherwise arrow steps
   * (`caretStep`) until one deletes something, so Backspace never just eats into a marker.
   */
  const del = (e: InputEvent) => {
    const s = getSel(part), r = e.getTargetRanges()[0];
    if (!s) return;
    let [a, b] = s;
    if (a === b && r && !/^deleteContent(Backward|Forward)$/.test(e.inputType)) {
      if (!part.contains(r.startContainer) || !part.contains(r.endContainer)) return;
      [a, b] = [offsetOf(part, r.startContainer, r.startOffset), offsetOf(part, r.endContainer, r.endOffset)];
    } else if (a === b) {
      const src = p.src, m = markMask(src), d = e.inputType.endsWith('Forward') ? 1 : -1, x = a;
      for (let y = x, z = caretStep(src, m, x, d); z !== y; y = z, z = caretStep(src, m, z, d)) {
        [a, b] = z < x ? [z, x] : [x, z];
        if (cut(src, a, b)[0] !== src) break;
      }
    }
    replace(a, b, '', s[0] !== s[1]);
  };
  /** Applies `tableEdit`, or `listEdit` on a collapsed caret; false when the key should keep its default. */
  const listKey = (key: 'Enter' | 'Tab' | 'Backspace', shift: boolean) => {
    const s = multi && getSel(part);
    const ed = s && ((key !== 'Backspace' && tableEdit(p.src, s[0], key, shift)) || (s[0] === s[1] && listEdit(p.src, s[0], key, shift)));
    if (!ed) return false;
    // A pure move (table Tab) only selects: no undo step, no input event
    if (ed[0] === ed[1] && !ed[2]) { setSel(part, ed[3], ed[4] ?? ed[3]); reveal(part); }
    else splice(st, p, ed[0], ed[1], ed[2], ed[3], ed[4]);
    return true;
  };

  // Caret: Left/Right step over markers (`caretStep`); other moves and clicks on text are corrected after the fact
  // (`caretSnap`). Clicks in a shown marker bubble keep the caret inside it, so the marker can be edited.
  const arrow = (e: KeyboardEvent) => {
    const s = getSelection();
    if (!s?.focusNode || !part.contains(s.focusNode) || (!s.isCollapsed && !e.shiftKey)) return;
    const x = offsetOf(part, s.focusNode, s.focusOffset), y = caretStep(p.src, markMask(p.src), x, e.key === 'ArrowLeft' ? -1 : 1);
    if (y === x) return;
    e.preventDefault();
    if (e.shiftKey) s.extend(...pointOf(part, y)); else setSel(part, y);
  };
  // A caret at a marker's edge has the same offset as the text next to it but shows inside the bubble: moved out too
  const fix = () => {
    const s = getSel(part);
    if (!s || s[0] !== s[1]) return;
    const y = caretSnap(p.src, markMask(p.src), s[0]);
    if (y !== s[0] || elOf(getSelection()!.focusNode!).closest('.mk')) setSel(part, y);
  };

  // Table rows: cells are separate blocks to the browser, so its Up goes to the previous cell and Home/End stop at
  // cell edges. Up/Down from a cell's first/last visual line instead go to the adjacent line at the same x (`goal`,
  // kept across consecutive moves); Home/End go to the row's ends. Needs the markers hidden (`nav`) for hit testing.
  let goal: number | null = null;
  const lineOf = (ln: Element) => tokenize(p.src)[rows(part).indexOf(ln)];
  const tableMove = (e: KeyboardEvent): boolean => {
    const s = getSelection()!, n = s.focusNode, cell = n && part.contains(n) && elOf(n).closest('.cell'), ln = cell && cell.parentElement;
    if (!cell || !ln || e.ctrlKey || e.metaKey || e.altKey || !/^(ArrowUp|ArrowDown|Home|End)$/.test(e.key)) return false;
    let y: number;
    if (e.key === 'Home' || e.key === 'End') {
      const l = lineOf(ln);
      y = e.key === 'Home' ? l.start : l.end;
    } else {
      // Caret and cell content boxes (no caret box in an empty cell: the cell's own then)
      const up = e.key === 'ArrowUp', c = document.createRange(), cb = cell.getBoundingClientRect();
      c.selectNodeContents(cell);
      const rs = Array.from(c.getClientRects()), [cx, top, bottom] = caretBox(n, s.focusOffset) ?? [cb.left, cb.top, cb.bottom], h = (bottom - top) / 2;
      if (up ? top - Math.min(...rs.map(q => q.top)) > h : Math.max(...rs.map(q => q.bottom)) - bottom > h) return false;
      goal ??= cx;
      let to = up ? ln.previousElementSibling : ln.nextElementSibling;
      if (isGrp(to)) to = up ? to.lastElementChild : to.firstElementChild;
      if (!to) y = up ? 0 : p.src.length;
      else {
        // Into the target line's nearest visual line, in a row the cell under `goal`. A collapsed delimiter row's text
        // has no width to hit: that cell's text start then.
        const t = to.getBoundingClientRect(), d = Math.min(3, t.height / 2), gx = Math.min(Math.max(goal, t.left + 1), t.right - 1);
        const at = document.caretPositionFromPoint(gx, up ? t.bottom - d : t.top + d), ks = Array.from(to.children).filter(k => k.classList.contains('cell'));
        const k = ks.find(k => k.getBoundingClientRect().right >= gx) ?? ks.at(-1), box = k ?? to;
        if (at && box.contains(at.offsetNode) && !to.matches('.tsep:not(.near)')) y = offsetOf(part, at.offsetNode, at.offset);
        else { const l = lineOf(to); y = k ? l.cells![ks.indexOf(k)].open : l.start; }
      }
    }
    e.preventDefault();
    y = caretSnap(p.src, markMask(p.src), y);
    if (e.shiftKey) s.extend(...pointOf(part, y)); else setSel(part, y);
    return true;
  };

  // Triple click selects the clicked line's text (a table cell's in a row); the browser's paragraph would stop at
  // the marker boxes. Any other click on text is corrected like a native move.
  part.addEventListener('click', e => {
    const t = e.target as HTMLElement, cell = t.closest('.cell'), ln = t.closest('.ln');
    if (e.detail !== 3) { if (!t.closest('.mk')) fix(); return; }
    if (!ln || !rows(part).includes(ln)) return;
    const l = lineOf(ln);
    const c = cell && l.cells?.[Array.prototype.indexOf.call(ln.children, cell)];
    setSel(part, c ? c.open : l.mark, c ? c.close : l.end);
  });

  // Multi-click bursts: the first click reveals markers over neighboring text, so the next ones would land in their
  // bubbles; revealed markers ignore the pointer until the burst ends. A burst starting on a shown marker edits it.
  let burst: ReturnType<typeof setTimeout> | undefined;
  part.addEventListener('mousedown', e => {
    goal = null;
    if (e.detail === 1 && (e.target as HTMLElement).closest('.mk')) return;
    part.classList.add('pt');
    clearTimeout(burst);
    burst = setTimeout(() => part.classList.remove('pt'), 500);
  });

  // Enter: Ctrl confirms, Shift inserts a hard break; plain Enter confirms a single line in line mode, else continues
  // lists or starts a paragraph (`enterText`)
  // Enter, Tab and Shift+Tab edit table rows (see `tableEdit`); Tab, Shift+Tab and Backspace edit list items (see
  // `listEdit`); elsewhere they keep their default
  part.addEventListener('keydown', e => {
    if (e.isComposing) return;
    const mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') goal = null;
    if (e.key === 'Enter') {
      e.preventDefault();
      if (mod) confirm(st);
      else if (e.shiftKey || o.mode === 'block' || p.src.includes('\n')) { if (multi && (e.shiftKey || !listKey('Enter', false))) insertBreak(e.shiftKey); }
      else confirm(st);
    } else if ((e.key === 'Tab' || e.key === 'Backspace') && !mod && !e.altKey) { if (listKey(e.key, e.shiftKey)) e.preventDefault(); }
    else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !mod && !e.altKey) arrow(e);
    else if (/^(Arrow|Home$|End$|Page)/.test(e.key)) {
      // Markers are absolutely positioned boxes the native move would treat as extra lines: hidden during it
      part.classList.add('nav');
      if (tableMove(e)) { part.classList.remove('nav'); return; }
      setTimeout(() => { part.classList.remove('nav'); fix(); });
    }
    else if (mod && (k === 'b' || k === 'i')) { e.preventDefault(); wrap(st, k === 'b' ? '**' : '*'); }
    else if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? history(st, p, p.redo, p.undo) : history(st, p, p.undo, p.redo); }
    else if (mod && k === 'y') { e.preventDefault(); history(st, p, p.redo, p.undo); }
  });

  // Edits the browser would do as rich text: undo from menus, line breaks from virtual keyboards, deletes
  part.addEventListener('beforeinput', e => {
    if (e.inputType === 'historyUndo' || e.inputType === 'historyRedo') {
      e.preventDefault();
      if (e.inputType === 'historyUndo') history(st, p, p.undo, p.redo); else history(st, p, p.redo, p.undo);
    } else if (e.inputType === 'insertParagraph' || e.inputType === 'insertLineBreak') { e.preventDefault(); if (multi) insertBreak(e.inputType === 'insertLineBreak'); }
    // Deleting and typing over a selection keep partly covered markers (`cut`); drag moves and IME edits stay native
    else if (!e.cancelable || e.isComposing) return;
    else if (e.inputType.startsWith('delete') && e.inputType !== 'deleteByDrag') { e.preventDefault(); del(e); }
    else if (e.inputType === 'insertText' && !getSelection()?.isCollapsed) { e.preventDefault(); insert(e.data ?? ''); }
  });

  // Paste: plain text is Markdown. HTML is converted (`fromHtml`) unless it is our own copy, whose plain text is the
  // exact source, or source text from a code editor. Deeply nested HTML could overflow the stack: plain text then.
  part.addEventListener('paste', e => {
    e.preventDefault();
    const plain = (e.clipboardData?.getData('text/plain') ?? '').replace(/\r\n?/g, '\n'), html = e.clipboardData?.getData('text/html');
    let t = plain;
    if (html && !html.includes(toHtml(plain) || '\0')) {
      try { t = fromHtml(new DOMParser().parseFromString(html, 'text/html').body)?.replace(/\r\n?/g, '\n') || plain; } catch { /* plain */ }
    }
    insert(multi ? t : t.replace(/\n/g, ' '));
  });

  // Copy and cut put the selection's Markdown (`clip`) as plain text and its rendering as HTML; the browser's own copy
  // would serialize the marker bubbles
  const copy = (e: ClipboardEvent) => {
    const s = getSel(part);
    if (!s || s[0] === s[1] || !e.clipboardData) return;
    e.preventDefault();
    const [a, b, md] = clip(p.src, s[0], s[1]);
    e.clipboardData.setData('text/plain', md);
    e.clipboardData.setData('text/html', toHtml(md));
    if (e.type === 'cut') replace(a, b, '');
  };
  part.addEventListener('copy', copy);
  part.addEventListener('cut', copy);

  // Typing, deleting and dropping are left to the browser, then the source is re-read and repainted
  const sync = () => {
    const at = getSel(part)?.[0] ?? 0, src = read(part);
    if (src === p.src) return;
    snapshot(p, at);
    commit(st, p, src, at);
  };
  part.addEventListener('input', e => { if (!(e as InputEvent).isComposing) sync(); });
  part.addEventListener('compositionend', sync);

  // Ctrl+click follows links; only web and mail URLs, never `javascript:` and the like
  part.addEventListener('click', e => {
    const a = (e.ctrlKey || e.metaKey) && (e.target as HTMLElement).closest<HTMLElement>('.k-link');
    if (a && /^(https?:|mailto:)/i.test(a.dataset.href ?? '')) window.open(a.dataset.href, '_blank', 'noopener');
  });
}
