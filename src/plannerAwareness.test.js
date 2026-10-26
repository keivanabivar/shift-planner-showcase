// Synthetic showcase fixtures only; never derived from real accounts or exports.
import test from 'node:test';
import assert from 'node:assert/strict';
import {plannerAwareness,isForeignShift,protectedAssignment,assertPlannerShiftSafety,branchMarker} from './plannerAwareness.js';
import {filterSnapshotByBranches,branchLabelForShift,mergeScopedSnapshot,branchOperations} from './branchPersistence.js';
import {emptySnapshot} from './plannerStore.js';
import {attendanceTotals,makeVariation} from './attendance.js';
import {reportPeriod} from './schedule.js';
import {assignmentConflicts,applyBulkAssignment} from './bulkEditing.js';
import {rangePlan,applyRange} from './schedule.js';
import {buildDayCopy,copyConflicts,applyShiftCopy} from './copyShifts.js';
const branches=[{id:'roma',name:'Demo Branch Alpha',active:true,readable:true,operable:true},{id:'milano',name:'Demo Branch Beta',active:true,readable:true,operable:true}];
function fixture(){return {...emptySnapshot(),data:{version:1,employees:[{id:'shared',name:'Demo Sample 016 Test',homeBranchId:'roma',branchIds:['roma','milano']},{id:'m-only',name:'Demo Fixture 103',homeBranchId:'milano',branchIds:['milano']}],shifts:{'shared|2027-02-01':{branchId:'roma',type:'Apertura',off:false,start:'07:00',end:'15:00',presetId:'a',presetName:'Apertura',presetColor:'#123456'},'shared|2027-02-02':{branchId:'milano',type:'Magazzino 2',off:false,start:'22:00',end:'06:00',presetId:'b',presetName:'Magazzino 2',presetColor:'#654321'},'m-only|2027-02-02':{branchId:'milano',type:'Riposo',off:true}}},variations:{'shared|2027-02-02':{...makeVariation('shared','2027-02-02','22:30','05:30','Ritardo'),branchId:'milano'}}};}

