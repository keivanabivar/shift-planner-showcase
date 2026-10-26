// Synthetic showcase fixtures only; never derived from real accounts or exports.
import test from 'node:test';
import assert from 'node:assert/strict';
import {sortedCustomPresets,settingsForBranch,shiftOptions,hours,minutes,normalizeTemplateSort} from './schedule.js';
import {employeeAssignmentGroups} from './employeeAssignmentGroups.js';

const templates=[
 {id:'b',branchId:'a',name:'Beta',start:'16:00',end:'22:00'},
 {id:'a',branchId:'a',name:'Alfa',start:'22:30',end:'06:00'},
 {id:'c',branchId:'a',name:'Gamma',start:'09:00',end:'17:00'},
 {id:'foreign',branchId:'b',name:'Demo Fixture 101',start:'10:00',end:'12:00'}
];
test('all four template sorts in both directions share the Planner order; overnight duration is correct',()=>{
 const settings={presets:{custom:templates}},expected={name:['a','b','c'],start:['c','b','a'],end:['a','c','b'],duration:['b','a','c']};
 for(const [key,ids] of Object.entries(expected))for(const direction of ['asc','desc']){
  const scoped=settingsForBranch(settings,'a',{key,direction}),order=direction==='asc'?ids:[...ids].reverse();
  assert.deepEqual(sortedCustomPresets(scoped).map(t=>t.id),order);
  assert.deepEqual(shiftOptions(scoped).slice(0,3),order.map(id=>'custom:'+id));
 }
 assert.equal(hours(minutes(templates[0])),'6 h');assert.equal(hours(minutes(templates[1])),'7 h 30 min');
 assert.deepEqual(normalizeTemplateSort({key:'unknown',direction:'bad'}),{key:'name',direction:'asc'});
 assert.deepEqual(templates.map(t=>t.id),['b','a','c','foreign'],'sorting cannot mutate the saved templates');
 const tied={presets:{custom:[{...templates[0],id:'z'},{...templates[0],id:'a'}]},templateSort:{key:'duration',direction:'desc'}};
 assert.deepEqual(sortedCustomPresets(tied).map(t=>t.id),['a','z']);
});
test('employee groups support large lists, multiple assignments, accent-insensitive search and empty results',()=>{
 const branches=[{id:'a',name:'Demo Branch Alpha',active:true},{id:'b',name:'Demo Branch Beta',active:true}];
 const employees=[{employee_id:'shared',employee_name:'Éxample Fixturé',branch_ids:['a','b']},...Array.from({length:100},(_,i)=>({employee_id:String(i),employee_name:'Persona '+i,branch_ids:[i%2?'a':'b']})),{employee_id:'unknown',employee_name:'Demo Record 016',branch_ids:[]}];
 const groups=employeeAssignmentGroups(employees,branches);
 assert.deepEqual(groups.map(g=>g.employees.length),[51,51,1]);
 assert.deepEqual(employeeAssignmentGroups(employees,branches,'EXAMPLE FIXTURE','b')[0].employees.map(e=>e.employee_id),['shared']);
 assert.equal(employeeAssignmentGroups(employees,branches,'not found').length,0);
 assert.equal(employeeAssignmentGroups(employees,branches,'','a').length,1);
});

import {applyTemplateColorChanges} from './templateColors.js';
import {createPlannerStore,emptySnapshot,validateEnvelope} from './plannerStore.js';
import {branchOperations} from './branchPersistence.js';
import {canonical} from './persistence.js';
const colorFixture=()=>{
 const s=emptySnapshot();s.settings.presets.custom=[{...templates[0],color:'#112233',legacyPresetId:'legacy'}];
 s.data.employees=[{id:'e',name:'Demo Sample 016',homeBranchId:'a'}];
 const shift={type:'Storico',presetId:'b',presetName:'Storico',presetColor:'#112233',start:'17:00',end:'23:30',branchId:'a',off:false};
 s.data.shifts={'e|2026-01-01':shift,'e|2026-01-02':{...shift,presetId:'legacy'},'e|2026-01-03':{...shift,branchId:'other'},'e|2026-01-04':{type:'Riposo',off:true,branchId:'a'},'e|2026-01-05':{type:'Manuale',start:'09:00',end:'12:00',off:false,branchId:'a'}};
 return s;
};
test('expected retroactive color recognizes only exact and known legacy links in the same Sede',()=>{
 const previous=colorFixture(),next=structuredClone(previous);next.settings.presets.custom[0]={...next.settings.presets.custom[0],name:'Nuovo',start:'08:00',color:'#AABBCC'};
 const result=applyTemplateColorChanges(previous,next);
 for(const day of ['01','02'])assert.deepEqual(result.data.shifts['e|2026-01-'+day],{...previous.data.shifts['e|2026-01-'+day],presetColor:'#AABBCC'});
 for(const day of ['03','04','05'])assert.deepEqual(result.data.shifts['e|2026-01-'+day],previous.data.shifts['e|2026-01-'+day]);
 assert.deepEqual(next.data.shifts,previous.data.shifts);
 assert.deepEqual(branchOperations(previous,next).map(op=>op.kind),['template_upsert'],'historical propagation emits no shift edits');
});
test('store accepts color-only propagation and still rejects unexpected historical times',async()=>{
 for(const corrupt of [false,true]){
  const before=colorFixture(),next=structuredClone(before);next.settings.presets.custom[0].color='#AABBCC';
  const values=new Map(),storage={getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v)};
  const envelope=snapshot=>({organization_id:'org',revision:1,empty:false,snapshot});
  const repository={load:async()=>envelope(before),saveScoped:async sent=>{
   assert.deepEqual(sent.data.shifts,before.data.shifts);const returned=applyTemplateColorChanges(before,sent);
   if(corrupt)returned.data.shifts['e|2026-01-01'].start='01:00';return envelope(returned);
  }};
  const store=createPlannerStore({storage,repository,organizationId:'org',userId:'user'});await store.connect();
  assert.equal(await store.save(next),!corrupt);assert.equal(store.getSnapshot().status,corrupt?'error':'connected');
  store.dispose();
 }
});

