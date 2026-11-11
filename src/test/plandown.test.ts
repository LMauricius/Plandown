import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDb, findNode, Plandown, parseFormat, parseMarkdown } from '../index.js';
import { caretSnap, caretStep, clip, cut, enterText, fromHtml, markMask, listEdit, tableEdit, tokenize, toHtml, type HNode } from '../gui/mdedit.js';

const DEMO = fileURLToPath(new URL('../../examples/demo/', import.meta.url));
const copy = () => { const d = mkdtempSync(join(tmpdir(), 'plandown-')); cpSync(DEMO, d, { recursive: true }); return d; };
const read = (d: string, f: string) => readFileSync(join(d, f), 'utf8');
const links = (m: Plandown, id: string) => m.db.edges.filter(e => e.from === id).map(e => `${e.type} ${e.to}`).sort();

test('format: flips may be omitted (one-directional) but not contradicted', () => {
  const bad = parseFormat(parseMarkdown('plandown-format.md', '# [A] a\n\nX:\n- [A] X\n- [B] Y\n\n# [B] b\n\nY:\n- [A] Z\n'));
  assert.deepEqual(bad.diagnostics.map(d => d.line), [4]);
  assert.deepEqual(parseFormat(parseMarkdown('plandown-format.md', '# [A] a\n\nX:\n- [B] Y\n\n# [B] b\n')).diagnostics, []);
  const good = parseFormat(parseMarkdown('plandown-format.md', read(DEMO, 'plandown-format.md')));
  assert.deepEqual(good.diagnostics, []);
  assert.equal(good.format.types.Bug.links['Discovered during'].Task, 'Revealed');
  assert.deepEqual(good.format.types.Task.props.Priority, { type: 'number', enum: [1, 2, 3] });
  const meta = parseFormat(parseMarkdown('plandown-format.md', '# [A] a\n```yaml\n$meta:\n  color: teal\n  icon: x\nP: string\n```\n\n# [B] b\n```yaml\n$meta: red\n```\n'));
  assert.equal(meta.format.types.A.color, 'teal');
  assert.deepEqual(Object.keys(meta.format.types.A.props), ['P']);
  assert.deepEqual(meta.diagnostics.map(d => d.message), ['Unknown type setting "$meta.icon"', '"$meta" must be a map of type settings']);
});

test('parser: checkboxes, links and code are not tasks; lists end at blank lines', () => {
  const pf = parseMarkdown('a.md', '# [T] A\n- [x] done item\n- [link](x) text\n\n```\n# [T] Code\n```\nBlocked by:\n- [x] [T] B\n\n- [T] C\n');
  assert.deepEqual(pf.nodes.map(n => n.title), ['A', 'B', 'C']);
  assert.deepEqual(pf.nodes[0].lists.map(l => l.label), ['Blocked by', null]);
});

test('db: interwoven files merge into one task with links from headings and lists', async () => {
  const m = await Plandown.open(DEMO);
  assert.deepEqual(m.db.diagnostics, []);
  const anim = m.db.tasks['[Task] Offline mode'];
  assert.equal(anim.home.file, 'roadmap.md');
  assert.equal(anim.occurrences.length, 2);
  assert.equal(anim.props.effort, 16);
  assert.deepEqual(links(m, anim.id), [
    'Blocked by [Task] Account system',
    'Subtask [Task] Conflict resolution',
    'Subtask [Task] Design the sync protocol',
    'Subtask [Task] Local recipe cache',
    'Subtask [Task] Sync status indicator',
  ]);
  assert.equal(m.db.edges.find(e => e.to === anim.id)?.from, '[Task] Pantry 1.0');
  assert.equal(m.db.tasks['[Task] Choose an auth provider'].body[0], 'The hosted provider with passkeys and a free tier won.');
  assert.deepEqual(m.db.totals['[Task] Pantry 1.0'], { effort: 37, spent: 6.5 });
  assert.equal(m.db.tasks['[Task] Recipe import'].occurrences.length, 2);
});

test('db: anchors follow GitHub heading slugs and stay unique', () => {
  const { format } = parseFormat(parseMarkdown('plandown-format.md', '# [T] t\n'));
  const { db } = buildDb(format, [], [parseMarkdown('a.md', '# [T] Fix: Ünicode_ok\n# [T] A.b\n# [T] Ab\n')]);
  assert.deepEqual(Object.values(db.tasks).map(t => t.anchor), ['t-fix-ünicode_ok', 't-ab', 't-ab-1']);
});

test('db: invalid links and properties are reported', async () => {
  const d = copy();
  writeFileSync(join(d, 'bad.md'), '# [Bug] X\n```yaml\nSeverity: huge\nFoo: 1\n```\n\nBlocks:\n- [Nope] Y\n\nRevealed:\n- [Task] Z\n');
  const m = await Plandown.open(d);
  assert.deepEqual(m.db.diagnostics.map(d => d.message).sort(), [
    'Link "Blocks" of [Bug] cannot target [Nope]',
    'Link "Revealed" of [Bug] cannot target [Task]',
    'Property "Severity" of [Bug] X must be one of low, medium, high',
    'Unknown task type [Nope]',
    '[Bug] does not declare property "Foo"',
  ]);
});

