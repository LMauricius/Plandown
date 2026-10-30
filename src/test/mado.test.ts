import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Mado, parseFormat, parseMarkdown } from '../index.js';

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
  assert.equal(m.db.tasks['[Task] Stabilize the SQueLe core API'].description, 'The query library everything else builds on.');
  assert.deepEqual(m.db.totals['[Task] Game-ready 3D engine'], { effort: 26, spent: 3.5 });
  assert.equal(m.db.tasks['[Task] Port EAA shadows'].occurrences.length, 2);
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

  await m.apply({ op: 'update', id: '[Task] Smart scene graph', title: 'Scene graph', props: { Priority: 2 }, description: 'Flat prop list.' });
  const sg = m.db.tasks['[Task] Scene graph'];
  assert.equal(sg.description, 'Flat prop list.');
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
  await m.apply({ op: 'update', id: '[Task] Scene graph', title: 'Smart scene graph', props: {}, description: 'The scene is a flat list of props; the engine builds the optimal structure.' });
  assert.equal(read(d, 'roadmap.md'), before, 'round trip restores the file byte for byte');
  assert.deepEqual(m.db.diagnostics, []);
});

test('edits: refuse to write over files changed on disk', async () => {
  const d = copy(), m = await Mado.open(d);
  writeFileSync(join(d, 'roadmap.md'), read(d, 'roadmap.md') + '\nexternal\n');
  await assert.rejects(m.apply({ op: 'delete', id: '[Bug] Shadow acne on EAA shadows' }), /changed on disk/);
  assert.ok(read(d, 'roadmap.md').endsWith('external\n'));
});
