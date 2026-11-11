/**
 * Markdown structure parser. Finds `[Type] Title` headings (tasks) with their YAML property blocks, descriptions and
 * (labeled) lists of `[Type] Title` bullets (references), and records line ranges so edits can rewrite files surgically.
 * Knows nothing about task types; `format.ts` and `db.ts` interpret the result.
 */
import { parse as parseYaml } from 'yaml';

/** Line range, `end` exclusive. An empty range is an insertion point. */
export interface Range { start: number; end: number }

/**
 * Property block below a heading; `style`: `indent` (lines indented 4+ columns), `fence` (a ```yaml fence) or `dash`
 * (legacy `---` lines). Edits rewrite it as `indent`.
 */
export interface Props extends Range { raw: string; data: Record<string, unknown>; style: 'indent' | 'fence' | 'dash' }

/** Top-level block of an occurrence's body holding task lists (label line included); `labels` of every list inside it. */
export interface Span extends Range { labels: (string | null)[] }

/** A run of contiguous bullets owned by a task; `label` is the `<Link type>:` paragraph line above it (null: Subtask). */
export interface List {
  label: string | null;
  labelLine: number;   // -1 when unlabeled; blank lines may separate it from the list
  start: number;       // first bullet line
  bullet: string;      // marker of the first item (`  - `), reused when appending
  items: Node[];       // task items only
  end: number;         // line after the last bullet item (append position); blank lines between items stay inside (loose list)
}

/**
 * One occurrence of a task in one file. The same task may occur in several places. A heading defines the task; a bullet
 * only refers to it, so its body fields stay empty (content nested under a bullet is plain text).
 */
export interface Node {
  type: string;
  title: string;
  line: number;              // title line
  kind: 'heading' | 'bullet';
  prefix: string;            // title line text before `[Type]` (`## `, `  - [x] `)
  props?: Props;             // YAML block including its opening and closing lines
  own: Range;                // body: content after the props up to the next task heading; where new lists are appended
  spans: Span[];             // task-list blocks in `own`; the text between them is the description
  block: Range;              // everything the occurrence spans: what deletion removes
  lists: List[];
  children: Node[];          // task sub-headings (implicit Subtask links)
  list: List | null;         // list this bullet belongs to
}

export interface Diagnostic { file: string; line: number; severity: 'error' | 'warning'; message: string }

export interface ParsedFile {
  file: string;
  text: string;
  eol: string;
  lines: string[];           // without the final empty line of a newline-terminated file
  roots: Node[];             // occurrences without an owning task
  nodes: Node[];             // all occurrences in document order
  heads: { line: number; level: number }[];   // every ATX heading outside fences and heading property blocks (level shifts need them)
  diagnostics: Diagnostic[];
}

const HEADING = /^(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
export const BULLET = /^([ \t]*)([-*+]|\d{1,9}[.)])([ \t]+)(.*)$/;
// property block opening: a ```yaml / ~~~yml fence (any fence length)
const YAML_FENCE = /^[ \t]*(`{3,}|~{3,})[ \t]*ya?ml[ \t]*$/i;
// YAML document end or start marker: may close a heading's indented property block
export const DOC_END = /^[ \t]*(?:---|\.\.\.)[ \t]*$/;
const LEGACY = 'Property block uses the "---" style, which was supported before and has been replaced by indented blocks; editing the properties converts it';
// optional checkbox, then `[Type] Title`; `](` (a link) does not match because whitespace must follow `]`
const TASK = /^(\[[ xX]\][ \t]+)?\[([^\[\]\r\n]+)\][ \t]+(\S.*?)[ \t]*$/;

/** Leading whitespace width; content columns and YAML de-indentation depend on it. Tabs count as 1 (shortcut: mixed tabs/spaces indentation is not normalized). */
export const indentOf = (line: string) => line.length - line.trimStart().length;

/**
 * Fence opening run of a line (```` ``` ````, `~~~~`, …), if any. A backtick fence's info string cannot contain backticks
 * (CommonMark). Shortcut: any indentation is accepted (CommonMark allows 3 spaces outside list items).
 */
