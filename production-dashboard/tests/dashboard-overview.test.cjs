const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync(require('node:path').join(__dirname,'../app.js'),'utf8');
const functionSource = (name) => { const start = source.indexOf(`function ${name}(`); return source.slice(start, source.indexOf('\nfunction ',start+1)); };
function setup() {
  const prefs = {}, calls = [];
  const context = vm.createContext({ prefs, calls, overviewScheduleRange: 'week',
    state: { projects: [{id:'p',title:'내 영상',owners:['me'],finalDate:'2026-09-30',status:'편집'},{id:'done',title:'완료 영상',owners:['me'],finalDate:'2026-09-30',broadcastCompleted:true}],
      works: [{id:'w',title:'팀 업무',owners:['other'],finalDate:'2026-09-30'},{id:'next',title:'내 다음 업무',owners:['me'],finalDate:'2026-10-01'},{id:'none',owners:['me'],finalDate:'2026-09-30',noSchedule:true}],
      schedules: [{id:'s',title:'내 일정',date:'2026-09-30',owners:['me']}],
      staffEvents: [{id:'st',title:'내 방송',date:'2026-09-30',owners:['me']}] },
    currentUser:()=>({id:'u'}), linkedOwnerIdsForUser:()=>['me'], isAdminUser:()=>false, viewPref:(key, fallback)=>prefs[key]||fallback,
    seoulNowParts:()=>({date:'2026-09-30'}), overviewWeekKeys:()=>['2026-09-28','2026-09-29','2026-09-30','2026-10-01','2026-10-02','2026-10-03','2026-10-04'],
    projectOwners:p=>p.owners, workOwners:w=>w.owners, staffReservationTitle:e=>e.title,
    openProjectDetail:id=>calls.push(['project',id]), openWorkDetail:id=>calls.push(['work',id]), openScheduleEventDetail:id=>calls.push(['schedule',id]), openStaffEventDetail:id=>calls.push(['studio',id]) });
  for (const name of ['overviewScope','overviewMatchesOwners','overviewScheduleItems','openOverviewSchedule']) vm.runInContext(functionSource(name),context);
  return { context, prefs, calls, run: code=>vm.runInContext(code,context) };
}

test('my home includes assigned schedules and unfinished deadlines; mobile today ignores desktop week', () => {
  const h=setup();
  assert.equal(h.run('overviewScope()'),'mine');
  assert.deepEqual(Array.from(h.run('overviewScheduleItems("today").map(x=>x.id)')).sort(), ['p','s','st']);
  assert.ok(Array.from(h.run('overviewScheduleItems().map(x=>x.id)')).includes('next'));
  h.prefs['overviewScope:u']='team';
  assert.ok(Array.from(h.run('overviewScheduleItems("today").map(x=>x.id)')).includes('w'));
});

test('each home schedule opens its exact entity rather than a section landing page', () => {
  const h=setup();
  for (const source of ['project','work','calendar','studio']) h.run(`openOverviewSchedule('${source}','item-${source}')`);
  assert.deepEqual(h.calls,[['project','item-project'],['work','item-work'],['schedule','item-calendar'],['studio','item-studio']]);
});