test('edits: update, create, link, unlink, timer and delete rewrite only their lines', async () => {
  const d = copy(), m = await Plandown.open(d), before = read(d, 'roadmap.md');

  await m.apply({ op: 'update', id: '[Task] Account system', title: 'Accounts', props: { Priority: 2 }, body: ['Email sign-in only.'] });
  const sg = m.db.tasks['[Task] Accounts'];
  assert.equal(sg.body[0], 'Email sign-in only.');
  assert.equal(sg.props.Priority, 2);
  assert.ok(read(d, 'notes/2026-11.md').includes('## [Task] Accounts'), 'renamed in every file');
  assert.ok(links(m, '[Task] Offline mode').includes('Blocked by [Task] Accounts'));

  await m.apply({ op: 'create', type: 'Task', title: 'Write docs', parent: '[Task] Recipe import' });
  await m.apply({ op: 'link', from: '[Task] Write docs', type: 'Blocked by', to: '[Bug] Imported recipes lose their photos' });
  assert.ok(links(m, '[Task] Recipe import').includes('Subtask [Task] Write docs'));
  assert.ok(links(m, '[Task] Write docs').includes('Blocked by [Bug] Imported recipes lose their photos'));
  await assert.rejects(m.apply({ op: 'link', from: '[Task] Write docs', type: 'Discovered during', to: '[Bug] Imported recipes lose their photos' }));

  await m.apply({ op: 'unlink', from: '[Task] Write docs', type: 'Blocked by', to: '[Bug] Imported recipes lose their photos' });
  assert.ok(!read(d, 'notes/2026-11.md').includes('Blocked by:'), 'label removed with its last item');

  await m.apply({ op: 'start', id: '[Task] Write docs' });
  assert.equal(typeof m.db.tasks['[Task] Write docs'].props.started, 'string');
  await m.apply({ op: 'stop', id: '[Task] Write docs' });
  assert.equal(m.db.tasks['[Task] Write docs'].props.started, undefined);
  assert.equal(typeof m.db.tasks['[Task] Write docs'].props.spent, 'number');
  const spent = m.db.tasks['[Task] Write docs'].props.spent as number;
  await m.apply({ op: 'log', id: '[Task] Write docs', hours: 1.5 });
  assert.equal(m.db.tasks['[Task] Write docs'].props.spent, Math.round((spent + 1.5) * 100) / 100);
  await assert.rejects(m.apply({ op: 'log', id: '[Task] Write docs', hours: '2' as unknown as number }));
  await assert.rejects(m.apply({ op: 'log', id: '[Task] Write docs', hours: -1000 }));
  await assert.rejects(m.apply({ op: 'lap', id: '[Task] Write docs' }), /No running timer/);
  await m.apply({ op: 'start', id: '[Task] Write docs' });
  await m.apply({ op: 'lap', id: '[Task] Write docs' });
  assert.equal(typeof m.db.tasks['[Task] Write docs'].props.started, 'string', 'lap keeps the timer running');
  await m.apply({ op: 'stop', id: '[Task] Write docs' });

  await m.apply({ op: 'delete', id: '[Task] Write docs' });
  await m.apply({ op: 'update', id: '[Task] Accounts', title: 'Account system', props: {}, body: ['Sign-in with an email address or a single sign-on provider.'] });
  assert.equal(read(d, 'roadmap.md'), before, 'round trip restores the file byte for byte');
  assert.deepEqual(m.db.diagnostics, []);
});

test('parser: YAML fences and legacy "---" property blocks; unclosed ones never swallow tasks', () => {
  const pf = parseMarkdown('a.md', [
    '# [T] A', '~~~~yml', '# comment', 'a: |', '  ~~~', '  ```', '~~~~',                // shorter or different closers do not close
    '- [T] B', '  ```YAML', '  b: 2', '  ```', '  - [T] B1',
    '- [T] C', '  ```yaml', '  c: 3', '- [T] D',                                         // unclosed: ends at the less indented line
    '# [T] E', '---', 'e: 5', '---',
    '# [T] F', '```yaml', 'f: 6', '# [T] G', '```yaml', 'g: 7', '```',                 // unclosed: ends at the next task heading
  ].join('\n') + '\n');
  const props = Object.fromEntries(pf.nodes.map(n => [n.title, n.props?.data]));
  assert.deepEqual(props, { A: { a: '~~~\n```\n' }, B: { b: 2 }, B1: undefined, C: undefined, D: undefined, E: { e: 5 }, F: undefined, G: { g: 7 } });
  assert.deepEqual(pf.diagnostics.map(d => [d.line, d.severity, d.message.slice(0, 30)]), [
    [13, 'error', 'Unclosed property block (missi'], [17, 'warning', 'Property block uses the "---" '], [21, 'error', 'Unclosed property block (missi'],
  ]);
});

test('edits: property edits write a fence, converting a legacy block and keeping its comments', async () => {
  const d = mkdtempSync(join(tmpdir(), 'plandown-'));
  writeFileSync(join(d, 'plandown-format.md'), '# [T] t\n');
  writeFileSync(join(d, 'a.md'), '# [T] A\n---\n# keep\neffort: 1\n---\nText\n- [T] B\n  more\n');
  const m = await Plandown.open(d);
  await m.apply({ op: 'update', id: '[T] A', props: { effort: 2 } });
  await m.apply({ op: 'update', id: '[T] B', props: { note: 'x\n```\ny' } });
  assert.equal(read(d, 'a.md'), '# [T] A\n```yaml\n# keep\neffort: 2\n```\nText\n- [T] B\n  ````yaml\n  note: |-\n    x\n    ```\n    y\n  ````\n  more\n');
  assert.equal(m.db.tasks['[T] B'].props.note, 'x\n```\ny');
});

test('edits: refuse to write over files changed on disk', async () => {
  const d = copy(), m = await Plandown.open(d);
  writeFileSync(join(d, 'bugs.md'), read(d, 'bugs.md') + '\nexternal\n');
  await assert.rejects(m.apply({ op: 'delete', id: '[Bug] Imported recipes lose their photos' }), /changed on disk/);
  assert.ok(read(d, 'bugs.md').endsWith('external\n'));
});

