const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
function fn(name) {
  const start = source.indexOf(`function ${name}(`);
  const end = source.indexOf('\nfunction ', start + 1);
  return source.slice(start, end < 0 ? undefined : end);
}
function harness() {
  const timers = new Map(); let next = 0;
  const ctx = vm.createContext({ structuredClone, timers,
    setTimeout: callback => { timers.set(++next, callback); return next; }, clearTimeout: id => timers.delete(id),
    uniqueValues: values => [...new Set(values)],
    captureDetailedActivityLogs() {}, resetActivityAuditSnapshot() {}, pruneActivityLogs: rows => rows,
    notificationActor: () => ({ name: 'PD' }), isUnassignedStudioOwner: owner => !owner,
  });
  vm.runInContext(`const SUPABASE_ENABLED=true; let queued=0, renders=0, notices=[];
    let state={staffEvents:[{id:'e',title:'촬영',date:'2026-10-01',owners:['a'],owner:'a',staffRows:[{id:'r1',type:'촬영',owner:'a',memo:''}]}],activityLogs:[]};
    let mobileStudioDetailId='e', mobileStudioDetailDraft={staffRows:structuredClone(state.staffEvents[0].staffRows)}, mobileStudioFormOpen=false, mobileStudioFormDraft=null, mobileStudioDeleteConfirm=false;
    function queueRemoteSave(){queued++} function renderMobileDashboard(){renders++}
    function notifyOwners(owners,message,meta){notices.push({owners,message,meta})}
  `, ctx);
  vm.runInContext(source.slice(source.indexOf('let basicAuditTimer ='), source.indexOf('function isSharedGuestItem(')), ctx);
  for (const name of ['normalizeStaffEventRows', 'syncStaffEventSummary', 'mobileStudioFormRows', 'saveMobileStudioStaffOnly', 'moveMobileStudioRow', 'closeMobileStudioDetail']) vm.runInContext(fn(name), ctx);
  return { run: code => vm.runInContext(code, ctx), flush() { const callbacks = [...timers.values()]; timers.clear(); callbacks.forEach(callback => callback()); } };
}
test('mobile staff memo autosaves immediately without a button, rerender or unstable row IDs', () => {
  const h = harness();
  h.run(`mobileStudioDetailDraft.staffRows[0].memo='메모'; saveMobileStudioStaffOnly()`);
  assert.equal(h.run('state.staffEvents[0].staffRows[0].memo'), '메모');
  assert.equal(h.run('state.staffEvents[0].staffRows[0].id'), 'r1');
  assert.equal(h.run('queued'), 1); assert.equal(h.run('renders'), 0);
  h.run('saveMobileStudioStaffOnly()'); assert.equal(h.run('queued'), 1, 'duplicate change events do not resave');
});
test('owner changes and rapid typing batch one team notice, including previous and new owners', () => {
  const h = harness();
  h.run(`mobileStudioDetailDraft.staffRows[0].owner='b'; saveMobileStudioStaffOnly(); mobileStudioDetailDraft.staffRows[0].memo='1'; saveMobileStudioStaffOnly(); mobileStudioDetailDraft.staffRows[0].memo='12'; saveMobileStudioStaffOnly()`);
  assert.equal(h.run('state.staffEvents[0].owner'), 'b');
  assert.equal(h.run('notices.length'), 0); h.flush();
  assert.equal(h.run('notices.length'), 1);
  assert.deepEqual(Array.from(h.run('notices[0].owners')).sort(), ['a', 'b']);
  assert.equal(h.run('pendingBasicNotifications.size'), 0);
});
test('staff order and closing retain edits; new schedule form changes stay drafts', () => {
  const h = harness();
  h.run(`mobileStudioDetailDraft.staffRows.push({id:'r2',type:'음향',owner:'b',memo:''}); saveMobileStudioStaffOnly(); moveMobileStudioRow('r2',-1)`);
  assert.equal(h.run('state.staffEvents[0].staffRows[0].id'), 'r2');
  h.run('closeMobileStudioDetail()');
  assert.equal(h.run('state.staffEvents[0].staffRows[0].owner'), 'b');
  assert.equal(h.run('notices.length'), 1);
  h.run(`mobileStudioDetailId='e'; mobileStudioDetailDraft={staffRows:structuredClone(state.staffEvents[0].staffRows)}; mobileStudioFormOpen=true; mobileStudioDetailDraft.staffRows[0].memo='미확정'; saveMobileStudioStaffOnly()`);
  assert.equal(h.run('state.staffEvents[0].staffRows[0].memo'), '');
});
test('save status stays inside details, and dynamically created retry buttons use delegation', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'dashboard-improvements.css'), 'utf8');
  assert.doesNotMatch(html, /id="saveStatus"/);
  assert.match(html, /id="detailTitle"[^\n]+\n\s*<div class="save-status" data-save-status/);
  assert.match(html, /id="workDetailTitle"[^\n]+\n\s*<div class="save-status" data-save-status/);
  assert.doesNotMatch(css.match(/\.save-status \{[^}]+\}/)[0], /position:\s*fixed|bottom:/);
  assert.match(source, /document\.addEventListener\("click", async \(event\) => \{\s*if \(!event\.target\.closest\("\[data-save-retry\]"\)\) return/);
});
