/**
 * Markdown structure parser. Finds `[Type] Title` headings and bullets, their YAML property blocks,
 * descriptions and (labeled) task lists, and records line ranges so edits can rewrite files surgically.
 * Knows nothing about task types; `format.ts` and `db.ts` interpret the result.
 */
import { parse as parseYaml } from 'yaml';

/** Line range, `end` exclusive. An empty range is an insertion point. */
export interface Range { start: number; end: number }

export interface Props extends Range { raw: string; data: Record<string, unknown> }

/** A run of contiguous bullets owned by a task; `label` is the `<Link type>:` line above it (null: Subtask). */
export interface List {
  label: string | null;
  labelLine: number;   // -1 when unlabeled
  bullet: string;      // marker of the first item (`  - `), reused when appending
  items: Node[];       // task items only
  end: number;         // line after the last bullet item (append position)
}

/** One occurrence of a task in one file. The same task may occur in several places. */
export interface Node {
  type: string;
  title: string;
  line: number;              // title line
  kind: 'heading' | 'bullet';
  prefix: string;            // title line text before `[Type]` (`## `, `  - [x] `)
  indent: string;            // indentation of content lines ('' for headings)
  props?: Props;             // YAML block including both `---` fences
  desc: Range;               // description: content up to the first task list
  own: Range;                // content excluding sub-headings: where new lists are appended
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
  diagnostics: Diagnostic[];
}

