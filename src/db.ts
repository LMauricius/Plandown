/**
 * Task database: merges occurrences from all files into tasks (identity = `[Type] Title`),
 * collects links, validates them and the properties against the format, and rolls up time.
 * `Db` is plain JSON (sent to GUIs); `occ` keeps the parser nodes needed for editing.
 */
import { descText, type Diagnostic, type Node, type ParsedFile } from './markdown.js';
import { BUILTIN_PROPS, linkReverse, PARENT, SUBTASK, type Format, type PropSchema } from './format.js';

export interface Loc { file: string; line: number }

export interface Task {
  id: string;
  type: string;
  title: string;
  props: Record<string, unknown>;
  description: string;
  home: Loc;            // occurrence holding properties and description; edits go there
  occurrences: Loc[];
}

/** `from --type--> to`; Parent links are stored flipped as Subtask so hierarchy has one direction. */
export interface Edge { from: string; type: string; to: string; reverse: string | null; at: Loc; heading: boolean }

/** Own value plus every unique Subtask descendant's value. */
export interface Totals { effort: number; spent: number }

export interface Db {
  format: Format;
  files: string[];
  tasks: Record<string, Task>;
  edges: Edge[];
  totals: Record<string, Totals>;
  diagnostics: Diagnostic[];
}

export interface Occ { pf: ParsedFile; node: Node }

export const taskId = (type: string, title: string) => `[${type}] ${title}`;

/** Numeric property or 0; rollups must not break on missing or malformed values. */
const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? v : 0;

/** Schema check for one property value. */
function valid(s: PropSchema, v: unknown): boolean {
  if (s.enum && !s.enum.includes(v as string | number)) return false;
  switch (s.type) {
    case 'string': return typeof v === 'string';
    case 'number': return typeof v === 'number' && Number.isFinite(v);
    case 'boolean': return typeof v === 'boolean';
    case 'date': return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !isNaN(Date.parse(v));
    case 'datetime': return typeof v === 'string' && !isNaN(Date.parse(v));
  }
}

export function buildDb(format: Format, formatDiagnostics: Diagnostic[], files: ParsedFile[]): { db: Db; occ: Map<string, Occ[]> } {
  const diagnostics = [...formatDiagnostics];
  const diag = (at: Loc, severity: Diagnostic['severity'], message: string) => diagnostics.push({ ...at, severity, message });
  const occ = new Map<string, Occ[]>();
  const edges: Edge[] = [], seen = new Set<string>();
  const id = (n: Node) => taskId(n.type, n.title);

  // Links: declared by lists and by heading nesting; the same relation stated from both sides is kept once
  function addEdge(pf: ParsedFile, from: Node, type: string, to: Node, at: Node, heading: boolean) {
    const loc = { file: pf.file, line: at.line };
    let a = id(from), b = id(to);
    if (a === b) return diag(loc, 'error', `${a} cannot link to itself`);
    if (type !== SUBTASK && type !== PARENT) {
      const links = format.types[from.type]?.links;
      if (links && !links[type]) diag(loc, 'error', `[${from.type}] has no link type "${type}"`);
      else if (links && !(to.type in links[type])) diag(loc, 'error', `Link "${type}" of [${from.type}] cannot target [${to.type}]`);
    }
    let reverse = linkReverse(format, from.type, type, to.type);
    if (type === PARENT) [a, b, type, reverse] = [b, a, SUBTASK, PARENT];
    if (seen.has(`${a}\0${type}\0${b}`) || (reverse && seen.has(`${b}\0${reverse}\0${a}`))) return;
    seen.add(`${a}\0${type}\0${b}`);
    edges.push({ from: a, type, to: b, reverse, at: loc, heading });
  }

  for (const pf of files) {
    diagnostics.push(...pf.diagnostics);
    for (const node of pf.nodes) {
      const list = occ.get(id(node)) ?? occ.set(id(node), []).get(id(node))!;
      list.push({ pf, node });
      if (!format.types[node.type]) diag({ file: pf.file, line: node.line }, 'error', `Unknown task type [${node.type}]`);
      for (const c of node.children) addEdge(pf, node, SUBTASK, c, c, true);
      for (const l of node.lists) for (const item of l.items) addEdge(pf, node, l.label ?? SUBTASK, item, item, false);
    }
  }

  // Tasks: the first occurrence with content is home; its properties are validated against the schema
  const tasks: Record<string, Task> = {};
  for (const [tid, list] of occ) {
    const home = list.find(o => o.node.props || descText(o.pf, o.node)) ?? list.find(o => o.node.kind === 'heading') ?? list[0];
    const loc = (o: Occ): Loc => ({ file: o.pf.file, line: o.node.line });
    for (const o of list) if (o !== home && o.node.props) diag(loc(o), 'warning', `Properties of ${tid} are already defined at ${home.pf.file}:${home.node.line + 1}; these are ignored`);
    const props = home.node.props?.data ?? {}, type = format.types[home.node.type];
    const schema = { ...BUILTIN_PROPS, ...type?.props };
    for (const [k, v] of Object.entries(props)) {
      const at = { file: home.pf.file, line: home.node.props!.start };
      if (!schema[k]) { if (type) diag(at, 'warning', `[${type.name}] does not declare property "${k}"`); }
      else if (!valid(schema[k], v)) diag(at, 'error', `Property "${k}" of ${tid} must be ${schema[k].enum ? `one of ${schema[k].enum!.join(', ')}` : `a ${schema[k].type}`}`);
    }
    tasks[tid] = { id: tid, type: home.node.type, title: home.node.title, props, description: descText(home.pf, home.node), home: loc(home), occurrences: list.map(loc) };
  }

  // Rollup: DFS per task over Subtask links with a visited set (shared subtasks and cycles count once)
  const kids = new Map<string, string[]>();
  for (const e of edges) if (e.type === SUBTASK) kids.set(e.from, [...kids.get(e.from) ?? [], e.to]);
  const totals: Record<string, Totals> = {};
  for (const tid in tasks) {
    const seenT = new Set<string>(), stack = [tid], t: Totals = { effort: 0, spent: 0 };
    while (stack.length) {
      const v = stack.pop()!;
      if (seenT.has(v)) continue;
      seenT.add(v);
      t.effort += num(tasks[v].props.effort);
      t.spent += num(tasks[v].props.spent);
      stack.push(...kids.get(v) ?? []);
    }
    totals[tid] = t;
  }

  return { db: { format, files: files.map(f => f.file), tasks, edges, totals, diagnostics }, occ };
}
