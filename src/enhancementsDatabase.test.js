// Synthetic showcase fixtures only; never derived from real accounts or exports.
import {LEGACY_SETTINGS} from './legacySettings.js';
import {makeLegacyShift as makeShift} from './testFixtures.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {emptySnapshot} from './plannerStore.js';
import {applyPresetSettingsFrom} from './schedule.js';

test('PostgreSQL 008–012: richieste, note, modelli e preferenze personali isolate',async()=>{
 const db=new PGlite(),admin='10000000-0000-0000-0000-000000000001',viewer='10000000-0000-0000-0000-000000000002';
 const scalar=async(sql,args=[])=>(await db.query(sql,args)).rows[0]?.value;
 const asUser=async id=>{await db.exec('reset role; set role authenticated');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id]);};
 try{
  await db.exec("create role anon;create role authenticated;create schema auth;create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema public,auth to anon,authenticated;");
  const dir=new URL('../supabase/migrations/',import.meta.url);for(const file of (await readdir(dir)).filter(x=>x.endsWith('.sql')&&Number(x.slice(0,3))<=27).sort())await db.exec(await readFile(new URL(file,dir),'utf8'));
  await db.query('insert into auth.users values($1,$2,now()),($3,$4,now())',[admin,'admin@example.invalid',viewer,'viewer@example.invalid']);
  await asUser(admin);const account=await scalar("select public.organization_onboard('Azienda','Admin') as value"),oid=account.organization_id;
  // Keep these legacy template/preference fixtures in editable months as time advances.
  const dates=await scalar("select jsonb_build_object('earlier',to_char(date_trunc('month',current_date)+interval '24 days','YYYY-MM-DD'),'initial',to_char(date_trunc('month',current_date)+interval '25 days','YYYY-MM-DD'),'effective',to_char(date_trunc('month',current_date)+interval '1 month','YYYY-MM-DD'),'later',to_char(date_trunc('month',current_date)+interval '1 month 1 day','YYYY-MM-DD')) as value");
  const snapshot={...emptySnapshot(),settings:structuredClone(LEGACY_SETTINGS)};snapshot.data.employees=[{id:'e1',name:'Demo Sample 016'},{id:'e2',name:'DemoBeta'}];snapshot.data.shifts={[`e1|${dates.earlier}`]:makeShift('Mattina'),[`e1|${dates.later}`]:makeShift('Mattina')};snapshot.notes=[{id:'n1',text:'Nota iniziale',date:dates.initial,employeeId:''}];snapshot.settings.templateEffectiveFrom=dates.initial;
  await scalar('select public.planner_save_effective($1::jsonb,0,true) as value',[JSON.stringify({...snapshot,expected_organization_id:oid})]);
  await db.exec('reset role');await db.query("insert into public.profiles(user_id,organization_id,full_name,role,employee_id,is_active) values($1,$2,'Demo Sample 016','viewer','e1',true)",[viewer,oid]);
  await asUser(admin);let adminPreferences=await scalar("select public.user_planner_preferences_save($1,240,array['e2','e1']) as value",[oid]);assert.equal(adminPreferences.employee_column_width,240);assert.deepEqual(adminPreferences.employee_order,['e2','e1']);await scalar("select public.user_planner_visibility_save($1,array['e1']) as value",[oid]);
  await db.exec('start transaction read only');adminPreferences=await scalar('select public.user_planner_preferences() as value');assert.deepEqual(adminPreferences.employee_order,['e2','e1']);assert.deepEqual(adminPreferences.hidden_employee_ids,['e1']);await db.exec('rollback');
  await asUser(viewer);assert.equal((await scalar('select public.user_planner_preferences() as value')).employee_column_width,190);let viewerPreferences=await scalar("select public.user_planner_preferences_save($1,160,array['e1','e2']) as value",[oid]);assert.equal(viewerPreferences.employee_column_width,160);assert.deepEqual(viewerPreferences.employee_order,['e1','e2']);assert.deepEqual((await scalar('select public.user_planner_preferences() as value')).hidden_employee_ids,[]);await assert.rejects(scalar("select public.user_planner_preferences_save($1,500,array['e1']) as value",[oid]));await assert.rejects(scalar("select public.user_planner_preferences_save($1,180,array['missing']) as value",[oid]));await assert.rejects(scalar("select public.user_planner_visibility_save($1,array['missing']) as value",[oid]));
  await asUser(admin);adminPreferences=await scalar('select public.user_planner_preferences() as value');assert.equal(adminPreferences.employee_column_width,240);assert.deepEqual(adminPreferences.employee_order,['e2','e1']);assert.deepEqual(adminPreferences.hidden_employee_ids,['e1']);
  await asUser(viewer);assert.equal((await scalar('select public.note_unread_state($1) as value',[oid])).unread,true);await scalar('select public.note_mark_read($1) as value',[oid]);assert.equal((await scalar('select public.note_unread_state($1) as value',[oid])).unread,false);
  const permission=await scalar(`select public.request_create($1,'e1','Permesso','${dates.later}','${dates.later}','10:00','11:00','Visita') as value`,[oid]);
  await asUser(admin);let loaded=await scalar('select public.planner_load() as value'),approved=await scalar(`select public.request_approve($1,$2,$3,$4,false,'Orario corretto','Permesso','${dates.later}','${dates.later}','10:30','11:30') as value`,[oid,permission.id,permission.version,loaded.revision]);
  assert.equal(approved.request.adjusted,true);assert.equal(approved.request.start_time,'10:00:00');assert.equal(approved.request.approved_start_time,'10:30:00');
  await asUser(viewer);assert.equal((await scalar('select public.request_list($1) as value',[oid])).find(x=>x.id===permission.id).approved_start_time,'10:30:00');let requestUnread=await scalar('select public.request_unread_state($1) as value',[oid]);assert.equal(requestUnread.unread,true);assert.deepEqual(requestUnread.request_ids,[permission.id]);await scalar('select public.request_mark_read($1) as value',[oid]);assert.equal((await scalar('select public.request_unread_state($1) as value',[oid])).unread,false);
  const holiday=await scalar(`select public.request_create($1,'e1','Ferie','${dates.later}','${dates.later}',null,null,'Ferie') as value`,[oid]);
  await asUser(admin);loaded=await scalar('select public.planner_load() as value');approved=await scalar(`select public.request_approve($1,$2,$3,$4,true,'','Ferie','${dates.later}','${dates.later}',null,null) as value`,[oid,holiday.id,holiday.version,loaded.revision]);assert.equal((await scalar(`select type as value from public.shifts where organization_id=$1 and id='e1|${dates.later}'`,[oid])),'Ferie');
  const revoked=await scalar("select public.request_revoke($1,$2,$3,$4,true,'Cambio programma') as value",[oid,holiday.id,approved.request.version,approved.revision]);assert.equal(revoked.request.status,'revoked');assert.equal((await scalar(`select type as value from public.shifts where organization_id=$1 and id='e1|${dates.later}'`,[oid])),'Mattina');
  loaded=await scalar('select public.planner_load() as value');const next=structuredClone(loaded.snapshot),before=structuredClone(next.settings);next.settings.presets.Mattina={start:'08:00',end:'16:00'};next.settings.templateEffectiveFrom=dates.effective;next.data=applyPresetSettingsFrom(next.data,before,next.settings,dates.effective);await scalar('select public.planner_save_effective($1::jsonb,$2,false) as value',[JSON.stringify({...next,expected_organization_id:oid}),loaded.revision]);
  const shifts=(await scalar('select public.planner_load() as value')).snapshot.data.shifts;assert.deepEqual([shifts[`e1|${dates.earlier}`].start,shifts[`e1|${dates.later}`].start],['09:30','09:30'],'legacy template edits preserve assignment snapshots');assert.equal(await scalar('select count(*)::int as value from public.shift_template_versions where organization_id=$1',[oid]),2);
  await asUser(viewer);assert.equal((await scalar('select public.note_unread_state($1) as value',[oid])).unread,false);
 }finally{await db.close();}
});
