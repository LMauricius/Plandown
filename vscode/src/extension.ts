/**
 * Plandown for VSCode: finds databases in the workspace, marks their files as Plandown files, lists them in the activity bar tree, opens tasks, the graph and
 * the time view in webview tabs running the standalone GUI, and reports diagnostics in the Problems view.
 * The extension host loads CommonJS while the library is ESM, so the library is loaded with a dynamic `import()`.
 */
import * as vscode from 'vscode';
import { dirname, join, relative, sep } from 'node:path';
import type { Op, Plandown } from 'plandown' with { 'resolution-mode': 'import' };
import { TaskTree, typeDecorations, type Item } from './tree.js';
import { Panels, linkOf } from './panels.js';

/** One loaded database: the folder holding a `plandown-format.md`. */
export interface Root { uri: vscode.Uri; pd: Plandown; diags: vscode.DiagnosticCollection; unwatch(): void; server?: Promise<{ url: string; close(): void }> }

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

/**
 * Per-root file associations in workspace settings (VSCode can't scope them to "folders holding plandown-format.md"):
 * every `.md` of a root is the `plandown` language (its icon) and opens in the `plandown.file` editor, except the format
 * file (text editor). Globs start with `**` + the workspace folder's name, so no machine-specific path is stored.
 * Entries are recognized as ours by their shape and value and rewritten as a whole; settings are written only on change.
 * (`*.plandown.md` and `plandown-format.md` anywhere are associated statically, in package.json.)
 */
