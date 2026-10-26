// Synthetic showcase fixtures only; never derived from real accounts or exports.
import {makeLegacyShift as makeShift} from './testFixtures.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {archivePdf,archiveCsv,archiveDeletionConfirmation,archiveJson,clampPlanningDate,createZip,dateNavigationTarget,filterSnapshotForMonths,groupArchiveMonths,monthsForScope} from './archive.js';
import {emptySnapshot} from './plannerStore.js';
import {dateKey} from './schedule.js';

const months=[{month_start:'2026-08-01'},{month_start:'2026-07-01'},{month_start:'2025-12-01'}];
test('archivio raggruppa anno/mese e seleziona backup mensile, annuale o completo',()=>{
 assert.deepEqual(Object.keys(groupArchiveMonths(months)),['2025','2026']);
 assert.deepEqual(monthsForScope(months,'month','2026-08-18'),['2026-08-01']);
 assert.deepEqual(monthsForScope(months,'year','2026-08-18'),['2026-08-01','2026-07-01']);
 assert.deepEqual(monthsForScope(months,'all','2026-08-18'),months.map(item=>item.month_start));
});
test('Pianificazione non naviga prima del mese corrente',()=>{
 const today=new Date(2026,8,27);
 assert.equal(dateKey(clampPlanningDate('2026-08-14',today)),'2026-09-01');
 assert.equal(dateKey(clampPlanningDate(new Date(2026,8,1),today)),'2026-09-01');
 assert.equal(dateKey(clampPlanningDate(new Date(2026,9,14),today)),'2026-10-14');
});
test('Vai alla data distingue mese corrente, futuro e archivio completato',()=>{
 const today=new Date(2026,8,27);
 const current=dateNavigationTarget(new Date(2026,8,5),today),future=dateNavigationTarget(new Date(2026,9,15),today),past=dateNavigationTarget(new Date(2026,7,15),today);
 assert.deepEqual({view:current.view,date:dateKey(current.date),month:current.month},{view:'planning',date:'2026-09-05',month:'2026-09-01'});
 assert.deepEqual({view:future.view,date:dateKey(future.date),month:future.month},{view:'planning',date:'2026-10-15',month:'2026-10-01'});
 assert.deepEqual({view:past.view,date:dateKey(past.date),month:past.month},{view:'archive',date:'2026-08-15',month:'2026-08-01'});
});
test('la conferma eliminazione archivio usa mese e anno italiani esatti',()=>{
 assert.equal(archiveDeletionConfirmation('2026-08-01'),'ELIMINA AGOSTO 2026');
});
test('backup archivio filtra snapshot e produce CSV/JSON completi',()=>{
 const snapshot=emptySnapshot();snapshot.data.employees=[{id:'e1',name:'Demo Sample 016'}];snapshot.data.shifts={'e1|2026-07-03':makeShift('Mattina'),'e1|2026-08-04':makeShift('Ferie'),'e1|2026-09-05':makeShift('Pomeriggio')};snapshot.notes=[{id:'n',text:'Storica',date:'2026-08-04',employeeId:'e1'}];
 const filtered=filterSnapshotForMonths(snapshot,['2026-08-01']);assert.deepEqual(Object.keys(filtered.data.shifts),['e1|2026-08-04']);assert.equal(filtered.notes.length,1);
 const requests=[{start_date:'2026-08-04',end_date:'2026-08-04',employee_id:'e1',employee_name:'Demo Sample 016',type:'Ferie',status:'approved',note:'Estate'}];
 const csv=archiveCsv(filtered,requests,['2026-08-01']);assert.match(csv,/Turno/);assert.match(csv,/Richiesta/);assert.doesNotMatch(csv,/2026-09-05/);
 const json=JSON.parse(archiveJson({snapshot:filtered,requests,months:['2026-08-01'],scope:'month',organizationId:'org'}));assert.equal(json.format,'turni.archive');assert.equal(json.organizationId,'org');assert.equal(json.requests.length,1);
});
test('ZIP contiene manifest, PDF, CSV e JSON senza dipendenze esterne',async()=>{
 const blob=createZip([{name:'manifest.json',data:'{}'},{name:'archivio.pdf',data:new Uint8Array([37,80,68,70])},{name:'archivio.csv',data:'a;b'},{name:'archivio.json',data:'{}'}]);const bytes=new Uint8Array(await blob.arrayBuffer()),text=new TextDecoder().decode(bytes);assert.deepEqual([...text.matchAll(/(?:manifest\.json|archivio\.(?:pdf|csv|json))/g)].map(match=>match[0]).sort(),['archivio.csv','archivio.csv','archivio.json','archivio.json','archivio.pdf','archivio.pdf','manifest.json','manifest.json']);assert.deepEqual([...bytes.slice(0,4)],[0x50,0x4b,0x03,0x04]);
});


for(const [label,variation] of [['none',null],['start only',{start:'10:30',end:null}],['end only',{start:null,end:'16:45'}],['both',{start:'10:30',end:'16:45'}]])test(`archive backup PDF preserves ${label} attendance in its monthly shift cell`,async()=>{
 const snapshot=emptySnapshot();snapshot.data.employees=[{id:'a',name:'Demo Sample 016'},{id:'b',name:'DemoBeta'}];snapshot.data.shifts={'a|2026-08-01':makeShift('Mattina'),'b|2026-08-01':makeShift('Mattina')};
 if(variation)snapshot.variations['a|2026-08-01']={employeeId:'a',date:'2026-08-01',...variation,reason:'Malessere'};
 const bytes=await archivePdf(snapshot,['2026-08-01'],snapshot.settings),text=new TextDecoder('latin1').decode(bytes);assert.ok(text.startsWith('%PDF-'));assert.ok(text.includes('Demo Sample 016'));assert.ok(text.includes('DemoBeta'));
 if(variation){assert.match(text,/\(P 09:30\)/);assert.equal((text.match(/\(E /g)||[]).length,1);assert.match(text,/\(Malessere\)/);if(variation.start)assert.match(text,/\(E 10:30\)/);if(variation.end)assert.match(text,/16:45/);}else assert.doesNotMatch(text,/\(P 09:30\)|\(E /);
});