test('body: text gaps around task lists, sub-chapters included, edited gap by gap', async () => {
  const d = mkdtempSync(join(tmpdir(), 'plandown-'));
  writeFileSync(join(d, 'plandown-format.md'), '# [T] t\n\nBlocks:\n- [T] Blocks\n');
  writeFileSync(join(d, 'a.md'), '# [T] A\nIntro\n\n- [T] B\n  Bullet text\n\nMid\n\n## Notes\nMore\n\nBlocks:\n- [T] C\n\nTail\n\n## [T] D\n');
  const m = await Plandown.open(d);
  assert.deepEqual(m.db.tasks['[T] A'].body, ['Intro', { links: ['Subtask'] }, 'Mid\n\n## Notes\nMore', { links: ['Blocks'] }, 'Tail']);
  assert.deepEqual(m.db.tasks['[T] B'].body, ['Bullet text']);
  assert.ok(links(m, '[T] A').includes('Subtask [T] D'), 'task sub-heading still nests');

  await m.apply({ op: 'update', id: '[T] A', body: ['Intro', '', 'Tail\ntwo'] });
  assert.equal(read(d, 'a.md'), '# [T] A\nIntro\n\n- [T] B\n  Bullet text\n\nBlocks:\n- [T] C\n\nTail\ntwo\n\n## [T] D\n');
  await m.apply({ op: 'update', id: '[T] B', body: ['New\n\ntext'] });
  assert.ok(read(d, 'a.md').includes('- [T] B\n  New\n\n  text\n'));
  await m.apply({ op: 'update', id: '[T] A', body: ['First'] });
  assert.deepEqual(m.db.tasks['[T] A'].body, ['First', { links: ['Subtask'] }, '', { links: ['Blocks'] }, 'Tail\ntwo'], 'missing trailing gaps are kept');
  await assert.rejects(m.apply({ op: 'update', id: '[T] A', body: ['a', 'b', 'c', 'd'] }), /lists changed/);
});

test('tree: .plandown.md files merge like .md files and keep their suffix on rename', async () => {
  const d = mkdtempSync(join(tmpdir(), 'plandown-')), w = (f: string, t: string) => writeFileSync(join(d, f), t);
  mkdirSync(join(d, 'h'));
  w('plandown-format.md', '# [T] t\n');
  w('h.plandown.md', '# [T] H\n');
  w('h/x.md', '# [T] X\n');
  const m = await Plandown.open(d);
  assert.deepEqual(m.db.tree.map(n => [n.path, n.folder, n.file, n.task]), [['h', true, 'h.plandown.md', '[T] H']]);
  await m.apply({ op: 'update', id: '[T] H', title: 'K' });
  assert.ok(existsSync(join(d, 'K.plandown.md')) && existsSync(join(d, 'K/x.md')));
});

test('tree: a subtask in its own file merges with the file, not listed twice', async () => {
  const d = mkdtempSync(join(tmpdir(), 'plandown-')), w = (f: string, t: string) => writeFileSync(join(d, f), t);
  mkdirSync(join(d, 'g'));
  w('plandown-format.md', '# [T] t\n');
  w('g.md', '# [T] G\n- [T] Z\n- [T] C\n- [T] Shared\n');
  w('g/z.md', '# [T] Z\nAbout Z.\n');
  w('g/a.md', '# [T] A\n');
  w('g/c.md', '# [T] C\nAbout C.\n## [T] D\n');
  w('other.md', '# [T] Shared\nAbout Shared.\n# [T] X\n');
  const m = await Plandown.open(d), node = (p: string) => findNode(m.db.tree, p)!;
  assert.deepEqual([node('g').task, node('g').tasks], ['[T] G', ['[T] Shared']], 'C is shown by its child node only');
  assert.deepEqual(node('g').kids.map(k => k.path), ['g/z', 'g/c', 'g/a'], 'subtask nodes in the parent\'s order, then by name');
  assert.deepEqual([node('g/c').task, node('g/c').tasks], ['[T] C', ['[T] D']]);
  assert.deepEqual([node('other').task, node('other').tasks], [null, ['[T] Shared', '[T] X']], 'a parent elsewhere keeps a task top-level in its file');
});

test('tree: a node is done when every task below it is, and it has at least one', async () => {
  const d = mkdtempSync(join(tmpdir(), 'plandown-')), w = (f: string, t: string) => writeFileSync(join(d, f), t);
  for (const f of ['a/b', 'a/empty']) mkdirSync(join(d, f), { recursive: true });
  w('plandown-format.md', '# [T] t\n');
  w('a/b/x.md', '# [T] X\n```yaml\ndone: true\n```\n# [T] Y\n```yaml\ndone: true\n```\n');
  w('a/c.md', '# [T] C\n## [T] D\n```yaml\ndone: true\n```\n');
  const m = await Plandown.open(d), node = (p: string) => findNode(m.db.tree, p)!;
  assert.deepEqual(['a', 'a/b', 'a/b/x', 'a/c', 'a/empty'].map(p => node(p).done), [false, true, true, false, false]);
});