const HEADING = /^(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
const BULLET = /^([ \t]*)([-*+]|\d{1,9}[.)])([ \t]+)(.*)$/;
const FENCE = /^[ \t]*(```|~~~)/;
// optional checkbox, then `[Type] Title`; `](` (a link) does not match because whitespace must follow `]`
const TASK = /^(\[[ xX]\][ \t]+)?\[([^\[\]\r\n]+)\][ \t]+(\S.*?)[ \t]*$/;

/** Leading whitespace width; content columns and YAML de-indentation depend on it. Tabs count as 1 (shortcut: mixed tabs/spaces indentation is not normalized). */
export const indentOf = (line: string) => line.length - line.trimStart().length;

/** `[Type] Title` matcher shared by headings and bullets; rejects bare checkboxes like `[x] Done`. */
export function matchTask(text: string): { pre: string; type: string; title: string } | null {
  const m = TASK.exec(text);
  if (!m || /^\s*[xX]?\s*$/.test(m[2])) return null;
  return { pre: m[1] ?? '', type: m[2].trim(), title: m[3] };
}

/** Description text of an occurrence, de-indented and trimmed of surrounding blank lines. */
export function descText(pf: ParsedFile, node: Node): string {
  return pf.lines.slice(node.desc.start, node.desc.end)
    .map(l => l.slice(Math.min(node.indent.length, indentOf(l))))
    .join('\n').replace(/^(?:[ \t]*\n)+/, '').trimEnd();
}

export function parseMarkdown(file: string, text: string): ParsedFile {
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  const pf: ParsedFile = { file, text, eol: text.includes('\r\n') ? '\r\n' : '\n', lines, roots: [], nodes: [], diagnostics: [] };
  const n = lines.length;
  const diag = (line: number, severity: Diagnostic['severity'], message: string) => pf.diagnostics.push({ file, line, severity, message });
  const isTaskHeading = (i: number) => { const h = HEADING.exec(lines[i]); return !!h && !!matchTask(h[2]); };

  // Pass 1: headings. Fenced code and heading property blocks are marked `skip` (a YAML `# comment` is not a heading).
  const skip = new Array<boolean>(n).fill(false);
  const heads: { line: number; level: number; text: string }[] = [];
  let fence: string | null = null;
  for (let i = 0; i < n; i++) {
    const f = FENCE.exec(lines[i]);
    if (fence) { skip[i] = true; if (f?.[1] === fence) fence = null; continue; }
    if (f) { fence = f[1]; skip[i] = true; continue; }
    const h = HEADING.exec(lines[i]);
    if (!h) continue;
    heads.push({ line: i, level: h[1].length, text: h[2] });
    if (matchTask(h[2]) && lines[i + 1]?.trim() === '---') {
      const close = findClose(i + 2, n);
      if (close >= 0) { skip.fill(true, i + 1, close + 1); i = close; }
    }
  }

  /** Closing `---` of a property block; stops at the next task heading so an unclosed block cannot swallow tasks. */
  function findClose(from: number, end: number): number {
    for (let k = from; k < end; k++) {
      if (lines[k].trim() === '---') return k;
      if (isTaskHeading(k)) return -1;
    }
    return -1;
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

  /** Reads the YAML block right after a title line; returns the first content line. */
  function readProps(node: Node, end: number): number {
    const o = node.line + 1;
    if (o >= end || lines[o].trim() !== '---') return o;
    const c = findClose(o + 1, end);
    if (c < 0) { diag(o, 'error', 'Unclosed property block (missing closing "---")'); return o; }
    const raw = lines.slice(o + 1, c).map(l => l.slice(Math.min(node.indent.length, indentOf(l)))).join('\n');
    let data: Record<string, unknown> = {};
    try {
      const v = parseYaml(raw);
      if (v && typeof v === 'object' && !Array.isArray(v)) data = v;
      else if (v != null) diag(o, 'error', 'Property block must be a YAML mapping');
    } catch (e) {
      diag(o, 'error', `Invalid YAML: ${(e as Error).message.split('\n')[0]}`);
    }
    node.props = { start: o, end: c + 1, raw, data };
    return c + 1;
  }

  function mk(kind: Node['kind'], line: number, prefix: string, indent: string, t: { type: string; title: string }, blockEnd: number): Node {
    const r = { start: line + 1, end: line + 1 };
    const node: Node = { type: t.type, title: t.title, line, kind, prefix, indent, desc: r, own: r, block: { start: line, end: blockEnd }, lists: [], children: [], list: null };
    pf.nodes.push(node);
    return node;
  }

  /**
   * Scans [start, end) for lists. Task bullets become occurrences in `owner.lists` (or roots).
   * With `desc`, the owner's description ends where the first list containing a task starts.
   * Returns whether any task was found (so enclosing non-task bullets also end the description).
   */
  function parseBody(start: number, end: number, owner: Node | null, desc: boolean): boolean {
    let found = false, descEnd = end, i = start;
    while (i < end) {
      const b = skip[i] ? null : BULLET.exec(lines[i]);
      if (!b) { i++; continue; }

      // Label: the line immediately above, if it is `<Link type>:` text; otherwise Subtask
      const col = b[1].length, prev = i > start ? lines[i - 1] : '';
      const label = prev.trim().endsWith(':') && !BULLET.test(prev) && !skip[i - 1] ? prev.trim().slice(0, -1).trim() : null;
      const list: List = { label, labelLine: label === null ? -1 : i - 1, bullet: b[1] + b[2] + ' ', items: [], end: i };
      let hasTask = false, j = i;

      // Items: contiguous bullets at the same column (a blank line ends the list)
      while (j < end) {
        const bb = skip[j] ? null : BULLET.exec(lines[j]);
        if (!bb || bb[1].length !== col) break;
        const contentCol = col + bb[2].length + bb[3].length, e = itemEnd(j, contentCol, end), t = matchTask(bb[4]);
        if (t) {
          const node = mk('bullet', j, bb[1] + bb[2] + bb[3] + t.pre, ' '.repeat(contentCol), t, e);
          node.list = list;
          list.items.push(node);
          const body = readProps(node, e);
          node.desc = node.own = { start: body, end: e };
          parseBody(body, e, node, true);
          hasTask = true;
        } else if (parseBody(j + 1, e, owner, false)) hasTask = true;
        list.end = j = e;
      }

      if (hasTask) { found = true; if (desc && descEnd === end) descEnd = label === null ? i : i - 1; }
      if (list.items.length) {
        if (owner) owner.lists.push(list);
        else {
          pf.roots.push(...list.items);
          if (label !== null) diag(list.labelLine, 'warning', `Link list "${label}" has no owning task`);
        }
      }
      i = j;
    }
    if (desc && owner) owner.desc = { start, end: descEnd };
    return found;
  }

  // Pass 2: sections. Task headings nest under the nearest task heading above them.
  parseBody(0, heads[0]?.line ?? n, null, false);
  const stack: { level: number; node: Node | null }[] = [];
  heads.forEach((h, k) => {
    while (stack.length && stack[stack.length - 1].level >= h.level) stack.pop();
    const owner = stack.findLast(s => s.node)?.node ?? null, end = heads[k + 1]?.line ?? n, t = matchTask(h.text);
    if (!t) {
      stack.push({ level: h.level, node: null });
      parseBody(h.line + 1, end, owner, false);
      return;
    }
    let b = k + 1;
    while (b < heads.length && heads[b].level > h.level) b++;
    const line = lines[h.line];
    const node = mk('heading', h.line, line.slice(0, line.indexOf(h.text)) + t.pre, '', t, heads[b]?.line ?? n);
    (owner ? owner.children : pf.roots).push(node);
    const body = readProps(node, end);
    node.own = { start: body, end };
    node.desc = { start: body, end };
    parseBody(body, end, node, true);
    stack.push({ level: h.level, node });
  });
  return pf;
}
