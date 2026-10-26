// Synthetic showcase fixtures only; never derived from real accounts or exports.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';

test('PostgreSQL 014: il processor elimina solo mesi idonei, per tenant e in transazione',async()=>{
 const db=new PGlite();
 const users=['20000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000002','20000000-0000-0000-0000-000000000003'];
 const scalar=async(sql,args=[])=>(await db.query(sql,args)).rows[0]?.value;
 const month=async offset=>scalar(`select to_char(date_trunc('month',current_date)+make_interval(months=>$1),'YYYY-MM-DD') as value`,[offset]);
 const asUser=async id=>{await db.exec('reset role;set role authenticated');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id]);};
 try{
  await db.exec("create role anon;create role authenticated;create schema auth;create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema public,auth to anon,authenticated;");
  const dir=new URL('../supabase/migrations/',import.meta.url);
  for(const file of (await readdir(dir)).filter(name=>name.endsWith('.sql')&&name<'015').sort())await db.exec(await readFile(new URL(file,dir),'utf8'));
  await db.query('insert into auth.users values($1,$2,now()),($3,$4,now()),($5,$6,now())',[users[0],'a@example.invalid',users[1],'b@example.invalid',users[2],'c@example.invalid']);
  const organizations=[];
  for(let index=0;index<users.length;index++){
   await asUser(users[index]);
   organizations.push((await scalar('select public.organization_onboard($1,$2) as value',[`Org ${index+1}`,`Admin ${index+1}`])).organization_id);
  }
  await db.exec('reset role');
  for(const [index,oid] of organizations.entries())await db.query('insert into public.employees(organization_id,id,name) values($1,$2,$3)',[oid,`e${index+1}`,`Employee ${index+1}`]);
  await db.query('update public.organizations set archive_retention_months=12 where id=any($1::uuid[])',[organizations.slice(0,2)]);
  await db.query('update public.organizations set archive_retention_months=null where id=$1',[organizations[2]]);

  const eligible=await month(-20),failed=await month(-19),cancelled=await month(-18),notDue=await month(-17),otherTenant=await month(-16),noAutomatic=await month(-15),current=await month(0),future=await month(1);
  const addMonth=async(oid,date,state='scheduled_deletion',grace="clock_timestamp()-interval '1 day'")=>db.query(`insert into public.archive_months(organization_id,month_start,state,deletion_scheduled_at,grace_until) values($1,$2,$3,clock_timestamp()-interval '31 days',${grace})`,[oid,date,state]);
  await addMonth(organizations[0],eligible);
  await addMonth(organizations[0],failed);
  await addMonth(organizations[0],cancelled,'archived');
  await addMonth(organizations[0],notDue,'scheduled_deletion',"clock_timestamp()+interval '1 day'");
  await addMonth(organizations[1],otherTenant);
  await addMonth(organizations[2],noAutomatic);
  await addMonth(organizations[0],current);
  await addMonth(organizations[0],future);

  const addRecords=async(oid,employee,date,label)=>{
   await db.query("select set_config('planner.retention_organization_id',$1,false),set_config('planner.retention_month_start',$2,false)",[oid,date]);
   const shift=`${employee}|${date}`;
   await db.query("insert into public.shifts(organization_id,id,employee_id,date,type,start_time,end_time) values($1,$2,$3,$4,'Mattina','09:30','17:30')",[oid,shift,employee,date]);
   await db.query("insert into public.attendance_variations(organization_id,id,shift_id,actual_start_time,actual_end_time,reason) values($1,$2,$2,'09:45','17:30','Ritardo')",[oid,shift]);
   await db.query('insert into public.notes(organization_id,id,text,date,employee_id) values($1,$2,$3,$4,$5)',[oid,`note-${label}`,label,date,employee]);
   const requestId=await scalar("insert into public.requests(organization_id,employee_id,employee_name,created_by_name,type,start_date,end_date) values($1,$2,$3,'Fixture','Ferie',$4,$4) returning id as value",[oid,employee,label,date]);
   await db.query("insert into public.request_events(organization_id,request_id,actor_name,action,request_snapshot) values($1,$2,'Fixture','created','{}')",[oid,requestId]);
   await db.query("insert into public.request_shift_changes(organization_id,request_id,employee_id,shift_date,applied_shift) values($1,$2,$3,$4,'{}')",[oid,requestId,employee,date]);
  };
  for(const [oid,employee,date,label] of [
   [organizations[0],'e1',eligible,'eligible'],[organizations[0],'e1',failed,'fail-fixture'],
   [organizations[0],'e1',cancelled,'cancelled'],[organizations[0],'e1',notDue,'not-due'],
   [organizations[1],'e2',otherTenant,'other'],[organizations[2],'e3',noAutomatic,'no-auto'],
   [organizations[0],'e1',current,'current'],[organizations[0],'e1',future,'future']
  ])await addRecords(oid,employee,date,label);

  await db.exec("create function public.fail_retention_fixture() returns trigger language plpgsql as $$begin if old.text='fail-fixture' then raise exception 'disposable fixture failure'; end if;return old;end$$;create trigger retention_fixture_failure before delete on public.notes for each row execute function public.fail_retention_fixture();");

  let result=await scalar("select planner_private.process_archive_retention('manual-test',$1) as value",[organizations[0]]);
  assert.deepEqual(result,{succeeded:1,failed:1});
  assert.equal(await scalar('select count(*)::int as value from public.shifts where organization_id=$1 and date=$2',[organizations[0],eligible]),0,'past-grace scheduled month is deleted');
  assert.equal(await scalar('select count(*)::int as value from public.notes where organization_id=$1 and date=$2',[organizations[0],failed]),1,'failure rolls back earlier deletes for the month');
  assert.equal(await scalar('select count(*)::int as value from public.shifts where organization_id=$1 and date in ($2,$3,$4,$5)',[organizations[0],cancelled,notDue,current,future]),4,'cancelled, not-due, current, and future months survive');
  assert.equal(await scalar('select count(*)::int as value from public.shifts where organization_id=$1 and date=$2',[organizations[1],otherTenant]),1,'scoped processing cannot touch another tenant');
  assert.equal(await scalar('select count(*)::int as value from public.shifts where organization_id=$1 and date=$2',[organizations[2],noAutomatic]),1,'no-automatic-deletion organization survives');
  assert.equal(await scalar("select count(*)::int as value from public.archive_retention_log where organization_id=$1 and month_start=$2 and status='succeeded'",[organizations[0],eligible]),1,'success audit row is written');
  assert.equal(await scalar("select count(*)::int as value from public.archive_retention_log where organization_id=$1 and month_start=$2 and status='failed'",[organizations[0],failed]),1,'failure is diagnosable');
  assert.equal(await scalar('select count(*)::int as value from public.employees where organization_id=$1',[organizations[0]]),1,'employee master record is preserved');

  result=await scalar("select planner_private.process_archive_retention('manual-test-rerun',$1) as value",[organizations[0]]);
  assert.deepEqual(result,{succeeded:0,failed:1});
  assert.equal(await scalar("select count(*)::int as value from public.archive_retention_log where organization_id=$1 and month_start=$2 and status='succeeded'",[organizations[0],eligible]),1,'rerun is idempotent');

  result=await scalar("select planner_private.process_archive_retention('manual-test-other',$1) as value",[organizations[1]]);
  assert.deepEqual(result,{succeeded:1,failed:0});
  assert.equal(await scalar('select count(*)::int as value from public.shifts where organization_id=$1 and date=$2',[organizations[1],otherTenant]),0);
  await asUser(users[0]);
  await assert.rejects(scalar('select public.archive_deletion_cancel($1,$2) as value',[organizations[0],eligible]),/Scheduled archive month unavailable/,'a stale cancellation cannot resurrect a deleted month');
  await assert.rejects(scalar("select planner_private.process_archive_retention('browser-attempt',$1) as value",[organizations[0]]),/permission denied/,'normal users cannot invoke the backend processor');
 }finally{await db.close();}
});
