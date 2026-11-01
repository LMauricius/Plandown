/**
 * Plandown for VSCode: finds databases in the workspace, lists them in the activity bar tree, opens tasks, the graph and
 * the time view in webview tabs running the standalone GUI, and reports diagnostics in the Problems view.
 * The extension host loads CommonJS while the library is ESM, so the library is loaded with a dynamic `import()`.
 */
import * as vscode from 'vscode';
import { dirname, join, relative, sep } from 'node:path';
import type { Op, Plandown } from 'plandown' with { 'resolution-mode': 'import' };
import { TaskTree, type Item } from './tree.js';
import { Panels } from './panels.js';

/** One loaded database: the folder holding a `plandown-format.md`. */
export interface Root { uri: vscode.Uri; pd: Plandown; diags: vscode.DiagnosticCollection; unwatch(): void }

/** Applies an operation to a root and refreshes every view of it; throws as `Plandown.apply` does. */
export type Apply = (root: Root, op: Op) => Promise<string | undefined>;

// ---- Utilities ----

/**
 * Database folders of the workspace: every `plandown-format.md` at most `plandown.searchDepth` folders below a workspace
 * folder. `findFiles` honors `files.exclude`; hidden folders are skipped as the library skips them. A root inside
 * another root is dropped, since the library reads only its root's format file (nested ones are reserved for sub-formats).
 */
async function findRoots(): Promise<vscode.Uri[]> {
  const depth = vscode.workspace.getConfiguration('plandown').get('searchDepth', 3);
  const dirs = (await vscode.workspace.findFiles('**/plandown-format.md', '**/node_modules/**')).flatMap(u => {
    const ws = vscode.workspace.getWorkspaceFolder(u), parts = ws ? relative(ws.uri.fsPath, u.fsPath).split(sep) : [];
    return parts.length && parts.length - 1 <= depth && !parts.some(p => p.startsWith('.')) ? [dirname(u.fsPath)] : [];
  });
  return dirs.filter(d => !dirs.some(o => d.startsWith(o + sep))).sort().map(d => vscode.Uri.file(d));
}

/** Mirrors `db.diagnostics` of one root into the Problems view (whole lines). */
function report(root: Root): void {
  const byFile = new Map<string, vscode.Diagnostic[]>();
  for (const d of root.pd.db.diagnostics) {
    const sev = d.severity === 'error' ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning;
    byFile.set(d.file, [...byFile.get(d.file) ?? [], new vscode.Diagnostic(new vscode.Range(d.line, 0, d.line, Number.MAX_SAFE_INTEGER), d.message, sev)]);
  }
  root.diags.clear();
  root.diags.set([...byFile].map(([f, list]) => [vscode.Uri.joinPath(root.uri, f), list]));
}

/** Elapsed time as `hh:mm:ss`, the GUI's timer format. */
const clock = (ms: number) => { const t = Math.floor(ms / 1000); return [t / 3600, (t / 60) % 60, t % 60].map(x => String(Math.floor(x)).padStart(2, '0')).join(':'); };

const isItem = (a: unknown): a is Item => typeof a === 'object' && a !== null && 'kind' in a && 'root' in a;

// ---- Activation ----

