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
  /** Source of each text part, in order. */
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
    l.inl = inline(src, l.mark, end);
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
 * alignment), so each target applies its own look. Lines of a paragraph or quote stay separate lines (`<br>`), as the
 * editor shows them; nested lists follow item depth; task items get disabled checkboxes, as GitHub renders them.
 */
export function toHtml(src: string): string {
  const ls = tokenize(src), out: string[] = [];
  const body = (l: Line) => inlineHtml(src, l.mark, l.end, l.inl);
  const cell = (tag: string, c: Cell) => `<${tag}${c.align ? ` style="text-align:${{ l: 'left', c: 'center', r: 'right' }[c.align]}"` : ''}>${inlineHtml(src, c.open, c.close, c.inl)}</${tag}>`;
  const blank = (l: Line) => l.block === 'p' && !src.slice(l.start, l.end).trim();
  for (let i = 0; i < ls.length;) {
    const l = ls[i];
    /** Lines from `i` on while `ok` holds; advances `i` past them. */
    const take = (ok: (l: Line) => boolean) => { const g: Line[] = []; while (i < ls.length && ok(ls[i])) g.push(ls[i++]); return g; };
    if (blank(l)) i++;
    else if (l.block[0] === 'h') { out.push(`<${l.block}>${body(l)}</${l.block}>`); i++; }
    else if (l.block === 'p' || l.block === 'quote') {
      const g = take(x => x.block === l.block && !blank(x)).map(body).join('<br>');
      out.push(l.block === 'p' ? `<p>${g}</p>` : `<blockquote><p>${g}</p></blockquote>`);
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
      for (const x of take(x => x.block === 'li' || x.block === 'ol')) {
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

/**
 * Marker bubble. Its outer whitespace stays source text (offsets and `read` see it) but sits in zero-width `.sp` spans,
 * so the bubble hugs the syntax; an all-blank marker (indentation, a row's trailing spaces) is never shown.
 */
function marker(text: string, side: 'o' | 'c'): HTMLElement {
  const [, lead, core, tail] = /^(\s*)(.*?)(\s*)$/s.exec(text)!, sp = (t: string) => el('span', 'sp', t);
  return el('span', `mk ${side}${core ? '' : ' blank'}`, ...[lead && sp(lead), core, tail && sp(tail)].filter(x => x));
}

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

/**
 * Rebuilds a part's DOM: one `div.ln` per source line, so lines map 1:1 to the part's child nodes.
 * shortcut: full re-render per change; switch to per-line diffing if descriptions get very long.
 */
function paint(p: Part) {
  const src = p.src;
  p.el.replaceChildren(...tokenize(src).map(l => {
    const div = ranged(el('div', `ln ${l.block}`), l.start, l.end);
    if (l.depth) div.style.setProperty('--d', String(l.depth));
    if (l.check) div.dataset.cb = l.check;
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
    else paintInline(div, src, l.mark, l.end, l.inl);
    if (l.start === l.end) div.append(document.createElement('br'));
    return div;
  }));
  p.el.toggleAttribute('data-empty', !src);
}

/** Source text of a part. Each child node is one line (the browser may merge or add nodes before `paint` runs). */
const read = (part: HTMLElement) => Array.from(part.childNodes).map(n => n.textContent ?? '').join('\n');

/** Source offset of a DOM point inside a part. */
function offsetOf(part: HTMLElement, node: Node, off: number): number {
  const kids = Array.from(part.childNodes), before = (i: number) => kids.slice(0, i).reduce((a, n) => a + (n.textContent ?? '').length + 1, 0);
  if (node === part) return Math.max(0, before(off) - (off === kids.length && off ? 1 : 0));
  let ln = node;
  while (ln.parentNode !== part) ln = ln.parentNode!;
  const r = document.createRange();
  r.setStart(ln, 0);
  r.setEnd(node, off);
  return before(kids.indexOf(ln as ChildNode)) + r.toString().length;
}

/** DOM point of a source offset. At a boundary between a marker and text, the text side wins (typing lands there). */
function pointOf(part: HTMLElement, off: number): [Node, number] {
  for (const ln of Array.from(part.childNodes)) {
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
interface Part { el: HTMLElement; src: string; undo: Snap[]; redo: Snap[]; last: number }
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
  paint(p);
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
    const p: Part = { el: part, src: x, undo: [], redo: [], last: 0 };
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
    texts: () => st.parts.map(p => p.src),
    set(texts) { st.parts.forEach((p, i) => { p.src = texts[i] ?? ''; p.undo = []; p.redo = []; paint(p); }); },
  };
}

/** Keys, paste, browser edits and link clicks of one part. */
function listen(st: State, p: Part) {
  const { o } = st, part = p.el, multi = o.multiline !== false;
  const insert = (text: string) => { const s = getSel(part); if (s) splice(st, p, s[0], s[1], text); };
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

  // Enter: Ctrl confirms, Shift inserts a newline; plain Enter confirms a single line in line mode, else continues lists
  // Enter, Tab and Shift+Tab edit table rows (see `tableEdit`); Tab, Shift+Tab and Backspace edit list items (see
  // `listEdit`); elsewhere they keep their default
  part.addEventListener('keydown', e => {
    if (e.isComposing) return;
    const mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
    if (e.key === 'Enter') {
      e.preventDefault();
      if (mod) confirm(st);
      else if (e.shiftKey || o.mode === 'block' || p.src.includes('\n')) { if (multi && (e.shiftKey || !listKey('Enter', false))) insert('\n'); }
      else confirm(st);
    } else if ((e.key === 'Tab' || e.key === 'Backspace') && !mod && !e.altKey) { if (listKey(e.key, e.shiftKey)) e.preventDefault(); }
    else if (mod && (k === 'b' || k === 'i')) { e.preventDefault(); wrap(st, k === 'b' ? '**' : '*'); }
    else if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? history(st, p, p.redo, p.undo) : history(st, p, p.undo, p.redo); }
    else if (mod && k === 'y') { e.preventDefault(); history(st, p, p.redo, p.undo); }
  });

  // Edits the browser would do as rich text: undo from menus, line breaks from virtual keyboards
  part.addEventListener('beforeinput', e => {
    if (e.inputType === 'historyUndo' || e.inputType === 'historyRedo') {
      e.preventDefault();
      if (e.inputType === 'historyUndo') history(st, p, p.undo, p.redo); else history(st, p, p.redo, p.undo);
    } else if (e.inputType === 'insertParagraph' || e.inputType === 'insertLineBreak') { e.preventDefault(); if (multi) insert('\n'); }
  });

  part.addEventListener('paste', e => {
    e.preventDefault();
    const t = (e.clipboardData?.getData('text/plain') ?? '').replace(/\r\n?/g, '\n');
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
    if (e.type === 'cut') splice(st, p, a, b, '');
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
