const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync(require('node:path').join(__dirname, '../app.js'), 'utf8');
const storage = () => {
  const data = {};
  Object.defineProperties(data, {
    getItem: { value(key) { return this[key] ?? null; } },
    setItem: { value(key, value) { this[key] = value; } },
    removeItem: { value(key) { delete this[key]; } }
  });
  return data;
};
const initial = () => ({ projects: [{ id: 'p', title: '영상', memo: '초안' }], currentUser: 'u' });
function harness(localStorage = storage()) {
  const remote = { value: initial(), version: '2026-09-30T01:00:00.000Z', fail: false, writes: 0, beforeWrite: null };
  const client = { from() {
    let row = null, expected;
    return {
      select() {
        if (!row) return this;
        return (async () => {
          if (remote.beforeWrite) await remote.beforeWrite();
          if (remote.fail) return { error: new Error('offline') };
          if (expected && expected !== remote.version) return { data: [] };
          remote.value = structuredClone(row.data); remote.version = row.updated_at; remote.writes++;
          return { data: [{ updated_at: remote.version }] };
        })();
      },
      eq(key, value) { if (key === 'updated_at') expected = value; return this; },
      async maybeSingle() { return remote.fail ? { error: new Error('offline') } : { data: { data: structuredClone(remote.value), updated_at: remote.version } }; },
      update(value) { row = value; return this; }, insert(value) { row = value; return this; }
    };
  } };
  const ctx = vm.createContext({ localStorage, sessionStorage: storage(), crypto: { randomUUID: () => 'tab1' }, structuredClone, console: { warn() {} },
    window: { DashboardSync: require('../lib/dashboard-sync.js') }, navigator: { onLine: true }, setTimeout: () => 1, clearTimeout() {},
    document: { activeElement: { matches: () => true } },
    getSupabaseClient: () => client, normalizeState: value => value, migrateOwnerState: value => value, resetActivityAuditSnapshot() {} });
  vm.runInContext(`const STORAGE_KEY='test'; const SUPABASE_URL='server'; const SUPABASE_ENABLED=true; const DASHBOARD_STATE_ROW_ID='main'; let currentProfile={id:'u', approved:true}; let remoteStateLoaded=false, remoteSaveTimer=null, isRemoteHydrating=false, monthlyReportSharedPromptSnapshot=''; let state=${JSON.stringify(initial())}; function mergeProfileUser() {state.currentUser='u';}`, ctx);
  vm.runInContext(source.slice(source.indexOf('let remoteBase ='), source.indexOf('async function fetchSharedLinkPayload()')), ctx);
  vm.runInContext('setSyncStatus = (status) => {syncStatus=status}; resolveSyncConflicts=async()=>"";',ctx);
  return { ctx, remote, localStorage, run: js => vm.runInContext(js, ctx) };
}

test('failed save survives reload and merges new team changes before retrying', async () => {
  const h = harness(); await h.run('loadRemoteDashboardState()');
  h.run('state.projects[0].memo="작성한 메모"; queueRemoteSave()'); h.remote.fail = true;
  assert.equal(await h.run('saveRemoteDashboardState()'), false);
  assert.equal(h.run('remotePending'), true);
  assert.match(h.localStorage.getItem('test-pending:server:u:tab1'), /작성한 메모/);
  const reloaded = harness(h.localStorage); reloaded.remote.value.projects[0].title = '팀 제목 변경';
  await reloaded.run('loadRemoteDashboardState()');
  assert.equal(reloaded.run('state.projects[0].memo'), '작성한 메모');
  assert.equal(await reloaded.run('saveRemoteDashboardState()'), true);
  assert.equal(reloaded.remote.value.projects[0].title, '팀 제목 변경');
  assert.equal(reloaded.remote.value.projects[0].memo, '작성한 메모');
  assert.equal(reloaded.localStorage.getItem('test-pending:server:u:tab1'), null);
});

test('in-flight typing is saved by a second serialized write', async () => {
  const h = harness(); await h.run('loadRemoteDashboardState()');
  h.run('state.projects[0].memo="입력1"; queueRemoteSave()');
  let release, started;
  const began = new Promise(resolve => { started = resolve; });
  h.remote.beforeWrite = async () => { h.remote.beforeWrite = null; started(); await new Promise(resolve => { release = resolve; }); };
  const saving = h.run('saveRemoteDashboardState()'); await began;
  h.run('state.projects[0].memo="입력2"; queueRemoteSave()'); release();
  assert.equal(await saving, true);
  assert.equal(h.remote.value.projects[0].memo, '입력2'); assert.equal(h.remote.writes, 2);
  assert.equal(h.run('remotePending'), false); assert.equal(h.run('syncStatus'), 'saved');
});

test('failed initial load cannot overwrite remote state with a stale local cache', async () => {
  const h = harness(); h.remote.fail = true; await h.run('loadRemoteDashboardState()');
  assert.equal(h.run('remoteStateLoaded'), false);
  assert.equal(await h.run('saveRemoteDashboardState()'), false); assert.equal(h.remote.writes, 0);
});

test('same-field conflict preserves pending edits when user postpones resolution', async () => {
  const h = harness(); await h.run('loadRemoteDashboardState()');
  h.run('state.projects[0].memo="내 메모"; queueRemoteSave()'); h.remote.value.projects[0].memo = '팀 메모';
  assert.equal(await h.run('saveRemoteDashboardState()'), false);
  assert.equal(h.run('syncStatus'), 'conflict'); assert.equal(h.remote.writes, 0);
  assert.equal(h.run('state.projects[0].memo'), '내 메모');
  assert.match(h.localStorage.getItem('test-pending:server:u:tab1'), /내 메모/);
});
