// Synthetic showcase fixtures only; never derived from real accounts or exports.
import test from 'node:test';
import assert from 'node:assert/strict';
import {DEFAULT_SETTINGS,validSettings} from './preferences.js';
import {emptySnapshot} from './plannerStore.js';
import {makeShift,settingsForBranch,shiftOptions,shiftColor,shiftType,minutes,reportPeriod,applyPresetSettings} from './schedule.js';
import {canonical,backupText,parseBackup,validateSnapshot} from './persistence.js';
import {branchOperations,filterSnapshotByBranches,mergeScopedSnapshot} from './branchPersistence.js';
import {copyShiftValue,buildDayCopy,applyShiftCopy} from './copyShifts.js';
import {shiftAbbreviation} from './timeline.js';
import {makeVariation,attendanceTotals} from './attendance.js';
import {buildHoursReport} from './hoursReport.js';
import {hoursReportCsv,createHoursPdf} from './hoursExport.js';
import {monthlySchedule,printDocument,createMonthlySchedulePdf,createSchedulePdf} from './export.js';
import {archiveJson,archiveCsv,createArchivePackage} from './archive.js';
const ta={id:'00000000-0000-0000-0000-000000000001',branchId:'a',name:'Mattina',start:'22:00',end:'06:00',color:'#123ABC'};
const tb={...ta,id:'00000000-0000-0000-0000-000000000002',branchId:'b',start:'10:00',end:'18:00',color:'#ABCDE1'};
const fixture=()=>{const s=emptySnapshot();s.settings.presets.custom=[ta,tb];s.data.employees=[{id:'e',name:'Demo Sample 016',homeBranchId:'a',branchIds:['a','b']}];s.data.shifts={'e|2027-01-01':makeShift('custom:'+ta.id,'','',settingsForBranch(s.settings,'a'))};return s;};
test('empty Sede has exactly three system statuses and arbitrary work names are ordinary templates',()=>{
 assert.deepEqual(shiftOptions(DEFAULT_SETTINGS),['Riposo','Malattia','Ferie']);assert.equal(makeShift('Mattina'),null);assert.equal(makeShift('Pomeriggio'),null);assert.equal(makeShift('Centrale'),null);
 for(const name of ['Mattina','Pomeriggio','Centrale','Apertura','Magazzino 2','Reception AM','Mattina B']){const s=structuredClone(DEFAULT_SETTINGS);s.presets.custom=[{...ta,name}];assert.ok(validSettings(s));assert.equal(shiftType(makeShift('custom:'+ta.id,'','',s)),name);}
 for(const name of ['Riposo','Malattia','Ferie']){const s=structuredClone(DEFAULT_SETTINGS);s.presets.custom=[{...ta,name}];assert.equal(validSettings(s),false);assert.equal(minutes(makeShift(name)),0);}
});
test('Sede-scoped list, same name different times/colors, scoped merge and diff never touch another Sede',()=>{
 const s=fixture(),a=filterSnapshotByBranches(s,['a']),b=filterSnapshotByBranches(s,['b']);assert.deepEqual(a.settings.presets.custom,[ta]);assert.deepEqual(b.settings.presets.custom,[tb]);
 const next=structuredClone(a);next.settings.presets.custom[0].start='23:00';const merged=mergeScopedSnapshot(s,a,next),ops=branchOperations(s,merged,['a','b']);
 assert.deepEqual(ops,[{kind:'template_upsert',...ta,start:'23:00'}]);assert.deepEqual(merged.settings.presets.custom.find(t=>t.branchId==='b'),tb);
 const deleted=structuredClone(a);deleted.settings.presets.custom=[];assert.deepEqual(branchOperations(s,mergeScopedSnapshot(s,a,deleted),['a','b']),[{kind:'template_delete',id:ta.id,branchId:'a'}]);
});
test('edit/delete preserves assignments, variations, backup and copy; future assignments use edited template',()=>{
 const s=fixture(),before=structuredClone(s.data.shifts),changed=structuredClone(s);changed.settings.presets.custom[0]={...ta,name:'Notte nuova',start:'23:00',color:'#998877'};
 const historical=canonical(changed);assert.deepEqual(historical.data.shifts,before);assert.equal(shiftColor(historical.data.shifts['e|2027-01-01'],changed.settings),'#123ABC');
 const newly=makeShift('custom:'+ta.id,'','',settingsForBranch(changed.settings,'a'));assert.deepEqual([newly.type,newly.start,newly.presetColor],['Notte nuova','23:00','#998877']);
 assert.deepEqual(copyShiftValue(before['e|2027-01-01'],changed.settings),before['e|2027-01-01']);
 changed.settings.presets.custom=[];assert.deepEqual(canonical(changed).data.shifts,before);assert.deepEqual(parseBackup(backupText(changed)).data.shifts,before);assert.ok(validateSnapshot(changed));
 const copy=applyShiftCopy(changed.data,buildDayCopy(changed.data,'e','2027-01-01',['2027-01-02'],changed.settings));assert.deepEqual(copy.shifts['e|2027-01-02'],before['e|2027-01-01']);
});
test('generic abbreviations use names, Unicode initials and deterministic collisions',()=>{
 for(const [name,label] of [['Apertura','A'],['Chiusura','C'],['Notte','N'],['Mattina B','MB'],['Turno Serale','TS'],['Pomeriggio','P'],['Centrale','C'],['Équipe Notte','ÉN']])assert.equal(shiftAbbreviation(name),label);
 const names=['Apertura','Accoglienza','Riposo','Reception'];assert.equal(shiftAbbreviation('Apertura',names),'A2');assert.equal(shiftAbbreviation('Accoglienza',[...names].reverse()),'A1');assert.equal(shiftAbbreviation('Riposo',names),'R');assert.equal(shiftAbbreviation('Reception',names),'R1');
});
test('overnight snapshots and variations drive totals, ordinary/monthly PDF, reports and archive',async()=>{
 const s=fixture();s.variations={'e|2027-01-01':makeVariation('e','2027-01-01','23:00','05:00','Altro','Visita')};
 // Same name across Sedi, plus historical/current variants in one month.
 s.data.shifts['e|2027-01-02']=makeShift('custom:'+tb.id,'','',settingsForBranch(s.settings,'b'));
 s.settings.presets.custom[0]={...ta,start:'09:00',end:'12:00',color:'#000000'};
 assert.deepEqual(attendanceTotals(s.data,s.variations,'e',['2027-01-01','2027-01-02']),{planned:960,actual:840});
 const report=reportPeriod(s.data,'e','2027-01-01','2027-01-02',s.variations);assert.equal(report.rows[0].total,'16 h');assert.match(printDocument([report]),/22:00 – 06:00/);assert.ok((await createSchedulePdf([report])).output().startsWith('%PDF-'));
 const month=monthlySchedule(s.data,'','2027-01-01',s.settings,'',s.variations);assert.equal(month.legend.length,2);assert.deepEqual(month.legend.map(t=>[t.color,t.time]),[['#123ABC','22:00–06:00'],['#ABCDE1','10:00–18:00']]);assert.ok((await createMonthlySchedulePdf(month)).output().startsWith('%PDF-'));
 const rows=buildHoursReport(s.data,s.variations,['e'],'2027-01-01','2027-01-02');assert.equal(rows[0].planned,960);assert.equal(rows[0].actual,840);assert.match(hoursReportCsv(rows),/16 h/);assert.equal(rows[0].days[0].type,'Mattina');assert.ok((await createHoursPdf(rows,'2027-01-01','2027-01-02')).output().startsWith('%PDF-'));
 assert.match(archiveCsv(s,[],['2027-01-01']),/Mattina/);const json=JSON.parse(archiveJson({snapshot:s,requests:[],months:['2027-01-01'],scope:'month',organizationId:'org'}));assert.deepEqual(json.archive.data.shifts,s.data.shifts);
 const zip=await createArchivePackage({snapshot:s,requests:[],archiveMonths:[{month_start:'2027-01-01'}],scope:'month',anchor:'2027-01-01',organizationId:'org'});assert.ok(zip.blob.size>0);
});