test('blocker 1: template color verification accepts trigger output and preserves historical names/hours',async()=>{
 const before=colorFixture(),next=structuredClone(before);next.settings.presets.custom[0].color='#AABBCC';
 const returned=structuredClone(next);
 for(const day of ['01','02'])returned.data.shifts['e|2026-01-'+day].presetColor='#AABBCC';
 const values=new Map(),storage={getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v)};
 const envelope=snapshot=>({organization_id:'org',revision:2,empty:false,snapshot});
 const repository={load:async()=>envelope(before),saveScoped:async sent=>{
  assert.deepEqual(branchOperations(canonical(before),sent).map(op=>op.kind),['template_upsert']);return envelope(returned);
 }};
 const store=createPlannerStore({storage,repository,organizationId:'org',userId:'user'});await store.connect();
 assert.equal(await store.save(next),true);assert.equal(store.getSnapshot().message,'');
 assert.deepEqual(store.getSnapshot().snapshot.data.shifts,returned.data.shifts);store.dispose();
});

for(const presetId of ['b','legacy'])test(`blocker 2: copied historical ${presetId} color resolves only at the written destination`,async()=>{
 const before=colorFixture();before.data.shifts['e|2026-01-01']={...before.data.shifts['e|2026-01-01'],presetId,presetColor:'#778899'};
 const next=structuredClone(before);next.data.shifts['e|2026-12-01']={...before.data.shifts['e|2026-01-01']};
 const returned=structuredClone(next);returned.data.shifts['e|2026-12-01'].presetColor='#112233';
 const values=new Map(),storage={getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v)};
 const envelope=snapshot=>({organization_id:'org',revision:2,empty:false,snapshot});
 const repository={load:async()=>envelope(before),saveScoped:async sent=>{
  const ops=branchOperations(canonical(before),sent);assert.equal(ops.length,1);assert.equal(ops[0].presetColor,'#778899');return envelope(returned);
 }};
 const store=createPlannerStore({storage,repository,organizationId:'org',userId:'user'});await store.connect();
 assert.equal(await store.save(next),true);assert.equal(store.getSnapshot().status,'connected');assert.equal(store.getSnapshot().message,'');
 assert.deepEqual(store.getSnapshot().snapshot.data.shifts,returned.data.shifts);assert.deepEqual(next.data.shifts['e|2026-12-01'],before.data.shifts['e|2026-01-01']);store.dispose();
});

test('color prediction honors deleted/unknown templates, Sede scope and exact-ID priority',()=>{
 const before=colorFixture();before.data.shifts['e|2026-01-01'].presetColor='#778899';
 const next=structuredClone(before);next.data.shifts['e|2026-12-01']={...before.data.shifts['e|2026-01-01']};next.settings.presets.custom=[];
 assert.equal(applyTemplateColorChanges(before,next).data.shifts['e|2026-12-01'].presetColor,'#112233');
 assert.equal(applyTemplateColorChanges(before,next).data.shifts['e|2026-01-01'].presetColor,'#778899');
 for(const change of [shift=>shift.branchId='other',shift=>shift.presetId='unknown']){
  const foreign=structuredClone(next);change(foreign.data.shifts['e|2026-12-01']);assert.deepEqual(applyTemplateColorChanges(before,foreign),foreign);
 }
 before.settings.presets.custom.push({...before.settings.presets.custom[0],id:'legacy',legacyPresetId:undefined,color:'#ABCDEF'});
 const direct=structuredClone(before);direct.data.shifts['e|2026-12-01']={...before.data.shifts['e|2026-01-01'],presetId:'legacy'};
 assert.equal(applyTemplateColorChanges(before,direct).data.shifts['e|2026-12-01'].presetColor,'#ABCDEF');
});

