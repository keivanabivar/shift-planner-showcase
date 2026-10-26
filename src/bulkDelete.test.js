// Synthetic showcase fixtures only; never derived from real accounts or exports.
import {LEGACY_SETTINGS as DEFAULT_SETTINGS} from './legacySettings.js';
import {makeLegacyShift as makeShift} from './testFixtures.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {applyBulkDelete,buildBulkDeletePlan,bulkDeleteBranch,bulkDeleteConfirmation} from './bulkDelete.js';
import {absenceRows} from './preferences.js';
import {dateRange,reportPeriod} from './schedule.js';
import {makeVariation} from './attendance.js';
import {buildHoursReport} from './hoursReport.js';
import {EMPTY_SCHEDULE_FILTERS,filterSchedule} from './filters.js';
import {createPlannerStore} from './plannerStore.js';
import {STORAGE_KEY} from './schedule.js';
import {NOTES_KEY,SETTINGS_KEY} from './preferences.js';
import {VARIATIONS_KEY} from './attendance.js';

const scopedPlan=(data,ids,from,to,types=[])=>buildBulkDeletePlan(data,ids,from,to,types,'A');
const scopedApply=(snapshot,plan)=>applyBulkDelete(snapshot,plan,'A');
function fixture(){
  const employees=[{id:'a',name:'Demo Sample 016'},{id:'b',name:'DemoBeta'},{id:'c',name:'Demo Sample 023'}],types=['Mattina','Pomeriggio','Centrale','Riposo','Malattia','Ferie'],shifts={};
  for(const [employeeIndex,employee] of employees.entries())for(const [dayIndex,date] of dateRange('2026-10-01','2026-10-14').entries()){
    const type=types[(dayIndex+employeeIndex)%types.length];shifts[`${employee.id}|${date}`]={...makeShift(type,'10','18'),branchId:'A'};
  }
  const variations={'a|2026-10-01':makeVariation('a','2026-10-01','10','17','Uscita anticipata'),'b|2026-10-01':makeVariation('b','2026-10-01','15','22','Ritardo')};
  for(const variation of Object.values(variations))variation.branchId='A';
  return {data:{version:1,employees,shifts},variations,notes:[{id:'n',text:'Nota da conservare',date:'2026-10-01',employeeId:'a'}],settings:structuredClone(DEFAULT_SETTINGS)};
}
const memory=snapshot=>{const map=new Map([[STORAGE_KEY,JSON.stringify(snapshot.data)],[NOTES_KEY,JSON.stringify(snapshot.notes)],[SETTINGS_KEY,JSON.stringify(snapshot.settings)],[VARIATIONS_KEY,JSON.stringify(snapshot.variations)]]);return {getItem:key=>map.get(key)??null,setItem:(key,value)=>map.set(key,value),removeItem:key=>map.delete(key)};};