test('tree: subfolders, stem merges and placement of new groups and tasks', async () => {
  const d = mkdtempSync(join(tmpdir(), 'plandown-')), w = (f: string, t: string) => writeFileSync(join(d, f), t);
  for (const f of ['g/empty', '.hidden']) mkdirSync(join(d, f), { recursive: true });
  w('plandown-format.md', '# [T] t\n');
  w('g.md', '# [T] G\n');                              // one node with folder g/ and its task
  w('g/fix-login.md', '# [T] Fix login\n## [T] Sub\n'); // merged by slug; Sub is its subtask row
  w('g/notes.md', '# [T] A\n# [T] B\n');
  w('g/plandown-format.md', '# [T] Nested\n');             // reserved for sub-formats: ignored
  w('.hidden/x.md', '# [T] Hidden\n');
  const m = await Plandown.open(d), node = (p: string) => findNode(m.db.tree, p)!;
  assert.deepEqual(m.db.tree.map(n => [n.path, n.folder, n.file, n.task]), [['g', true, 'g.md', '[T] G']]);
  assert.deepEqual(node('g').kids.map(k => [k.path, k.task, k.tasks]), [['g/empty', null, []], ['g/fix-login', '[T] Fix login', ['[T] Sub']], ['g/notes', null, ['[T] A', '[T] B']]]);
  assert.deepEqual(Object.keys(m.db.tasks).sort(), ['[T] A', '[T] B', '[T] Fix login', '[T] G', '[T] Sub']);

  const create = (title: string, near: string) => m.apply({ op: 'create', type: 'T', title, near });
  await create('Next', 'g/fix-login');
  assert.equal(node('g/Next').task, '[T] Next', 'next to a merged file: a file of its own');
  await create('C', 'g/notes');
  assert.deepEqual(node('g/notes').tasks, ['[T] A', '[T] B', '[T] C'], 'appended to a file with several tasks');
  await create('D', 'g/empty');
  assert.ok(!existsSync(join(d, 'g/empty')) && read(d, 'g/empty.md') === '# [T] D\n', 'an empty folder becomes a file');
  await create('Root: 1', '');
  assert.equal(read(d, 'Root 1.md'), '# [T] Root: 1\n');
  assert.equal(findNode(m.db.tree, 'Root 1')?.task, '[T] Root: 1', 'stripped characters still match by slug');

  await m.apply({ op: 'group', name: 'New', near: '' });
  await m.apply({ op: 'group', name: 'In', near: 'New' });
  await m.apply({ op: 'group', name: 'Side', near: 'g/notes' });
  assert.deepEqual(m.db.folders, ['g', 'g/Side', 'New', 'New/In']);
  await assert.rejects(m.apply({ op: 'group', name: 'In', near: 'New' }), /already exists/);
  await assert.rejects(m.apply({ op: 'group', name: '..', near: '' }), /Invalid/);
  await assert.rejects(m.apply({ op: 'group', name: 'X', near: 'nope' }), /No group/);
  await assert.rejects(m.apply({ op: 'create', type: 'T', title: 'X', file: '../x.md' }), /Invalid/);
  await assert.rejects(m.apply({ op: 'create', type: 'T', title: 'X', file: 'g/plandown-format.md' }), /Invalid/);

  await m.apply({ op: 'update', id: '[T] G', title: 'H' });
  assert.ok(existsSync(join(d, 'H.md')) && existsSync(join(d, 'H/notes.md')) && !existsSync(join(d, 'g')), 'merged file and folder follow a rename');
  assert.equal(node('H').task, '[T] H');
  w('H/Taken.md', 'Notes\n');
  await m.reload();
  await assert.rejects(m.apply({ op: 'update', id: '[T] Next', title: 'Taken' }), /Cannot rename H\/Next: H\/Taken already exists/);
});

test('move: task blocks keep their content, reshape between bullets and headings, and never land inside themselves', async () => {
  const d = mkdtempSync(join(tmpdir(), 'plandown-')), w = (f: string, t: string) => writeFileSync(join(d, f), t);
  w('plandown-format.md', '# [T] t\n');
  w('a.md', '# [T] A\n\n- [T] B\n  ```yaml\n  effort: 2\n  ```\n  # not a heading\n  - [T] B1\n- [T] C\n\n## [T] D\nAbout D.\n\n### Notes\nN\n\n# [T] E\n- [T] Ref\n');
  const m = await Plandown.open(d), move = (o: object) => m.apply({ op: 'move', ...o } as never);

  // Bullet under a heading parent: re-indented into its Subtask list, subtasks and props along
  await move({ id: '[T] B', parent: '[T] D' });
  assert.equal(read(d, 'a.md'), '# [T] A\n\n- [T] C\n\n## [T] D\nAbout D.\n\n### Notes\nN\n\n- [T] B\n  ```yaml\n  effort: 2\n  ```\n  # not a heading\n  - [T] B1\n\n# [T] E\n- [T] Ref\n');
  assert.deepEqual(links(m, '[T] D'), ['Subtask [T] B']);
  assert.deepEqual(links(m, '[T] B'), ['Subtask [T] B1']);
  assert.equal(m.db.tasks['[T] B'].props.effort, 2);

  // Bullet to a file: becomes a level-1 heading, a `#` description line escaped; the emptied list leaves one blank line
  await move({ id: '[T] B', near: '' });
  assert.ok(read(d, 'a.md').includes('N\n\n# [T] E'));
  assert.ok(read(d, 'B.md') === '# [T] B\n```yaml\neffort: 2\n```\n\\# not a heading\n- [T] B1\n');
  assert.equal(findNode(m.db.tree, 'B')?.task, '[T] B');

  // Heading under a heading: nested one level deeper, sub-chapters shifted along
  await move({ id: '[T] D', parent: '[T] E' });
  assert.equal(read(d, 'a.md'), '# [T] A\n\n- [T] C\n\n# [T] E\n- [T] Ref\n\n## [T] D\nAbout D.\n\n### Notes\nN\n');
  assert.deepEqual(links(m, '[T] E'), ['Subtask [T] D', 'Subtask [T] Ref']);

  // Heading under a bullet parent: level-1 heading at the end of the file, referenced from the parent's list
  await move({ id: '[T] D', parent: '[T] C' });
  assert.equal(read(d, 'a.md'), '# [T] A\n\n- [T] C\n  - [T] D\n\n# [T] E\n- [T] Ref\n\n# [T] D\nAbout D.\n\n## Notes\nN\n');
  assert.deepEqual(m.db.diagnostics, []);
  assert.deepEqual(links(m, '[T] C'), ['Subtask [T] D']);

  // Sibling slots: before a heading (bullet converted), after a bullet in the same list
  await move({ id: '[T] Ref', near: 'a', sibling: '[T] A' });
  assert.ok(read(d, 'a.md').startsWith('# [T] Ref\n\n# [T] A\n'));
  await move({ id: '[T] B1', parent: '[T] A', sibling: '[T] C', after: false });
  assert.ok(read(d, 'a.md').includes('# [T] A\n\n- [T] B1\n- [T] C\n  - [T] D\n'));

  await assert.rejects(move({ id: '[T] A', parent: '[T] C' }), /under itself/);
  await assert.rejects(move({ id: '[T] A', parent: '[T] A' }), /under itself/);
});

