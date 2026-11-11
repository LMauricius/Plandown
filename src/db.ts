/**
 * Task database: merges occurrences from all files into tasks (identity = `[Type] Title`),
 * collects links, validates them and the properties against the format, and rolls up time.
 * `Db` is plain JSON (sent to GUIs); `occ` keeps the parser nodes needed for editing.
 */
import { bodyTexts, type Diagnostic, type Node, type ParsedFile } from './markdown.js';
import { BUILTIN_PROPS, linkReverse, PARENT, SUBTASK, type Format, type PropSchema } from './format.js';
import { buildTree, slug, type TreeNode } from './tree.js';

export interface Loc { file: string; line: number }

/** A description text, or a task-list block with the link type of each list in it (Subtask for unlabeled lists). */
export type BodyPart = string | { links: string[] };

export interface Task {
  id: string;
  type: string;
  title: string;
  props: Record<string, unknown>;
  body: BodyPart[];     // description texts alternating with the task-list blocks between them; starts and ends with text
  anchor: string;       // ID for URLs: the heading anchor Markdown viewers give `[Type] Title`, unique across tasks
  home: Loc;            // occurrence holding properties and description; edits go there
  occurrences: Loc[];
}

/**
 * `from --type--> to`; Parent links are stored flipped as Subtask so hierarchy has one direction. `at` is the declaring
 * list entry (in `from`); `back` is `to`'s own declaration of the same relation (as `reverse`), if it states it too.
 */
export interface Edge { from: string; type: string; to: string; reverse: string | null; at: Loc; back: Loc | null; heading: boolean }

/** Own value plus every unique Subtask descendant's value. */
export interface Totals { effort: number; spent: number }

export interface Db {
  format: Format;
  files: string[];       // task files, `/`-separated paths relative to the folder
  folders: string[];     // every subfolder, including empty ones (groups)
  tree: TreeNode[];
  tasks: Record<string, Task>;
  edges: Edge[];
  totals: Record<string, Totals>;
  diagnostics: Diagnostic[];
}

export interface Occ { pf: ParsedFile; node: Node }

export const taskId = (type: string, title: string) => `[${type}] ${title}`;

/**
 * GitHub-style heading anchor (`[Task] Fix login` → `task-fix-login`), so a task's URL matches its section link.
 * Collisions get `-1`, `-2`, … in load order, as GitHub does for repeated headings.
 */
function anchor(text: string, taken: Set<string>): string {
  const base = slug(text);
  let a = base;
  for (let i = 1; taken.has(a); i++) a = `${base}-${i}`;
  taken.add(a);
  return a;
}

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

export function buildDb(format: Format, formatDiagnostics: Diagnostic[], files: ParsedFile[], folders: string[] = []): { db: Db; occ: Map<string, Occ[]> } {
  const diagnostics = [...formatDiagnostics];
  const diag = (at: Loc, severity: Diagnostic['severity'], message: string) => diagnostics.push({ ...at, severity, message });
  const occ = new Map<string, Occ[]>();
  const edges: Edge[] = [], seen = new Map<string, Edge>();   // `from\0type\0to` → edge
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
    if (seen.has(`${a}\0${type}\0${b}`)) return;
    // Stated from the other side too: kept once, remembering the other declaration (the first one) for removal
    const twin = reverse && seen.get(`${b}\0${reverse}\0${a}`);
    if (twin) { twin.back ??= loc; return; }
    const e: Edge = { from: a, type, to: b, reverse, at: loc, back: null, heading };
    seen.set(`${a}\0${type}\0${b}`, e);
    edges.push(e);
  }

  for (const pf of files) {
    diagnostics.push(...pf.diagnostics);
    for (const node of pf.nodes) {
      (occ.get(id(node)) ?? occ.set(id(node), []).get(id(node))!).push({ pf, node });
      if (!format.types[node.type]) diag({ file: pf.file, line: node.line }, 'error', `Unknown task type [${node.type}]`);
    }
  }
  // A task exists only where it has a heading; bullets merely refer to tasks
  for (const [tid, list] of occ) if (!list.some(o => o.node.kind === 'heading')) {
    for (const o of list) diag({ file: o.pf.file, line: o.node.line }, 'error', `No task ${tid}: a task needs its own heading`);
    occ.delete(tid);
  }
  for (const pf of files) for (const node of pf.nodes) {
    for (const c of node.children) addEdge(pf, node, SUBTASK, c, c, true);
    for (const l of node.lists) for (const item of l.items) if (occ.has(id(item))) addEdge(pf, node, l.label ?? SUBTASK, item, item, false);
  }

  // Tasks: the first heading with content is home (bullets have none), else the first heading; its properties are validated against the schema
  const tasks: Record<string, Task> = {}, anchors = new Set<string>();
  for (const [tid, list] of occ) {
    const home = list.find(o => o.node.props || bodyTexts(o.pf, o.node).some(Boolean)) ?? list.find(o => o.node.kind === 'heading')!;
    const loc = (o: Occ): Loc => ({ file: o.pf.file, line: o.node.line });
    for (const o of list) if (o !== home && o.node.props) diag(loc(o), 'warning', `Properties of ${tid} are already defined at ${home.pf.file}:${home.node.line + 1}; these are ignored`);
    const props = home.node.props?.data ?? {}, type = format.types[home.node.type];
    const schema = { ...BUILTIN_PROPS, ...type?.props };
    for (const [k, v] of Object.entries(props)) {
      const at = { file: home.pf.file, line: home.node.props!.start };
      if (!schema[k]) { if (type) diag(at, 'warning', `[${type.name}] does not declare property "${k}"`); }
      else if (!valid(schema[k], v)) diag(at, 'error', `Property "${k}" of ${tid} must be ${schema[k].enum ? `one of ${schema[k].enum!.join(', ')}` : `a ${schema[k].type}`}`);
    }
    tasks[tid] = { id: tid, type: home.node.type, title: home.node.title, props, body: bodyTexts(home.pf, home.node).flatMap((t, i) => {
      const s = home.node.spans[i];
      return s ? [t, { links: s.labels.map(l => l ?? SUBTASK) }] : [t];
    }), anchor: anchor(tid, anchors), home: loc(home), occurrences: list.map(loc) };
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

  const names = files.map(f => f.file);
  return { db: { format, files: names, folders, tree: buildTree(names, folders, tasks, edges), tasks, edges, totals, diagnostics }, occ };
}
