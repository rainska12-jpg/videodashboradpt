const test = require('node:test');
const assert = require('node:assert/strict');
const { merge, commit } = require('../lib/dashboard-sync.js');
const base = () => ({ projects: [{ id: 'p1', title: '영상', memo: '초안', status: '기획' }], works: [{ id: 'w1', tasks: [{ id: 't1', text: '촬영', done: false }] }], currentUser: 'a' });

test('different fields and nested tasks from two team members survive together', () => {
  const b = base(), l = base(), r = base();
  l.projects[0].memo = '내 메모';
  r.projects[0].status = '편집';
  r.works[0].tasks[0].done = true;
  r.currentUser = 'b';
  const result = merge(b, l, r);
  assert.equal(result.conflicts.length, 0);
  assert.equal(result.value.projects[0].memo, '내 메모');
  assert.equal(result.value.projects[0].status, '편집');
  assert.equal(result.value.works[0].tasks[0].done, true);
});

test('concurrent additions merge and unchanged deletions are retained', () => {
  const b = base(), l = base(), r = base();
  l.projects.push({ id: 'p2', title: '새 영상' });
  r.projects.push({ id: 'p3', title: '팀 영상' });
  l.works = [];
  const result = merge(b, l, r);
  assert.deepEqual(result.value.projects.map(p => p.id), ['p1', 'p2', 'p3']);
  assert.deepEqual(result.value.works, []);
  assert.equal(result.conflicts.length, 0);
});

test('same memo and delete-versus-edit require a decision; neither silently overwrites', () => {
  const b = base(), l = base(), r = base();
  l.projects[0].memo = '내 메모'; r.projects[0].memo = '팀 메모';
  assert.deepEqual(merge(b, l, r).conflicts[0].path, ['projects', 'p1', 'memo']);
  assert.equal(merge(b, l, r, 'remote').value.projects[0].memo, '팀 메모');
  l.projects = [];
  assert.equal(merge(b, l, r).conflicts.length, 1);
  assert.equal(merge(b, l, r, 'remote').value.projects.length, 1);
});

test('typing during a save is rebased without losing newer input or team changes', () => {
  const snapshot = base(), current = base(), committed = base();
  snapshot.projects[0].memo = '입력'; current.projects[0].memo = '입력 중 새 내용';
  committed.projects[0].memo = '입력'; committed.projects[0].status = '편집';
  const next = merge(snapshot, current, committed, 'local').value;
  assert.equal(next.projects[0].memo, '입력 중 새 내용');
  assert.equal(next.projects[0].status, '편집');
});

test('compare-and-swap race rereads latest state before retrying', async () => {
  const b = base(), l = base(); l.projects[0].memo = '새 메모';
  let server = base(), version = 1, writes = 0;
  const value = await commit({ base: b, local: l,
    read: async () => ({ value: structuredClone(server), version }),
    write: async (value, expected) => {
      if (++writes === 1) { server.projects[0].status = '촬영'; version++; return false; }
      assert.equal(expected, version); server = value; return true;
    }, resolve: async () => { throw new Error('No conflict expected'); }
  });
  assert.equal(writes, 2); assert.equal(value.projects[0].memo, '새 메모');
  assert.equal(value.projects[0].status, '촬영');
});

test('cancelled conflicts and network failures never write', async () => {
  const b = base(), l = base(), r = base();
  l.projects[0].memo = 'mine'; r.projects[0].memo = 'theirs';
  let writes = 0;
  await assert.rejects(commit({ base: b, local: l, read: async () => ({ value: r, version: 1 }), write: async () => { writes++; }, resolve: async () => '' }), /CONFLICT/);
  await assert.rejects(commit({ base: b, local: l, read: async () => { throw new Error('offline'); }, write: async () => { writes++; } }), /offline/);
  assert.equal(writes, 0);
});

test('a conflict that changes again during resolution is shown again', async () => {
  const b = base(), l = base(), r = base();
  l.projects[0].memo = 'mine'; r.projects[0].memo = 'theirs';
  let resolutions = 0, writes = 0;
  const result = await commit({ base: b, local: l,
    read: async () => ({ value: r, version: writes }),
    resolve: async () => { resolutions++; return 'remote'; },
    write: async () => { if (!writes++) { r.projects[0].memo = 'newer'; return false; } return true; }
  });
  assert.equal(resolutions, 2); assert.equal(result.projects[0].memo, 'newer');
});
