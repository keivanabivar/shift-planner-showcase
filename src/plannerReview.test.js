// Synthetic showcase fixtures only; never derived from real accounts or exports.
import test from 'node:test';
import assert from 'node:assert/strict';
import {emptySnapshot,createPlannerStore} from './plannerStore.js';
import {exportData,exportWeeks,scheduleFilename,sedeTotals} from './plannerExport.js';
import {monthlySchedule,monthlyPrintDocument,printDocument,createMonthlySchedulePdf,createSchedulePdf,monthlyShiftText} from './export.js';
import {makeShift,minutes,shiftType,shiftLabel,shiftColor,shiftOptionLabel,settingsForBranch} from './schedule.js';
import {validSettings} from './preferences.js';
import {navigationForRole} from './permissions.js';

const branches=[{id:'a',name:'Demo Branch Alpha'},{id:'b',name:'Demo Branch Beta'}];
const snapshot=()=>{
 const s=emptySnapshot();s.data.employees=[{id:'z',name:'Demo Sample 017',homeBranchId:'a'},{id:'a',name:'Demo Sample 016',homeBranchId:'a'}];
 s.data.shifts={'z|2026-10-05':{type:'Mattina',start:'08:00',end:'16:00',off:false,branchId:'a'},'z|2026-10-06':{type:'Notte',start:'22:00',end:'06:00',off:false,branchId:'b'}};return s;
};
test('PDF rows retain Sede Planner order; other Sedi toggle includes only already visible employees, totals per Sede',()=>{
 const s=snapshot(),scoped={...s.data,shifts:{'z|2026-10-05':s.data.shifts['z|2026-10-05']}};
 const off=exportData(scoped,s.data,false),on=exportData(scoped,{...s.data,shifts:{...s.data.shifts,'outsider|2026-10-05':s.data.shifts['z|2026-10-06']}},true);
 assert.deepEqual(on.employees.map(e=>e.name),['Demo Sample 017','Demo Sample 016']);assert.equal(on.shifts['outsider|2026-10-05'],undefined);
 assert.equal(sedeTotals(off,'z',['2026-10-05','2026-10-06'],branches),'8 h · Demo Branch Alpha');
 assert.equal(sedeTotals(on,'z',['2026-10-05','2026-10-06'],branches),'8 h · Demo Branch Alpha\n8 h · Demo Branch Beta\n16 h · Totale');
 const weeks=exportWeeks(on,'','2026-10-05','2026-10-11',{},s.settings,branches,['a']);
 assert.deepEqual(weeks[0].rows.map(r=>r.name),['Demo Sample 017','Demo Sample 016']);assert.equal(weeks[0].rows[0].branchNames[1],'Demo Branch Beta');assert.match(printDocument(weeks),/22:00.*06:00/);assert.match(printDocument(weeks),/Demo Branch Beta/);
 assert.equal(exportWeeks(off,'','2026-10-05','2026-10-11',{},s.settings,branches,['a'])[0].rows[0].shifts[1],'Non assegnato');
 const month=monthlySchedule(on,'',new Date(2026,9,1),s.settings,undefined,{}, {branches,selectedBranchIds:['a']});
 assert.deepEqual(month.rows.map(r=>r.name),['Demo Sample 017','Demo Sample 016']);assert.match(monthlyShiftText(month.rows[0].cells[5]),/22:00–06:00\nDemo Branch Beta/);assert.match(monthlyPrintDocument(month),/16 h · Totale/);
});
test('PDF tables include Sede/time lines and monthly filename uses exported month/year, leap year and full-month readable mode',async()=>{
 const s=snapshot(),weeks=exportWeeks(s.data,'','2026-10-05','2026-10-11',{},s.settings,branches,['a']);
 const pdf=await createSchedulePdf(weeks);assert.match(pdf.lastAutoTable.body[0].cells[2].text.join('\n'),/Demo Branch Beta/);assert.match(pdf.lastAutoTable.body[0].cells[8].text.join('\n'),/16 h/);
 const month=monthlySchedule(s.data,'',new Date(2026,9,1),s.settings,undefined,{}, {branches,selectedBranchIds:['a']});
 const monthly=await createMonthlySchedulePdf(month);assert.match(monthly.lastAutoTable.body[0].cells[6].text.join('\n'),/Demo Branch Beta/);
 assert.equal(scheduleFilename('monthly','2026-10-01','2026-10-31'),'turni_mensile_ottobre_2026.pdf');
 assert.equal(scheduleFilename('readable','2028-02-01','2028-02-29'),'turni_mensile_febbraio_2028.pdf');
 assert.equal(scheduleFilename('readable','2026-10-05','2026-10-11'),'turni_2026-10-05_2026-10-11.pdf');
});
test('status styles never alter Riposo/Ferie/Malattia identity or totals, support per-Sede display and reject malformed labels/colors',()=>{
 const s=snapshot();s.settings.statusStyles={a:{Riposo:{name:'Giorno libero',color:'#123456'}},b:{Riposo:{name:'Libero B',color:'#654321'}}};assert.equal(validSettings(s.settings),true);
 const shift={...makeShift('Riposo'),branchId:'a'};assert.equal(shiftType(shift),'Riposo');assert.equal(shiftLabel(shift,s.settings),'Giorno libero');assert.equal(minutes(shift),0);assert.equal(shiftColor(shift,s.settings),'#123456');
 assert.equal(shiftOptionLabel('Riposo',settingsForBranch(s.settings,'b')),'Libero B');
 for(const bad of [{name:'',color:'#123456'},{name:'a',color:'red'},{name:' a ',color:'#123456'}])assert.equal(validSettings({...s.settings,statusStyles:{a:{Riposo:bad}}}),false);
});
test('local multistep Undo, management exclusion, save failure and session disposal',async()=>{
 const values=new Map(),storage={getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)};
 const store=createPlannerStore({storage});const initial=snapshot();assert.equal(await store.save(initial),true);
 let next=structuredClone(initial);next.data.shifts['a|2026-10-05']={type:'Ferie',off:true,branchId:'a'};assert.equal(await store.save(next,{undoable:true}),true);
 let third=structuredClone(next);delete third.data.shifts['z|2026-10-05'];assert.equal(await store.save(third,{undoable:true}),true);assert.equal(store.getSnapshot().undoDepth,2);
 assert.equal(await store.undo(),true);assert.deepEqual(store.getSnapshot().snapshot,next);assert.equal(await store.undo(),true);assert.deepEqual(store.getSnapshot().snapshot,initial);
 assert.equal(store.getSnapshot().undoDepth,0);assert.equal(await store.undo(),false);
 await store.save(next,{undoable:true});await store.save({...next,notes:[{id:'note',text:'Admin-independent note',date:'2026-10-05',employeeId:''}]});assert.equal(store.getSnapshot().undoDepth,0);
 store.dispose();assert.equal(await store.undo(),false);
});
test('navigation places daily work first, administration next, settings/account last and invite remains admin only',()=>{
 const admin=navigationForRole('admin').map(([id])=>id),editor=navigationForRole('editor').map(([id])=>id),viewer=navigationForRole('viewer').map(([id])=>id);
 assert.deepEqual(admin,['planning','employees','notes','requests','absences','hours','archive','branches','access','invite','backup','settings','account']);
 assert.ok(!editor.includes('invite')&&!viewer.includes('invite'));assert.ok(!viewer.includes('backup'));assert.equal(editor.at(-1),'account');assert.equal(viewer.at(-1),'account');
});