export function fenceRun(line: string): string | null {
  const m = /^[ \t]*(`{3,}|~{3,})(.*)$/.exec(line);
  return m && !(m[1][0] === '`' && m[2].includes('`')) ? m[1] : null;
}

/** Whether `line` closes a fence opened by `run`: same character, at least as long, nothing else on the line (CommonMark). */
export function closesFence(line: string, run: string): boolean {
  const t = line.trim();
  return t.length >= run.length && t === run[0].repeat(t.length);
}

/** Indentation column with tabs advancing to the next multiple of 4, as CommonMark measures indented code blocks. */
export function columnOf(line: string): number {
  let c = 0;
  for (const ch of line) { if (ch === ' ') c++; else if (ch === '\t') c += 4 - c % 4; else break; }
  return c;
}

/** `line` minus its first `n` columns of indentation (shortcut: a tab straddling column `n` is dropped whole; CommonMark keeps its rest as spaces). */
function stripCols(line: string, n: number): string {
  let c = 0, i = 0;
  for (; i < line.length && c < n && (line[i] === ' ' || line[i] === '\t'); i++) c += line[i] === '\t' ? 4 - c % 4 : 1;
  return line.slice(i);
}

/** `[Type] Title` matcher shared by headings and bullets; rejects bare checkboxes like `[x] Done`. */
export function matchTask(text: string): { pre: string; type: string; title: string } | null {
  const m = TASK.exec(text);
  if (!m || /^\s*[xX]?\s*$/.test(m[2])) return null;
  return { pre: m[1] ?? '', type: m[2].trim(), title: m[3] };
}

/** Whether two list markers continue one list (CommonMark): the same bullet character, or the same ordered delimiter. */
export const sameMarker = (a: string, b: string) => a.slice(-1) === b.slice(-1);

/** Text gaps of an occurrence's body (`own` minus its spans), in order; always `spans.length + 1` ranges. */
export function gaps(node: Node): Range[] {
  const b = [node.own.start, ...node.spans.flatMap(s => [s.start, s.end]), node.own.end];
  return Array.from({ length: node.spans.length + 1 }, (_, i) => ({ start: b[2 * i], end: b[2 * i + 1] }));
}

/** Description texts of an occurrence, one per gap. */
export const bodyTexts = (pf: ParsedFile, node: Node) => gaps(node).map(r => rangeText(pf, r));

/** Text of a body range, trimmed of surrounding blank lines. */
export const rangeText = (pf: ParsedFile, r: Range) => pf.lines.slice(r.start, r.end).join('\n').replace(/^(?:[ \t]*\n)+/, '').trimEnd();

export function parseMarkdown(file: string, text: string): ParsedFile {
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  const pf: ParsedFile = { file, text, eol: text.includes('\r\n') ? '\r\n' : '\n', lines, roots: [], nodes: [], heads: [], diagnostics: [] };
  const n = lines.length;
  const diag = (line: number, severity: Diagnostic['severity'], message: string) => pf.diagnostics.push({ file, line, severity, message });
  const isTaskHeading = (i: number) => { const h = HEADING.exec(lines[i]); return !!h && !!matchTask(h[2]); };

  /**
   * Property block of the task heading at line `t`: its first line, last line (-1: an unclosed fence) and style; null if
   * none. Blank lines may come first (formatters put one between a heading and a code block). Either an indented block
   * (CommonMark indented code: lines indented 4+ columns, up to the first less indented non-blank line) or a fence; legacy
   * `---` blocks must start directly under the title. A fence closes CommonMark-style (same character, at least as long,
   * nothing else on the line); the search stops at the next task heading or a line indented less than the opening, so an
   * unclosed block cannot swallow later tasks.
   */
  function propsAt(t: number, end: number): { start: number; close: number; style: Props['style']; term: boolean } | null {
    let o = t + 1;
    while (o < end && !lines[o].trim()) o++;
    if (o >= end) return null;
    if (columnOf(lines[o]) >= 4) {
      // A `---` or `...` line (indented or not, blank lines may precede it) closes the block and belongs to it
      let last = o, k = o + 1;
      for (; k < end && !DOC_END.test(lines[k]) && (!lines[k].trim() || columnOf(lines[k]) >= 4); k++) if (lines[k].trim()) last = k;
      const term = k < end && DOC_END.test(lines[k]);
      return { start: o, close: term ? k : last, style: 'indent', term };
    }
    const f = YAML_FENCE.exec(lines[o]), style = f ? 'fence' : 'dash';
    if (!f && (o !== t + 1 || lines[o].trim() !== '---')) return null;
    const ind = indentOf(lines[o]);
    for (let k = o + 1; k < end; k++) {
      if (isTaskHeading(k) || (lines[k].trim() && indentOf(lines[k]) < ind)) break;
      if (f ? closesFence(lines[k], f[1]) : lines[k].trim() === '---') return { start: o, close: k, style, term: true };
    }
    return { start: o, close: -1, style, term: true };
  }

  // Pass 1: headings. Fenced code and property blocks are marked `skip` (a YAML `# comment` is not a heading, `- x` no bullet).
  // `opens`: fence opening lines, so a ```yaml fence under a bullet (an old property block) can be reported
  const skip = new Array<boolean>(n).fill(false), opens = new Set<number>();
  const heads: { line: number; level: number; text: string }[] = [];
  pf.heads = heads;
  let fence: string | null = null;
  for (let i = 0; i < n; i++) {
    if (fence) { skip[i] = true; if (closesFence(lines[i], fence)) fence = null; continue; }
    const f = fenceRun(lines[i]);
    if (f) { fence = f; skip[i] = true; opens.add(i); continue; }
    const h = HEADING.exec(lines[i]);
    if (h) heads.push({ line: i, level: h[1].length, text: h[2] });
    // Property block below a task heading: bounded by `propsAt`; an unclosed fence skips only its opening line (an open fence would skip the rest of the file)
    const p = h && matchTask(h[2]) ? propsAt(i, n) : null;
    if (p) { const e = p.close < 0 ? p.start : p.close; skip.fill(true, p.start, e + 1); i = e; }
  }

  /** Item end: last non-blank line indented at least to the content column, plus one. */
  function itemEnd(j: number, contentCol: number, end: number): number {
    let last = j;
    for (let k = j + 1; k < end; k++) {
      if (!lines[k].trim()) continue;
      if (indentOf(lines[k]) < contentCol) break;
      last = k;
    }
    return last + 1;
  }

  /** Reads the property block below a task heading; returns the first content line. */
  function readProps(node: Node, end: number): number {
    const p = propsAt(node.line, end);
    if (!p) return node.line + 1;
    const o = p.start, c = p.close;
    if (c < 0) { diag(o, 'error', `Unclosed property block (missing closing ${p.style === 'dash' ? '"---"' : 'fence'})`); return node.line + 1; }
    if (p.style === 'dash') diag(o, 'warning', LEGACY);
    const raw = (p.style === 'indent' ? lines.slice(o, p.term ? c : c + 1).map(l => stripCols(l, 4))
      : lines.slice(o + 1, c)).join('\n');
    let data: Record<string, unknown> = {};
    try {
      const v = parseYaml(raw);
      if (v && typeof v === 'object' && !Array.isArray(v)) data = v;
      else if (v != null) diag(o, 'error', 'Property block must be a YAML mapping');
    } catch (e) {
      diag(o, 'error', `Invalid YAML: ${(e as Error).message.split('\n')[0]}`);
    }
    node.props = { start: o, end: c + 1, raw, data, style: p.style };
    return c + 1;
  }

  function mk(kind: Node['kind'], line: number, prefix: string, t: { type: string; title: string }, blockEnd: number): Node {
    const r = { start: line + 1, end: line + 1 };
    const node: Node = { type: t.type, title: t.title, line, kind, prefix, own: r, spans: [], block: { start: line, end: blockEnd }, lists: [], children: [], list: null };
    pf.nodes.push(node);
    return node;
  }

  /** Whether [from, to) holds task content: a ```yaml fence or a task bullet. Nested under a bullet, it is ignored. */
  const hasTaskContent = (from: number, to: number) => {
    for (let k = from; k < to; k++) {
      const b = skip[k] ? null : BULLET.exec(lines[k]);
      if ((opens.has(k) && YAML_FENCE.test(lines[k])) || (b && matchTask(b[4]))) return true;
    }
    return false;
  };

  /**
   * Scans [start, end) for lists. Task bullets become reference occurrences in `owner.lists` (or roots).
   * With `top`, each top-level list containing a task (even nested under non-task bullets) becomes a span of the owner.
   * Returns whether any task was found.
   */
  function parseBody(start: number, end: number, owner: Node | null, top: boolean): boolean {
    let found = false, i = start;
    while (i < end) {
      const b = skip[i] ? null : BULLET.exec(lines[i]);
      if (!b) { i++; continue; }

      // Label: the nearest non-blank line above (formatters insert a blank line), if it is `<Link type>:` paragraph text
      // (not a heading or bullet); otherwise Subtask
      const col = b[1].length;
      let p = i - 1;
      while (p >= start && !lines[p].trim()) p--;
      const prev = p >= start && !skip[p] ? lines[p] : '';
      const colon = prev.trim().endsWith(':') && !BULLET.test(prev), head = HEADING.test(prev);
      const label = colon && !head ? prev.trim().slice(0, -1).trim() : null;
      const list: List = { label, labelLine: label === null ? -1 : p, start: i, bullet: b[1] + b[2] + ' ', items: [], end: i };
      let hasTask = false, j = i;
      const before = owner?.lists.length ?? 0;

      // Items: bullets at the same column with the same marker kind, blank lines between them allowed (CommonMark lists)
      while (j < end) {
        const bb = skip[j] ? null : BULLET.exec(lines[j]);
        if (!bb || bb[1].length !== col || !sameMarker(bb[2], b[2])) break;
        const contentCol = col + bb[2].length + bb[3].length, e = itemEnd(j, contentCol, end), t = matchTask(bb[4]);
        if (t) {
          const node = mk('bullet', j, bb[1] + bb[2] + bb[3] + t.pre, t, e);
          node.list = list;
          list.items.push(node);
          if (hasTaskContent(j + 1, e)) diag(j, 'warning', `A bullet only refers to [${t.type}] ${t.title}; the properties and tasks nested under it are ignored (a task needs its own heading)`);
          hasTask = true;
        } else if (parseBody(j + 1, e, owner, false)) hasTask = true;
        list.end = j = e;
        let k = e;
        while (k < end && !lines[k].trim()) k++;
        const nb = k > e && k < end && !skip[k] ? BULLET.exec(lines[k]) : null;
        if (nb && nb[1].length === col && sameMarker(nb[2], b[2])) j = k;
      }

      if (list.items.length) {
        if (owner) owner.lists.push(list);
        else {
          pf.roots.push(...list.items);
          if (label !== null) diag(list.labelLine, 'warning', `Link list "${label}" has no owning task`);
        }
      }
      if (hasTask) {
        found = true;
        if (colon && head && owner) diag(p, 'warning', 'A heading cannot label a list; write "<Link type>:" as a paragraph line (this list is read as subtasks)');
        if (top && owner) owner.spans.push({ start: label === null ? i : p, end: j, labels: owner.lists.slice(before).map(l => l.label) });
      }
      i = j;
    }
    return found;
  }

  // Pass 2: sections. Task headings nest under the nearest task heading above them. A task's body runs over its
  // non-task sub-headings (sub-chapters) up to the next task heading or same-level heading; those are parsed with it.
  parseBody(0, heads[0]?.line ?? n, null, false);
  const stack: { level: number; node: Node | null }[] = [];
  let covered = 0;
  heads.forEach((h, k) => {
    while (stack.length && stack[stack.length - 1].level >= h.level) stack.pop();
    const owner = stack.findLast(s => s.node)?.node ?? null, t = matchTask(h.text);
    if (!t) {
      stack.push({ level: h.level, node: null });
      // From the heading line itself, so a heading misused as a list label is seen (and reported)
      if (h.line >= covered) parseBody(h.line, heads[k + 1]?.line ?? n, owner, false);
      return;
    }
    let o = k + 1;
    while (o < heads.length && heads[o].level > h.level && !matchTask(heads[o].text)) o++;
    const end = covered = heads[o]?.line ?? n;
    let b = k + 1;
    while (b < heads.length && heads[b].level > h.level) b++;
    const line = lines[h.line];
    const node = mk('heading', h.line, line.slice(0, line.indexOf(h.text)) + t.pre, t, heads[b]?.line ?? n);
    (owner ? owner.children : pf.roots).push(node);
    const body = readProps(node, end);
    node.own = { start: body, end };
    parseBody(body, end, node, true);
    stack.push({ level: h.level, node });
  });
  return pf;
}
