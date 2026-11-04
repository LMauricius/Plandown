import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDb, findNode, Plandown, parseFormat, parseMarkdown } from '../index.js';
import { listEdit, tokenize } from '../gui/mdedit.js';

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
  const meta = parseFormat(parseMarkdown('plandown-format.md', '# [A] a\n---\n$meta:\n  color: teal\n  icon: x\nP: string\n---\n\n# [B] b\n---\n$meta: red\n---\n'));
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
  writeFileSync(join(d, 'bad.md'), '# [Bug] X\n---\nSeverity: huge\nFoo: 1\n---\n\nBlocks:\n- [Nope] Y\n\nRevealed:\n- [Task] Z\n');
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
