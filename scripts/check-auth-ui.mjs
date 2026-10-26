// Synthetic showcase fixtures only; never derived from real accounts or exports.
// Isolated browser smoke checks. No real credentials, accounts or local data.
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {createServer} from 'vite';
import {emptySnapshot} from '../src/plannerStore.js';
import {checkPlannerReview} from './check-planner-review.mjs';
import {checkSedeRefinements} from './check-sede-refinements.mjs';
import {checkMobilePlanner} from './check-mobile-planner.mjs';
import {CLIENT_PROTOCOL,READ_RPCS} from '../src/clientCompatibility.js';
import {legacy029Frontend} from './test-client-030.mjs';
import {checkClientCompatibility} from './check-client-compatibility.mjs';
import {STORAGE_KEY} from '../src/schedule.js';
const server=await createServer({cacheDir:'node_modules/.vite-showcase-smoke',envFile:false,define:{'import.meta.env.VITE_SUPABASE_URL':JSON.stringify('https://tenant-test.invalid'),'import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY':JSON.stringify('sb_publishable_browser_test'),'import.meta.env.VITE_SUPPORT_EMAIL':JSON.stringify('support@example.test')},server:{host:'127.0.0.1',port:5189,strictPort:true}});
let browser,legacyServer;
try{
 await server.listen();browser=await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL||'chrome',headless:true});
	 const context=await browser.newContext();const page=await context.newPage(),cdp=await context.newCDPSession(page);const errors=[];page.on('pageerror',e=>errors.push(e.message));await cdp.send('Accessibility.enable');
 page.setDefaultTimeout(15000);
	 await context.grantPermissions(['clipboard-read','clipboard-write'],{origin:'http://127.0.0.1:5189'});
 let schemaVersion=30,gateOpen=true;
 const compatibility=()=>({schema_version:schemaVersion,client_protocol:CLIENT_PROTOCOL,writes_enabled:gateOpen});
 const extraBranches={},deletedTemplates={},undoReceipts=new Map();const branchesFor=id=>[{id:`branch-${id}`,name:`Sede ${id}`,active:true,readable:true,operable:true,admin:true},...(extraBranches[id]||[])];
 const deletedColorsFor=id=>(deletedTemplates[id]||[]).filter(t=>branchesFor(id).some(b=>b.id===t.branchId&&b.readable)).sort((a,b)=>a.id.localeCompare(b.id));
 const accounts={A:{user_id:'A',organization_id:'org-A',organization_name:'Organizzazione A',full_name:'Responsabile A',role:'admin'},B:{user_id:'B',organization_id:'org-B',organization_name:'Organizzazione B',full_name:'Responsabile B',role:'editor'}};
 const user=id=>({id,aud:'authenticated',role:'authenticated',email:`${id.toLowerCase()}@example.invalid`,email_confirmed_at:new Date().toISOString(),created_at:new Date().toISOString(),user_metadata:{}});
 const token=id=>`${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify({sub:id,exp:Math.floor(Date.now()/1000)+3600,role:'authenticated'})).toString('base64url')}.test`;
 const session=id=>({access_token:token(id),refresh_token:`refresh-${id}`,token_type:'bearer',expires_in:3600,user:user(id)});
 const data={A:emptySnapshot(),B:emptySnapshot(),C:emptySnapshot()},preferences={};for(const id of ['A','B'])data[id].data.employees=[{id:`employee-${id}`,name:`Dipendente ${id}`,homeBranchId:`branch-${id}`}];// Explicit user-created fixtures; these names are ordinary templates.
 data.A.settings.presets.custom=[{id:'user-morning',branchId:'branch-A',name:'Mattina',start:'09:30',end:'17:30',color:'#7DD3FC'},{id:'user-afternoon',branchId:'branch-A',name:'Pomeriggio',start:'14:00',end:'22:00',color:'#1D4E89'},{id:'user-central',branchId:'branch-A',name:'Centrale',start:'10:00',end:'18:00',color:'#F59E0B'}];
 data.A.settings.legacyColors={Mattina:'#7DD3FC'};
 data.A.data.shifts['employee-A|2026-08-15']={type:'Mattina',off:false,start:'09:30',end:'17:30',branchId:'branch-A'};
 const archives={A:{organization_id:'org-A',retention_months:24,months:[{month_start:'2026-08-01',state:'archived',approaching_deletion:false,deletion_scheduled_at:null,grace_until:null,exceptional_edit_until:null}]}};
	 const requests={D:[{id:'request-own-final',organization_id:'org-D',employee_id:'invited-employee',employee_name:'Dipendente invitato',created_by_user_id:'D',created_by_name:'Viewer',type:'Ferie',start_date:'2026-09-22',end_date:'2026-09-22',start_time:null,end_time:null,note:'Storico personale',status:'approved',version:2,created_at:'2026-09-01T00:00:00Z'},{id:'request-team-pending',organization_id:'org-D',employee_id:'colleague',employee_name:'Collega',created_by_user_id:'X',created_by_name:'Collega',type:'Permesso',start_date:'2026-09-28',end_date:'2026-09-28',start_time:'09:00',end_time:'11:00',note:'Visibile al team',status:'pending',version:1,created_at:'2026-09-02T00:00:00Z'}]};
	 const members={A:[{user_id:'A',organization_id:'org-A',full_name:'Responsabile A',role:'branch_admin',branch_id:'branch-A',branch_ids:['branch-A'],visibility_level:'all_branches',employee_id:null,is_active:true,organization_role:'owner'},{user_id:'member-2',organization_id:'org-A',full_name:'Éxample Fixturé',role:'viewer',branch_id:'branch-A',branch_ids:['branch-A'],visibility_level:'all_branches',employee_id:null,is_active:true,organization_role:'member'}]},invitations={A:[]};
	 let writes=0,resets=0,passwordUpdates=0,registrations=0,accepts=0,requestRead=false,memberUpdates=0;
 await context.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
 await context.route('https://tenant-test.invalid/**',async route=>{
 const request=route.request(),url=new URL(request.url()),body=request.postDataJSON?.()||{};
 if(url.pathname.startsWith('/auth/v1/'))assert.equal(request.headers()['x-planner-protocol'],undefined,'Auth must keep its supported CORS headers');
 let id;try{id=JSON.parse(Buffer.from((request.headers().authorization||'').split('.')[1],'base64url')).sub;}catch{}
 const rpcName=url.pathname.split('/').at(-1);
 if(url.pathname.includes('/rpc/')&&!READ_RPCS.has(rpcName)&&(!gateOpen||schemaVersion!==30||request.headers()['x-planner-protocol']!==CLIENT_PROTOCOL)){
  await route.fulfill({status:400,contentType:'application/json',body:JSON.stringify({code:'P0030',message:'Ricarica la pagina.'})});return;
 }
 let result={};
 if(url.pathname.endsWith('/planner_client_compatibility')){
  if(schemaVersion!==30){await route.fulfill({status:404,contentType:'application/json',body:JSON.stringify({code:'PGRST202'})});return;}
  result=compatibility();
 }
 else if(url.pathname.endsWith('/token'))result=session((body.email?.[0]||body.refresh_token?.at(-1)||'A').toUpperCase());
 else if(url.pathname.endsWith('/signup')){registrations++;if(body.email==='d@example.invalid'){assert.deepEqual(body.data,{});assert.equal(new URL(url.searchParams.get('redirect_to')).searchParams.get('invite'),'test-invite');}else assert.equal(body.data.organization_name,'Nuova organizzazione');result={user:user('C'),session:null};}
 else if(url.pathname.endsWith('/recover')){resets++;assert.equal(new URL(url.searchParams.get('redirect_to')).searchParams.get('recovery'),'1');result={};}
 else if(url.pathname.endsWith('/user')){if(request.method()==='PUT')passwordUpdates++;result=user(id||'A');}
 else if(url.pathname.endsWith('/logout'))result={};
 else if(url.pathname.endsWith('/account_context'))result=accounts[id]||null;
 else if(url.pathname.endsWith('/organization_invite_resolve'))result=body.p_token==='test-invite'?{email:'d@example.invalid',expires_at:'2026-10-04T10:00:00Z'}:null;
 else if(url.pathname.endsWith('/organization_invite_check'))result=body.p_token==='test-invite'&&body.p_email==='d@example.invalid';
 else if(url.pathname.endsWith('/organization_invite_accept')){
 accepts++;assert.equal(body.p_token,'test-invite');assert.equal('p_full_name' in body,false);
 if(accepts===1){await route.fulfill({status:400,contentType:'application/json',body:JSON.stringify({message:'Account already has a membership; contact an admin (no automatic tenant transfer)'})});return;}
 result=accounts[id]={user_id:id,organization_id:`org-${id}`,organization_name:'Organizzazione invitante',full_name:'',role:'viewer',employee_id:'invited-employee'};
		 data[id]=emptySnapshot();data[id].data.employees=[{id:'invited-employee',name:'Dipendente invitato'},{id:'colleague',name:'Collega'},{id:'long-name',name:'Dipendente con un nome volutamente molto lungo'},...Array.from({length:17},(_,index)=>({id:`extra-${index}`,name:`Dipendente aggiuntivo ${index+1}`}))].map(item=>({...item,homeBranchId:`branch-${id}`}));data[id].data.shifts['invited-employee|2026-08-10']={type:'Mattina',off:false,start:'09:30',end:'17:30',branchId:`branch-${id}`};data[id].notes=[{id:'note-30',text:'Nota 30',date:'2026-09-30',employeeId:'',branchId:`branch-${id}`},{id:'note-26',text:'Nota 26',date:'2026-09-26',employeeId:'',branchId:`branch-${id}`},{id:'note-28',text:'Nota 28',date:'2026-09-28',employeeId:'',branchId:`branch-${id}`}];archives[id]={organization_id:`org-${id}`,retention_months:24,months:[{month_start:'2026-08-01',state:'archived',approaching_deletion:false,deletion_scheduled_at:null,grace_until:null,exceptional_edit_until:null}]};
 }
 else if(url.pathname.endsWith('/organization_onboard'))result=accounts[id]={user_id:id,organization_id:`org-${id}`,organization_name:body.organization_name,full_name:body.manager_name,role:'admin'};
 else if(url.pathname.endsWith('/account_update'))result=accounts[id]={...accounts[id],full_name:body.manager_name,...(body.organization_name===undefined?{}:{organization_name:body.organization_name})};
	 else if(url.pathname.endsWith('/request_list'))result=requests[id]||[];
	 else if(url.pathname.endsWith('/note_unread_state'))result={organization_id:`org-${id}`,unread:id==='D'};
	 else if(url.pathname.endsWith('/note_mark_read'))result={organization_id:`org-${id}`,unread:false,read_at:new Date().toISOString()};
	 else if(url.pathname.endsWith('/request_unread_state'))result={organization_id:`org-${id}`,unread:id==='D'&&!requestRead,request_ids:id==='D'&&!requestRead?['request-own-final']:[]};
	 else if(url.pathname.endsWith('/request_mark_read')){requestRead=true;result={organization_id:`org-${id}`,unread:false,request_ids:[],read_at:new Date().toISOString()};}
 else if(url.pathname.endsWith('/user_planner_preferences'))result={organization_id:`org-${id}`,employee_column_width:preferences[id]?.employee_column_width||190,employee_order:preferences[id]?.employee_order||[],hidden_employee_ids:preferences[id]?.hidden_employee_ids||[],branch_preferences:preferences[id]?.branch_preferences||{}};
 else if(url.pathname.endsWith('/user_branch_employee_order_save')){
  const scoped=preferences[id]?.branch_preferences||{},prior=scoped[body.p_branch_id]||{};
  if(JSON.stringify(prior.employee_order??null)!==JSON.stringify(body.p_expected_order)){await route.fulfill({status:400,contentType:'application/json',body:JSON.stringify({code:'40001'})});return;}
  preferences[id]={...preferences[id],branch_preferences:{...scoped,[body.p_branch_id]:{...prior,employee_order:body.p_employee_order}}};result={organization_id:`org-${id}`,...preferences[id]};
 }
 else if(url.pathname.endsWith('/user_branch_planner_preferences_save')){
  const scoped=preferences[id]?.branch_preferences||{},prior=scoped[body.p_branch_id]||{},patch={};
  if(body.p_employee_order!==null)patch.employee_order=body.p_employee_order;
  if(body.p_template_sort_key!==null)patch.template_sort={key:body.p_template_sort_key,direction:body.p_template_sort_direction};
  preferences[id]={...preferences[id],branch_preferences:{...scoped,[body.p_branch_id]:{...prior,...patch}}};
  result={organization_id:`org-${id}`,...preferences[id]};
 }
 else if(url.pathname.endsWith('/user_planner_preferences_save')){preferences[id]={...preferences[id],employee_column_width:body.p_employee_column_width,employee_order:body.p_employee_order};result={organization_id:`org-${id}`,...preferences[id]};}
 else if(url.pathname.endsWith('/user_planner_visibility_save')){preferences[id]={...preferences[id],hidden_employee_ids:body.p_hidden_employee_ids};result={organization_id:`org-${id}`,hidden_employee_ids:body.p_hidden_employee_ids};}
 else if(url.pathname.endsWith('/archive_list'))result=archives[id]||{organization_id:`org-${id}`,retention_months:24,months:[]};
 else if(url.pathname.endsWith('/archive_exceptional_edit_begin')){assert.equal(body.p_confirmation,'MODIFICA ECCEZIONALE');archives[id].months[0].exceptional_edit_until=new Date(Date.now()+1800000).toISOString();result={organization_id:`org-${id}`,...archives[id].months[0]};}
 else if(url.pathname.endsWith('/archive_exceptional_edit_end')){archives[id].months[0].exceptional_edit_until=null;result={organization_id:`org-${id}`,...archives[id].months[0]};}
	 else if(url.pathname.endsWith('/archive_delete_manual')){assert.equal(body.p_confirmation,'ELIMINA AGOSTO 2026');archives[id].months=[];result={organization_id:`org-${id}`,month_start:body.p_month_start,status:'deleted',deleted_counts:{}};}
	 else if(url.pathname.endsWith('/archive_backup_record'))result={organization_id:`org-${id}`,scope:body.p_scope,month_start:body.p_month_start,created_at:new Date().toISOString()};
	 else if(url.pathname.endsWith('/branch_access_overview')||url.pathname.endsWith('/organization_members'))result=members[id]||[];

	 else if(url.pathname.endsWith('/employee_branch_assignment_overview'))result=(data[id]?.data?.employees||[]).map(employee=>({
	  organization_id:`org-${id}`,
	  employee_id:employee.id,
	  employee_name:employee.name,
	  user_id:(members[id]||[]).find(member=>member.employee_id===employee.id)?.user_id||null,
	  branch_ids:Array.isArray(employee.branchIds)&&employee.branchIds.length
	   ?employee.branchIds
	   :[employee.homeBranchId||`branch-${id}`].filter(Boolean)
	 }));

	 else if(url.pathname.endsWith('/employee_branch_assignment_update')){
	  const employee=data[id]?.data?.employees?.find(item=>item.id===body.p_employee_id);
	  if(employee)employee.branchIds=body.p_branch_ids||[];
	  result={
	   organization_id:`org-${id}`,
	   employee_id:body.p_employee_id,
	   branch_ids:body.p_branch_ids||[]
	  };
	 }

	 else if(url.pathname.endsWith('/branch_member_assignments_update')||url.pathname.endsWith('/branch_member_update')||url.pathname.endsWith('/organization_member_update')){
	  if(body.p_user_id==='A'&&body.p_role==='viewer'){
	   await route.fulfill({status:400,contentType:'application/json',body:JSON.stringify({message:'Cannot remove the last active admin'})});
	   return;
	  }
	  memberUpdates++;
	  const member=members[id].find(item=>item.user_id===body.p_user_id);
	  Object.assign(member,{
	   role:body.p_role,
	   branch_id:body.p_branch_id??body.p_branch_ids?.[0]??member.branch_id,
	   branch_ids:body.p_branch_ids??member.branch_ids??[],
	   visibility_level:body.p_visibility_level,
	   employee_id:body.p_employee_id,
	   is_active:body.p_is_active
	  });
	  result=member;
	 }
	 else if(url.pathname.endsWith('/cross_branch_shift_list'))result=[];

	 else if(url.pathname.endsWith('/access_invite_list')||url.pathname.endsWith('/organization_invite_list'))result=invitations[id]||[];
	 else if(url.pathname.endsWith('/branch_invite_create')||url.pathname.endsWith('/organization_invite_create')){const created={id:'invite-1',organization_id:`org-${id}`,email:body.p_email,role:body.p_target_role||body.p_role,employee_id:body.p_employee_id,target_branch_id:body.p_target_branch_id,expires_at:'2026-10-04T10:00:00Z',token:'a'.repeat(64)};invitations[id]=[{...created,token:undefined,accepted_at:null,revoked_at:null}];result=created;}
	 else if(url.pathname.endsWith('/access_invite_revoke')||url.pathname.endsWith('/organization_invite_revoke')){invitations[id]=[];result=null;}
 else if(url.pathname.endsWith('/request_create')){assert.equal(body.p_employee_id,accounts[id].employee_id);const created={id:'request-created',organization_id:`org-${id}`,employee_id:body.p_employee_id,employee_name:'Dipendente invitato',created_by_user_id:id,created_by_name:'Viewer',type:body.p_type,start_date:body.p_start_date,end_date:body.p_end_date,start_time:body.p_start_time,end_time:body.p_end_time,note:body.p_note,status:'pending',version:1,created_at:new Date().toISOString()};requests[id]=[created,...(requests[id]||[])];result=created;}
 else if(url.pathname.endsWith('/request_update')){const item=requests[id].find(item=>item.id===body.p_request_id);Object.assign(item,{type:body.p_type,start_date:body.p_start_date,end_date:body.p_end_date,note:body.p_note,version:item.version+1});result=item;}
 else if(url.pathname.endsWith('/request_cancel')){const item=requests[id].find(item=>item.id===body.p_request_id);Object.assign(item,{status:'cancelled',version:item.version+1});result={ok:true,request:item,revision:writes};}
	 else if(url.pathname.endsWith('/planner_undo')){
  const receipt=undoReceipts.get(body.p_token);if(!receipt||receipt.id!==id){await route.fulfill({status:400,contentType:'application/json',body:JSON.stringify({code:'40001'})});return;}
  data[id]=structuredClone(receipt.before);undoReceipts.delete(body.p_token);writes++;
  result={organization_id:`org-${id}`,revision:writes,empty:false,branches:branchesFor(id),selected_branch_ids:branchesFor(id).map(b=>b.id),branch_revisions:{[`branch-${id}`]:writes},deleted_template_colors:deletedColorsFor(id),client_compatibility:compatibility(),planner_features:{template_names:true,undo:true},snapshot:data[id]};
 }
 else if(url.pathname.endsWith('/planner_apply_branch_operations')){
  const before=structuredClone(data[id]);
	  for(const op of body.p_operations){if(op.kind==='employee_upsert'){const next={id:op.id,name:op.name,homeBranchId:op.branchId},index=data[id].data.employees.findIndex(item=>item.id===op.id);if(index<0)data[id].data.employees.push(next);else data[id].data.employees[index]=next;}else if(op.kind==='employee_delete')data[id].data.employees=data[id].data.employees.filter(item=>item.id!==op.id);else if(op.kind==='shift_upsert'){const {kind,id:shiftId,employeeId,date,branchId,...shift}=op;
   const scoped=[...data[id].settings.presets.custom,...(deletedTemplates[id]||[])].filter(t=>t.branchId===branchId);
   const template=shift.presetId&&(scoped.find(t=>t.id===shift.presetId)||scoped.find(t=>t.legacyPresetId===shift.presetId));
   data[id].data.shifts[shiftId]={...shift,branchId,...(template?{presetColor:template.color,...(data[id].settings.presets.custom.includes(template)?{type:template.name,presetName:template.name}:{})}:{})};
  }else if(op.kind==='shift_delete'){delete data[id].data.shifts[op.id];delete data[id].variations[op.id];}else if(op.kind==='variation_upsert'){const {kind,id:variationId,branchId,...value}=op;assert.equal(branchId,data[id].data.shifts[variationId].branchId);data[id].variations[variationId]={...value,branchId:data[id].data.shifts[variationId].branchId};}else if(op.kind==='variation_delete')delete data[id].variations[op.id];else if(op.kind==='template_upsert'){
   const {kind,updateFutureTimes,timeZone,...template}=op,list=data[id].settings.presets.custom,previous=list.find(t=>t.id===template.id);
   if(previous&&(previous.color!==template.color||previous.name!==template.name||op.updateFutureTimes))for(const shift of Object.values(data[id].data.shifts)){
    const scoped=[...list,...(deletedTemplates[id]||[])].filter(t=>t.branchId===shift.branchId);
    const resolved=scoped.find(t=>t.id===shift.presetId)||scoped.find(t=>t.legacyPresetId===shift.presetId);
    if(resolved?.id===template.id&&shift.branchId===template.branchId){
     if(previous.color!==template.color)shift.presetColor=template.color;
     if(previous.name!==template.name){shift.type=template.name;shift.presetName=template.name;}
    }
   }
   if(previous&&op.updateFutureTimes&&(previous.start!==template.start||previous.end!==template.end))for(const [key,shift] of Object.entries(data[id].data.shifts)){if(shift.branchId===template.branchId&&shift.presetId===template.id&&key.slice(-10)>'2026-09-27'){shift.start=template.start;shift.end=template.end;}}
   data[id].settings.presets.custom=previous?list.map(t=>t.id===template.id?template:t):[...list,template];
  }else if(op.kind==='status_style_upsert'){data[id].settings.statusStyles||={};data[id].settings.statusStyles[op.branchId]||={};data[id].settings.statusStyles[op.branchId][op.status]={name:op.name,color:op.color};}else if(op.kind==='template_delete'){const prior=data[id].settings.presets.custom.find(t=>t.id===op.id);assert.ok(prior);deletedTemplates[id]=[...(deletedTemplates[id]||[]),{id:prior.id,branchId:prior.branchId,color:prior.color,...(prior.legacyPresetId?{legacyPresetId:prior.legacyPresetId}:{})}];data[id].settings.presets.custom=data[id].settings.presets.custom.filter(t=>t.id!==op.id);}else if(op.kind==='settings_update')throw Error('Shared settings write must not be used');}writes++;
   let undo_token; if(body.p_operations.length&&body.p_operations.every(op=>['shift_upsert','shift_delete','variation_upsert','variation_delete'].includes(op.kind))){undo_token=crypto.randomUUID();undoReceipts.set(undo_token,{id,before});}
	  result={organization_id:`org-${id}`,revision:writes,empty:false,branches:branchesFor(id),selected_branch_ids:branchesFor(id).map(b=>b.id),branch_revisions:{[`branch-${id}`]:writes},deleted_template_colors:deletedColorsFor(id),client_compatibility:compatibility(),planner_features:{template_names:true,undo:true},undo_token,snapshot:data[id]};
	 }
	 else if(url.pathname.endsWith('/planner_load_scoped'))result={organization_id:`org-${id}`,revision:writes,empty:id==='C'&&!data.C.data.employees.length,branches:branchesFor(id),selected_branch_ids:branchesFor(id).map(b=>b.id),branch_revisions:{[`branch-${id}`]:writes},deleted_template_colors:deletedColorsFor(id),client_compatibility:compatibility(),planner_features:{template_names:true,undo:true},snapshot:data[id]};
	 else if(url.pathname.endsWith('/planner_load')||url.pathname.endsWith('/planner_save')||url.pathname.endsWith('/planner_save_effective')){
	 if(url.pathname.endsWith('/planner_save')||url.pathname.endsWith('/planner_save_effective')){assert.equal(body.payload.expected_organization_id,`org-${id}`);const {expected_organization_id,...snapshot}=body.payload;data[id]=snapshot;writes++;}
 result={organization_id:`org-${id}`,revision:writes,empty:id==='C'&&!data.C.data.employees.length,snapshot:data[id]};
 }else throw Error(`Unexpected request: ${url.pathname}`);
 await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(result)});
 });
 const legacy=JSON.stringify({version:1,employees:[{id:'local',name:'Dati locali riservati'}],shifts:{}});
 await page.addInitScript(({key,legacy})=>{if(!localStorage.getItem(key))localStorage.setItem(key,legacy)}, {key:STORAGE_KEY,legacy});
	 await page.addInitScript(()=>{const RealDate=Date,fixed=RealDate.parse('2026-09-27T10:00:00Z');class MockDate extends RealDate{constructor(...args){super(...(args.length?args:[fixed]))}static now(){return fixed}}Object.defineProperty(globalThis,'Date',{value:MockDate});});
	 const visible=async text=>{await page.getByText(text,{exact:true}).last().waitFor({state:'visible'});};
 const login=async id=>{await page.getByLabel('Email',{exact:true}).fill(`${id.toLowerCase()}@example.invalid`);await page.getByLabel('Password',{exact:true}).fill('Password123!');await page.getByRole('button',{name:'Entra',exact:true}).click();};
	 const logout=async()=>{await page.getByRole('button',{name:'Esci',exact:true}).click();await page.getByRole('heading',{name:'Accedi',exact:true}).waitFor();};
	 const assertTimelineAccessibility=async days=>{
	  await page.getByLabel('Numero di giorni visibili').fill(String(days));await page.waitForFunction(value=>document.querySelector('.schedule')?.getAttribute('aria-label')===`Pianificazione su ${value} giorni`,days);await page.waitForTimeout(180);
	  const exposedHeaders=page.locator('[data-range-date]:not([aria-hidden="true"])'),hiddenHeaders=page.locator('[data-range-date][aria-hidden="true"]');assert.equal(await exposedHeaders.count(),days);assert.equal(await hiddenHeaders.count(),62);
	  const row=page.locator('tr[data-employee-id="employee-A"]'),exposedCells=row.locator('td[data-planner-date]:not([aria-hidden="true"])'),hiddenCells=row.locator('td[data-planner-date][aria-hidden="true"]');assert.equal(await exposedCells.count(),days);assert.equal(await hiddenCells.count(),62);assert.ok(await hiddenCells.locator('.shift-cell').evaluateAll(nodes=>nodes.every(node=>node.tabIndex===-1)));
	  const exposedButton=exposedCells.locator('.shift-cell').first();await exposedButton.focus();assert.equal(await exposedButton.evaluate(node=>document.activeElement===node),true);
	  const {nodes}=await cdp.send('Accessibility.getFullAXTree'),shiftNodes=nodes.filter(node=>!node.ignored&&node.role?.value==='button'&&node.name?.value?.startsWith('Dipendente A,')),columnHeaders=nodes.filter(node=>!node.ignored&&node.role?.value==='columnheader');assert.equal(shiftNodes.length,days);assert.equal(columnHeaders.length,days+2);
	 };
 if(process.env.CHECK_SEDE_REFINEMENTS_ONLY!=='1'&&process.env.CHECK_CLIENT_COMPATIBILITY_ONLY!=='1'){
 await page.goto('http://127.0.0.1:5189');
 await page.getByRole('heading',{name:'Accedi',exact:true}).waitFor();
 for(const label of ['Informativa privacy del pilot','Condizioni del pilot','Supporto e privacy'])assert.ok(await page.getByRole('link',{name:label,exact:true}).count());
 await page.getByRole('link',{name:'Informativa privacy del pilot',exact:true}).click();
 await page.getByRole('heading',{name:'Informativa privacy del pilot',exact:true}).waitFor();
 await visible('DEMO · DATI FITTIZI');
 await page.getByText('Questa versione dimostrativa usa soltanto dati fittizi.',{exact:false}).waitFor();
 await page.getByRole('link',{name:'Supporto e privacy',exact:true}).click();
 await page.getByRole('heading',{name:'Supporto e privacy',exact:true}).waitFor();
 assert.ok(await page.getByRole('link',{name:'Scrivi a support@example.test',exact:true}).count());
 await page.getByRole('link',{name:'Torna all’app'}).click();
 await page.getByRole('heading',{name:'Accedi',exact:true}).waitFor();
 await page.getByRole('button',{name:'Mostra password'}).click();
 assert.equal(await page.locator('input[type="password"]').count(),0);
 await page.getByRole('button',{name:'Nascondi password'}).click();
 assert.equal(await page.locator('input[type="password"]').count(),1);
 await page.getByRole('button',{name:'Crea account',exact:true}).click();assert.equal(await page.getByLabel('Nome organizzazione',{exact:true}).inputValue(),'');assert.equal(await page.getByRole('button',{name:'Mostra password'}).count(),2);await page.getByRole('button',{name:'Mostra password'}).first().click();assert.equal(await page.getByLabel('Password',{exact:true}).getAttribute('type'),'text');assert.equal(await page.getByLabel('Conferma password').getAttribute('type'),'password');assert.equal(await page.getByLabel('Conferma password').getAttribute('autocomplete'),'new-password');
 await page.getByLabel('Nome organizzazione',{exact:true}).fill('Nuova organizzazione');await page.getByLabel('Nome responsabile').fill('Responsabile C');await page.getByLabel('Email',{exact:true}).fill('c@example.invalid');await page.getByLabel('Password',{exact:true}).fill('Password123!');await page.getByLabel('Conferma password').fill('Password123!');await page.getByRole('button',{name:'Crea account',exact:true}).click();await page.getByRole('status').waitFor();assert.equal(registrations,1);
 await page.getByRole('button',{name:'Torna ad Accedi'}).click();await login('A');await visible('Dipendente A');assert.equal(await page.getByText('Organizzazione B',{exact:true}).count(),0);assert.equal(await page.getByText('Dati locali riservati').count(),0);
	 const jump=page.getByLabel('Vai alla data');const jumpButton=page.getByRole('button',{name:'Vai',exact:true}),rangeTitle=page.locator('.week-title h2');
	 for(let day=0;day<20;day++)await page.getByRole('button',{name:'Giorno precedente'}).click();assert.equal(await rangeTitle.textContent(),'1 settembre – 7 settembre 2026');
	 await jump.fill('2026-09-05');await jumpButton.click();await page.getByText('5 settembre – 11 settembre 2026',{exact:true}).waitFor();
	 await jump.fill('2026-10-15');await jumpButton.click();await page.getByText('15 ottobre – 21 ottobre 2026',{exact:true}).waitFor();
	 await page.getByRole('button',{name:'Oggi',exact:true}).click();await page.getByRole('button',{name:'Mese',exact:true}).click();assert.equal(await rangeTitle.textContent(),'1 settembre – 30 settembre 2026');assert.equal(await page.locator('.schedule').getAttribute('aria-label'),'Pianificazione su 30 giorni');
	 await page.getByRole('button',{name:'Oggi',exact:true}).click();assert.equal(await rangeTitle.textContent(),'21 settembre – 27 settembre 2026');assert.equal(await page.locator('.schedule').getAttribute('aria-label'),'Pianificazione su 7 giorni');
	 await jump.fill('2026-08-15');await jumpButton.click();await page.getByRole('heading',{name:'Archivio mensile'}).waitFor();assert.equal(await page.locator('.archive-month-heading h2').textContent(),'agosto 2026');assert.equal(await page.getByRole('button',{name:/settembre/i}).count(),0);
		 const archivedShift=page.getByRole('button',{name:/Dipendente A, .*: Mattina/}).first();assert.equal(await archivedShift.isDisabled(),true);await page.getByRole('button',{name:'Elimina definitivamente'}).click();const deleteDialog=page.getByRole('dialog',{name:'Elimina mese archiviato'}),typedDelete=deleteDialog.getByLabel(/Scrivi ELIMINA AGOSTO 2026/);await typedDelete.fill('ELIMINA AGOSTO');assert.equal(await deleteDialog.getByRole('button',{name:'Elimina senza backup'}).isDisabled(),true);await deleteDialog.getByRole('button',{name:'Annulla'}).click();await deleteDialog.waitFor({state:'hidden'});assert.equal(archives.A.months.length,1);await page.getByRole('button',{name:'Modifica eccezionale'}).click();await page.getByLabel(/Scrivi MODIFICA ECCEZIONALE/).fill('MODIFICA ECCEZIONALE');await page.getByRole('button',{name:'Sblocca per 30 minuti'}).click();await page.locator('dialog').waitFor({state:'hidden'});assert.equal(await archivedShift.isDisabled(),false);await page.getByRole('button',{name:'Termina modifica'}).click();await page.getByRole('button',{name:'Pianificazione',exact:true}).click();
	 assert.equal(await page.locator('.account-menu').getByText('Responsabile A',{exact:true}).count(),1);assert.equal(await page.locator('.account-menu').getByRole('button').count(),0);
	 await page.getByRole('button',{name:'Utenti e accessi',exact:true}).click();await visible('Éxample Fixturé');const giuliaRow=page.getByRole('row').filter({hasText:'Éxample Fixturé'}),roleSelect=giuliaRow.locator('select').first();let confirmation='';page.once('dialog',dialog=>{confirmation=dialog.message();dialog.dismiss()});await roleSelect.selectOption('editor');assert.match(confirmation,/Éxample Fixturé[\s\S]*Viewer → Editor/);assert.equal(await roleSelect.inputValue(),'viewer');assert.equal(memberUpdates,0);page.once('dialog',dialog=>dialog.accept());await roleSelect.selectOption('editor');await page.waitForTimeout(50);assert.equal(members.A[1].role,'editor');assert.equal(memberUpdates,1);const activeToggle=giuliaRow.locator('label.access-toggle input[type="checkbox"]');page.once('dialog',dialog=>{assert.match(dialog.message(),/Éxample Fixturé[\s\S]*Attivo → Disattivato/);dialog.accept()});await activeToggle.click();await page.waitForTimeout(50);assert.equal(members.A[1].is_active,false);assert.equal(await activeToggle.isChecked(),false);assert.equal(memberUpdates,2);const adminRow=page.getByRole('row').filter({hasText:'Responsabile A'}),adminRole=adminRow.locator('select').first();assert.equal(await adminRole.inputValue(),'admin');assert.equal(await adminRole.isDisabled(),true);assert.equal(memberUpdates,2);await page.getByRole('button',{name:'Invita utente',exact:true}).click();await page.getByLabel('Email',{exact:true}).fill('invited@example.test');await page.getByRole('button',{name:'Crea invito'}).click();const inviteLink=page.getByLabel('Link invito');assert.equal(await inviteLink.inputValue(),`http://127.0.0.1:5189/?invite=${'a'.repeat(64)}`);await page.getByRole('button',{name:'Copia link invito'}).click();await visible('Link invito copiato.');assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),await inviteLink.inputValue());assert.equal(await page.getByText('Invia questo link al destinatario: dovrà aprirlo e registrarsi con l’email invitata.',{exact:true}).count(),1);await page.getByRole('button',{name:'Pianificazione',exact:true}).click();
 const cell=page.getByRole('button',{name:/Dipendente A, .*: Assegna turno/}).first();await cell.click();await page.getByRole('heading',{name:'Organizza il turno'}).waitFor();
 const expected={Mattina:'rgb(125, 211, 252)',Pomeriggio:'rgb(29, 78, 137)',Centrale:'rgb(245, 158, 11)',Riposo:'rgb(216, 74, 74)',Malattia:'rgb(230, 198, 92)',Ferie:'rgb(184, 196, 209)'};
 for(const [name,color] of Object.entries(expected))assert.equal(await page.getByRole('button',{name,exact:true}).evaluate(node=>getComputedStyle(node).backgroundColor),color,name);
 await page.getByRole('button',{name:'Mattina',exact:true}).click();await page.locator('dialog').waitFor({state:'hidden'});let copySource=page.getByRole('button',{name:/Dipendente A, .*: Mattina/}).first();const copyTarget=page.getByRole('button',{name:/Dipendente A, .*: Assegna turno/}).nth(1);await copySource.dispatchEvent('click',{ctrlKey:true});await page.getByText(/^Copia rapida:/).waitFor();await copyTarget.dispatchEvent('click',{ctrlKey:true});await page.waitForTimeout(80);assert.ok(await page.getByRole('button',{name:/Dipendente A, .*: Mattina/}).count()>=2);await page.getByRole('button',{name:'Annulla modalità'}).click();await page.getByRole('button',{name:'Eliminazione rapida',exact:true}).click();const deleteTarget=page.getByRole('button',{name:/Dipendente A, .*: Mattina/}).nth(1);await deleteTarget.dispatchEvent('click',{ctrlKey:true});await page.waitForTimeout(80);assert.equal(await page.getByRole('button',{name:/Dipendente A, .*: Mattina/}).count(),1);await page.getByRole('button',{name:'Annulla modalità'}).click();
 // Desktop drag preserves the snapshot and Sede. Pin the source locator before the DOM order changes.
 const pinnedSourceDate=await copySource.evaluate(node=>node.closest('td').dataset.plannerDate);
 copySource=page.locator(`tr[data-employee-id="employee-A"] td[data-planner-date="${pinnedSourceDate}"] .shift-cell`);
 const dragDestination=page.getByRole('button',{name:/Dipendente A, .*: Assegna turno/}).nth(1),dragDestinationDate=await dragDestination.evaluate(node=>node.closest('td').dataset.plannerDate);
 assert.equal(await copySource.getAttribute('draggable'),'true');await copySource.dragTo(dragDestination);
 const draggedCell=page.locator(`tr[data-employee-id="employee-A"] td[data-planner-date="${dragDestinationDate}"] .shift-cell`);
 await page.waitForFunction(date=>document.querySelector(`tr[data-employee-id="employee-A"] td[data-planner-date="${date}"] .shift-cell`)?.getAttribute('aria-label')?.includes('Mattina'),dragDestinationDate);
 assert.deepEqual(data.A.data.shifts[`employee-A|${dragDestinationDate}`],data.A.data.shifts[`employee-A|${pinnedSourceDate}`]);assert.equal(data.A.data.shifts[`employee-A|${dragDestinationDate}`].branchId,'branch-A');assert.match(await copySource.getAttribute('aria-label'),/Mattina/);
 await draggedCell.click();await page.getByRole('button',{name:'Elimina turno',exact:true}).click();await page.locator('dialog').waitFor({state:'hidden'});

 assert.ok(data.A.data.shifts[`employee-A|${pinnedSourceDate}`],'Dragging and deleting the copy must preserve the source');
 await page.getByRole('button',{name:'Oggi',exact:true}).click();await page.getByText('21 settembre – 27 settembre 2026',{exact:true}).waitFor();
 // Attendance creation/editing must update the UI immediately after a scoped RPC.
 await copySource.click();await page.getByRole('button',{name:'Variazione turno',exact:true}).click();
 await page.getByLabel('Entrata effettiva',{exact:true}).fill('1030');await page.getByLabel('Uscita effettiva',{exact:true}).fill('1730');await page.getByRole('button',{name:'Salva variazione',exact:true}).click();
 await page.getByRole('heading',{name:'Organizza il turno'}).waitFor();assert.match(await page.locator('.variation-card').innerText(),/10:30 – 17:30/);
 await page.getByRole('button',{name:'Modifica variazione',exact:true}).click();await page.getByLabel('Entrata effettiva',{exact:true}).fill('1045');await page.getByLabel('Uscita effettiva',{exact:true}).fill('1645');await page.getByRole('dialog').getByRole('combobox').selectOption('Malessere');await page.getByRole('button',{name:'Salva variazione',exact:true}).click();
 await page.getByRole('heading',{name:'Organizza il turno'}).waitFor();assert.match(await page.locator('.variation-card').innerText(),/10:45 – 16:45/);assert.equal(await page.getByText(/Verifica del salvataggio non riuscita/).count(),0);
 const variationDate=await copySource.evaluate(node=>node.closest('td').dataset.plannerDate),variationKey=`employee-A|${variationDate}`;
 assert.deepEqual(data.A.variations[variationKey],{employeeId:'employee-A',date:variationDate,start:'10:45',end:'16:45',reason:'Malessere',customReason:'',note:'',branchId:'branch-A'});
 await page.getByRole('button',{name:'Chiudi',exact:true}).click();
 await page.getByRole('button',{name:'Stampa / Esporta PDF'}).click();await page.getByLabel('Periodo da esportare').selectOption('range');await page.getByLabel('Data di inizio',{exact:true}).fill(variationDate);await page.getByLabel('Data di fine',{exact:true}).fill(variationDate);
 await page.getByLabel('Dipendenti da includere').selectOption('one');await page.getByLabel('Dipendente',{exact:true}).selectOption('employee-A');
 let downloadPromise=page.waitForEvent('download');await page.getByRole('button',{name:'Esporta PDF',exact:true}).click();await (await downloadPromise).saveAs('/private/tmp/shift-planner-attendance-readable.pdf');
 // Disable browser printing only inside this isolated browser; inspect the iframe.
 await page.addInitScript(()=>{window.print=()=>{window.__printRequested=true}});
 await page.getByRole('button',{name:'Stampa',exact:true}).click();let printFrame=page.frameLocator('iframe[data-turni-print]');await printFrame.locator('.shift-actual').waitFor({state:'attached'});assert.equal(await printFrame.locator('.shift-actual').innerText(),'Eff. 10:45 – 16:45');assert.equal(await printFrame.locator('.shift-reason').innerText(),'Malessere');assert.equal(await printFrame.locator('.shift-time').innerText(),'Pian. 09:30 – 17:30');await page.locator('iframe[data-turni-print]').evaluate(node=>node.remove());
 await page.getByLabel('Stampa mensile compatta').check();downloadPromise=page.waitForEvent('download');await page.getByRole('button',{name:'Esporta PDF',exact:true}).click();await (await downloadPromise).saveAs('/private/tmp/shift-planner-attendance-monthly.pdf');
 await page.getByRole('button',{name:'Stampa',exact:true}).click();printFrame=page.frameLocator('iframe[data-turni-print]');await printFrame.locator('.attendance-times').waitFor({state:'attached'});const actualCell=printFrame.locator('tbody tr').first().locator('td').nth(Number(variationDate.slice(-2))-1);assert.match(await actualCell.innerText(),/P 09:30[\s\S]*E 10:45[\s\S]*16:45[\s\S]*Malessere/);assert.equal(await printFrame.locator('.attendance-times').count(),1);await page.locator('iframe[data-turni-print]').evaluate(node=>node.remove());await page.locator('dialog .dialog-actions').getByRole('button',{name:'Chiudi',exact:true}).click();
 const adminHeaders=page.locator('[data-range-date]'),rangeDates=[];for(let i=31;i<=33;i++)rangeDates.push(await adminHeaders.nth(i).getAttribute('data-range-date'));await adminHeaders.nth(31).dispatchEvent('pointerdown',{button:0,pointerId:21});for(let i=32;i<=33;i++)await adminHeaders.nth(i).dispatchEvent('pointerover',{pointerId:21,bubbles:true});await page.locator('.timeline-scroll').dispatchEvent('pointerup',{button:0,pointerId:21});await page.getByText(/^Intervallo selezionato:/).waitFor();await page.locator(`td[data-planner-date="${rangeDates[1]}"] .shift-cell`).first().click();await page.getByRole('button',{name:'Pomeriggio',exact:true}).click();if(await page.getByRole('heading',{name:'Conferma sostituzione'}).count())await page.getByRole('button',{name:'Sostituisci e applica'}).click();await page.locator('dialog').waitFor({state:'hidden'});for(const date of rangeDates)assert.match(await page.locator(`td[data-planner-date="${date}"] .shift-cell`).first().getAttribute('aria-label'),/Pomeriggio/);
 await page.locator(`td[data-planner-date="${rangeDates[1]}"] .shift-cell`).first().click();await page.getByRole('button',{name:'Elimina nell’intervallo',exact:true}).click();await page.getByRole('heading',{name:'Elimina turni selezionati'}).waitFor();await page.getByRole('dialog').getByRole('button',{name:'Elimina turni',exact:true}).click();await page.locator('dialog').waitFor({state:'hidden'});for(const date of rangeDates)assert.match(await page.locator(`td[data-planner-date="${date}"] .shift-cell`).first().getAttribute('aria-label'),/Assegna turno/);await page.getByRole('button',{name:'Annulla modalità'}).click();
 const resizeHandle=page.getByRole('separator',{name:'Ridimensiona colonna dipendenti'});const resizeBox=await resizeHandle.boundingBox();await page.mouse.move(resizeBox.x+3,resizeBox.y+12);await page.mouse.down();await page.mouse.move(resizeBox.x+400,resizeBox.y+12);await page.mouse.up();await page.waitForTimeout(50);assert.equal(preferences.A.employee_column_width,320);
		 await page.getByRole('button',{name:'Impostazioni',exact:true}).click();await page.getByRole('heading',{name:'Turni predefiniti'}).waitFor();assert.equal(await page.getByText('Turni predefiniti',{exact:true}).count(),2);await page.getByRole('button',{name:'Account',exact:true}).click();assert.equal(await page.getByLabel('Nome organizzazione',{exact:true}).inputValue(),'Organizzazione A');assert.equal(await page.getByLabel('Nome utente',{exact:true}).inputValue(),'Responsabile A');for(const label of ['Informativa privacy del pilot','Condizioni del pilot','Supporto e privacy'])assert.ok(await page.getByRole('link',{name:label,exact:true}).count());assert.ok(await page.getByText(/Per richiedere la cancellazione dell’account e dei dati/).count());assert.equal(await page.getByLabel('Conservazione archivio').count(),0);
 await page.getByRole('button',{name:'Impostazioni',exact:true}).click();await page.getByRole('button',{name:'Aggiungi turno predefinito'}).click();const newTemplateId=await page.locator('.custom-preset-row').filter({has:page.locator('input[value=""]')}).getAttribute('data-template-id');const presetRow=page.locator(`[data-template-id="${newTemplateId}"]`);await presetRow.getByLabel('Nome',{exact:true}).fill('Notte');await presetRow.getByLabel('Ora di inizio').fill('23:00');await presetRow.getByLabel('Ora di fine').fill('07:00');await presetRow.locator('input[type=color]').fill('#7c3aed');await page.getByRole('button',{name:'Salva turni predefiniti'}).click();await page.waitForTimeout(100);
 await page.getByRole('button',{name:'Pianificazione',exact:true}).click();await cell.click();assert.equal(await page.getByRole('button',{name:'Notte',exact:true}).evaluate(node=>getComputedStyle(node).backgroundColor),'rgb(124, 58, 237)');await page.getByRole('button',{name:'Notte',exact:true}).click();await page.locator('dialog').waitFor({state:'hidden'});
 const assignedNight=Object.entries(data.A.data.shifts).find(([,shift])=>shift.type==='Notte');assert.ok(assignedNight);const nightSnapshot=structuredClone(assignedNight[1]);
 await page.getByRole('button',{name:'Impostazioni',exact:true}).click();assert.equal(await page.getByLabel('Data di efficacia').count(),0);assert.equal(await page.getByText('Orari predefiniti',{exact:true}).count(),0);await page.locator('.custom-preset-row').filter({has:page.locator('input[value="Notte"]')}).getByLabel('Nome',{exact:true}).fill('Notte lunga');await page.getByRole('button',{name:'Salva turni predefiniti'}).click();await page.waitForTimeout(100);await page.reload();await visible('Dipendente A');await page.getByRole('button',{name:'Impostazioni',exact:true}).click();await page.getByRole('heading',{name:'Turni predefiniti'}).waitFor();assert.equal(await page.locator('.custom-preset-row').filter({has:page.locator('input[value="Notte lunga"]')}).getByLabel('Nome',{exact:true}).inputValue(),'Notte lunga');assert.deepEqual(data.A.data.shifts[assignedNight[0]],{...nightSnapshot,type:'Notte lunga',presetName:'Notte lunga'});
	 await page.getByRole('button',{name:'Pianificazione',exact:true}).click();await page.getByRole('button',{name:/Dipendente A, .*: Assegna turno/}).first().click();await page.getByRole('button',{name:'Mattina',exact:true}).click();await page.locator('dialog').waitFor({state:'hidden'});const assignedDate=await page.getByRole('button',{name:/Dipendente A, .*: Mattina/}).first().evaluate(node=>node.closest('td').dataset.plannerDate);await page.getByRole('button',{name:'Aggiungi dipendente'}).click();await page.getByLabel('Nome e cognome').fill('Nuovo A');await page.getByRole('button',{name:'Salva',exact:true}).click();await visible('Nuovo A');const newHandle=page.getByRole('button',{name:'Riordina Nuovo A'}),firstAdminRow=page.locator('tr[data-employee-id="employee-A"]');await newHandle.dragTo(firstAdminRow,{targetPosition:{x:80,y:2}});await page.waitForTimeout(80);assert.match(await page.locator('.timeline-scroll tbody tr').first().innerText(),/Nuovo A/);assert.match(await firstAdminRow.locator(`td[data-planner-date="${assignedDate}"] .shift-cell`).getAttribute('aria-label'),/Mattina/);
	 requests.A=[{id:'permission-a',organization_id:'org-A',employee_id:'employee-A',employee_name:'Dipendente A',created_by_user_id:'A',created_by_name:'Responsabile A',type:'Permesso',start_date:'2026-09-28',end_date:'2026-09-28',start_time:'10:00',end_time:'11:00',note:'Visita',status:'approved',version:2,created_at:'2026-09-01T00:00:00Z'}];await page.reload();await visible('Nuovo A');await visible('Organizzazione A');assert.match(await page.locator('.timeline-scroll tbody tr').first().innerText(),/Nuovo A/);await page.getByRole('button',{name:'Dipendenti',exact:true}).click();assert.equal(await page.locator('.employee-visibility-menu').count(),0);await page.getByRole('button',{name:/Dipendenti visibili/}).click();const employeeRows=page.locator('.employee-order-row');assert.match(await employeeRows.first().innerText(),/Dipendente A/);assert.equal(await page.getByRole('button',{name:'Sposta Nuovo A in alto'}).count(),0);await page.getByLabel('Cerca dipendente').fill('Nuovo');assert.equal(await employeeRows.count(),1);assert.match(await employeeRows.first().innerText(),/Nuovo A/);await page.keyboard.press('Escape');assert.equal(await page.locator('.employee-visibility-menu').count(),0);await page.getByRole('button',{name:'Assenze',exact:true}).click();await visible('Permesso');await page.getByRole('button',{name:'Permesso',exact:true}).click();assert.equal(await page.locator('.absence-row:not(.absence-head)').count(),1);await logout();assert.equal(await page.getByText('Nuovo A',{exact:true}).count(),0);
 await login('B');await visible('Dipendente B');await page.getByRole('button',{name:/Dipendente B, .*: Assegna turno/}).first().click();for(const name of ['Mattina','Pomeriggio','Centrale'])assert.equal(await page.getByRole('dialog').getByRole('button',{name,exact:true}).count(),0);for(const name of ['Riposo','Malattia','Ferie'])assert.equal(await page.getByRole('dialog').getByRole('button',{name,exact:true}).count(),1);await page.getByRole('button',{name:'Chiudi',exact:true}).click();assert.equal(await page.getByText('Nuovo A',{exact:true}).count(),0);assert.equal(await page.getByText('Organizzazione A',{exact:true}).count(),0);
 await page.getByRole('button',{name:'Report ore',exact:true}).click();assert.equal(await page.getByText('Dipendente A',{exact:true}).count(),0);
	 await logout();await login('A');await visible('Organizzazione A');for(const days of [7,14,31])await assertTimelineAccessibility(days);
 // Same-name templates remain independent in the real Settings and assignment controls.
 const beforeSecondSede=structuredClone(data.A.settings.presets.custom);
 extraBranches.A=[{id:'branch-A2',name:'Sede A seconda',active:true,readable:true,operable:true,admin:true}];
 data.A.data.employees.find(e=>e.id==='employee-A').branchIds=['branch-A','branch-A2'];
 await page.reload();await visible('Dipendente A');await page.getByRole('button',{name:'Impostazioni',exact:true}).click();
 const templateSede=page.getByLabel('Sede dei turni predefiniti');await templateSede.selectOption('branch-A2');assert.equal(await page.locator('.custom-preset-row').count(),0);
 await page.getByRole('button',{name:'Aggiungi turno predefinito'}).click();const secondSedeRow=page.locator('.custom-preset-row');await secondSedeRow.getByLabel('Nome',{exact:true}).fill('Mattina');await secondSedeRow.getByLabel('Ora di inizio').fill('22:00');await secondSedeRow.getByLabel('Ora di fine').fill('06:00');await secondSedeRow.getByLabel('Colore').fill('#334455');await page.getByRole('button',{name:'Salva turni predefiniti'}).click();await page.waitForTimeout(150);
 assert.deepEqual(data.A.settings.presets.custom.filter(t=>t.branchId==='branch-A'),beforeSecondSede);assert.deepEqual(data.A.settings.presets.custom.filter(t=>t.branchId==='branch-A2').map(t=>[t.name,t.start,t.end,t.color]),[['Mattina','22:00','06:00','#334455']]);
 await page.getByRole('button',{name:'Pianificazione',exact:true}).click();await page.getByRole('button',{name:'Oggi',exact:true}).click();await page.getByRole('button',{name:/Dipendente A, .*: Assegna turno/}).first().click();await page.getByLabel('Sede del turno').selectOption('branch-A2');assert.equal(await page.getByRole('dialog').getByRole('button',{name:'Mattina',exact:true}).evaluate(n=>getComputedStyle(n).backgroundColor),'rgb(51, 68, 85)');assert.equal(await page.getByRole('dialog').getByRole('button',{name:'Notte lunga',exact:true}).count(),0);await page.getByRole('button',{name:'Chiudi',exact:true}).click();
 await page.getByRole('button',{name:'Impostazioni',exact:true}).click();await page.getByLabel('Sede dei turni predefiniti').selectOption('branch-A2');page.once('dialog',d=>d.accept());await page.locator('.custom-preset-row').getByRole('button',{name:'Elimina',exact:true}).click();await page.getByRole('button',{name:'Salva turni predefiniti'}).click();await page.waitForTimeout(150);assert.deepEqual(data.A.settings.presets.custom,beforeSecondSede);
 await logout();await login('C');await page.getByRole('heading',{name:'La tua organizzazione'}).waitFor();await page.getByLabel('Nome organizzazione',{exact:true}).fill('Nuova organizzazione');await page.getByLabel('Nome prima Sede').fill('Sede principale');await page.getByLabel('Nome responsabile').fill('Responsabile C');await page.getByRole('button',{name:'Crea organizzazione'}).click();await page.getByRole('button',{name:'Inizia senza importare'}).waitFor();const before=writes;await page.getByRole('button',{name:'Inizia senza importare'}).click();await visible('Nuova organizzazione');assert.equal(writes,before);assert.equal(await page.evaluate(key=>localStorage.getItem(key),STORAGE_KEY),legacy);await page.getByRole('button',{name:'Archivio',exact:true}).click();await visible('Non ci sono ancora mesi archiviati.');await logout();
 await page.getByRole('button',{name:'Password dimenticata?'}).click();await page.getByLabel('Email',{exact:true}).fill('a@example.invalid');await page.getByRole('button',{name:'Invia collegamento'}).click();await page.getByRole('status').waitFor();assert.equal(resets,1);
 await page.goto(`http://127.0.0.1:5189/?recovery=1#access_token=${token('A')}&refresh_token=refresh-A&expires_in=3600&token_type=bearer&type=recovery`);
 await page.getByRole('heading',{name:'Nuova password',exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'Mostra password'}).count(),2);assert.equal(await page.getByLabel('Nuova password',{exact:true}).getAttribute('autocomplete'),'new-password');await page.getByLabel('Nuova password',{exact:true}).fill('NewPassword123!');await page.getByLabel('Conferma password').fill('Different123!');await page.getByRole('button',{name:'Salva password'}).click();await visible('Le password non coincidono.');assert.equal(passwordUpdates,0);await page.getByLabel('Conferma password').fill('NewPassword123!');await page.getByRole('button',{name:'Salva password'}).click();await visible('Dipendente A');assert.equal(passwordUpdates,1);
 await logout();
 await page.goto('http://127.0.0.1:5189/?invite=test-invite&keep=1#section');
 await page.getByRole('heading',{name:'Accedi',exact:true}).waitFor();
 await page.getByRole('button',{name:'Crea account',exact:true}).click();
 assert.equal(new URL(page.url()).searchParams.get('invite'),'test-invite');
 await page.getByLabel('Email invitata').waitFor();await page.waitForFunction(()=>document.querySelector('input[aria-readonly="true"]')?.value==='d@example.invalid');
 assert.equal(await page.locator('form input').count(),3);
 assert.equal(await page.getByLabel('Email invitata').inputValue(),'d@example.invalid');
 assert.equal(await page.getByLabel('Email invitata').isEditable(),false);
 await page.getByLabel('Password',{exact:true}).fill('Password123!');
 await page.getByLabel('Conferma password').fill('Different123!');
 await page.getByRole('button',{name:'Crea account',exact:true}).click();await visible('Le password non coincidono.');assert.equal(registrations,1);
 await page.getByLabel('Conferma password').fill('Password123!');
 await page.getByRole('button',{name:'Crea account',exact:true}).click();await page.getByRole('status').waitFor();assert.equal(registrations,2);
 await page.getByRole('button',{name:'Torna ad Accedi'}).click();await login('D');
 await page.getByRole('heading',{name:'Accetta invito',exact:true}).waitFor();
 assert.equal(await page.getByRole('heading',{name:'La tua organizzazione'}).count(),0);
 await page.reload();await page.getByRole('heading',{name:'Accetta invito',exact:true}).waitFor();
 assert.equal(await page.getByLabel('Nome completo').count(),0);await page.getByRole('button',{name:'Accetta invito',exact:true}).click();
 await visible('Questo account appartiene già a un’organizzazione. Accedi con l’account invitato o contatta un amministratore.');assert.equal(new URL(page.url()).searchParams.get('invite'),'test-invite');
 await page.getByRole('button',{name:'Esci',exact:true}).click();await page.getByRole('heading',{name:'Accedi',exact:true}).waitFor();assert.equal(new URL(page.url()).searchParams.get('invite'),'test-invite');
 await login('D');await page.getByRole('button',{name:'Accetta invito',exact:true}).click();
 await visible('Dipendente invitato');await visible('Organizzazione invitante');assert.equal(accepts,2);
 assert.equal(new URL(page.url()).searchParams.has('invite'),false);assert.equal(new URL(page.url()).searchParams.get('keep'),'1');assert.equal(new URL(page.url()).hash,'#section');
 await page.reload();await visible('Dipendente invitato');
	 const viewerNav=await page.locator('.sidebar nav .nav-item').allTextContents();assert.deepEqual(viewerNav.map(value=>value.trim()),['Pianificazione','Dipendenti','Note','Richieste','Report ore','Archivio','Account']);
 await page.getByRole('button',{name:'Archivio',exact:true}).click();await page.getByRole('heading',{name:'Archivio mensile'}).waitFor();assert.equal(await page.getByRole('button',{name:/Dipendente invitato, .*: Mattina/}).first().isDisabled(),true);assert.equal(await page.getByRole('button',{name:'Modifica eccezionale'}).count(),0);await page.getByRole('button',{name:'Pianificazione',exact:true}).click();
 assert.equal(await page.getByRole('button',{name:'Assenze',exact:true}).count(),0);assert.equal(await page.getByRole('button',{name:'Utenti e accessi',exact:true}).count(),0);
 const timeline=page.locator('.schedule');assert.equal(await timeline.getAttribute('aria-label'),'Pianificazione su 7 giorni');
 await page.getByLabel('Numero di giorni visibili').fill('14');assert.equal(await timeline.getAttribute('aria-label'),'Pianificazione su 14 giorni');
 await page.getByLabel('Numero di giorni visibili').fill('31');assert.equal(await timeline.getAttribute('aria-label'),'Pianificazione su 31 giorni');await page.screenshot({path:'/tmp/shift-planner-31-days.png',fullPage:true});
 await page.getByRole('button',{name:'Settimana',exact:true}).click();assert.equal(await timeline.getAttribute('aria-label'),'Pianificazione su 7 giorni');
 await page.getByRole('button',{name:'Mese',exact:true}).click();assert.match(await timeline.getAttribute('aria-label'),/Pianificazione su (28|29|30|31) giorni/);
 await page.getByRole('button',{name:'Stampa / Esporta PDF'}).click();await visible('Stampa leggibile');assert.ok(await page.getByLabel('Stampa leggibile').isChecked());await page.getByLabel('Stampa mensile compatta').check();await visible('Mese completo:');assert.ok(await page.getByText(/A3 orizzontale consigliato/).count());await page.locator('dialog .dialog-actions').getByRole('button',{name:'Chiudi',exact:true}).click();
 await page.getByRole('button',{name:'Oggi',exact:true}).click();assert.equal(await timeline.getAttribute('aria-label'),'Pianificazione su 7 giorni');assert.ok(await page.locator('.timeline-scroll thead .today').count()>0);
	 const scroll=page.locator('.timeline-scroll'),header=page.locator('.timeline-scroll thead');const beforeWheel=await scroll.evaluate(node=>({left:node.scrollLeft,top:node.scrollTop,height:node.clientHeight,scrollHeight:node.scrollHeight}));assert.ok(beforeWheel.scrollHeight>beforeWheel.height);const wheelBox=await scroll.boundingBox();await page.mouse.move(wheelBox.x+500,wheelBox.y+180);await page.mouse.wheel(0,220);await page.waitForTimeout(50);const afterWheel=await scroll.evaluate(node=>({left:node.scrollLeft,top:node.scrollTop}));assert.equal(afterWheel.left,beforeWheel.left);assert.ok(afterWheel.top>beforeWheel.top);const headerTop=await header.evaluate(node=>node.getBoundingClientRect().top);await scroll.evaluate(node=>node.scrollTop+=300);await page.waitForTimeout(20);assert.ok(Math.abs((await header.evaluate(node=>node.getBoundingClientRect().top))-headerTop)<2);
	 const box=await scroll.boundingBox();await page.mouse.move(box.x+420,box.y+140);await page.mouse.down();await page.mouse.move(box.x+340,box.y+140,{steps:4});await page.mouse.up();assert.notEqual(await scroll.evaluate(node=>node.scrollLeft),afterWheel);
	 assert.equal(await header.evaluate(node=>getComputedStyle(node).position),'sticky');assert.equal(await scroll.evaluate(node=>getComputedStyle(node).overflowY),'auto');assert.equal(await page.getByText('Dipendente con un nome volutamente molto lungo',{exact:true}).evaluate(node=>getComputedStyle(node).whiteSpace),'normal');
	 const rangeHeaders=page.locator('[data-range-date]'),firstHeader=rangeHeaders.nth(31);await firstHeader.dispatchEvent('pointerdown',{button:0,pointerId:17});for(let i=32;i<=36;i++)await rangeHeaders.nth(i).dispatchEvent('pointerover',{pointerId:17,bubbles:true});await scroll.dispatchEvent('pointerup',{button:0,pointerId:17});await page.getByText(/^Intervallo selezionato:/).waitFor();assert.ok(await page.locator('.range-focused').count()>=6);assert.ok(await page.locator('.range-focused-cell').count()>=6);await page.getByRole('button',{name:'Annulla modalità'}).click();assert.equal(await page.locator('.range-focused').count(),0);assert.equal(await page.locator('.range-focused-cell').count(),0);
	 assert.equal(await page.getByRole('button',{name:'Filtri pianificazione',exact:true}).count(),0);assert.equal(await page.locator('.page-heading').getByRole('button',{name:'Filtri',exact:true}).count(),0);const viewerShift=page.getByRole('button',{name:/Dipendente invitato, .*: Assegna turno/}).first();assert.equal(await viewerShift.isDisabled(),true);const colleagueHandle=page.getByRole('button',{name:'Riordina Collega'}),invitedRow=page.locator('tr[data-employee-id="invited-employee"]');const viewerReorderReply=page.waitForResponse(r=>r.url().endsWith('/user_branch_employee_order_save'));await colleagueHandle.dragTo(invitedRow,{targetPosition:{x:80,y:2}});const viewerReorder=await viewerReorderReply;assert.equal(viewerReorder.status(),200,await viewerReorder.text());await page.waitForFunction(()=>document.querySelector('.timeline-scroll tbody tr')?.dataset.employeeId==='colleague');assert.match(await page.locator('.timeline-scroll tbody tr').first().innerText(),/Collega/);assert.equal(preferences.D.branch_preferences['branch-D'].employee_order[0],'colleague');await page.reload();await visible('Organizzazione invitante');await page.waitForFunction(()=>document.querySelector('.timeline-scroll tbody tr')?.dataset.employeeId==='colleague');assert.match(await page.locator('.timeline-scroll tbody tr').first().innerText(),/Collega/);
	 await page.getByRole('button',{name:'Dipendenti',exact:true}).click();assert.equal(await page.locator('.employee-filter-list').count(),0);await page.getByRole('button',{name:/Dipendenti visibili/}).click();const viewerEmployeeList=page.locator('.employee-filter-list');const listMetrics=await viewerEmployeeList.evaluate(node=>({height:node.clientHeight,scrollHeight:node.scrollHeight,overflow:getComputedStyle(node).overflowY}));assert.equal(listMetrics.overflow,'auto');assert.ok(listMetrics.scrollHeight>listMetrics.height);const viewerNames=await page.locator('.employee-order-row .employee-list-name').allTextContents();assert.deepEqual(viewerNames,[...viewerNames].sort((a,b)=>a.localeCompare(b,'it',{sensitivity:'base',numeric:true})));await page.getByLabel('Cerca dipendente').fill('volutamente');assert.equal(await page.locator('.employee-order-row').count(),1);await page.getByLabel('Cerca dipendente').fill('');await page.getByRole('checkbox',{name:'Dipendente aggiuntivo 17'}).uncheck();await page.getByRole('button',{name:'Applica alla pianificazione'}).click();await page.locator('.employee-visibility-menu').waitFor({state:'detached'});assert.deepEqual(preferences.D.hidden_employee_ids,['extra-16']);await page.getByRole('button',{name:'Pianificazione',exact:true}).click();await page.locator('tr[data-employee-id="extra-16"]').waitFor({state:'detached'});await page.reload();await visible('Organizzazione invitante');await page.locator('tr[data-employee-id="extra-16"]').waitFor({state:'detached'});
	 assert.equal(await page.getByRole('button',{name:'Riconnetti e ricarica'}).evaluate(node=>getComputedStyle(node.closest('.connection-panel')).position),'fixed');
	 await page.getByRole('button',{name:'Note',exact:true}).click();await visible('Nota 26');assert.deepEqual(await page.locator('.notes-list article>p').allTextContents(),['Nota 26','Nota 28','Nota 30']);assert.equal(await page.getByRole('button',{name:'Nuova nota',exact:true}).isDisabled(),true);assert.equal(await page.locator('.notes-list article').first().evaluate(node=>getComputedStyle(node).minHeight),'0px');
 await page.getByRole('button',{name:'Report ore',exact:true}).click();await page.getByRole('heading',{name:'Il tuo report ore'}).waitFor();assert.equal(await page.getByText('Collega',{exact:true}).count(),0);
 await page.getByRole('button',{name:'Richieste',exact:true}).click();await visible('Storico personale');await visible('Visibile al team');assert.equal(await page.getByRole('button',{name:'Modifica',exact:true}).count(),0);
 await page.getByRole('button',{name:'Nuova richiesta',exact:true}).click();await page.locator('dialog[open] select').nth(1).selectOption('Altro');await page.getByLabel('Dal',{exact:true}).fill('2026-10-01');await page.getByLabel('Al',{exact:true}).fill('2026-10-01');await page.getByLabel('Nota',{exact:true}).fill('Richiesta browser');await page.getByRole('button',{name:'Salva richiesta'}).click();await page.locator('dialog').waitFor({state:'hidden'});await visible('Richiesta browser');await page.screenshot({path:'/tmp/shift-planner-viewer-requests.png',fullPage:true});
	 await page.getByRole('button',{name:'Account',exact:true}).click();assert.equal(await page.getByLabel('Nome organizzazione',{exact:true}).count(),0);assert.equal(await page.getByLabel('Email',{exact:true}).inputValue(),'d@example.invalid');
 accounts.D={...accounts.D,employee_id:null};await page.reload();await page.getByRole('button',{name:'Richieste',exact:true}).click();await visible('Il tuo account non è ancora associato a un dipendente. Contatta l’amministratore.');assert.equal(await page.getByRole('button',{name:'Nuova richiesta',exact:true}).isDisabled(),true);accounts.D={...accounts.D,employee_id:'invited-employee'};
 await logout();await page.goto('http://127.0.0.1:5189/?invite=expired-invite');await page.getByRole('button',{name:'Crea account',exact:true}).click();await visible('Invito non valido o scaduto. Chiedi un nuovo invito all’amministratore.');assert.equal(await page.getByRole('button',{name:'Crea account',exact:true}).isDisabled(),true);assert.equal(new URL(page.url()).searchParams.get('invite'),'expired-invite');
 await page.goto('http://127.0.0.1:5189/?recovery=1#error=access_denied&error_code=otp_expired');await page.getByRole('heading',{name:'Collegamento non valido'}).waitFor();await page.getByRole('button',{name:'Torna ad Accedi'}).click();await page.getByRole('heading',{name:'Accedi',exact:true}).waitFor();assert.equal(new URL(page.url()).searchParams.has('recovery'),false);
 }else{await page.goto('http://127.0.0.1:5189');await page.getByRole('heading',{name:'Accedi',exact:true}).waitFor();}
 if(process.env.CHECK_CLIENT_COMPATIBILITY_ONLY!=='1'){
  await checkPlannerReview({page,data,extraBranches,preferences,login,logout});
  await checkSedeRefinements({page,data,extraBranches,deletedTemplates,preferences,login,logout});
 }
 legacyServer=await createServer({root:await legacy029Frontend(),cacheDir:'node_modules/.vite-legacy-smoke',envFile:false,define:{'import.meta.env.VITE_SUPABASE_URL':JSON.stringify('https://tenant-test.invalid'),'import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY':JSON.stringify('sb_publishable_browser_test'),'import.meta.env.VITE_SUPPORT_EMAIL':JSON.stringify('support@example.test')},server:{host:'127.0.0.1',port:5190,strictPort:true}});
 await legacyServer.listen();
 await checkClientCompatibility({page,login,logout,getWrites:()=>writes,getAccount:()=>accounts.A,legacyUrl:'http://127.0.0.1:5190',setCompatibility:(schema,open)=>{schemaVersion=schema;gateOpen=open;}});
 // Reuse the existing mobile gesture/layout regression in this isolated feature UI.
 if(process.env.CHECK_MOBILE_PLANNER==='1'){
  const originalEmployees=data.A.data.employees;
  extraBranches.A=[{id:'branch-A2',name:'Seconda sede',active:true,readable:true,operable:true,admin:true}];
  data.A.data.employees=[...originalEmployees,...Array.from({length:22},(_,index)=>({id:`mobile-${index}`,name:`Persona mobile ${index+1}`,homeBranchId:'branch-A'}))];
  for(let index=0;index<22;index++)data.A.data.shifts[`mobile-${index}|2026-09-25`]={type:'Magazzino 2',presetId:'mobile-warehouse',presetName:'Magazzino 2',presetColor:'#334455',off:false,start:'22:00',end:'06:00',branchId:'branch-A'};
  data.A.settings.presets.custom.push({id:'mobile-warehouse',branchId:'branch-A',name:'Magazzino 2',start:'22:00',end:'06:00',color:'#334455'});
  const mobileDataBefore=JSON.stringify(data.A);
  await login('A');await visible('Dipendente A');
  await checkMobilePlanner({page,cdp,getWrites:()=>writes,screenshotDir:process.env.MOBILE_SCREENSHOT_DIR});
  assert.equal(JSON.stringify(data.A),mobileDataBefore,'mobile navigation/gestures must not mutate data');
 }
 assert.deepEqual(errors,[]);console.log(process.env.CHECK_CLIENT_COMPATIBILITY_ONLY==='1'?'Compatibility-only browser checks completed.':'Browser OK: autenticazione, viewer, richieste, note, report personale, timeline 7–31 giorni, scorrimento e trascinamento.');
 }finally{await browser?.close();await legacyServer?.close();await server.close();}
