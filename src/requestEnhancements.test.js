// Synthetic showcase fixtures only; never derived from real accounts or exports.
import {LEGACY_SETTINGS as DEFAULT_SETTINGS} from './legacySettings.js';
import {makeLegacyShift as makeShift} from './testFixtures.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {attendanceTotals} from './attendance.js';
import {buildHoursReport} from './hoursReport.js';
import {approvedPermissionRows,approvedRequestEffects,dayAccounting,permissionShiftOverlap} from './requestEffects.js';
import {applyPresetSettingsFrom} from './schedule.js';
import {requestWasAdjusted} from './requests.js';

test('permesso orario approvato conserva il turno e separa ore pianificate, permesso ed effettive',()=>{
 const data={employees:[{id:'e1',name:'Demo Sample 016'}],shifts:{'e1|2026-10-01':makeShift('Mattina','','',DEFAULT_SETTINGS)},version:1};
 const requests=[{status:'approved',employee_id:'e1',type:'Permesso',start_date:'2026-10-01',end_date:'2026-10-01',start_time:'11:00',end_time:'12:00'}];
 const effects=approvedRequestEffects(requests,data.shifts),totals=attendanceTotals(data,{},'e1',['2026-10-01'],effects),report=buildHoursReport(data,{},['e1'],'2026-10-01','2026-10-01',effects)[0];
 assert.deepEqual(totals,{planned:480,actual:420,permission:60});
 assert.deepEqual(dayAccounting(data.shifts['e1|2026-10-01'],null,effects['e1|2026-10-01']),{scheduled:480,permission:60,actual:420});
 assert.equal(report.leaveMinutes,60);assert.equal(report.days[0].permission,60);assert.match(report.days[0].reason,/Permesso approvato/);
});

test('permesso orario segue dinamicamente il turno corrente: nessuna, parziale e piena sovrapposizione',()=>{
 const request={status:'approved',employee_id:'e1',type:'Permesso',start_date:'2026-10-01',end_date:'2026-10-01',start_time:'17:00',end_time:'20:00'};
 const morning={type:'Mattina',start:'08:00',end:'16:00',off:false},partial={type:'Centrale',start:'15:00',end:'18:00',off:false},evening={type:'Pomeriggio',start:'16:00',end:'00:00',off:false};
 assert.equal(permissionShiftOverlap(morning,'17:00','20:00'),0);
 assert.equal(permissionShiftOverlap(partial,'17:00','20:00'),60);
 assert.equal(permissionShiftOverlap(evening,'17:00','20:00'),180);
 assert.equal(approvedRequestEffects([request],{'e1|2026-10-01':morning})['e1|2026-10-01'],undefined);
 assert.equal(approvedRequestEffects([request],{'e1|2026-10-01':partial})['e1|2026-10-01'].minutes,60);
 assert.equal(approvedRequestEffects([request],{'e1|2026-10-01':evening})['e1|2026-10-01'].minutes,180);
});

test('permessi sovrapposti non duplicano minuti e i turni notturni usano la vera intersezione',()=>{
 const shift={type:'Centrale',start:'22:00',end:'06:00',off:false},requests=[
  {status:'approved',employee_id:'e1',type:'Permesso',start_date:'2026-10-01',end_date:'2026-10-01',start_time:'23:00',end_time:'02:00'},
  {status:'approved',employee_id:'e1',type:'Permesso',start_date:'2026-10-01',end_date:'2026-10-01',start_time:'01:00',end_time:'03:00'}
 ];
 assert.equal(approvedRequestEffects(requests,{'e1|2026-10-01':shift})['e1|2026-10-01'].minutes,240);
});

test('Assenze mostra solo i Permessi approvati usando i valori effettivi approvati',()=>{
 const requests=[
  {id:'approved',employee_id:'e1',employee_name:'Demo Record 015',type:'Permesso',status:'approved',start_date:'2026-10-01',end_date:'2026-10-02',start_time:'09:00',end_time:'10:00',approved_start_time:'10:30',approved_end_time:'11:30'},
  {id:'pending',employee_id:'e1',type:'Permesso',status:'pending',start_date:'2026-10-03',end_date:'2026-10-03'}
 ];
 const rows=approvedPermissionRows(requests,[{id:'e1',name:'Demo Sample 016'}]);
 assert.deepEqual(rows.map(row=>[row.employeeName,row.date,row.type,row.time]),[['Demo Sample 016','2026-10-01','Permesso','10:30–11:30'],['Demo Sample 016','2026-10-02','Permesso','10:30–11:30']]);
});

test('cambio modello conserva tutte le assegnazioni esistenti',()=>{
 const previous=structuredClone(DEFAULT_SETTINGS),next=structuredClone(DEFAULT_SETTINGS);next.presets.Mattina={start:'08:00',end:'16:00'};
 const data={version:1,employees:[{id:'e1',name:'Demo Sample 016'}],shifts:{
  'e1|2026-09-25':makeShift('Mattina','','',previous),
  'e1|2026-10-02':makeShift('Mattina','','',previous),
  'e1|2026-10-03':{type:'Mattina',start:'07:00',end:'13:00',off:false}
 }};
 const changed=applyPresetSettingsFrom(data,previous,next,'2026-10-01');
 assert.deepEqual(changed.shifts['e1|2026-09-25'],data.shifts['e1|2026-09-25']);
 assert.deepEqual(changed.shifts['e1|2026-10-02'],data.shifts['e1|2026-10-02']);
 assert.deepEqual(changed.shifts['e1|2026-10-03'],data.shifts['e1|2026-10-03']);
});

test('approvazione modificata viene rilevata senza sovrascrivere i dettagli originali',()=>{
 const original={type:'Permesso',start_date:'2026-10-01',end_date:'2026-10-01',start_time:'10:00',end_time:'11:00'};
 assert.equal(requestWasAdjusted({...original,approved_type:'Permesso',approved_start_date:'2026-10-01',approved_end_date:'2026-10-01',approved_start_time:'10:00',approved_end_time:'11:00'}),false);
 assert.equal(requestWasAdjusted({...original,approved_type:'Permesso',approved_start_date:'2026-10-01',approved_end_date:'2026-10-01',approved_start_time:'10:30',approved_end_time:'11:30'}),true);
});