for(const field of ['presetColor','presetName','presetId','type','start','end','branchId','untouchedColor','templateColor','malformed'])test(`trigger-aware verification still rejects unexpected ${field}`,async()=>{
 const before=colorFixture(),next=structuredClone(before);next.data.shifts['e|2026-12-01']={...before.data.shifts['e|2026-01-01'],presetColor:'#778899'};
 const returned=structuredClone(next),shift=returned.data.shifts['e|2026-12-01'];shift.presetColor='#112233';
 if(field==='untouchedColor')returned.data.shifts['e|2026-01-03'].presetColor='#ABCDEF';
 else if(field==='templateColor')returned.settings.presets.custom[0].color='#ABCDEF';
 else if(field==='malformed')shift.end='99:99';
 else shift[field]=({presetColor:'#ABCDEF',presetName:'Diverso',presetId:'foreign',type:'Diverso',start:'08:00',end:'15:00',branchId:'other'})[field];
 const values=new Map(),storage={getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v)};
 const envelope=snapshot=>({organization_id:'org',revision:2,empty:false,snapshot});
 const store=createPlannerStore({storage,repository:{load:async()=>envelope(before),saveScoped:async()=>envelope(returned)},organizationId:'org',userId:'user'});await store.connect();
 const previous=structuredClone(store.getSnapshot().snapshot);assert.equal(await store.save(next),false);assert.equal(store.getSnapshot().status,'error');assert.deepEqual(store.getSnapshot().snapshot,previous);store.dispose();
});

for(const presetId of ['b','legacy'])test(`deleted template after reload → copy shift: ${presetId} uses authoritative color only at the destination`,async()=>{
 const before=colorFixture(),template=before.settings.presets.custom[0];before.settings.presets.custom=[];
 before.data.shifts['e|2026-01-01']={...before.data.shifts['e|2026-01-01'],presetId,presetColor:'#778899'};
 const colors=[{id:template.id,branchId:template.branchId,color:template.color,legacyPresetId:template.legacyPresetId}];
 const values=new Map(),storage={getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v)};
 const envelope=snapshot=>({organization_id:'org',revision:2,empty:false,selected_branch_ids:['a'],deleted_template_colors:colors,snapshot});
 const store=createPlannerStore({storage,repository:{load:async()=>envelope(before),saveScoped:async sent=>{
  const operations=branchOperations(canonical(before),sent);assert.equal(operations.length,1);assert.equal(operations[0].presetColor,'#778899');
  const returned=structuredClone(sent);returned.data.shifts['e|2026-12-01'].presetColor='#112233';return envelope(returned);
 }},organizationId:'org',userId:'user'});
 assert.equal(await store.connect(),true);const next=structuredClone(store.getSnapshot().snapshot);
 assert.deepEqual(next.settings.presets.custom,[],'reload exposes no deleted template in current presets');
 next.data.shifts['e|2026-12-01']={...next.data.shifts['e|2026-01-01']};
 assert.equal(await store.save(next),true);assert.equal(store.getSnapshot().status,'connected');assert.equal(store.getSnapshot().message,'');
 assert.deepEqual(store.getSnapshot().snapshot.data.shifts['e|2026-12-01'],{...before.data.shifts['e|2026-01-01'],presetColor:'#112233'});
 assert.deepEqual(store.getSnapshot().snapshot.data.shifts['e|2026-01-01'],before.data.shifts['e|2026-01-01']);
 store.dispose();
});

for(const field of ['presetColor','presetName','presetId','type','start','end','branchId','untouchedColor','metadataColor','missingMetadata','malformed'])test('deleted template verification rejects unexpected '+field,async()=>{
 const before=colorFixture();before.settings.presets.custom=[];before.data.shifts['e|2026-01-01'].presetColor='#778899';
 const colors=[{id:'b',branchId:'a',color:'#112233',legacyPresetId:'legacy'}];
 const envelope=(snapshot,metadata=colors)=>({organization_id:'org',revision:2,empty:false,selected_branch_ids:['a'],deleted_template_colors:metadata,snapshot});
 const next=structuredClone(before);next.data.shifts['e|2026-12-01']={...before.data.shifts['e|2026-01-01']};
 const returned=structuredClone(next),shift=returned.data.shifts['e|2026-12-01'];shift.presetColor='#112233';let metadata=colors;
 if(field==='untouchedColor')returned.data.shifts['e|2026-01-01'].presetColor='#112233';
 else if(field==='metadataColor')metadata=[{...colors[0],color:'#ABCDEF'}];
 else if(field==='missingMetadata')metadata=[];
 else if(field==='malformed')shift.end='99:99';
 else shift[field]=({presetColor:'#ABCDEF',presetName:'Diverso',presetId:'unknown',type:'Diverso',start:'08:00',end:'15:00',branchId:'other'})[field];
 const values=new Map(),storage={getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v)};
 const store=createPlannerStore({storage,repository:{load:async()=>envelope(before),saveScoped:async()=>envelope(returned,metadata)},organizationId:'org',userId:'user'});
 assert.equal(await store.connect(),true);const initial=structuredClone(store.getSnapshot().snapshot);
 assert.equal(await store.save(next),false);assert.equal(store.getSnapshot().status,'error');assert.deepEqual(store.getSnapshot().snapshot,initial);store.dispose();
});