test('elimina i turni di un dipendente per tre giorni e conserva tutte le altre entità',()=>{const snapshot=fixture(),before=structuredClone(snapshot),plan=scopedPlan(snapshot.data,['a'],'2026-10-01','2026-10-03'),next=scopedApply(snapshot,plan);assert.equal(plan.length,3);assert.equal(Object.keys(next.data.shifts).length,Object.keys(snapshot.data.shifts).length-3);assert.deepEqual(next.data.employees,before.data.employees);assert.deepEqual(next.notes,before.notes);assert.deepEqual(next.settings,before.settings);assert.equal(next.variations['a|2026-10-01'],undefined);assert.ok(next.data.shifts['b|2026-10-01']);assert.deepEqual(snapshot,before);});
test('elimina più dipendenti per una settimana usando OR tra Mattina e Pomeriggio',()=>{const snapshot=fixture(),plan=scopedPlan(snapshot.data,['a','b'],'2026-10-01','2026-10-07',['Mattina','Pomeriggio']);assert.ok(plan.length>0);assert.ok(plan.every(item=>['a','b'].includes(item.employeeId)&&['Mattina','Pomeriggio'].includes(item.type)));const next=scopedApply(snapshot,plan);for(const item of plan)assert.equal(next.data.shifts[item.key],undefined);assert.ok(Object.values(next.data.shifts).some(shift=>shift.type==='Malattia'));assert.ok(Object.values(next.data.shifts).some(shift=>shift.type==='Ferie'));assert.ok(next.data.shifts['c|2026-10-01']);});
test('elimina tutti i dipendenti per due settimane senza eliminare dipendenti o note',()=>{const snapshot=fixture(),ids=snapshot.data.employees.map(item=>item.id),plan=scopedPlan(snapshot.data,ids,'2026-10-01','2026-10-14'),next=scopedApply(snapshot,plan);assert.equal(plan.length,42);assert.deepEqual(next.data.shifts,{});assert.deepEqual(next.variations,{});assert.deepEqual(next.data.employees,snapshot.data.employees);assert.deepEqual(next.notes,snapshot.notes);});
test('elimina soltanto Mattina e mantiene Pomeriggio, Malattia e Ferie',()=>{const snapshot=fixture(),plan=scopedPlan(snapshot.data,['a','b','c'],'2026-10-01','2026-10-14',['Mattina']),next=scopedApply(snapshot,plan);assert.ok(plan.length>0&&plan.every(item=>item.type==='Mattina'));assert.equal(Object.values(next.data.shifts).some(shift=>shift.type==='Mattina'),false);for(const type of ['Pomeriggio','Malattia','Ferie'])assert.equal(Object.values(next.data.shifts).some(shift=>shift.type===type),true);});
test('totali, report, assenze e filtri riflettono subito lo snapshot eliminato',()=>{const snapshot=fixture(),beforeHours=buildHoursReport(snapshot.data,snapshot.variations,['a'],'2026-10-01','2026-10-14')[0].planned,plan=scopedPlan(snapshot.data,['a'],'2026-10-01','2026-10-14',['Mattina','Malattia']),next=scopedApply(snapshot,plan),afterHours=buildHoursReport(next.data,next.variations,['a'],'2026-10-01','2026-10-14')[0].planned;assert.ok(afterHours<beforeHours);assert.equal(reportPeriod(next.data,'a','2026-10-01','2026-10-14').rows[0].shifts.some(value=>value.startsWith('Mattina')),false);assert.equal(absenceRows(next.data,'a','','','Malattia').length,0);assert.equal(filterSchedule(next.data,next.variations,{...EMPTY_SCHEDULE_FILTERS,shiftTypes:['Mattina']},dateRange('2026-10-01','2026-10-14'),['a']).employees.length,0);});
test('intervalli non validi e selezioni vuote non producono eliminazioni',()=>{const snapshot=fixture();assert.deepEqual(scopedPlan(snapshot.data,['a'],'2026-10-14','2026-10-01'),[]);assert.deepEqual(scopedPlan(snapshot.data,[],'2026-10-01','2026-10-14'),[]);assert.deepEqual(scopedApply(snapshot,[]),snapshot);});
test('eliminazione multipla persiste in localStorage e sopravvive alla riapertura',async()=>{const snapshot=fixture(),storage=memory(snapshot),store=createPlannerStore({storage}),plan=scopedPlan(snapshot.data,['a'],'2026-10-01','2026-10-03'),next=scopedApply(snapshot,plan);assert.equal(await store.save(next),true);const reopened=createPlannerStore({storage});assert.deepEqual(reopened.getSnapshot().snapshot,next);assert.deepEqual(reopened.getSnapshot().snapshot.notes,snapshot.notes);assert.deepEqual(reopened.getSnapshot().snapshot.data.employees,snapshot.data.employees);});