export async function activate(ctx: vscode.ExtensionContext) {
  const { Plandown } = await import('plandown');
  let roots: Root[] = [], loading = Promise.resolve();

  // ---- Databases ----

  const changed = (r: Root) => { report(r); tree.refresh(); panels.changed(r); showTimers(); };
  const apply: Apply = async (r, op) => { try { return await r.pd.apply(op); } finally { changed(r); } };
  const close = (r: Root) => { r.unwatch(); r.diags.dispose(); panels.drop(r); };

  /** Rescans the workspace: opens new roots, closes vanished ones. Rescans run one at a time. */
  // shortcut: a plandown-format.md created later is found only on a rescan trigger; add a file watcher if that matters
  const load = () => loading = loading.then(async () => {
    const found = await findRoots(), keep = (r: Root) => found.some(u => u.fsPath === r.uri.fsPath);
    roots.filter(r => !keep(r)).forEach(close);
    roots = roots.filter(keep);
    for (const uri of found) {
      if (roots.some(r => r.uri.fsPath === uri.fsPath)) continue;
      try {
        const r: Root = { uri, pd: await Plandown.open(uri.fsPath), diags: vscode.languages.createDiagnosticCollection('plandown'), unwatch: () => {} };
        r.unwatch = r.pd.watch(() => changed(r));
        roots.push(r);
        report(r);
      } catch (e) {
        vscode.window.showErrorMessage(`Plandown: cannot load ${uri.fsPath}: ${(e as Error).message}`);
      }
    }
    roots.sort((a, b) => a.uri.fsPath < b.uri.fsPath ? -1 : 1);
    tree.refresh();
    showTimers();
  });

  // ---- Status bar: running timers ----

  /** One item per running timer (`started` set) of every root, as the GUI header lists them; click opens the task. */
  let timers: { item: vscode.StatusBarItem; started: number; title: string }[] = [];
  const tick = () => timers.forEach(t => t.item.text = `$(clock) ${t.title} ${clock(Date.now() - t.started)}`);
  const showTimers = () => {
    timers.forEach(t => t.item.dispose());
    timers = roots.flatMap(r => Object.values(r.pd.db.tasks).flatMap(t => {
      const started = Date.parse(String(t.props.started ?? ''));
      if (isNaN(started)) return [];
      const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
      item.tooltip = `Running timer: ${t.id}`;
      item.command = { title: 'Open task', command: 'plandown.open', arguments: [r, t.id] };
      item.show();
      return [{ item, started, title: t.title.length > 30 ? t.title.slice(0, 29) + '…' : t.title }];
    }));
    tick();
  };
  const ticker = setInterval(tick, 1000);

  // ---- Views ----

  const tree = new TaskTree(() => roots, apply);
  const view = vscode.window.createTreeView('plandown.tree', { treeDataProvider: tree, manageCheckboxStateManually: true });   // a parent's Done never ticks its subtasks
  // `require.resolve` follows the `file:..` symlink to the library, whose `dist/gui` the webviews load
  const panels = new Panels(vscode.Uri.file(join(dirname(require.resolve('plandown')), 'gui')), () => loading.then(() => roots), apply);
  ctx.subscriptions.push(view, view.onDidChangeCheckboxState(e => tree.checked(e)),
    vscode.window.registerCustomEditorProvider('plandown.file', panels, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.window.registerCustomEditorProvider('plandown.task', panels, { webviewOptions: { retainContextWhenHidden: true } }),    vscode.window.registerWebviewPanelSerializer('plandown.view', panels),
    vscode.workspace.onDidChangeWorkspaceFolders(load),
    vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('plandown.searchDepth')) load(); }),
    { dispose: () => { roots.forEach(close); clearInterval(ticker); timers.forEach(t => t.item.dispose()); } });

  // ---- Commands ----

  /** Runs an operation, showing failures (stale file, invalid input) as the GUI toasts them. */
  const run = (r: Root, op: Op) => apply(r, op).catch(e => { vscode.window.showErrorMessage((e as Error).message); return undefined; });

  /** Root for a command: the focused Plandown tab's, else the only one, else a quick pick. */
  const pickRoot = async (): Promise<Root | undefined> => {
    if (!roots.length) { vscode.window.showInformationMessage('Plandown: no plandown-format.md found in the workspace.'); return; }
    return panels.active()?.root ?? (roots.length === 1 ? roots[0]
      : (await vscode.window.showQuickPick(roots.map(r => ({ label: vscode.workspace.asRelativePath(r.uri), r })), { placeHolder: 'Plandown database' }))?.r);
  };

  /** Where new items go: next to the tree item the command came from or the selected one (as the GUI's picked row), else a root's top. */
  const where = async (arg: unknown): Promise<{ root: Root; near: string } | undefined> => {
    const item = isItem(arg) ? arg : view.selection[0];
    if (item) return { root: item.root, near: item.kind === 'node' ? item.node.path : item.kind === 'task' ? item.near : '' };
    const root = await pickRoot();
    return root && { root, near: '' };
  };

  const filter = (text: string) => {
    tree.filter = text;
    view.description = text ? `Filter: ${text}` : undefined;
    vscode.commands.executeCommand('setContext', 'plandown.filtered', !!text);
    tree.refresh();
  };

  const reg = (name: string, f: (...a: any[]) => unknown) => ctx.subscriptions.push(vscode.commands.registerCommand(name, f));
  reg('plandown.create', async (arg?: unknown) => {
    const at = await where(arg);
    const type = at && await vscode.window.showQuickPick(Object.keys(at.root.pd.db.format.types), { placeHolder: 'Task type' });
    const title = type && await vscode.window.showInputBox({ prompt: `New ${type}`, placeHolder: 'Title' });
    const id = title?.trim() && await run(at!.root, { op: 'create', type: type!, title, near: at!.near });
    if (id) panels.openTask(at!.root, id);
  });
  reg('plandown.createGroup', async (arg?: unknown) => {
    const at = await where(arg);
    const name = at && await vscode.window.showInputBox({ prompt: 'New group', placeHolder: 'Group name' });
    if (name?.trim()) await run(at!.root, { op: 'group', name, near: at!.near });
  });
  for (const kind of ['graph', 'time'] as const)
    reg(`plandown.${kind}`, async (arg?: unknown) => { const r = isItem(arg) ? arg.root : await pickRoot(); if (r) panels.openView(r, kind); });
  reg('plandown.filter', async () => { const text = await vscode.window.showInputBox({ prompt: 'Filter tasks by title or description', value: tree.filter }); if (text !== undefined) filter(text.trim()); });
  reg('plandown.clearFilter', () => filter(''));
  reg('plandown.refresh', load);
  // Opening the same task twice within 500 ms (a double click on a tree row) pins its tab, as the Explorer does for files
  let last = { r: undefined as Root | undefined, id: '', at: 0 };
  reg('plandown.open', (r: Root, id: string) => {
    const pin = last.r === r && last.id === id && Date.now() - last.at < 500;
    last = { r, id, at: Date.now() };
    panels.openTask(r, id, pin);
  });
  reg('plandown.openPinned', (item: Item) => {
    const id = item.kind === 'node' ? item.node.task : item.kind === 'task' ? item.id : undefined;
    if (id) panels.openTask(item.root, id, true);
  });

  await load();
}

export function deactivate() {}
