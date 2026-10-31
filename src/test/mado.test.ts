import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDb, findNode, Mado, parseFormat, parseMarkdown } from '../index.js';
import { tokenize } from '../gui/mdedit.js';

const DEMO = fileURLToPath(new URL('../../examples/demo/', import.meta.url));
const copy = () => { const d = mkdtempSync(join(tmpdir(), 'mado-')); cpSync(DEMO, d, { recursive: true }); return d; };
const read = (d: string, f: string) => readFileSync(join(d, f), 'utf8');
const links = (m: Mado, id: string) => m.db.edges.filter(e => e.from === id).map(e => `${e.type} ${e.to}`).sort();

test('format: flips are cross-checked, reflexive entries need none', () => {
  const bad = parseFormat(parseMarkdown('mado-format.md', '# [A] a\n\nX:\n- [A] X\n- [B] Y\n\n# [B] b\n\nZ:\n- [A] X\n'));
  assert.deepEqual(bad.diagnostics.map(d => d.line), [4, 9]);
  const good = parseFormat(parseMarkdown('mado-format.md', read(DEMO, 'mado-format.md')));
  assert.deepEqual(good.diagnostics, []);
  assert.equal(good.format.types.Bug.links['Discovered during'].Task, 'Revealed');
  assert.deepEqual(good.format.types.Task.props.Priority, { type: 'number', enum: [1, 2, 3] });
  const meta = parseFormat(parseMarkdown('mado-format.md', '# [A] a\n---\n$meta:\n  color: teal\n  icon: x\nP: string\n---\n\n# [B] b\n---\n$meta: red\n---\n'));
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
  const m = await Mado.open(DEMO);
  assert.deepEqual(m.db.diagnostics, []);
  const anim = m.db.tasks['[Task] Animation system'];
  assert.equal(anim.home.file, 'roadmap.md');
  assert.equal(anim.occurrences.length, 2);
  assert.equal(anim.props.effort, 16);
  assert.deepEqual(links(m, anim.id), [
    'Blocked by [Task] Smart scene graph',
    'Subtask [Task] High-level design of animation system',
    'Subtask [Task] Implementation of a modular system',
    'Subtask [Task] Implementation of common methods as examples',
    'Subtask [Task] Programming interface for the system',
  ]);
  assert.equal(m.db.edges.find(e => e.to === anim.id)?.from, '[Task] Game-ready 3D engine');
  assert.equal(m.db.tasks['[Task] Stabilize the SQueLe core API'].body[0], 'The query library everything else builds on.');
  assert.deepEqual(m.db.totals['[Task] Game-ready 3D engine'], { effort: 26, spent: 3.5 });
  assert.equal(m.db.tasks['[Task] Port EAA shadows'].occurrences.length, 2);
});

test('db: anchors follow GitHub heading slugs and stay unique', () => {
  const { format } = parseFormat(parseMarkdown('mado-format.md', '# [T] t\n'));
  const { db } = buildDb(format, [], [parseMarkdown('a.md', '# [T] Fix: Ünicode_ok\n# [T] A.b\n# [T] Ab\n')]);
  assert.deepEqual(Object.values(db.tasks).map(t => t.anchor), ['t-fix-ünicode_ok', 't-ab', 't-ab-1']);
});

test('db: invalid links and properties are reported', async () => {
  const d = copy();
  writeFileSync(join(d, 'bad.md'), '# [Bug] X\n---\nSeverity: huge\nFoo: 1\n---\n\nBlocks:\n- [Nope] Y\n\nRevealed:\n- [Task] Z\n');
  const m = await Mado.open(d);
  assert.deepEqual(m.db.diagnostics.map(d => d.message).sort(), [
    'Link "Blocks" of [Bug] cannot target [Nope]',
    'Link "Revealed" of [Bug] cannot target [Task]',
    'Property "Severity" of [Bug] X must be one of low, medium, high',
    'Unknown task type [Nope]',
    '[Bug] does not declare property "Foo"',
  ]);
});