test('deleted template metadata rejects malformed, duplicate, active and foreign-Sede records',()=>{
 const before=colorFixture(),item={id:'deleted',branchId:'a',color:'#112233',legacyPresetId:'old-deleted'};
 const envelope=colors=>({revision:1,empty:false,selected_branch_ids:['a'],snapshot:before,deleted_template_colors:colors});
 assert.deepEqual(validateEnvelope(envelope([item])).deleted_template_colors,[item]);
 for(const colors of [null,{},[null],[item,item],[{...item,id:'b'}],[{...item,branchId:'other'}],[{...item,color:'red'}],[{...item,legacyPresetId:42}],[{...item,legacyPresetId:'legacy'}],[{...item,name:'unexpected'}]])
  assert.throws(()=>validateEnvelope(envelope(colors)),/Dati del database non validi/);
});

test('deleted template colors preserve Sede scope and exact-ID precedence across active/deleted legacy collisions',()=>{
 const before=colorFixture();before.settings.presets.custom[0].legacyPresetId='deleted';
 const known=[{id:'deleted',branchId:'a',color:'#ABCDEF',legacyPresetId:'b'}],next=structuredClone(before);
 for(const [day,presetId,branchId] of [['01','deleted','a'],['02','b','a'],['03','deleted','other'],['04','missing','a']])
  next.data.shifts['e|2026-12-'+day]={...before.data.shifts['e|2026-01-01'],presetId,branchId,presetColor:'#778899'};
 const result=applyTemplateColorChanges(before,next,known);
 assert.equal(result.data.shifts['e|2026-12-01'].presetColor,'#ABCDEF');assert.equal(result.data.shifts['e|2026-12-02'].presetColor,'#112233');
 for(const day of ['03','04'])assert.deepEqual(result.data.shifts['e|2026-12-'+day],next.data.shifts['e|2026-12-'+day]);
});

for(const corrupt of [false,true])test(`legacy collision: active color edit ${corrupt?'rejects an unrelated historical recolor':'verifies without recoloring deleted-template history'}`,async()=>{
 const before=colorFixture();before.settings.presets.custom[0].legacyPresetId='deleted';
 const colors=[{id:'deleted',branchId:'a',color:'#ABCDEF',legacyPresetId:'old-deleted'}];
 const historical={...before.data.shifts['e|2026-01-01'],presetId:'deleted',presetColor:'#778899'};
 before.data.shifts['e|2026-01-02']=historical;
 before.data.shifts['e|2026-01-03']={...historical,branchId:'other'};
 const next=structuredClone(before);Object.assign(next.settings.presets.custom[0],{name:'Nuovo',start:'08:00',end:'16:00',color:'#AABBCC'});
 const returned=structuredClone(next);returned.data.shifts['e|2026-01-01'].presetColor='#AABBCC';
 if(corrupt)returned.data.shifts['e|2026-01-02'].presetColor='#ABCDEF';
 const envelope=snapshot=>({organization_id:'org',revision:2,empty:false,selected_branch_ids:['a'],deleted_template_colors:colors,snapshot});
 const values=new Map(),storage={getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v)};
 const store=createPlannerStore({storage,repository:{load:async()=>envelope(before),saveScoped:async sent=>{
  assert.deepEqual(branchOperations(canonical(before),sent).map(op=>op.kind),['template_upsert']);return envelope(returned);
 }},organizationId:'org',userId:'user'});
 assert.equal(await store.connect(),true);const initial=structuredClone(store.getSnapshot().snapshot);
 assert.equal(await store.save(next),!corrupt);assert.equal(store.getSnapshot().status,corrupt?'error':'connected');
 assert.deepEqual(store.getSnapshot().snapshot,corrupt?initial:canonical(returned));
 assert.deepEqual(store.getSnapshot().snapshot.data.shifts['e|2026-01-02'],historical);
 assert.deepEqual(store.getSnapshot().snapshot.data.shifts['e|2026-01-03'],before.data.shifts['e|2026-01-03']);
 if(!corrupt)assert.equal(store.getSnapshot().message,'');store.dispose();
});
