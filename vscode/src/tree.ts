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
   * as description, Done checkbox, click opens its tab. Ids follow the path from the root, so expansion survives refreshes.
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
      Object.assign(ti, { id: `${root.uri.fsPath}\0${n.path}`, contextValue: 'node', iconPath: new vscode.ThemeIcon(n.folder ? 'folder' : 'file'), tooltip: n.file ?? n.path + '/' });
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
