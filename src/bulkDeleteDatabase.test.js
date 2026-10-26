// Synthetic showcase fixtures only; never derived from real accounts or exports.
import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {readFile,readdir} from 'node:fs/promises';
import {buildBulkDeletePlan,applyBulkDelete} from './bulkDelete.js';
import {canonical} from './persistence.js';

test('PostgreSQL bulk deletion is atomic, authorized and confined to one Sede, preserving all other entities',async()=>{
 const db=new PGlite(),dir=new URL('../supabase/migrations/',import.meta.url);
 const owner='28000000-0000-0000-0000-000000000201',adminB='28000000-0000-0000-0000-000000000202',viewerB='28000000-0000-0000-0000-000000000203';
 const scalar=async(sql,args=[])=>(await db.query(sql,args)).rows[0]?.value;
 const asUser=async uid=>{await db.exec('reset role;set role authenticated');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[uid]);};
 try{
  await db.exec("create role anon;create role authenticated;create schema auth;create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema public,auth to anon,authenticated;");
  for(const f of (await readdir(dir)).filter(f=>f.endsWith('.sql')&&Number(f.slice(0,3))<=28).sort())await db.exec(await readFile(new URL(f,dir),'utf8'));
  await db.query('insert into auth.users values($1,$2,now()),($3,$4,now()),($5,$6,now())',[owner,'bulk-owner@example.invalid',adminB,'bulk-admin@example.invalid',viewerB,'bulk-viewer@example.invalid']);
  await asUser(owner);const oid=(await scalar("select public.organization_onboard('Bulk test','Owner') as value")).organization_id;
  const a=await scalar('select id as value from public.branches where organization_id=$1',[oid]),b=(await scalar("select public.branch_create($1,'Sede B') as value",[oid])).id;
  await scalar("select public.branch_employee_create($1,$2,'ea','Demo Sample 016') as value",[oid,a]);await scalar("select public.branch_employee_create($1,$2,'eb','DemoBeta') as value",[oid,b]);
  await scalar("select public.branch_member_assignments_update($1,$2,'branch_admin',null,'all_branches',true,$3::uuid[]) as value",[oid,owner,[a,b]]);
  await scalar("select public.employee_branch_assignment_update($1,'ea',$2::uuid[]) as value",[oid,[a,b]]);
  const inv=await scalar("select public.branch_invite_create($1,'bulk-admin@example.invalid',$2,'branch_admin',null,'all_branches') as value",[oid,b]);await asUser(adminB);await scalar('select public.organization_invite_accept($1) as value',[inv.token]);await asUser(owner);
  const vi=await scalar("select public.branch_invite_create($1,'bulk-viewer@example.invalid',$2,'employee','eb','own') as value",[oid,b]);await asUser(viewerB);await scalar('select public.organization_invite_accept($1) as value',[vi.token]);await asUser(owner);
  const load=()=>scalar('select public.planner_load_scoped($1,null) as value',[oid]);
  const apply=async ops=>scalar('select public.planner_apply_branch_operations($1,$2::jsonb,$3::jsonb,null) as value',[oid,JSON.stringify(ops),JSON.stringify((await load()).branch_revisions)]);
  const date=await scalar("select to_char(current_date+60,'YYYY-MM-DD') as value"),dates=[];for(let i=0;i<5;i++)dates.push(await scalar('select ($1::date+$2::int)::text as value',[date,i]));
  const templates=[{id:'28000000-0000-0000-0000-000000000210',branchId:a,name:'Reception AM',start:'07:35',end:'14:20',color:'#ABCDEF'},{id:'28000000-0000-0000-0000-000000000211',branchId:b,name:'Magazzino 2',start:'22:00',end:'06:00',color:'#123456'}];
  const work=(employeeId,d,branchId,t)=>({kind:'shift_upsert',id:employeeId+'|'+d,employeeId,date:d,branchId,type:t.name,start:t.start,end:t.end,presetId:t.id,presetName:t.name,presetColor:t.color});
  const aIds=dates.slice(0,4).map(d=>'ea|'+d),bIds=['eb|'+dates[0],'ea|'+dates[4]];
  await apply([...templates.map(t=>({kind:'template_upsert',...t})),work('ea',dates[0],a,templates[0]),...['Riposo','Malattia','Ferie'].map((type,i)=>({kind:'shift_upsert',id:aIds[i+1],employeeId:'ea',date:dates[i+1],branchId:a,type,off:true})),work('eb',dates[0],b,templates[1]),work('ea',dates[4],b,templates[1]),{kind:'variation_upsert',id:aIds[0],branchId:a,employeeId:'ea',date:dates[0],start:'08:00',end:'14:20',reason:'Ritardo'},{kind:'variation_upsert',id:bIds[0],branchId:b,employeeId:'eb',date:dates[0],start:'22:30',end:'06:00',reason:'Ritardo'},...[[a,'note-a','ea'],[b,'note-b','eb']].map(([branchId,id,employeeId])=>({kind:'note_upsert',id,branchId,employeeId,date:dates[0],text:'Keep '+id}))]);
  const bulk=(bid,ids,rev)=>scalar('select public.planner_bulk_delete_shifts($1,$2,$3::text[],$4) as value',[oid,bid,ids,rev]);
  const raw=async()=>{await db.exec('reset role');const result={};for(const table of ['shifts','attendance_variations','employees','employee_branch_assignments','notes','settings','shift_templates','branch_planner_state','planner_state'])result[table]=await scalar(`select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]') as value from public.${table} t where organization_id=$1`,[oid]);return result;};
  const before=await raw();await asUser(owner);const initial=await load(),rev=initial.branch_revisions[a];
  for(const [bid,ids,revision,pattern] of [[null,aIds,rev,/one Sede/],[a,null,rev,/one Sede/],[a,[],rev,/one Sede/],[a,[aIds[0],aIds[0]],rev,/one Sede/],[a,[null],rev,/one Sede/],[a,[[aIds[0]]],rev,/one Sede/],[a,aIds,null,/one Sede/],[a,[aIds[0],bIds[0]],rev,/outside selected Sede/],[a,[aIds[0],'missing|'+date],rev,/selection changed/],[a,aIds,rev-1,/revision conflict/]]){
   await assert.rejects(bulk(bid,ids,revision),pattern);assert.deepEqual(await raw(),before,'rejected batch must preserve every row and revision');await asUser(owner);
  }
  await asUser(adminB);await assert.rejects(bulk(a,aIds,rev),/access denied/);await assert.rejects(bulk(b,[aIds[0]],initial.branch_revisions[b]),/outside selected Sede/);
  await asUser(viewerB);await assert.rejects(bulk(b,bIds,initial.branch_revisions[b]),/access denied/);
  await db.exec('reset role;set role anon');await assert.rejects(bulk(a,aIds,rev),/permission denied/);
  assert.deepEqual(await raw(),before);await asUser(owner);
  const plan=buildBulkDeletePlan(initial.snapshot.data,['ea','eb'],dates[0],dates[4],[],a);assert.equal(plan.length,4);
  const result=await bulk(a,plan.map(t=>t.key),rev);assert.deepEqual(canonical(result.snapshot),canonical(applyBulkDelete(initial.snapshot,plan,a)));
  assert.equal(result.branch_revisions[a],rev+1);assert.equal(result.branch_revisions[b],initial.branch_revisions[b]);
  const after=await raw();assert.deepEqual(after.shifts,before.shifts.filter(s=>s.branch_id===b));assert.deepEqual(after.attendance_variations,before.attendance_variations.filter(v=>bIds.includes(v.shift_id)));
  for(const table of ['employees','employee_branch_assignments','notes','settings','shift_templates'])assert.deepEqual(after[table],before[table],table+' must remain byte-for-byte unchanged');
  // Existing historical archive protection must remain active and atomic.
  await asUser(owner);const historic=await scalar("select to_char(date_trunc('month',current_date)-interval '2 months','YYYY-MM-DD') as value");
  await db.exec('reset role');await db.query('insert into public.archive_months(organization_id,month_start) values($1,$2)',[oid,historic]);await asUser(owner);
  await scalar("select public.archive_exceptional_edit_begin($1,$2,'MODIFICA ECCEZIONALE') as value",[oid,historic]);await apply([work('ea',historic,a,templates[0]),work('ea',dates[0],a,templates[0])]);await scalar('select public.archive_exceptional_edit_end($1,$2) as value',[oid,historic]);
  const locked=await raw();await asUser(owner);await assert.rejects(bulk(a,['ea|'+dates[0],'ea|'+historic],(await load()).branch_revisions[a]),/Archived month is read only/);assert.deepEqual(await raw(),locked);
  console.log('Single-Sede database regression: scoped deletion/cascades, untouched B and metadata, malformed/stale/unauthorized batches and archive protection passed.');
 }finally{await db.close();}
});