test('move: tree nodes move with their file and folder', async () => {
  const d = mkdtempSync(join(tmpdir(), 'plandown-')), w = (f: string, t: string) => writeFileSync(join(d, f), t);
  mkdirSync(join(d, 'g/sub'), { recursive: true });
  w('plandown-format.md', '# [T] t\n');
  w('g.md', '# [T] G\n');
  w('g/sub/x.md', '# [T] X\n');
  w('f.md', '# [T] F\n');
  const m = await Plandown.open(d), move = (o: object) => m.apply({ op: 'move', ...o } as never);
  assert.equal(await move({ path: 'g', near: 'f' }), '[T] G', 'a merged node answers with its task');
  assert.ok(existsSync(join(d, 'f/g.md')) && existsSync(join(d, 'f/g/sub/x.md')), 'a file-only target gains its folder');
  await move({ path: 'f/g/sub', near: '' });
  assert.ok(existsSync(join(d, 'sub/x.md')));
  await assert.rejects(move({ path: 'f', near: 'f/g' }), /into itself/);
  await assert.rejects(move({ path: 'sub', near: '' }), /already there/);
  w('f/sub.md', '\n');
  await m.reload();
  await assert.rejects(move({ path: 'sub', near: 'f' }), /already exists/);
});

test('move: a parent takes its whole subtree; merged tasks move as their nodes, links included', async () => {
  const d = mkdtempSync(join(tmpdir(), 'plandown-')), w = (f: string, t: string) => writeFileSync(join(d, f), t);
  mkdirSync(join(d, 'L'));
  mkdirSync(join(d, 'g'));
  w('plandown-format.md', '# [T] t\n');
  w('p.md', '# [T] P\n- [T] A\n- [T] B\n\n# [T] A\nAbout A.\n\n# [T] B\n\n# [T] Other\n');
  w('L.md', '# [T] L\n- [T] S\n- [T] U\n');
  w('L/S.md', '# [T] S\nAbout S.\n');
  w('L/U.md', '# [T] U\n');
  w('M.md', '# [T] M\n');
  w('g/x.md', '# [T] X\n');
  const m = await Plandown.open(d), move = (o: object) => m.apply({ op: 'move', ...o } as never);

  // Same-file subtree: subtasks homed at the top level of the old file follow their parent
  await move({ id: '[T] P', parent: '[T] M' });
  assert.equal(read(d, 'p.md'), '# [T] Other\n');
  await move({ id: '[T] Other', near: 'M' });
  assert.ok(!existsSync(join(d, 'p.md')) && !m.db.files.includes('p.md'), 'a file left empty by a move is deleted');
  assert.equal(read(d, 'M.md'), '# [T] M\n\n## [T] P\n- [T] A\n- [T] B\n\n# [T] A\nAbout A.\n\n# [T] B\n');
  assert.deepEqual(findNode(m.db.tree, 'M')?.tasks, ['[T] P']);

  // A merged subtask moves as its file, and its link moves from the old parent to the new one
  assert.equal(await move({ id: '[T] S', parent: '[T] M' }), '[T] S');
  assert.ok(existsSync(join(d, 'M/S.md')) && !existsSync(join(d, 'L/S.md')));
  assert.equal(read(d, 'L.md'), '# [T] L\n- [T] U\n');
  assert.ok(read(d, 'M.md').startsWith('# [T] M\n\n- [T] S\n\n## [T] P\n'));
  assert.deepEqual(findNode(m.db.tree, 'M')?.kids.map(k => k.task), ['[T] S']);

  // Reordering under the same parent moves only the link; to the root, the link is dropped
  await move({ id: '[T] S', parent: '[T] L', from: '[T] M' });
  await move({ id: '[T] S', parent: '[T] L', sibling: '[T] U', after: false });
  assert.equal(read(d, 'L.md'), '# [T] L\n- [T] S\n- [T] U\n');
  await move({ id: '[T] S', near: '' });
  assert.ok(existsSync(join(d, 'S.md')));
  assert.equal(read(d, 'L.md'), '# [T] L\n- [T] U\n');

  // Any node into any node: a folder into a task's node, a file node into a plain task's file node
  await move({ path: 'g', parent: '[T] U' });
  assert.ok(existsSync(join(d, 'L/U/g/x.md')));
  await move({ path: 'L/U/g', parent: '[T] Other' });
  assert.ok(existsSync(join(d, 'Other/g/x.md')), 'Other now has a file of its own');
  await assert.rejects(move({ id: '[T] L', parent: '[T] U' }), /into itself/);
  assert.deepEqual(m.db.diagnostics, []);
});

