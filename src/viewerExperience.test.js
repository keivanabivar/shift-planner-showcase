// Synthetic showcase fixtures only; never derived from real accounts or exports.
import test from 'node:test';
import assert from 'node:assert/strict';
import {navigationForRole,plannerCanWrite,reportEmployeeIds} from './permissions.js';
import {canCancelRequest,canEditRequest,visibleRequests} from './requests.js';
import {clampVisibleDays,densityForDays,isWeekend,monthRange,shiftAbbreviation,startOfWeek,timelineDays,zoomAnchorPosition,zoomStartForAnchor} from './timeline.js';
import {dateKey,parseDate} from './schedule.js';

const viewer={role:'viewer',user_id:'viewer-1',employee_id:'employee-1'};
test('sidebar viewer mostra viste condivise e nasconde amministrazione e Assenze',()=>{
 const labels=navigationForRole('viewer').map(item=>item[2]);
 assert.deepEqual(labels,['Pianificazione','Dipendenti','Note','Richieste','Report ore','Archivio','Account']);
 assert.ok(!labels.includes('Assenze'));assert.ok(!labels.includes('Impostazioni account'));assert.ok(!labels.includes('Utenti e accessi'));
 assert.ok(navigationForRole('admin').some(item=>item[0]==='access'));
 assert.ok(navigationForRole('editor').some(item=>item[0]==='settings'));
});

test('viewer resta in sola lettura per i turni',()=>{
 assert.equal(plannerCanWrite('viewer','connected'),false);
 assert.equal(plannerCanWrite('viewer','local'),false);
 assert.equal(plannerCanWrite('editor','connected'),true);
});
test('report viewer è limitato al dipendente collegato e resta vuoto senza collegamento',()=>{
 const employees=[{id:'employee-1'},{id:'employee-2'}];
 assert.deepEqual(reportEmployeeIds(viewer,employees),['employee-1']);
 assert.deepEqual(reportEmployeeIds({...viewer,employee_id:null},employees),[]);
 assert.deepEqual(reportEmployeeIds({role:'editor'},employees),['employee-1','employee-2']);
});
test('viewer vede pending del team e tutta la propria storia ma modifica solo il proprio pending',()=>{
 const requests=[
  {id:'own-final',employee_id:'employee-1',created_by_user_id:'admin',status:'approved'},
  {id:'own-pending',employee_id:'employee-1',created_by_user_id:'viewer-1',status:'pending'},
  {id:'other-pending',employee_id:'employee-2',created_by_user_id:'other',status:'pending'},
  {id:'other-final',employee_id:'employee-2',created_by_user_id:'other',status:'rejected'}
 ];
 assert.deepEqual(visibleRequests(requests,viewer).map(item=>item.id),['own-final','own-pending','other-pending']);
 assert.equal(canEditRequest(requests[1],viewer),true);assert.equal(canCancelRequest(requests[1],viewer),true);
 assert.equal(canEditRequest(requests[2],viewer),false);assert.equal(canCancelRequest(requests[0],viewer),false);
 assert.equal(visibleRequests(requests,{role:'admin'}).length,4);assert.equal(visibleRequests(requests,{role:'editor'}).length,4);
});
test('timeline accetta ogni valore 7–31 e applica densità adattiva',()=>{
 assert.equal(clampVisibleDays(2),7);assert.equal(clampVisibleDays(31),31);assert.equal(clampVisibleDays(44),31);
 for(const days of [7,8,10,12,14,18,21,25,31])assert.equal(timelineDays(parseDate('2026-09-21'),days).length,days+62);
 assert.equal(densityForDays(7),'comfortable');assert.equal(densityForDays(12),'condensed');assert.equal(densityForDays(31),'compact');
});
test('Oggi/Settimana usa sempre lunedì-domenica e Mese usa il mese completo',()=>{
 assert.equal(dateKey(startOfWeek(parseDate('2026-09-26'))),'2026-09-21');
 assert.deepEqual({start:dateKey(monthRange('2024-02-18').start),days:monthRange('2024-02-18').days},{start:'2024-02-01',days:29});
 assert.deepEqual({start:dateKey(monthRange('2026-09-26').start),days:monthRange('2026-09-26').days},{start:'2026-09-01',days:30});
});
test('abbreviazioni, weekend e ancoraggio zoom sono stabili',()=>{
 assert.equal(shiftAbbreviation('Mattina'),'M');assert.equal(shiftAbbreviation('Malattia'),'ML');assert.equal(shiftAbbreviation('Pomeriggio'),'P');assert.equal(shiftAbbreviation('Turno notte'),'TN');
 assert.equal(isWeekend(parseDate('2026-09-26')),true);assert.equal(isWeekend(parseDate('2026-09-28')),false);
 assert.equal(dateKey(zoomStartForAnchor(parseDate('2026-09-26'),240,60)),'2026-09-22');
});
test('ancora zoom usa solo un hover planner valido e altrimenti torna al centro',()=>{
 const base={now:1000,rectLeft:100,viewportWidth:1000,employeeWidth:158,totalWidth:105};
 assert.deepEqual(zoomAnchorPosition({...base,hover:{inside:true,date:'2026-09-26',clientX:500,at:900}}),{x:400,date:'2026-09-26',source:'planner'});
 assert.deepEqual(zoomAnchorPosition({...base,hover:{inside:false,date:'2026-09-26',clientX:500,at:900}}),{x:526.5,date:null,source:'center'});
 assert.deepEqual(zoomAnchorPosition({...base,hover:{inside:true,date:'2026-09-26',clientX:500,at:-1000}}),{x:526.5,date:null,source:'center'});
 assert.deepEqual(zoomAnchorPosition({...base,hover:null}),{x:526.5,date:null,source:'center'});
});
