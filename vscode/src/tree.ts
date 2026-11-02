/**
 * Navigation tree in the activity bar, built from the library's `db.tree` (the same structure the GUI sidebar shows):
 * folders and files merged by stem, files merged with their single same-named task, top-level tasks and their subtasks.
 * Children are produced lazily, as VSCode asks for them.
 */
import * as vscode from 'vscode';
import { basename } from 'node:path';
import type { TreeNode } from 'plandown' with { 'resolution-mode': 'import' };
import type { Apply, Root } from './extension.js';

const SUBTASK = 'Subtask';
const hours = (v: number) => String(Math.round(v * 100) / 100);
const TYPE_SCHEME = 'plandown-type';
/** Chart theme colors by hue: the nearest one stands in for a type's `$meta.color`, as decorations only take theme color ids. */
const CHART: [number, string][] = [[0, 'red'], [30, 'orange'], [55, 'yellow'], [120, 'green'], [220, 'blue'], [280, 'purple']];
/** Common CSS color names (the extension host has no CSS parser). */
const NAMED: Record<string, string> = {
  red: '#f00', orange: '#ffa500', yellow: '#ff0', gold: '#ffd700', green: '#008000', lime: '#0f0', teal: '#008080', cyan: '#0ff', aqua: '#0ff',
  blue: '#00f', navy: '#000080', purple: '#800080', violet: '#ee82ee', magenta: '#f0f', fuchsia: '#f0f', pink: '#ffc0cb', brown: '#a52a2a',
  gray: '#808080', grey: '#808080', black: '#000', white: '#fff',
};

/**
 * Theme color id for a CSS color: the nearest chart hue, `charts.foreground` for grays, `focusBorder` (the accent, as
 * the GUI falls back to) when there is no color.
 * shortcut: parses hex, rgb()/hsl() with plain numbers and the NAMED colors only; others fall back to the accent. Extend when formats need them.
 */