test('editor tokenizer: blocks, nested inline marks, fences and unclosed delimiters', () => {
  const src = '## **a *b*** `x*y*`\n- [x] [l](http://u) snake_case\n```\n**no**\n```\n*open';
  const t = tokenize(src), at = (s: number, e: number) => src.slice(s, e);
  assert.deepEqual(t.map(l => l.block), ['h2', 'li', 'fence', 'code', 'fence', 'p']);
  assert.equal(at(t[0].start, t[0].mark), '## ');
  const [strong, code] = t[0].inl;
  assert.deepEqual([strong.kind, at(strong.start, strong.end), strong.kids[0].kind, code.kind, code.kids.length], ['strong', '**a *b***', 'em', 'code', 0]);
  assert.deepEqual([t[1].check, t[1].inl.map(i => [i.kind, i.url])], ['x', [['link', 'http://u']]]);
  assert.deepEqual([t[3].inl, t[5].inl], [[], []]);
});

test('editor list keys: continue, end, indent, outdent and join items', () => {
  const ed = (src: string, key: 'Enter' | 'Tab' | 'Backspace', shift = false) => {
    // `|` marks the caret, before and after
    const at = src.indexOf('|'), s = src.replace('|', ''), e = listEdit(s, at, key, shift);
    if (!e) return null;
    const out = s.slice(0, e[0]) + e[2] + s.slice(e[1]);
    return out.slice(0, e[3]) + '|' + out.slice(e[3]);
  };
  assert.equal(ed('- a|b', 'Enter'), '- a\n- |b');
  assert.equal(ed('\t9) [x] a|', 'Enter'), '\t9) [x] a\n\t10) [ ] |');
  assert.equal(ed('- a\n- |', 'Enter'), '- a\n|');
  assert.equal(ed('- a\n\t\t- |\nb', 'Enter'), '- a\n\t- |\nb');
  assert.equal(ed('- a\n- |b', 'Tab'), '- a\n\t- |b');
  assert.equal(tokenize('\t- b')[0].depth, 1);
  assert.equal(ed('  \t- |b', 'Tab', true), '  - |b');
  assert.equal(ed('- a\n- |b', 'Tab', true), '- a\n|b');
  assert.equal(ed('a\n  - [ ] |b', 'Backspace'), 'a |b');
  assert.equal(ed('a \n- |b', 'Backspace'), 'a |b');
  assert.equal(ed('- |b', 'Backspace'), '|b');
  assert.equal(ed('- a|b', 'Tab'), null);
  assert.equal(ed('-| a', 'Enter'), null);
  assert.equal(ed('a|', 'Enter'), null);
});

test('links declared from both sides: kept once, each side unlinks only its own declaration', async () => {
  const d = mkdtempSync(join(tmpdir(), 'plandown-')), w = (f: string, t: string) => writeFileSync(join(d, f), t);
  w('plandown-format.md', '# [A] a\n\nBlocks:\n- [B] Blocked by\n\n# [B] b\n\nBlocked by:\n- [A] Blocks\n');
  w('t.md', '# [A] One\n\nBlocks:\n- [B] Two\n\n# [B] Two\n\nBlocked by:\n- [A] One\n');
  const m = await Plandown.open(d), edge = () => m.db.edges.map(e => [e.from, e.at.line, e.back?.line ?? null]);
  assert.deepEqual(m.db.diagnostics, []);
  assert.deepEqual(edge(), [['[A] One', 3, 8]]);
  // Two's own declaration goes; One's stays and now stands alone
  await m.apply({ op: 'unlink', from: '[B] Two', type: 'Blocked by', to: '[A] One' });
  assert.ok(read(d, 't.md').includes('Blocks:\n- [B] Two') && !read(d, 't.md').includes('Blocked by:'));
  assert.deepEqual(edge(), [['[A] One', 3, null]]);
  // Without a declaration of its own, Two unlinks One's
  await m.apply({ op: 'unlink', from: '[B] Two', type: 'Blocked by', to: '[A] One' });
  assert.deepEqual(m.db.edges, []);
});

test('editor tables: GFM rows, cells, alignment, escapes and table ends', () => {
  const src = '| a | **b** |  |\n|:-|--:|:-:|\nx \\| y | z\n> q\na | b\n--|-\n| c |\n\nd';
  const t = tokenize(src), text = (l: number) => t[l].cells!.map(c => src.slice(c.open, c.close));
  assert.deepEqual(t.map(l => l.block), ['th', 'tsep', 'td', 'quote', 'th', 'tsep', 'td', 'p', 'p']);
  assert.deepEqual(text(0), ['a', '**b**', '  ']);
  assert.deepEqual(t[0].cells!.map(c => c.align), ['l', 'r', 'c']);
  assert.equal(t[0].cells![1].inl[0].kind, 'strong');
  assert.deepEqual(text(2), ['x \\| y', 'z']);
  assert.deepEqual(t[0].cells!.map(c => src.slice(c.start, c.end)).join(''), src.slice(t[0].start, t[0].end));
  assert.equal(src.slice(t[0].cells![2].close, t[0].cells![2].end), '|');
  assert.deepEqual(t[0].cells!.map(c => src.slice(c.start, c.open)), ['| ', ' | ', ' |']);
  assert.deepEqual(tokenize('a | b\n|-|').map(l => l.block), ['p', 'p']);
  assert.deepEqual(tokenize('a\n---').map(l => l.block), ['p', 'p']);
});