test('single-Sede preview counts actual shift branches, including a shared employee; other Sede entities remain',()=>{
 const snapshot=fixture();snapshot.data.employees[0].branchIds=['A','B'];
 snapshot.data.shifts['a|2026-10-02'].branchId='B';snapshot.data.shifts['b|2026-10-01'].branchId='B';snapshot.variations['b|2026-10-01'].branchId='B';
 snapshot.settings.presets.custom=[{id:'template-a',branchId:'A',name:'Apertura',start:'07:00',end:'15:00',color:'#123456'},{id:'template-b',branchId:'B',name:'Chiusura',start:'15:00',end:'23:00',color:'#654321'}];
 const before=structuredClone(snapshot),plan=scopedPlan(snapshot.data,['a','b','c'],'2026-10-01','2026-10-14'),next=scopedApply(snapshot,plan);
 assert.equal(plan.length,40);assert.ok(plan.every(item=>item.branchId==='A'));
 assert.deepEqual(next.data.shifts,{'a|2026-10-02':before.data.shifts['a|2026-10-02'],'b|2026-10-01':before.data.shifts['b|2026-10-01']});
 assert.deepEqual(next.variations,{'b|2026-10-01':before.variations['b|2026-10-01']});
 assert.deepEqual(next.data.employees,before.data.employees);assert.deepEqual(next.notes,before.notes);assert.deepEqual(next.settings,before.settings);assert.deepEqual(snapshot,before);
});
test('combined, missing, inactive or unauthorized Sede cannot authorize a bulk delete',()=>{
 const branches=[{id:'A',active:true,readable:true,operable:true},{id:'B',active:true,readable:true,operable:false}];
 assert.equal(bulkDeleteBranch(branches,['A']).id,'A');
 for(const ids of [[],['A','B'],['B'],['missing']])assert.equal(bulkDeleteBranch(branches,ids),null);
 assert.equal(bulkDeleteBranch([{...branches[0],active:false}],['A']),null);
 const snapshot=fixture();assert.deepEqual(buildBulkDeletePlan(snapshot.data,['a'],'2026-10-01','2026-10-14'),[]);
 const plan=scopedPlan(snapshot.data,['a'],'2026-10-01','2026-10-02');snapshot.data.shifts[plan[1].key].branchId='B';
 assert.throws(()=>scopedApply(snapshot,plan));assert.throws(()=>applyBulkDelete(snapshot,plan));assert.throws(()=>scopedApply(snapshot,[plan[0],plan[0]]));
});
test('destructive confirmation identifies the selected Sede and its count',()=>{
 assert.equal(bulkDeleteConfirmation(14,'PANTHEON'),'Stai per eliminare 14 turni dalla Sede PANTHEON.');
 assert.equal(bulkDeleteConfirmation(1,'Demo Branch Alpha'),'Stai per eliminare 1 turno dalla Sede Demo Branch Alpha.');
});

test('connected store uses the dedicated single-Sede RPC and rejects unauthorized, stale or mixed-Sede previews without writes',async()=>{
 const snapshot=fixture();snapshot.data.shifts['b|2026-10-01'].branchId='B';snapshot.variations['b|2026-10-01'].branchId='B';
 const branches=[{id:'A',active:true,readable:true,operable:true},{id:'B',active:true,readable:true,operable:false}];
 let remote={organization_id:'org-test',revision:3,empty:false,snapshot,branches,branch_revisions:{A:3,B:2},selected_branch_ids:['A','B']},writes=0;
 const repository={load:async()=>structuredClone(remote),bulkDelete:async(branch,ids,revision)=>{writes++;assert.equal(branch,'A');assert.equal(revision,3);const plan=ids.map(key=>({key,branchId:branch}));remote={...remote,revision:4,branch_revisions:{A:4,B:2},snapshot:scopedApply(remote.snapshot,plan)};return structuredClone(remote);},save:()=>assert.fail('generic save must not be used'),saveScoped:()=>assert.fail('generic branch operations must not be used')};
 const store=createPlannerStore({storage:memory(snapshot),repository,organizationId:'org-test',userId:'user-test'});await store.connect();
 const plan=scopedPlan(snapshot.data,['a','b','c'],'2026-10-01','2026-10-14');
 assert.equal(await store.bulkDelete('A',plan,2),false);assert.equal(await store.bulkDelete('B',[{key:'b|2026-10-01',branchId:'B'}],2),false);
 assert.equal(await store.bulkDelete('A',[...plan,{key:'b|2026-10-01',branchId:'A'}],3),false);assert.equal(writes,0);
 assert.equal(await store.bulkDelete('A',plan,3),true);assert.equal(writes,1);assert.ok(store.getSnapshot().snapshot.data.shifts['b|2026-10-01']);assert.ok(store.getSnapshot().snapshot.variations['b|2026-10-01']);
});