function chartColor(css = ''): string {
  const c = NAMED[css.trim().toLowerCase()] ?? css.trim().toLowerCase();
  const hsl = /^hsla?\(\s*(-?[\d.]+)(?:deg)?[\s,]+([\d.]+)%/.exec(c);
  const hex = /^#([\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/.exec(c);
  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(c);
  let h: number, s: number;
  if (hsl) [h, s] = [+hsl[1], +hsl[2] / 100];
  else if (hex || rgb) {
    const [r, g, b] = hex ? (hex[1].length < 6 ? [...hex[1]].map(x => x + x).join('') : hex[1]).match(/../g)!.map(x => parseInt(x, 16)) : rgb!.slice(1).map(Number);
    const max = Math.max(r, g, b), d = max - Math.min(r, g, b);
    s = d / 255;   // chroma: enough to tell grays apart
    h = !d ? 0 : max === r ? 60 * ((g - b) / d) : max === g ? 60 * ((b - r) / d + 2) : 60 * ((r - g) / d + 4);
  } else return 'focusBorder';
  if (s < .15) return 'charts.foreground';
  const dist = (a: number) => { const x = Math.abs((((h - a) % 360) + 360) % 360); return Math.min(x, 360 - x); };
  return 'charts.' + CHART.reduce((m, x) => dist(x[0]) < dist(m[0]) ? x : m)[1];
}

/**
 * Type marker of task rows: a tree label is plain text, so the type shows as a file decoration (colored label plus a
 * 1-2 character badge on the right, which stays visible while the label is shortened). The row's `resourceUri`
 * carries the type and its theme color, so this provider is stateless and a color change makes a new URI.
 */
export const typeDecorations: vscode.FileDecorationProvider = {
  provideFileDecoration(uri) {
    if (uri.scheme !== TYPE_SCHEME) return;
    // VSCode rejects badges over 2 UTF-16 units: two characters, or one if either is astral (emoji)
    const type = uri.path.slice(1), cps = [...type], badge = cps.slice(0, 2).join('');
    return new vscode.FileDecoration(badge.length <= 2 ? badge : cps[0], type, new vscode.ThemeColor(uri.query));
  },
};

/**
 * Tree element. `node`: a folder and/or file row (or a task merged into it). `task`: a task row under node path `near`
 * (new tasks and groups created from it go there, as from the GUI's picked row). `up` holds the ancestors' ids and
 * `leaf` stops expansion: a task met again below itself (a Subtask cycle) is listed but not expanded, like the GUI's
 * `walk`, and filter matches are a flat list. With more than one root, roots are the top level.
 */
export type Item =
  | { kind: 'root'; root: Root }
  | { kind: 'node'; root: Root; node: TreeNode }
  | { kind: 'task'; root: Root; id: string; near: string; up: string[]; leaf: boolean };

export class TaskTree implements vscode.TreeDataProvider<Item> {
  /** Filter text; non-empty shows a flat list of tasks whose id or description contains it (case-insensitive), as the GUI does. */
  filter = '';
  private change = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.change.event;

  constructor(private roots: () => Root[], private apply: Apply) {}

  /** Rebuilds the whole tree (after any reload; it is cheap). */
  refresh(): void { this.change.fire(); }

  getChildren(item?: Item): Item[] {
    const task = (root: Root, id: string, near: string, up: string[]): Item => ({ kind: 'task', root, id, near, up, leaf: up.includes(id) });
    const subtasks = (root: Root, id: string, near: string, up: string[]) =>
      root.pd.db.edges.filter(e => e.type === SUBTASK && e.from === id).map(e => task(root, e.to, near, up));
    const nodes = (root: Root, list: TreeNode[]) => list.map((node): Item => ({ kind: 'node', root, node }));

    if (!item) {
      const roots = this.roots(), q = this.filter.toLowerCase();
      if (q) return roots.flatMap(root => Object.values(root.pd.db.tasks)
        .filter(t => `${t.id}\n${t.body.filter(x => typeof x === 'string').join('\n')}`.toLowerCase().includes(q))
        .map((t): Item => ({ kind: 'task', root, id: t.id, near: t.home.file.slice(0, -3), up: [], leaf: true })));
      return roots.length === 1 ? nodes(roots[0], roots[0].pd.db.tree) : roots.map(root => ({ kind: 'root', root }));
    }
    const { root } = item;
    if (item.kind === 'root') return nodes(root, root.pd.db.tree);
    if (item.kind === 'task') return item.leaf ? [] : subtasks(root, item.id, item.near, [...item.up, item.id]);
    const n = item.node;
    return [...n.task ? subtasks(root, n.task, n.path, [n.task]) : n.tasks.map(id => task(root, id, n.path, [])), ...nodes(root, n.kids)];
  }

  /**
   * Root: folder name. Node: folder/file icon and base name. Task (and merged node): title, type and `spent/effort h`
   * as description, Done checkbox, click opens its tab. Task rows (and merged nodes) carry
   * their type marker (see `typeDecorations`). Ids follow the path from the root, so expansion survives refreshes.
   */
  getTreeItem(item: Item): vscode.TreeItem {
    const { root } = item, db = root.pd.db, none = vscode.TreeItemCollapsibleState.None, closed = vscode.TreeItemCollapsibleState.Collapsed;
    if (item.kind === 'root') {
      const ti = new vscode.TreeItem(basename(root.uri.fsPath), vscode.TreeItemCollapsibleState.Expanded);
      return Object.assign(ti, { id: root.uri.fsPath, iconPath: new vscode.ThemeIcon('database'), tooltip: root.uri.fsPath, contextValue: 'root' });
    }
    const id = item.kind === 'node' ? item.node.task : item.id;
    const hasSubtasks = !!id && db.edges.some(e => e.type === SUBTASK && e.from === id);
    let ti: vscode.TreeItem;
    if (item.kind === 'node') {
      const n = item.node;
      ti = new vscode.TreeItem(basename(n.path), n.kids.length || (n.task ? hasSubtasks : n.tasks.length) ? closed : none);
      Object.assign(ti, { id: `${root.uri.fsPath}\0${n.path}`, contextValue: n.task ? 'nodeTask' : 'node', iconPath: new vscode.ThemeIcon(n.folder ? 'folder' : 'file'), tooltip: n.file ?? n.path + '/' });
    } else {
      ti = new vscode.TreeItem('', !item.leaf && hasSubtasks ? closed : none);
      Object.assign(ti, { id: `${root.uri.fsPath}\0${item.near}\0${[...item.up, id].join('\0')}`, contextValue: 'task' });
    }
    const t = id ? db.tasks[id] : undefined;
    if (!t) return ti;
    const tot = db.totals[t.id];
    ti.label = t.title;
    ti.description = tot.effort || tot.spent ? `${t.type} · ${hours(tot.spent)}/${hours(tot.effort)} h` : t.type;
    ti.tooltip = `${t.id}\n${t.home.file}`;
    ti.checkboxState = t.props.done === true ? vscode.TreeItemCheckboxState.Checked : vscode.TreeItemCheckboxState.Unchecked;
    ti.command = { command: 'plandown.open', title: 'Open', arguments: [root, t.id] };
    ti.resourceUri = vscode.Uri.from({ scheme: TYPE_SCHEME, path: '/' + t.type, query: chartColor(db.format.types[t.type]?.color) });
    return ti;
  }

  /** Done checkboxes: one update per changed task, as the GUI's row checkbox. */
  async checked(e: vscode.TreeCheckboxChangeEvent<Item>): Promise<void> {
    for (const [item, state] of e.items) {
      const id = item.kind === 'node' ? item.node.task : item.kind === 'task' ? item.id : null, t = id ? item.root.pd.db.tasks[id] : undefined;
      if (t) await this.apply(item.root, { op: 'update', id: t.id, props: { ...t.props, done: state === vscode.TreeItemCheckboxState.Checked || undefined } })
        .catch(err => vscode.window.showErrorMessage((err as Error).message));
    }
  }
}