test('editor table keys: cell moves, appended rows and ending the table', () => {
  // `|` in `[` `]` marks the selection, before and after; table pipes stay literal
  const ed = (src: string, key: 'Enter' | 'Tab', shift = false) => {
    const at = src.indexOf('^'), s = src.replace('^', ''), e = tableEdit(s, at, key, shift);
    if (!e) return null;
    const out = s.slice(0, e[0]) + e[2] + s.slice(e[1]);
    return out.slice(0, e[3]) + '[' + out.slice(e[3], e[4]) + ']' + out.slice(e[4]);
  };
  const tb = '| a^ | b |\n|-|-|\n| c |   |';
  assert.equal(ed(tb, 'Tab'), '| a | [b] |\n|-|-|\n| c |   |');
  assert.equal(ed('| a | b ^|\n|-|-|\n| c |   |', 'Tab'), '| a | b |\n|-|-|\n| [c] |   |');
  assert.equal(ed('| a | b |\n|-|-|\n| c^ |   |', 'Tab'), '| a | b |\n|-|-|\n| c | []  |');
  assert.equal(ed('| a | b |\n|-|-|\n| c |  ^ |', 'Tab'), '| a | b |\n|-|-|\n| c |   |\n| []  |   |');
  assert.equal(ed('| a | b |\n|-|-^|\n| c |   |', 'Tab', true), '| a | [b] |\n|-|-|\n| c |   |');
  assert.equal(ed(tb, 'Tab', true), null);
  assert.equal(ed(tb, 'Enter'), '| a | b |\n|-|-|\n| []  |   |\n| c |   |');
  assert.equal(ed('| a | b |\n|-|-|\n|  ^ |   |', 'Enter'), '| a | b |\n|-|-|\n[]');
  assert.equal(ed('a^', 'Tab'), null);
});

test('editor caret: arrows skip markers, line ends stay reachable', () => {
  // Offsets visited by repeated steps from `x` until they stop moving
  const walk = (src: string, x: number, d: 1 | -1) => {
    const m = markMask(src), out = [x];
    for (let y = caretStep(src, m, x, d); y !== out.at(-1); y = caretStep(src, m, y, d)) out.push(y);
    return out;
  };
  assert.deepEqual(walk('a**b**c', 0, 1), [0, 1, 4, 7]);
  assert.deepEqual(walk('a**b**\n- x', 0, 1), [0, 1, 4, 6, 9, 10]);
  assert.deepEqual(walk('a**b**\n- x', 10, -1), [10, 9, 6, 4, 3, 0]);
  assert.deepEqual(walk('é👍🏽', 0, 1), [0, 1, 5]);
  const snap = (src: string, x: number) => caretSnap(src, markMask(src), x);
  assert.equal(snap('a**b**', 4), 6);
  assert.equal(snap('a**b**', 2), 3);
  assert.equal(snap('a**b** c', 5), 4);
  assert.equal(snap('- x', 0), 2);
  assert.equal(snap('a**b**c', 1), 1);
});

test('editor deletes: partly covered markers stay, covered elements go whole', () => {
  // `^` marks the range's ends; `|` marks the caret in the result
  const del = (s: string, text = '') => {
    const [a, b] = [s.indexOf('^'), s.lastIndexOf('^') - 1], [out, at] = cut(s.replace(/\^/g, ''), a, b, text);
    return out.slice(0, at) + '|' + out.slice(at);
  };
  assert.equal(del('x **b^ol^d** y'), 'x **b|d** y');
  assert.equal(del('x **b^old** ^y'), 'x **b|**y');
  assert.equal(del('x **^bold^** y'), 'x | y');
  assert.equal(del('x ^**bold**^ y'), 'x | y');
  assert.equal(del('**a *^b^* c**'), '**a | c**');
  assert.equal(del('[l^in^k](u)', 'X'), '[lX|k](u)');
  assert.equal(del('## T^it^le'), '## T|le');
  assert.equal(del('## ^Title^'), '|');
  assert.equal(del('a^\n## T^itle'), 'a|itle');
  assert.equal(del('^a\n^## Title'), '|## Title');
  assert.equal(del('- a^\n- ^b'), '- a|b');
  assert.equal(del('| a^ | b^ |\n|-|-|'), '| a| |  |\n|-|-|');
});

test('editor clipboard: self-contained Markdown and its HTML rendering', () => {
  // `^` marks the selection's ends
  const md = (s: string) => { const [a, b] = [s.indexOf('^'), s.lastIndexOf('^') - 1], t = s.replace(/\^/g, ''); return clip(t, a, b)[2]; };
  assert.equal(md('x **^bold^** y'), '**bold**');
  assert.equal(md('x **b^ol^d** y'), '**ol**');
  assert.equal(md('x **b^old** y^'), '**old** y');
  assert.equal(md('^x [a *b^* c](u)'), 'x [a *b*](u)');
  assert.equal(md('## ^Head^'), '## Head');
  assert.equal(md('- [x] ^a\n\t- b^'), '- [x] a\n\t- b');
  assert.equal(md('| h |\n|-|\n| ^a |\n| b^ |'), '| h |\n|-|\n| a |\n| b |');
  assert.equal(md('```js\na^\nb^\n```'), '```js\n\nb\n```');
  assert.deepEqual(clip('x **b**', 2, 5), [2, 7, '**b**']);

  assert.equal(toHtml('# T\na *b* `<c>`\nd \\* [l](https://e.x) [j](javascript:x)\n\n> q'),
    '<h1>T</h1><p>a <em>b</em> <code>&lt;c&gt;</code>\nd * <a href="https://e.x">l</a> j</p><blockquote><p>q</p></blockquote>');
  assert.equal(toHtml('- a\n\t- [x] b\n2. c'),
    '<ul><li>a<ul><li><input type="checkbox" disabled checked> b</li></ul></li></ul><ol start="2"><li>c</li></ol>');
  assert.equal(toHtml('| a | b |\n|-|:-:|\n| 1 | **2** |'),
    '<table><thead><tr><th>a</th><th style="text-align:center">b</th></tr></thead><tbody><tr><td>1</td><td style="text-align:center"><strong>2</strong></td></tr></tbody></table>');
  assert.equal(toHtml('```ts\n<a>\n```'), '<pre><code class="language-ts">&lt;a&gt;</code></pre>');
  assert.equal(toHtml('a  \nb\\\nc\n- d\ne\n> f\ng'), '<p>a  <br>b<br>c</p><ul><li>d\ne</li></ul><blockquote><p>f\ng</p></blockquote>');
});

