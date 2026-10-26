// Synthetic showcase fixtures only; never derived from real accounts or exports.
import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {readFile,readdir} from 'node:fs/promises';
import {LEGACY_SETTINGS} from './legacySettings.js';
import {canonical,validateSnapshot} from './persistence.js';
import {makeShift,settingsForBranch} from './schedule.js';
const owner='28000000-0000-0000-0000-000000000001',adminB='28000000-0000-0000-0000-000000000002',viewerB='28000000-0000-0000-0000-000000000003';

test('028 upgrade: legacy rows unchanged, independent templates, snapshots, requests, RLS and zero FK orphans',async()=>{
 const db=new PGlite(),dir=new URL('../supabase/migrations/',import.meta.url);
 const scalar=async(sql,args=[])=>(await db.query(sql,args)).rows[0]?.value;
 const asUser=async uid=>{await db.exec('reset role;set role authenticated');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[uid]);};
 try{
  await db.exec("create role anon;create role authenticated;create schema auth;create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema public,auth to anon,authenticated;");
  const files=(await readdir(dir)).filter(f=>f.endsWith('.sql')).sort();
  for(const f of files.filter(f=>Number(f.slice(0,3))<=27))await db.exec(await readFile(new URL(f,dir),'utf8'));
  await db.query('insert into auth.users values($1,$2,now()),($3,$4,now()),($5,$6,now())',[owner,'owner28@example.invalid',adminB,'admin28@example.invalid',viewerB,'viewer28@example.invalid']);
  await asUser(owner);
  const account=await scalar("select public.organization_onboard('Upgrade 028','Owner') as value"),oid=account.organization_id;
  const a=await scalar('select id as value from public.branches where organization_id=$1',[oid]),b=(await scalar("select public.branch_create($1,'Sede B') as value",[oid])).id;
  await scalar("select public.branch_employee_create($1,$2,'ea','Demo Sample 016') as value",[oid,a]);await scalar("select public.branch_employee_create($1,$2,'eb','DemoBeta') as value",[oid,b]);
  const past=await scalar("select to_char(date_trunc('month',current_date)-interval '2 months','YYYY-MM-DD') as value");
  const future=await scalar("select to_char(current_date+60,'YYYY-MM-DD') as value");
  const legacy=structuredClone(LEGACY_SETTINGS);legacy.presets.custom=[{id:'old-night',name:'Notte',start:'22:00',end:'06:00',color:'#123ABC'}];
  await db.exec('reset role');await db.query('insert into public.settings(organization_id,id,value) values($1,true,$2::jsonb)',[oid,JSON.stringify(legacy)]);
  await db.exec('reset role');await db.query('insert into public.archive_months(organization_id,month_start) values($1,$2)',[oid,past]);await asUser(owner);await scalar("select public.archive_exceptional_edit_begin($1,$2,'MODIFICA ECCEZIONALE') as value",[oid,past]);
  await db.exec('reset role');
  for(const [i,type,start,end,id,name,color] of [[0,'Mattina','08:00','16:00',null,null,null],[1,'Pomeriggio','14:30','22:30',null,null,null],[2,'Centrale','21:00','05:00',null,null,null],[3,'Notte','23:00','07:00','old-night','Notte','#ABC123']]){
   await db.query("insert into public.shifts(organization_id,id,employee_id,date,type,start_time,end_time,branch_id,preset_id,preset_name,preset_color) values($1,'ea|'||($2::date+$3::integer)::text,'ea',$2::date+$3::integer,$4,$5::time,$6::time,$7,$8,$9,$10)",[oid,past,i,type,start,end,a,id,name,color]);
  }
  await db.query("insert into public.attendance_variations(organization_id,id,shift_id,actual_start_time,actual_end_time,reason,custom_reason,note) values($1,$2,$2,'23:30','06:30','Altro','Visita','storico')",[oid,'ea|'+await scalar('select ($1::date+3)::text as value',[past])]);
  await asUser(owner);await scalar('select public.archive_exceptional_edit_end($1,$2) as value',[oid,past]);
  // Representative approved leave with a previous custom work-shift snapshot.
  let loaded=await scalar('select public.planner_load_scoped($1,null) as value',[oid]);
  await scalar('select public.planner_apply_branch_operations($1,$2::jsonb,$3::jsonb,null) as value',[oid,JSON.stringify([{kind:'shift_upsert',id:'ea|'+future,employeeId:'ea',date:future,branchId:a,type:'Notte',presetId:'old-night',presetName:'Notte',presetColor:'#ABC123',start:'23:00',end:'07:00'}]),JSON.stringify(loaded.branch_revisions)]);
  const req=await scalar("select public.request_create($1,'ea','Ferie',$2,$2,null,null,'Vacanza') as value",[oid,future]);
  const preview=await scalar('select public.request_approval_preview($1,$2) as value',[oid,req.id]);
  const approved=await scalar("select public.request_approve($1,$2,$3,$4,true,'Ok','Ferie',$5,$5,null,null) as value",[oid,req.id,preview.expected_version,preview.expected_revision,future]);
  const invite=await scalar("select public.branch_invite_create($1,'admin28@example.invalid',$2,'branch_admin',null,'all_branches') as value",[oid,b]);await asUser(adminB);await scalar('select public.organization_invite_accept($1) as value',[invite.token]);
  const vi=await scalar("select public.branch_invite_create($1,'viewer28@example.invalid',$2,'employee','eb','own') as value",[oid,b]);await asUser(viewerB);await scalar('select public.organization_invite_accept($1) as value',[vi.token]);
  await asUser(owner);await scalar("select public.branch_member_assignments_update($1,$2,'branch_admin',null,'all_branches',true,$3::uuid[]) as value",[oid,owner,[a,b]]);
  await db.exec('reset role');
  await db.query("insert into public.notes(organization_id,id,text,date,employee_id,position,branch_id) values($1,'note-b','Sede B snapshot',$2,'eb',1,$3)",[oid,future,b]);
  const historical=async()=>{
   const result={};for(const table of ['shifts','attendance_variations','archive_months','requests','request_shift_changes','notes'])result[table]=await scalar(`select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]') as value from public.${table} t where organization_id=$1`,[oid]);return result;
  };
  const before=await historical();
  await db.exec(await readFile(new URL('028_per_sede_shift_templates.sql',dir),'utf8'));
  assert.deepEqual(await historical(),before,'upgrade must not update historical operational rows');
  assert.equal(await scalar('select count(*)::int as value from public.shift_templates where organization_id=$1',[oid]),2,'only the user-created Notte is copied to each Sede');
  assert.equal(await scalar("select count(*)::int as value from public.shift_templates where name in ('Mattina','Pomeriggio','Centrale')"),0);
  await asUser(owner);loaded=await scalar('select public.planner_load_scoped($1,null) as value',[oid]);
  assert.ok(validateSnapshot(loaded.snapshot));assert.deepEqual(canonical(loaded.snapshot).data.shifts,loaded.snapshot.data.shifts,'loading/canonicalization preserves stored times and colors');
  assert.equal(loaded.snapshot.settings.legacyColors.Mattina,'#7DD3FC');
  const oldA=loaded.snapshot.settings.presets.custom.find(t=>t.branchId===a),oldB=loaded.snapshot.settings.presets.custom.find(t=>t.branchId===b);assert.notEqual(oldA.id,oldB.id);
  const apply=async ops=>{const state=await scalar('select public.planner_load_scoped($1,null) as value',[oid]);return scalar('select public.planner_apply_branch_operations($1,$2::jsonb,$3::jsonb,null) as value',[oid,JSON.stringify(ops),JSON.stringify(state.branch_revisions)]);};
  const edited={...oldA,name:'Mattina',start:'09:00',end:'17:00',color:'#998877'};
  loaded=await apply([{kind:'template_upsert',...edited}]);assert.deepEqual(await historical(),before);
  const newDate=await scalar("select (current_date+61)::text as value"),snapshot=makeShift('custom:'+oldA.id,'','',settingsForBranch(loaded.snapshot.settings,a));
  assert.deepEqual([snapshot.type,snapshot.start,snapshot.presetColor],['Mattina','09:00','#998877']);
  await apply([{kind:'shift_upsert',id:'ea|'+newDate,employeeId:'ea',date:newDate,...snapshot}]);
  await apply([{kind:'template_delete',id:oldA.id,branchId:a}]);
  loaded=await scalar('select public.planner_load_scoped($1,array[$2]::uuid[]) as value',[oid,a]);assert.equal(loaded.snapshot.settings.presets.custom.length,0);assert.deepEqual(loaded.snapshot.data.shifts['ea|'+newDate],snapshot);
  await assert.rejects(apply([{kind:'template_upsert',...edited}]),/unavailable/i,'deleted template IDs cannot be resurrected');
  const tid='28000000-0000-0000-0000-000000000010';await apply([{kind:'template_upsert',id:tid,branchId:a,name:'Mattina',start:'07:00',end:'15:00',color:'#111111'}]);
  await apply([{kind:'template_upsert',...oldB,name:'Mattina',start:'22:00',end:'06:00',color:'#222222'}]);
  const scopeA=await scalar('select public.planner_load_scoped($1,array[$2]::uuid[]) as value',[oid,a]),scopeB=await scalar('select public.planner_load_scoped($1,array[$2]::uuid[]) as value',[oid,b]);
  assert.deepEqual(scopeA.snapshot.settings.presets.custom.map(t=>[t.name,t.start,t.color]),[['Mattina','07:00','#111111']]);assert.deepEqual(scopeB.snapshot.settings.presets.custom.map(t=>[t.name,t.start,t.color]),[['Mattina','22:00','#222222']]);
  const revisionBefore=await scalar('select public.planner_load_scoped($1,null) as value',[oid]);
  await assert.rejects(scalar('select public.planner_apply_branch_operations($1,$2::jsonb,$3::jsonb,null) as value',[oid,JSON.stringify([{kind:'template_upsert',...oldB,name:'Centrale',start:'01:00',end:'01:00'}]),JSON.stringify(revisionBefore.branch_revisions)]),/check constraint/i);
  await assert.rejects(scalar('select public.planner_apply_branch_operations($1,$2::jsonb,$3::jsonb,null) as value',[oid,JSON.stringify([{kind:'template_upsert',...oldB,name:'Centrale'},{kind:'shift_upsert',id:'missing|'+future,employeeId:'missing',date:future,branchId:b,type:'Notte',start:'22:00',end:'06:00'}]),JSON.stringify(revisionBefore.branch_revisions)]),/approval required|foreign key/i);
  const afterRejected=await scalar('select public.planner_load_scoped($1,null) as value',[oid]);assert.deepEqual(afterRejected.snapshot.settings,revisionBefore.snapshot.settings);assert.deepEqual(afterRejected.branch_revisions,revisionBefore.branch_revisions);
  await assert.rejects(scalar('select public.planner_apply_branch_operations($1,$2::jsonb,$3::jsonb,null) as value',[oid,JSON.stringify([{kind:'template_delete',id:tid,branchId:a}]),JSON.stringify({...revisionBefore.branch_revisions,[a]:0})]),/revision conflict/i);
  // Full snapshot round-trip must not consult current template definitions.
  loaded=await scalar('select public.planner_load() as value');await scalar('select public.planner_save_effective($1::jsonb,$2,false) as value',[JSON.stringify({...loaded.snapshot,expected_organization_id:oid,expected_branch_revisions:loaded.branch_revisions}),loaded.revision]);
  const afterRoundtrip=await scalar('select public.planner_load() as value');assert.deepEqual(afterRoundtrip.snapshot.data.shifts,loaded.snapshot.data.shifts);assert.deepEqual(afterRoundtrip.snapshot.notes,loaded.snapshot.notes);
  // Reversal restores original custom times/color after template edit/delete.
  const rev=(await scalar('select public.planner_load_scoped($1,null) as value',[oid])).branch_revisions[a];
  await scalar("select public.request_revoke($1,$2,$3,$4,true,'Revoca') as value",[oid,req.id,approved.request.version,rev]);
  const restored=(await scalar('select public.planner_load_scoped($1,null) as value',[oid])).snapshot.data.shifts['ea|'+future];assert.deepEqual([restored.type,restored.start,restored.end,restored.presetColor],['Notte','23:00','07:00','#ABC123']);
  // Cross-Sede approval preserves proposal snapshot, even after its template changes.
  const crossDate=await scalar('select (current_date+62)::text as value');
  const proposal=await scalar("select public.cross_branch_shift_propose($1,'ea',$2,$3,'Reception AM','22:00','06:00','proposal-template','Reception AM','#445566') as value",[oid,b,crossDate]);
  await asUser(adminB);await scalar("select public.cross_branch_shift_decide($1,$2,true,'Ok') as value",[oid,proposal.id]);
  const dest=(await scalar('select public.planner_load_scoped($1,null) as value',[oid])).snapshot.data.shifts['ea|'+crossDate];assert.deepEqual([dest.type,dest.start,dest.end,dest.presetColor,dest.branchId],['Reception AM','22:00','06:00','#445566',b]);
  await assert.rejects(apply([{kind:'template_delete',id:tid,branchId:a}]),/access denied/i);
  await assert.rejects(scalar('select public.planner_load_scoped($1,array[$2]::uuid[]) as value',[oid,a]),/scope denied/i);
  assert.ok((await db.query('select * from public.shift_templates')).rows.every(t=>t.branch_id===b));
  await assert.rejects(db.query("update public.shift_templates set name='Attack'"),/permission denied/i);
  await asUser(viewerB);assert.equal((await db.query('select * from public.shift_templates')).rows.length,1);await assert.rejects(apply([{kind:'template_delete',id:oldB.id,branchId:b}]),/access denied/i);
  await db.exec('reset role;set role anon');await assert.rejects(db.query('select * from public.shift_templates'),/permission denied/i);
  await db.exec('reset role');
  // Check every real public FK, including Auth references and new composite keys.
  const {rows:fks}=await db.query(`select c.conname,n.nspname schema_name,t.relname table_name,nr.nspname ref_schema,tr.relname ref_table,
   array(select a.attname from unnest(c.conkey) with ordinality k(num,ord) join pg_attribute a on a.attrelid=c.conrelid and a.attnum=k.num order by ord) cols,
   array(select a.attname from unnest(c.confkey) with ordinality k(num,ord) join pg_attribute a on a.attrelid=c.confrelid and a.attnum=k.num order by ord) ref_cols
   from pg_constraint c join pg_class t on t.oid=c.conrelid join pg_namespace n on n.oid=t.relnamespace join pg_class tr on tr.oid=c.confrelid join pg_namespace nr on nr.oid=tr.relnamespace where c.contype='f' and n.nspname='public'`);
  const q=s=>'"'+s.replaceAll('"','""')+'"';
  for(const fk of fks){const n=await scalar(`select count(*)::int as value from ${q(fk.schema_name)}.${q(fk.table_name)} s where ${fk.cols.map(c=>`s.${q(c)} is not null`).join(' and ')} and not exists(select 1 from ${q(fk.ref_schema)}.${q(fk.ref_table)} r where ${fk.cols.map((c,i)=>`s.${q(c)}=r.${q(fk.ref_cols[i])}`).join(' and ')})`);assert.equal(n,0,fk.conname);}
  console.log(`028 upgrade rehearsal: ${fks.length} FK checks, zero orphans; historical rows unchanged; templates and request snapshots passed.`);
 }finally{await db.close()}
});