test('edits: update, create, link, unlink, timer and delete rewrite only their lines', async () => {
  const d = copy(), m = await Mado.open(d), before = read(d, 'roadmap.md');

  await m.apply({ op: 'update', id: '[Task] Smart scene graph', title: 'Scene graph', props: { Priority: 2 }, body: ['Flat prop list.'] });
  const sg = m.db.tasks['[Task] Scene graph'];
  assert.equal(sg.body[0], 'Flat prop list.');
  assert.equal(sg.props.Priority, 2);
  assert.ok(read(d, '2026-11.md').includes('- [Task] Scene graph'), 'renamed in every file');
  assert.ok(links(m, '[Task] Animation system').includes('Blocked by [Task] Scene graph'));

  await m.apply({ op: 'create', type: 'Task', title: 'Write docs', parent: '[Task] Port EAA shadows' });
  await m.apply({ op: 'link', from: '[Task] Write docs', type: 'Blocked by', to: '[Bug] Shadow acne on EAA shadows' });
  assert.ok(links(m, '[Task] Port EAA shadows').includes('Subtask [Task] Write docs'));
  assert.ok(links(m, '[Task] Write docs').includes('Blocked by [Bug] Shadow acne on EAA shadows'));
  await assert.rejects(m.apply({ op: 'link', from: '[Task] Write docs', type: 'Discovered during', to: '[Bug] Shadow acne on EAA shadows' }));

  await m.apply({ op: 'unlink', from: '[Task] Write docs', type: 'Blocked by', to: '[Bug] Shadow acne on EAA shadows' });
  assert.ok(!read(d, '2026-11.md').includes('Blocked by:'), 'label removed with its last item');

  await m.apply({ op: 'start', id: '[Task] Write docs' });
  assert.equal(typeof m.db.tasks['[Task] Write docs'].props.started, 'string');
  await m.apply({ op: 'stop', id: '[Task] Write docs' });
  assert.equal(m.db.tasks['[Task] Write docs'].props.started, undefined);
  assert.equal(typeof m.db.tasks['[Task] Write docs'].props.spent, 'number');

  await m.apply({ op: 'delete', id: '[Task] Write docs' });
  await m.apply({ op: 'update', id: '[Task] Scene graph', title: 'Smart scene graph', props: {}, body: ['The scene is a flat list of props; the engine builds the optimal structure.'] });
  assert.equal(read(d, 'roadmap.md'), before, 'round trip restores the file byte for byte');
  assert.deepEqual(m.db.diagnostics, []);
});

test('edits: refuse to write over files changed on disk', async () => {
  const d = copy(), m = await Mado.open(d);
  writeFileSync(join(d, 'roadmap.md'), read(d, 'roadmap.md') + '\nexternal\n');
  await assert.rejects(m.apply({ op: 'delete', id: '[Bug] Shadow acne on EAA shadows' }), /changed on disk/);
  assert.ok(read(d, 'roadmap.md').endsWith('external\n'));
});

test('body: text gaps around task lists, sub-chapters included, edited gap by gap', async () => {
  const d = mkdtempSync(join(tmpdir(), 'mado-'));
  writeFileSync(join(d, 'mado-format.md'), '# [T] t\n\nBlocks:\n- [T] Blocks\n');
  writeFileSync(join(d, 'a.md'), '# [T] A\nIntro\n\n- [T] B\n  Bullet text\n\nMid\n\n## Notes\nMore\n\nBlocks:\n- [T] C\n\nTail\n\n## [T] D\n');
  const m = await Mado.open(d);
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

test('tree: subfolders, stem merges and placement of new groups and tasks', async () => {
  const d = mkdtempSync(join(tmpdir(), 'mado-')), w = (f: string, t: string) => writeFileSync(join(d, f), t);
  for (const f of ['g/empty', '.hidden']) mkdirSync(join(d, f), { recursive: true });
  w('mado-format.md', '# [T] t\n');
  w('g.md', '# [T] G\n');                              // one node with folder g/ and its task
  w('g/fix-login.md', '# [T] Fix login\n## [T] Sub\n'); // merged by slug; Sub is a subtask, not top-level
  w('g/notes.md', '# [T] A\n# [T] B\n');
  w('g/mado-format.md', '# [T] Nested\n');             // reserved for sub-formats: ignored
  w('.hidden/x.md', '# [T] Hidden\n');
  const m = await Mado.open(d), node = (p: string) => findNode(m.db.tree, p)!;
  assert.deepEqual(m.db.tree.map(n => [n.path, n.folder, n.file, n.task]), [['g', true, 'g.md', '[T] G']]);
  assert.deepEqual(node('g').kids.map(k => [k.path, k.task, k.tasks]), [['g/empty', null, []], ['g/fix-login', '[T] Fix login', []], ['g/notes', null, ['[T] A', '[T] B']]]);
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
  await assert.rejects(m.apply({ op: 'create', type: 'T', title: 'X', file: 'g/mado-format.md' }), /Invalid/);

  await m.apply({ op: 'update', id: '[T] G', title: 'H' });
  assert.ok(existsSync(join(d, 'H.md')) && existsSync(join(d, 'H/notes.md')) && !existsSync(join(d, 'g')), 'merged file and folder follow a rename');
  assert.equal(node('H').task, '[T] H');
  w('H/Taken.md', 'Notes\n');
  await m.reload();
  await assert.rejects(m.apply({ op: 'update', id: '[T] Next', title: 'Taken' }), /Cannot rename H\/Next: H\/Taken already exists/);
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
