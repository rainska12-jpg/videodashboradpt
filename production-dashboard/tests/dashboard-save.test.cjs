const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync(require('node:path').join(__dirname, '../app.js'), 'utf8');
const storage = () => {
  const data = {};
  Object.defineProperties(data, {
    getItem: { configurable: true, value(key) { return this[key] ?? null; } },
    setItem: { configurable: true, value(key, value) { this[key] = value; } },
    removeItem: { configurable: true, value(key) { delete this[key]; } }
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
  vm.runInContext('const actualSetSyncStatus = setSyncStatus; setSyncStatus = (status) => {syncStatus=status}; resolveSyncConflicts=async()=>"";',ctx);
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

function quotaStorage(limit) {
  const data = storage(), write = data.setItem;
  Object.defineProperty(data, 'setItem', { value(key, value) {
    const bytes = Object.keys(this).filter(k => k !== key).reduce((sum, k) => sum + 2 * (k.length + this[k].length), 0) + 2 * (key.length + value.length);
    if (bytes > limit) { const error = new Error('Quota'); error.name = 'QuotaExceededError'; throw error; }
    write.call(this, key, value);
  } });
  return data;
}

test('a 2.1 MiB dashboard exceeds 5 MiB with the old full recovery copies but compact recovery saves', async () => {
  const data = quotaStorage(5 * 1024 * 1024), h = harness(data);
  h.remote.value.archive = 'x'.repeat(1100000);
  await h.run('loadRemoteDashboardState()');
  h.run('state.projects[0].memo="추가 입력"');
  assert.throws(() => data.setItem('test-pending:server:u:tab1', h.run('JSON.stringify({base:remoteBase,local:state})')), { name: 'QuotaExceededError' });
  h.run('queueRemoteSave()');
  assert.ok(data.getItem('test-pending:server:u:tab1').length < 1000);
  assert.equal(h.run('browserStorageFailure'), null);
  assert.equal(await h.run('saveRemoteDashboardState()'), true);
  assert.equal(h.remote.value.projects[0].memo, '추가 입력');
});

test('exhausted browser storage does not stop server saves or report a false server failure', async () => {
  const data = quotaStorage(0), h = harness(data);
  await h.run('loadRemoteDashboardState()');
  h.run('state.projects[0].memo="서버에는 저장해야 하는 메모"; queueRemoteSave()');
  assert.equal(h.run('browserStorageFailure'), 'storage-quota');
  assert.equal(h.run('remoteSaveTimer'), 1, 'automatic server save is still scheduled');
  assert.equal(await h.run('saveRemoteDashboardState()'), true);
  assert.equal(h.remote.value.projects[0].memo, '서버에는 저장해야 하는 메모');
  assert.equal(h.run('remotePending'), false);
  assert.equal(h.run('browserStorageFailure'), null);
  assert.equal(h.run('syncStatus'), 'saved');
});

test('browser quota plus offline failure retains in-memory input and warns that recovery is unavailable', async () => {
  const h = harness(quotaStorage(0)); await h.run('loadRemoteDashboardState()');
  h.run('state.projects[0].memo="백업이 필요한 메모"; queueRemoteSave()'); h.remote.fail = true;
  assert.equal(await h.run('saveRemoteDashboardState()'), false);
  assert.equal(h.run('remotePending'), true);
  assert.equal(h.run('browserStorageFailure'), 'storage-quota');
  assert.equal(h.run('state.projects[0].memo'), '백업이 필요한 메모');
});

test('legacy full recovery snapshots migrate safely after a successful server save', async () => {
  const data = storage(), b = initial(), l = initial(); l.projects[0].memo = '이전 업데이트 미저장 메모';
  data.setItem('test-pending:server:u:tab1', JSON.stringify({ base: b, local: l }));
  const h = harness(data); h.remote.value.projects[0].title = '팀 변경 제목';
  await h.run('loadRemoteDashboardState()');
  assert.equal(JSON.parse(data.getItem('test-pending:server:u:tab1')).version, 2);
  assert.equal(await h.run('saveRemoteDashboardState()'), true);
  assert.equal(h.remote.value.projects[0].memo, '이전 업데이트 미저장 메모');
  assert.equal(h.remote.value.projects[0].title, '팀 변경 제목');
  assert.equal(data.getItem('test-pending:server:u:tab1'), null);
});

test('a failed optional cache write or cleanup does not turn a confirmed save into failure', async () => {
  const data = storage(), originalWrite = data.setItem;
  Object.defineProperty(data, 'setItem', { value(key, value) {
    if (key === 'test') { const error = new Error('quota'); error.name = 'QuotaExceededError'; throw error; }
    originalWrite.call(this, key, value);
  } });
  Object.defineProperty(data, 'removeItem', { value() { const error = new Error('blocked'); error.name = 'SecurityError'; throw error; } });
  const h = harness(data); await h.run('loadRemoteDashboardState()');
  h.run('state.projects[0].memo="확인된 저장"; queueRemoteSave()');
  assert.equal(await h.run('saveRemoteDashboardState()'), true);
  assert.equal(h.remote.value.projects[0].memo, '확인된 저장');
  assert.equal(h.run('remotePending'), false); assert.equal(h.run('syncStatus'), 'saved');
});

test('storage denial and serialization errors are not classified as insufficient device space', async () => {
  const h = harness();
  assert.equal(h.run('browserStorageErrorKind({name:"SecurityError"})'), 'storage-blocked');
  assert.equal(h.run('browserStorageErrorKind({name:"TypeError"})'), 'storage-error');
  assert.equal(h.run('browserStorageErrorKind({name:"QuotaExceededError"})'), 'storage-quota');
});

test('the status text does not claim offline data is backed up when the browser write failed', async () => {
  const h = harness(quotaStorage(0)); await h.run('loadRemoteDashboardState()');
  const nodes = { '[data-save-label]': {}, '[data-save-retry]': {}, '[data-save-backup]': {} };
  const bar = { dataset: {}, querySelector: key => nodes[key] };
  h.ctx.document.getElementById = () => ({});
  h.ctx.document.querySelectorAll = () => [bar];
  h.ctx.showToast = () => {};
  h.ctx.currentUser = () => ({ id: 'u' });
  h.run('state.projects[0].memo="미저장"; queueRemoteSave(); actualSetSyncStatus("offline")');
  assert.match(nodes['[data-save-label]'].textContent, /브라우저 저장 한도 초과/);
  assert.match(nodes['[data-save-label]'].textContent, /내용 백업/);
  assert.doesNotMatch(nodes['[data-save-label]'].textContent, /기기 저장 공간 부족|보관 중/);
  assert.equal(nodes['[data-save-backup]'].hidden, false);
  await h.run('saveRemoteDashboardState()'); h.run('actualSetSyncStatus("saved")');
  assert.equal(nodes['[data-save-label]'].textContent, '저장 완료');
  assert.equal(nodes['[data-save-backup]'].hidden, true);
});

test('browser storage access denial still permits loading and saving server data', async () => {
  const data = storage();
  for (const key of ['getItem', 'setItem']) Object.defineProperty(data, key, { value() { const error = new Error('blocked'); error.name = 'SecurityError'; throw error; } });
  const h = harness(data); await h.run('loadRemoteDashboardState()');
  assert.equal(h.run('remoteStateLoaded'), true);
  h.run('state.projects[0].memo="저장 차단 환경의 수정"; queueRemoteSave()');
  assert.equal(h.run('browserStorageFailure'), 'storage-blocked');
  assert.equal(await h.run('saveRemoteDashboardState()'), true);
  assert.equal(h.remote.value.projects[0].memo, '저장 차단 환경의 수정');
});