async function associate(roots: vscode.Uri[]): Promise<void> {
  const dirs = roots.flatMap(u => { const ws = vscode.workspace.getWorkspaceFolder(u); return ws ? ['**/' + relative(dirname(ws.uri.fsPath), u.fsPath).split(sep).join('/')] : []; });
  const want: Record<string, [string, string][]> = {
    'files.associations': dirs.map(d => [`${d}/**/*.md`, 'plandown']),
    'workbench.editorAssociations': dirs.flatMap((d): [string, string][] => [[`${d}/**/*.md`, 'plandown.file'], [`${d}/plandown-format.md`, 'default']]),
  };
  const ours = (k: string, v: string) => k.startsWith('**/')
    && (k.endsWith('/**/*.md') && (v === 'plandown' || v === 'plandown.file') || k.endsWith('/plandown-format.md') && v === 'default');
  const conf = vscode.workspace.getConfiguration();
  for (const [key, entries] of Object.entries(want)) {
    const cur = conf.inspect<Record<string, string>>(key)?.workspaceValue ?? {};
    const next = { ...Object.fromEntries(Object.entries(cur).filter(([k, v]) => !ours(k, v))), ...Object.fromEntries(entries) };
    if (JSON.stringify(next) !== JSON.stringify(cur))
      await conf.update(key, Object.keys(next).length ? next : undefined, vscode.ConfigurationTarget.Workspace);
  }
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
  const { Plandown, serve, findNode, fileStem } = await import('plandown');
  let roots: Root[] = [], loading = Promise.resolve();

  // ---- Databases ----

  const changed = (r: Root) => { report(r); tree.refresh(); panels.changed(r); showTimers(); setPaths(); };
  /** Context key `plandown.paths`: every folder and task file of every root (absolute), so Explorer menus and keys show only on them. */
  const setPaths = () => vscode.commands.executeCommand('setContext', 'plandown.paths',
    roots.flatMap(r => [...r.pd.db.folders, ...r.pd.db.files].map(p => join(r.uri.fsPath, ...p.split('/')))));
  const apply: Apply = async (r, op) => { try { return await r.pd.apply(op); } finally { changed(r); } };
  const close = (r: Root) => { r.unwatch(); r.diags.dispose(); panels.drop(r); r.server?.then(s => s.close(), () => {}); };

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
    // Several roots: create/view/browser buttons move from the view title to the root rows (section headers)
    vscode.commands.executeCommand('setContext', 'plandown.multi', roots.length > 1);
    tree.refresh();
    showTimers();
    setPaths();
    await associate(roots.map(r => r.uri)).catch(e => vscode.window.showWarningMessage(`Plandown: cannot associate .md files: ${(e as Error).message}`));
  });

  // ---- Status bar: running timers ----

  /** One item per running timer (timer role property set) of every root, as the GUI header lists them; click opens the task. */
  let timers: { item: vscode.StatusBarItem; started: number; title: string }[] = [];
  const tick = () => timers.forEach(t => t.item.text = `$(clock) ${t.title} ${clock(Date.now() - t.started)}`);
  const showTimers = () => {
    timers.forEach(t => t.item.dispose());
    timers = roots.flatMap(r => Object.values(r.pd.db.tasks).flatMap(t => {
      const k = r.pd.db.format.types[t.type]?.roles.timer, started = k ? Date.parse(String(t.props[k] ?? '')) : NaN;
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
  const view = vscode.window.createTreeView('plandown.tree', { treeDataProvider: tree, dragAndDropController: tree });
  // `require.resolve` finds the installed copy of the library (refreshed by `npm run build`), whose `dist/gui` the webviews load
  const panels = new Panels(vscode.Uri.file(join(dirname(require.resolve('plandown')), 'gui')), () => loading.then(() => roots), apply, (r, page) => {
    // Expands the tree down to the active tab's row, as the Explorer's auto reveal. `reveal` would open a hidden view, and a
    // selected row already showing the page (the clicked occurrence of a task listed twice) stays
    const sel = view.selection[0];
    if (!view.visible || (sel && tree.hits(sel, r, page))) return;
    const item = tree.find(r, page);
    if (item) view.reveal(item, { select: true, focus: false }).then(undefined, () => {});
  });
  ctx.subscriptions.push(view, vscode.window.registerFileDecorationProvider(typeDecorations),
    vscode.window.registerCustomEditorProvider('plandown.file', panels, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.window.registerCustomEditorProvider('plandown.own', panels, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.window.registerCustomEditorProvider('plandown.task', panels, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.window.registerWebviewPanelSerializer('plandown.view', panels),
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
  reg('plandown.done', (item: Item) => tree.setDone(item, true));
  reg('plandown.undone', (item: Item) => tree.setDone(item, false));
  reg('plandown.refresh', load);
  // One GUI server per root, started on first use on a free port (4848 may be taken by the CLI server) and closed with the root
  reg('plandown.openBrowser', async (arg?: unknown) => {
    const r = isItem(arg) ? arg.root : await pickRoot();
    if (!r) return;
    try { await vscode.env.openExternal(vscode.Uri.parse((await (r.server ??= serve(r.pd, 0))).url)); }
    catch (e) { r.server = undefined; vscode.window.showErrorMessage(`Plandown: cannot start the GUI server: ${(e as Error).message}`); }
  });
  // Opening the same page twice within 500 ms (a double click on a tree row) pins its tab, as the Explorer does for files.
  // A click from the tree (`item`) expands its row, or toggles it when its page is already shown (`cur`), as the Explorer
  // toggles folders; unless pinning, the focus stays in the tree. VSCode has no API to collapse an item: `list.toggleExpand`
  // acts on the focused row, which is the clicked one. The toggle waits out the double click window: a second click (pinning,
  // or another row) cancels it
  let last = { r: undefined as Root | undefined, key: '', at: 0 }, toggle: NodeJS.Timeout | undefined;
  const clicked = (r: Root, key: string, cur: boolean, item?: Item) => {
    const pin = last.r === r && last.key === key && Date.now() - last.at < 500;
    last = { r, key, at: Date.now() };
    clearTimeout(toggle);
    if (isItem(item) && !pin) {
      if (cur) toggle = setTimeout(() => vscode.commands.executeCommand('list.toggleExpand'), 500);
      else view.reveal(item, { expand: true }).then(undefined, () => {});
    }
    return pin;
  };
  reg('plandown.open', (r: Root, id: string, item?: Item) => { const pin = clicked(r, id, panels.shows(r, { kind: 'task', id }), item); panels.openTask(r, id, pin, isItem(item) && !pin); });
  reg('plandown.openNode', (r: Root, path: string, item?: Item) => { const pin = clicked(r, '/' + path, panels.shows(r, { kind: 'node', path }), item); panels.openNode(r, path, pin, isItem(item) && !pin); });
  /**
   * Explorer item's page: a folder's or file's group page, or the task merged with it. The context menu passes the item;
   * the keybinding passes nothing, and the Explorer selection is read with `copyFilePath` through the clipboard (VSCode
   * has no selection API). The clipboard's text is restored; other content (images, rich text) is lost.
   */
  reg('plandown.openInPlandown', async (arg?: unknown) => {
    let path = arg instanceof vscode.Uri ? arg.fsPath : undefined;
    if (!path) {
      const saved = await vscode.env.clipboard.readText();
      await vscode.env.clipboard.writeText('');
      await vscode.commands.executeCommand('copyFilePath');
      path = (await vscode.env.clipboard.readText()).split(/\r?\n/)[0];   // first of a multi-selection
      await vscode.env.clipboard.writeText(saved);
    }
    const r = path ? roots.find(x => path.startsWith(x.uri.fsPath + sep)) : undefined;
    const n = r && findNode(r.pd.db.tree, fileStem(relative(r.uri.fsPath, path!).split(sep).join('/')));
    if (!n) return vscode.window.showInformationMessage('Plandown: not a folder or task file of a database.');
    if (n.task) panels.openTask(r!, n.task); else panels.openNode(r!, n.path);
  });
  // Copies the link of a tree item (its context menu), an editor tab (the tab's context menu passes its URI) or the focused Plandown tab
  reg('plandown.copyLink', async (arg?: unknown) => {
    const link = !isItem(arg) ? await panels.link(arg instanceof vscode.Uri ? arg : undefined)
      : arg.kind === 'task' ? linkOf(arg.root, { kind: 'task', id: arg.id })
      : arg.kind === 'node' ? linkOf(arg.root, arg.node.task ? { kind: 'task', id: arg.node.task } : { kind: 'node', path: arg.node.path }) : undefined;
    if (!link) return;
    await vscode.env.clipboard.writeText(link);
    vscode.window.setStatusBarMessage(`Plandown: copied ${link}`, 3000);
  });
  reg('plandown.openPinned', (item: Item) => {
    if (item.kind === 'node' && !item.node.task) return panels.openNode(item.root, item.node.path, true);
    const id = item.kind === 'node' ? item.node.task : item.kind === 'task' ? item.id : undefined;
    if (id) panels.openTask(item.root, id, true);
  });

  await load();
}

export function deactivate() {}