test('editor line breaks: soft, hard, Enter', () => {
  const joins = (src: string) => tokenize(src).map(l => l.join ?? '-').join(' ');
  assert.equal(joins('a\nb  \nc\\\nd\n\ne'), '- soft hard hard - -');
  assert.equal(joins('# h\na\n- b\n  c\n> q\n> r\ns\n```\nx\n```'), '- - - soft - soft soft - - -');
  assert.equal(joins('a\\\\\nb'), '- soft');   // escaped backslash: no break
  const ls = tokenize('a\\\nb');
  assert.equal(ls[0].hb, true);
  assert.deepEqual(Array.from(markMask('a\\\nb')), [0, 2, 0, 0]);
  assert.deepEqual(cut('a\\\nb', 2, 3), ['ab', 1]);
  assert.equal(enterText('ab', 1, false), '\n\n');
  assert.equal(enterText('ab', 1, true), '\\\n');
  assert.equal(enterText('# h', 3, false), '\n');
  assert.equal(enterText('```\nx', 5, true), '\n');
});

test('editor paste: HTML to Markdown', () => {
  const H = (tag: string, attrs: Record<string, string> = {}, ...kids: (HNode | string)[]): HNode => ({
    nodeType: 1, nodeName: tag.toUpperCase(), nodeValue: null, getAttribute: a => attrs[a] ?? null,
    childNodes: kids.map(k => typeof k === 'string' ? { nodeType: 3, nodeName: '#text', nodeValue: k, childNodes: [] } : k),
  });
  const md = (...kids: HNode[]) => fromHtml(H('body', {}, ...kids));
  // Google Docs: marks only in styles, an outer `<b>` clearing bold, `pre; pre-wrap` spans
  const ws = 'white-space:pre;white-space:pre-wrap;';
  assert.equal(md(H('b', { style: 'font-weight:normal' },
    H('p', {}, H('span', { style: ws + 'font-weight:700' }, 'Bold'), H('span', { style: ws }, ' and '), H('span', { style: 'font-style:italic' }, 'it')),
    H('p', {}, '5 * 3 = [x] snake_case _y_\n  1. no'), H('p', {}, '- z'))),
    '**Bold** and *it*\n\n5 \\* 3 = \\[x] snake_case \\_y\\_ 1. no\n\n\\- z');
  assert.equal(md(H('ul', {}, H('li', {}, H('input', { type: 'checkbox', checked: '' }), ' a', H('ul', {}, H('li', {}, 'b')))), H('ol', { start: '3' }, H('li', {}, H('p', {}, 'c')))),
    '- [x] a\n\t- b\n\n3. c');
  assert.equal(md(H('h2', {}, 'T'), H('pre', { class: 'language-js' }, 'a`\n'), H('blockquote', {}, H('p', {}, 'q')),
    H('p', {}, H('a', { href: 'https://e.x/a b' }, 'l'), ' ', H('code', {}, 'x`y'), ' ', H('a', { href: 'javascript:1' }, 'j'))),
    '## T\n\n```js\na`\n```\n\n> q\n\n[l](https://e.x/a%20b) ``x`y`` j');
  // Adjacent and overlapping marks never form runs the tokenizer cannot read
  assert.equal(md(H('p', {}, H('b', {}, 'a'), H('b', {}, H('i', {}, 'b')), ' ', H('i', {}, 'c'), H('b', {}, 'd '), 'e')), '**a*b*** *c*__d__ e');
  assert.equal(md(H('table', {}, H('tr', {}, H('th', {}, 'a'), H('th', { style: 'text-align: right' }, 'b|')), H('tr', {}, H('td', {}, H('b', {}, '1'))))),
    '| a | b\\| |\n| --- | --: |\n| **1** |   |');
  // Line divs and `br` join with a hard break; an empty div or a double `br` is a blank line
  assert.equal(md(H('div', {}, 'a'), H('div', {}, H('br')), H('div', {}, 'b'), H('div', {}, 'c')), 'a\n\nb\\\nc');
  assert.equal(md(H('p', {}, 'a', H('br'), 'b', H('br'), H('br'), 'c'), H('h1', {}, 'd', H('br'), 'e')), 'a\\\nb\n\nc\n\n# d e');
  // Word lists: marker spans dropped, levels nest, letters count, other blocks end the numbering
  const mso = (lvl: number, mk: string, text: string) => H('p', { class: 'MsoListParagraph', style: `text-indent:-.25in;mso-list:l0 level${lvl} lfo1` },
    H('span', { style: 'font-family:Symbol' }, H('span', { style: 'mso-list:Ignore' }, mk, H('span', { style: 'font:7.0pt "Times New Roman"' }, '\u00a0\u00a0 '))), text);
  assert.equal(md(mso(1, '·', 'a'), mso(2, 'o', 'b'), mso(1, '3.', 'c'), mso(2, 'a)', 'd'), mso(2, 'b)', 'e'), H('p', {}, 'x'), mso(1, 'i.', 'f')),
    '- a\n\t- b\n3. c\n\t1. d\n\t2. e\n\nx\n\n1. f');
  // Code editors: the plain text is the source
  assert.equal(md(H('div', { style: 'white-space: pre;' }, H('div', {}, H('span', { style: 'font-weight: bold' }, '**x**')))), null);
});