test('Demo Branch Alpha planner retains authorized Demo Branch Beta assignment for the same employee; real scope/snapshot are unchanged',()=>{
 const snapshot=fixture(),before=structuredClone(snapshot),scoped=filterSnapshotByBranches(snapshot,['roma']),aware=plannerAwareness(snapshot,['roma']);
 assert.equal(scoped.data.shifts['shared|2027-02-02'],undefined);assert.deepEqual(aware.data.shifts['shared|2027-02-02'],before.data.shifts['shared|2027-02-02']);assert.equal(aware.data.shifts['shared|2027-02-02'].branchId,'milano');assert.ok(aware.variations['shared|2027-02-02']);
 assert.deepEqual(aware.data.employees.map(e=>e.id),['shared']);assert.equal(aware.data.shifts['m-only|2027-02-02'],undefined);assert.deepEqual(snapshot,before);
 assert.equal(isForeignShift(aware.data.shifts['shared|2027-02-02'],['roma']),true);assert.equal(isForeignShift(aware.data.shifts['shared|2027-02-01'],['roma']),false);
 assert.equal(branchLabelForShift(aware.data.shifts['shared|2027-02-02'],aware.data.employees[0],branches,['roma']),'Demo Branch Beta');assert.equal(branchLabelForShift(aware.data.shifts['shared|2027-02-01'],aware.data.employees[0],branches,['roma']),'');
});
test('awareness never widens a database-authorized snapshot',()=>{
 const snapshot=fixture();delete snapshot.data.shifts['shared|2027-02-02'];delete snapshot.variations['shared|2027-02-02'];assert.equal(plannerAwareness(snapshot,['roma']).data.shifts['shared|2027-02-02'],undefined);
});
test('compact/mobile Sede markers preserve full identity and disambiguate equal abbreviations',()=>{
 const foreign=fixture().data.shifts['shared|2027-02-02'];assert.equal(branchMarker(foreign,branches),'Demo Branch Beta');assert.equal(branchMarker(foreign,branches,true),'DBB');
 const names=[...branches,{id:'mantova',name:'Demo Branch Bridge'}];assert.notEqual(branchMarker(foreign,names,true),branchMarker({branchId:'mantova'},names,true));assert.equal(branchMarker(foreign,names),'Demo Branch Beta');
});
test('single-Sede totals/reports/exports exclude foreign awareness while combined totals count each assignment once',()=>{
 const snapshot=fixture(),dates=['2027-02-01','2027-02-02'],scoped=filterSnapshotByBranches(snapshot,['roma']),aware=plannerAwareness(snapshot,['roma']);
 assert.equal(Object.keys(aware.data.shifts).length,2);assert.deepEqual(attendanceTotals(scoped.data,scoped.variations,'shared',dates,{'shared|2027-02-02':{minutes:60}}),{planned:480,actual:480});
 assert.equal(reportPeriod(scoped.data,'shared',dates[0],dates[1]).rows[0].total,'8 h');assert.equal(reportPeriod(scoped.data,'shared',dates[0],dates[1]).rows[0].shifts.some(s=>s.includes('Magazzino')),false);
 const combined=plannerAwareness(snapshot,['roma','milano']);assert.equal(combined.data.employees.filter(e=>e.id==='shared').length,1);assert.equal(Object.keys(combined.data.shifts).length,3);assert.equal(attendanceTotals(combined.data,combined.variations,'shared',dates).planned,960);assert.equal(isForeignShift(combined.data.shifts['shared|2027-02-02'],['roma','milano']),false);
});
test('ordinary local edits remain allowed; foreign edits/deletion/reclassification fail before persistence',()=>{
 const snapshot=fixture(),aware=plannerAwareness(snapshot,['roma']);const local=applyBulkAssignment(snapshot.data,'shared',['2027-02-01'],{...aware.data.shifts['shared|2027-02-01'],start:'08:00'});assert.equal(assertPlannerShiftSafety(snapshot.data,local,['roma']),true);
 for(const edit of [s=>s.start='23:00',s=>s.branchId='roma']){const next=structuredClone(aware.data);edit(next.shifts['shared|2027-02-02']);assert.throws(()=>assertPlannerShiftSafety(snapshot.data,next,['roma']),/altra Sede/);}
 const next=structuredClone(aware.data);delete next.shifts['shared|2027-02-02'];assert.throws(()=>assertPlannerShiftSafety(snapshot.data,next,['roma']),/altra Sede/);
 const own=structuredClone(snapshot.data);own.shifts['shared|2027-02-02'].start='23:00';assert.equal(assertPlannerShiftSafety(snapshot.data,own,['milano']),true);own.shifts['shared|2027-02-02'].branchId='roma';assert.throws(()=>assertPlannerShiftSafety(snapshot.data,own,['roma','milano']),/altra Sede/);
});
test('range and copy conflicts detect the real existing Sede; skip occupied dates, never create a second daily assignment',()=>{
 const snapshot=fixture(),scoped=filterSnapshotByBranches(snapshot,['roma']),aware=plannerAwareness(snapshot,['roma']),entry=aware.data.shifts['shared|2027-02-01'],date='2027-02-02';
 assert.deepEqual(assignmentConflicts(aware.data,'shared',[date],entry),[date]);assert.equal(protectedAssignment(aware.data.shifts['shared|'+date],['roma'],entry.branchId),true);
 assert.deepEqual(rangePlan(aware.data,'shared',date,'2027-02-03').conflicts,[date]);
 const range=applyRange(aware.data,'shared',[date,'2027-02-03'],entry,'empty');assert.deepEqual(range.shifts['shared|'+date],snapshot.data.shifts['shared|'+date]);assert.equal(Object.keys(range.shifts).length,3);
 const entries=buildDayCopy(scoped.data,'shared','2027-02-01',[date,'2027-02-03']);assert.equal(copyConflicts(aware.data,entries).length,1);const copied=applyShiftCopy(aware.data,entries,'empty');assert.deepEqual(copied.shifts['shared|'+date],snapshot.data.shifts['shared|'+date]);
 const next={...scoped,data:copied};const merged=mergeScopedSnapshot(snapshot,scoped,next);assertPlannerShiftSafety(snapshot.data,merged.data,['roma']);assert.ok(branchOperations(snapshot,merged).every(op=>op.branchId==='roma'));
 const replaced=applyShiftCopy(aware.data,entries,'replace');assert.throws(()=>assertPlannerShiftSafety(snapshot.data,replaced,['roma']),/altra Sede/);
 // The model permits one shift per employee/date even if the new times would not overlap.
 const nonOverlapping={...entry,start:'07:00',end:'09:00'};assert.deepEqual(assignmentConflicts(aware.data,'shared',[date],nonOverlapping),[date]);
});
