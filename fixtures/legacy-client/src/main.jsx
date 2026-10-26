import React, {useEffect, useMemo, useRef, useState, useSyncExternalStore} from 'react';
import {createRoot} from 'react-dom/client';
import {STORAGE_KEY, customPresetKey, customPresets, settingsForBranch, normalizeTemplateSort, dateKey, hours, minutes, parseDate, validData, SHIFT_TYPES, shiftType, makeShift, isAbsence} from './schedule';
import {DEFAULT_SETTINGS, deleteNote, loadNotes, loadSettings, NOTES_KEY, SETTINGS_KEY, upsertNote, validSettings} from './preferences';
import {VARIATIONS_KEY,actualMinutes,deleteVariation,loadVariations,makeVariation,sanitizeVariations,upsertVariation,variationReason} from './attendance';
import ShiftFields from './ShiftFields';
import VariationFields from './VariationFields';
import RangeDialog from './RangeDialog';
import ExportDialog from './ExportDialog';
import CopyDialog from './CopyDialog';
import BulkDeleteDialog from './BulkDeleteDialog';
import {plannerAwareness,isForeignShift,protectedAssignment,assertPlannerShiftSafety,branchMarker} from './plannerAwareness';
import {useMobilePlannerViewport} from './MobilePlanner';
import {bulkDeleteBranch} from './bulkDelete.js';
import HoursReportView from './HoursReportView';
import {applyShiftCopy,buildDayCopy,copyConflicts} from './copyShifts';
import {AbsencesView, EmployeeFilterView, NotesView, ScheduleView, SettingsView} from './WorkspaceViews';
import RequestsView from './RequestsView';
import AccessView from './AccessView';
import AuthGate,{AccountMenu,AccountSettingsView} from './AuthGate';
import BackupPanel,{ConnectionPanel,statusLabel} from './StoragePanel';
import ArchiveView from './ArchiveView';
import {clampPlanningDate,dateNavigationTarget} from './archive';
import {navigationForRole,plannerCanWrite,reportEmployeeIds} from './permissions';
import {defaultShiftBranchId,employeeBranchOptions,filterSnapshotByBranches,mergeScopedSnapshot} from './branchPersistence';
import {BranchesView,BranchSelector,CrossBranchRequests} from './BranchesView';
import {monthRange,startOfWeek} from './timeline';
import {approvedRequestEffects} from './requestEffects';
import {applyBulkAssignment,applyBulkDeletion,assignmentConflicts,bulkDeletionTargets} from './bulkEditing';
import {DEFAULT_EMPLOYEE_COLUMN_WIDTH,clampEmployeeColumnWidth,moveEmployee,moveEmployeeTo,normalizeUserPreferences,orderEmployees,sortEmployeesAlphabetically} from './userPreferences';
import {persistBranchSelection,restoreBranchSelection} from './branchSelection';
import './styles.css';

function Icon({name, ...props}) {
  const paths = {
    calendar: <><rect x="3" y="5" width="18" height="16" rx="3"/><path d="M7 3v4m10-4v4M3 11h18m-13 4h2m4 0h2"/></>,
    plus: <path d="M12 5v14M5 12h14"/>, left: <path d="m14 6-6 6 6 6"/>, right: <path d="m10 6 6 6-6 6"/>,
    edit: <path d="M15 4l5 5M4 20l5-1L20 8a3.5 3.5 0 0 0-5-5L4 14z"/>, check: <path d="m5 12 4 4L19 6"/>, close: <path d="m6 6 12 12M6 18 18 6"/>,
    people: <><circle cx="9" cy="8" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3m1-16a3 3 0 0 1 0 6m3 10v-3a6 6 0 0 0-2-4"/></>,
    note: <><path d="M5 4h14v16H5zM8 8h8M8 12h8M8 16h5"/></>, absence: <><circle cx="12" cy="12" r="9"/><path d="M8 12h8"/></>,
    report: <><path d="M4 20V10m6 10V4m6 16v-7m4 7H2"/></>,
    settings: <><circle cx="12" cy="12" r="3"/><path d="M12 3v3m0 12v3M3 12h3m12 0h3M5.6 5.6l2.1 2.1m8.6 8.6 2.1 2.1m0-12.8-2.1 2.1m-8.6 8.6-2.1 2.1"/></>,
    archive: <><path d="M4 7h16v13H4zM3 4h18v3H3zM9 11h6"/></>,
  };
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>{paths[name]}</svg>;
}

function App({store,repository,account,onUpdated,onSignOut}) {
  const storageState=useSyncExternalStore(store.subscribe,store.getSnapshot);
  const [selectedBranchIds,setSelectedBranchIds]=useState([]);
  const mobilePlanner=useMobilePlannerViewport(),[immersiveRequested,setImmersiveRequested]=useState(false);
  const readableBranches=storageState.branches.filter(item=>item.active&&item.readable);
  useEffect(()=>{
   const readableIds=readableBranches.map(item=>item.id);
   if(readableIds.length)setSelectedBranchIds(current=>{
    const valid=current.filter(id=>readableIds.includes(id));
    return valid.length?valid:restoreBranchSelection(localStorage,account.organization_id,account.user_id,readableIds);
   });
  },[storageState.branches,account.organization_id,account.user_id]);
  function selectBranches(ids){
   const readableIds=readableBranches.map(item=>item.id);
   setSelectedBranchIds(persistBranchSelection(localStorage,account.organization_id,account.user_id,ids,readableIds));
  }
  const deleteBranch=bulkDeleteBranch(storageState.branches,selectedBranchIds);
  const scopedSnapshot=useMemo(()=>filterSnapshotByBranches(storageState.snapshot,selectedBranchIds),[storageState.snapshot,selectedBranchIds]);
  const {data,settings,notes,variations}=scopedSnapshot;
  const awareness=useMemo(()=>plannerAwareness(storageState.snapshot,selectedBranchIds),[storageState.snapshot,selectedBranchIds]);
  const [error,setError]=useState(''),[view,setView]=useState('planning'),[week,setWeek]=useState(()=>startOfWeek(new Date())),[visibleDays,setVisibleDays]=useState(7);
  const immersive=mobilePlanner&&view==='planning'&&immersiveRequested;
  useEffect(()=>{if(!mobilePlanner||view!=='planning')setImmersiveRequested(false);},[mobilePlanner,view]);
  const wasImmersive=useRef(false);
  useEffect(()=>{if(immersive)document.querySelector('.mobile-immersive-exit')?.focus();else if(wasImmersive.current)document.querySelector('.mobile-planner-entry')?.focus();wasImmersive.current=immersive;},[immersive]);
  const [requestRecords,setRequestRecords]=useState([]),[notesUnread,setNotesUnread]=useState(false),[requestsUnread,setRequestsUnread]=useState(false),[requestAttentionIds,setRequestAttentionIds]=useState([]);
  const [archive,setArchive]=useState({retention_months:24,months:[]}),[archiveTarget,setArchiveTarget]=useState('');
  const [hiddenEmployeeIds,setHiddenEmployeeIds]=useState([]),[draftFilter,setDraftFilter]=useState(()=>data.employees.map(item=>item.id));
  const [branchPreferences,setBranchPreferences]=useState({}),preferenceWrites=useRef(Promise.resolve()),preferenceWriteVersion=useRef(0);
  const [employeeColumnWidth,setEmployeeColumnWidth]=useState(DEFAULT_EMPLOYEE_COLUMN_WIDTH),[employeeOrder,setEmployeeOrder]=useState([]);
  const canWrite=['admin','editor'].includes(account.role);
  const visibleNavItems=navigationForRole(account.role).filter(([id])=>id!=='branches'||account.organization_role==='owner');
  const readOnly=!plannerCanWrite(account.role,storageState.status);
  useEffect(()=>{store.connect();const online=()=>store.connect(),offline=()=>store.offline();window.addEventListener('online',online);window.addEventListener('offline',offline);return()=>{window.removeEventListener('online',online);window.removeEventListener('offline',offline);};},[]);
  useEffect(()=>{let active=true;const refresh=()=>Promise.all([repository.requests(),repository.noteUnread(),repository.requestUnread()]).then(([requests,noteState,requestState])=>{if(active){setRequestRecords(requests);setNotesUnread(!!noteState.unread);setRequestsUnread(!!requestState.unread);if(requestState.unread)setRequestAttentionIds(requestState.request_ids||[]);}}).catch(()=>{});refresh();const timer=setInterval(refresh,30000);window.addEventListener('focus',refresh);return()=>{active=false;clearInterval(timer);window.removeEventListener('focus',refresh);};},[repository]);
  useEffect(()=>{let active=true;repository.plannerPreferences().then(value=>{if(!active)return;setEmployeeColumnWidth(clampEmployeeColumnWidth(value.employee_column_width));setEmployeeOrder(Array.isArray(value.employee_order)?value.employee_order:[]);setBranchPreferences(value.branch_preferences||{});setHiddenEmployeeIds(Array.isArray(value.hidden_employee_ids)?value.hidden_employee_ids:[]);}).catch(error=>{if(active)setError(error.userFacing?error.message:'Impossibile caricare le preferenze personali.');});return()=>{active=false};},[repository]);
  useEffect(()=>{let active=true;repository.archive().then(value=>{if(active)setArchive(value)}).catch(error=>{if(active)setError(error.userFacing?error.message:'Impossibile caricare l’archivio.');});return()=>{active=false};},[repository]);
  useEffect(()=>{if(view!=='requests'||!requestsUnread)return;let active=true;repository.markRequestsRead().then(()=>{if(active)setRequestsUnread(false)}).catch(()=>{});return()=>{active=false};},[view,requestsUnread,repository]);
  const [modal, setModal] = useState(null), [name, setName] = useState(''), [type, setType] = useState(''), [start, setStart] = useState(''), [end, setEnd] = useState(''),[shiftBranchId,setShiftBranchId]=useState('');
  const shiftBranchOptions=modal?.employee?employeeBranchOptions(modal.employee,storageState.branches):[];
  const [actualStart,setActualStart]=useState(''),[actualEnd,setActualEnd]=useState(''),[variationReasonValue,setVariationReasonValue]=useState('Ritardo'),[customReason,setCustomReason]=useState(''),[variationNote,setVariationNote]=useState('');
  const dialog = useRef(null);
  useEffect(() => { if (modal && !['range','export','copy','bulkDelete'].includes(modal.type)&&!dialog.current?.open) dialog.current?.showModal(); }, [modal]);
  async function persist(next){const merged=mergeScopedSnapshot(storageState.snapshot,scopedSnapshot,next);try{assertPlannerShiftSafety(storageState.snapshot.data,merged.data,selectedBranchIds);}catch(error){setError(error.message);return false;}const saved=await store.save(merged);if(!saved)setError(store.getSnapshot().message||'Salvataggio non disponibile.');else setError('');return saved;}
  async function commit(next){
    const ids=new Set(next.employees.map(item=>item.id));
    const nextNotes=notes.map(note=>({...note,employeeId:ids.has(note.employeeId)?note.employeeId:''}));
    const saved=await persist({data:next,settings,notes:nextNotes,variations:sanitizeVariations(next,variations)});
    if(saved)setModal(null);return saved;
  }
  function saveNotes(next){return persist({data,settings,variations,notes:next});}
  function saveVariations(next){return persist({data,settings,notes,variations:next});}
  async function saveSettings(next){if(!validSettings(next)){setError('Controlla nomi, orari e colori inseriti.');return false;}const saved=await store.save({...storageState.snapshot,settings:next});setError(saved?'':store.getSnapshot().message||'Salvataggio non disponibile.');return saved;}
  async function savePersonalPreferences(nextWidth=employeeColumnWidth,nextOrder=employeeOrder){
   const normalized=normalizeUserPreferences({employeeColumnWidth:nextWidth,employeeOrder:nextOrder},storageState.snapshot.data.employees);
   setEmployeeColumnWidth(normalized.employeeColumnWidth);setEmployeeOrder(normalized.employeeOrder);
   try{await repository.savePlannerPreferences(normalized);setError('');return true;}catch(error){setError(error.userFacing?error.message:'Impossibile salvare le preferenze personali.');return false;}
  }
  function employee(item) { if(readOnly)return;setName(item?.name || '');setModal({type:'employee', employee:item}); }
  async function saveBranchPreferences(branchId,patch){
   // Serialize writes so rapid drags/sort changes reach the server in order.
   const version=++preferenceWriteVersion.current;
   setBranchPreferences(current=>({...current,[branchId]:{...current[branchId],...patch}}));
   const write=preferenceWrites.current.then(()=>repository.saveBranchPlannerPreferences({branchId,employeeOrder:patch.employee_order,templateSort:patch.template_sort}));
   preferenceWrites.current=write.catch(()=>{});
   try{const saved=await write;if(version===preferenceWriteVersion.current)setBranchPreferences(saved.branch_preferences);setError('');return true;}catch(error){
    if(version===preferenceWriteVersion.current){
     try{const saved=await repository.plannerPreferences();if(version===preferenceWriteVersion.current)setBranchPreferences(saved.branch_preferences||{});}catch{}
    }
    setError(error.userFacing?error.message:'Impossibile salvare le preferenze della Sede.');return false;
   }
  }
  const orderBranchId=selectedBranchIds.length===1?selectedBranchIds[0]:null;
  const activeEmployeeOrder=branchPreferences[orderBranchId]?.employee_order??employeeOrder;
  const assignmentSettings=settingsForBranch(storageState.snapshot.settings,shiftBranchId,branchPreferences[shiftBranchId]?.template_sort);
  function shift(item,date,context={}) {
   if(readOnly)return;
   const key=`${item.id}|${dateKey(date)}`,existing=awareness.data.shifts[key];
   if(isForeignShift(existing,selectedBranchIds)){setModal({type:'crossShiftDetails',employee:item,date,key,shift:existing,variation:awareness.variations[key]});return;}
   setType(existing?(isAbsence(shiftType(existing))?shiftType(existing):'snapshot'):'');setStart(existing?.start||'');setEnd(existing?.end||'');
   setShiftBranchId(defaultShiftBranchId(item,storageState.branches,selectedBranchIds,existing?.branchId));
   setModal({type:'shift',employee:item,date,key,targetDates:context.dates?.length?context.dates:[dateKey(date)]});
  }
  function selectedEntry(nextType=type){
   if(nextType==='snapshot'){
    const prior=data.shifts[modal.key];if(!prior)return null;
    const timed=makeShift(shiftType(prior),start,end);
    return timed?{...prior,...timed}:null;
   }
   return makeShift(nextType,start,end,assignmentSettings);
  }
  async function applyShiftEntry(entry){
   const allowed=employeeBranchOptions(modal.employee,storageState.branches),branchId=shiftBranchId||allowed[0]?.id;
   if(!branchId||!allowed.some(branch=>branch.id===branchId)){setError('La Sede selezionata non è assegnata a questo dipendente.');return false;}
   const scopedEntry={...entry,branchId};
   const dates=modal.targetDates?.length?modal.targetDates:[dateKey(modal.date)],conflicts=assignmentConflicts(awareness.data,modal.employee.id,dates,scopedEntry);
   if(conflicts.some(d=>protectedAssignment(awareness.data.shifts[`${modal.employee.id}|${d}`],selectedBranchIds,branchId))||dates.length>1&&conflicts.length){setModal({...modal,type:'rangeConflict',entry:scopedEntry,conflicts});return;}
   commit(applyBulkAssignment(data,modal.employee.id,dates,scopedEntry));
  }
  async function save(event) {
    event.preventDefault();
    if (modal.type === 'employee') {
      if (!name.trim()) return;
      const employees = modal.employee ? data.employees.map(item => item.id===modal.employee.id ? {...item,name:name.trim()} : item) : [...data.employees,{id:crypto.randomUUID(),name:name.trim(),homeBranchId:selectedBranchIds[0]||readableBranches[0]?.id}];
      commit({...data,employees});
    } else { const entry=selectedEntry(); if(entry)applyShiftEntry(entry); }
  }
  function removeShift() { const dates=modal.targetDates?.length?modal.targetDates:[dateKey(modal.date)],targets=bulkDeletionTargets(data,modal.employee.id,dates);if(dates.length>1){setModal({...modal,type:'rangeDeleteConfirm',targets});return;}commit(applyBulkDeletion(data,modal.employee.id,dates)); }
  function confirmRangeDelete(){commit(applyBulkDeletion(data,modal.employee.id,modal.targetDates));}
  function confirmRangeAssignment(){commit(applyBulkAssignment(data,modal.employee.id,modal.targetDates,modal.entry));}
  function assignEmptyRange(){commit(applyBulkAssignment(data,modal.employee.id,modal.targetDates.filter(d=>!awareness.data.shifts[`${modal.employee.id}|${d}`]),modal.entry));}
  const protectedRange=modal?.type==='rangeConflict'&&modal.conflicts.some(d=>protectedAssignment(awareness.data.shifts[`${modal.employee.id}|${d}`],selectedBranchIds,modal.entry.branchId));
  const protectedCopy=modal?.type==='dragConflict'&&modal.conflicts.some(item=>protectedAssignment(awareness.data.shifts[`${item.employeeId}|${item.destinationDate}`],selectedBranchIds,item.shift.branchId));
  function saveInstantShift(nextType) { const entry=selectedEntry(nextType); if(entry)applyShiftEntry(entry); }
  async function removeEmployee() {
    const id=modal.employee.id, changed=await commit({...data,employees:data.employees.filter(item=>item.id!==id),shifts:Object.fromEntries(Object.entries(data.shifts).filter(([key])=>!key.startsWith(`${id}|`)))});
    if(changed){setDraftFilter(current=>current.filter(item=>item!==id));setHiddenEmployeeIds(current=>current.filter(item=>item!==id));}
  }
  function editVariation(){const existing=variations[modal.key],planned=data.shifts[modal.key];setActualStart(existing?.start||planned?.start||'');setActualEnd(existing?.end||planned?.end||'');setVariationReasonValue(existing?.reason||'Ritardo');setCustomReason(existing?.customReason||'');setVariationNote(existing?.note||'');setModal({...modal,type:'variation'});}
  async function saveVariation(event){event.preventDefault();const entry=makeVariation(modal.employee.id,dateKey(modal.date),actualStart,actualEnd,variationReasonValue,customReason,variationNote);if(!entry)return;if(await saveVariations(upsertVariation(variations,entry)))setModal({...modal,type:'shift'});}
  function removeVariation(){saveVariations(deleteVariation(variations,modal.key));}
  function dragCopy(employee,sourceDate,destinationDates){const destinations=[...new Set(Array.isArray(destinationDates)?destinationDates:[destinationDates])].filter(date=>date!==sourceDate),entries=buildDayCopy(data,employee.id,sourceDate,destinations,settings);if(!entries.length)return;const conflicts=copyConflicts(awareness.data,entries);if(conflicts.length)setModal({type:'dragConflict',entries,conflicts,entry:conflicts[0],key:`${employee.id}|${conflicts[0].destinationDate}`});else commit(applyShiftCopy(data,entries,'empty'));}
  function replaceDragCopy(){commit(applyShiftCopy(data,modal.entries,'replace'));}
  function fastDelete(employee,date){if(readOnly||isForeignShift(awareness.data.shifts[`${employee.id}|${date}`],selectedBranchIds))return;commit(applyBulkDeletion(data,employee.id,[date]));}
  async function bulkDelete(plan){
   if(readOnly||deleteBranch?.id!==modal?.branch.id){setError('Seleziona una sola Sede prima di eliminare i turni.');return false;}
   const saved=await store.bulkDelete(modal.branch.id,plan,modal.revision);
   if(saved){setError('');setModal(null);}else setError(store.getSnapshot().message||'Eliminazione non disponibile.');return saved;
  }
  useEffect(()=>{if(modal?.type==='bulkDelete'&&deleteBranch?.id!==modal.branch.id)setModal(null);},[deleteBranch?.id,modal]);

  const orderedEmployees=useMemo(()=>orderEmployees(data.employees,activeEmployeeOrder),[data.employees,activeEmployeeOrder]);
  const alphabeticalEmployees=useMemo(()=>sortEmployeesAlphabetically(data.employees),[data.employees]);
  const visiblePlannerEmployees=useMemo(()=>{const hidden=new Set(hiddenEmployeeIds);return orderedEmployees.filter(employee=>!hidden.has(employee.id));},[orderedEmployees,hiddenEmployeeIds]);
  function reorderEmployee(id,direction){if(!orderBranchId)return;const next=moveEmployee(activeEmployeeOrder,data.employees,id,direction);saveBranchPreferences(orderBranchId,{employee_order:next});}
  function reorderEmployeeTo(sourceId,targetId,position){if(!orderBranchId)return;const next=moveEmployeeTo(activeEmployeeOrder,data.employees,sourceId,targetId,position);saveBranchPreferences(orderBranchId,{employee_order:next});}
  async function applyEmployeeVisibility(){
   const selected=new Set(draftFilter),hidden=data.employees.filter(employee=>!selected.has(employee.id)).map(employee=>employee.id);
   setHiddenEmployeeIds(hidden);
   try{await repository.savePlannerVisibility(hidden);setError('');return true;}catch(error){setError(error.userFacing?error.message:'Impossibile salvare la selezione dei dipendenti.');return false;}
  }
  const requestEffects=approvedRequestEffects(requestRecords,data.shifts);
  const pendingRequests=canWrite&&requestRecords.some(item=>item.status==='pending');
  function setPlanningWeek(value){setWeek(current=>clampPlanningDate(typeof value==='function'?value(current):value));}
  function navigateToDate(value){const target=dateNavigationTarget(value);if(!target)return;if(target.view==='archive'){setArchiveTarget(target.month);setView('archive');return;}setView('planning');setPlanningWeek(target.date);}
  const scheduleProps={data,awarenessData:awareness.data,awarenessVariations:awareness.variations,settings,variations,requestEffects,week,setWeek:setPlanningWeek,visibleDays,setVisibleDays,onEmployee:employee,onShift:shift,onDragCopy:dragCopy,onFastDelete:fastDelete,onExport:()=>setModal({type:'export'}),onReorderEmployee:orderBranchId?reorderEmployeeTo:undefined,onMoveEmployee:orderBranchId?reorderEmployee:undefined,onNavigateDate:navigateToDate,disabled:readOnly,Icon,employeeColumnWidth,onEmployeeColumnWidth:width=>savePersonalPreferences(width,employeeOrder),minimumEditableDate:dateKey(new Date(new Date().getFullYear(),new Date().getMonth(),1)),branches:storageState.branches,selectedBranchIds};
  const colorVars=Object.fromEntries(SHIFT_TYPES.map(item=>[`--color-${item.toLowerCase()}`,settings.colors[item]||DEFAULT_SETTINGS.colors[item]]));
  const textVars={'--text-riposo':'#fff','--text-malattia':'#29230f','--text-ferie':'#1c2836'};
  return <div className={`app-shell${immersive?' mobile-planner-active':''}`} style={{...colorVars,...textVars}}>
    <aside className="sidebar"><div className="brand"><span>SHIFT PLANNER</span></div><nav aria-label="Navigazione principale">{visibleNavItems.map(([id,icon,label])=><button key={id} className={`nav-item ${view===id?'nav-active':''}`} aria-label={label} aria-current={view===id?'page':undefined} onClick={async()=>{if(view==='requests'&&id!=='requests')setRequestAttentionIds([]);if(id==='archive')setArchiveTarget('');setView(id);if(id==='employees'){const hidden=new Set(hiddenEmployeeIds);setDraftFilter(data.employees.filter(item=>!hidden.has(item.id)).map(item=>item.id));}if(id==='notes'&&notesUnread){try{await repository.markNotesRead();setNotesUnread(false);}catch{}}if(id==='requests'&&requestsUnread){try{await repository.markRequestsRead();setRequestsUnread(false);}catch{}}}}><Icon name={icon}/><span>{label}</span>{id==='requests'&&(pendingRequests||requestsUnread)&&<i className={`nav-alert ${requestsUnread?'request-outcome-alert':''}`} title={requestsUnread?'Esito richiesta da leggere':'Richieste in attesa'}/>} {id==='notes'&&notesUnread&&<i className="nav-alert note-alert" title="Nuove note"/>}</button>)}</nav><div className="sidebar-bottom"><button className="sidebar-signout" onClick={onSignOut}>Esci</button><ConnectionPanel store={store} state={storageState} configured={true}/><div><Icon name="check"/><span>{statusLabel[storageState.status]}</span></div></div></aside>
    <main>
      <header className="workspace-header"><AccountMenu account={account} onUpdated={onUpdated} onSignOut={onSignOut}/><strong>{account.organization_name}</strong><BranchSelector branches={storageState.branches} selected={selectedBranchIds} onChange={selectBranches}/></header>
      {view==='planning'&&<><div className="page-heading"><div><p className="eyebrow">PIANIFICAZIONE</p><h1>Pianificazione turni</h1></div><div className="heading-actions">{canWrite&&<><button onClick={()=>employee()} disabled={readOnly}><Icon name="plus"/> Aggiungi dipendente</button><button onClick={()=>setModal({type:'copy'})} disabled={!data.employees.length||readOnly}>Copia / Ripeti turni</button><button className="bulk-delete-button" onClick={()=>deleteBranch&&setModal({type:"bulkDelete",branch:deleteBranch,revision:storageState.branchRevisions[deleteBranch.id]})} disabled={!deleteBranch||!Object.keys(data.shifts).length||readOnly} aria-describedby={!deleteBranch?"bulk-delete-sede-help":undefined} title={!deleteBranch?"Seleziona una sola Sede che puoi gestire prima di eliminare i turni.":undefined}>Elimina turni</button>{!deleteBranch&&canWrite&&<span id="bulk-delete-sede-help" className="field-help">Per eliminare i turni, seleziona una sola Sede che puoi gestire.</span>}<button className="primary" onClick={()=>setModal({type:'range'})} disabled={!data.employees.length||readOnly}><Icon name="plus"/> Aggiungi turno</button></>}</div></div>{!orderBranchId&&readableBranches.length>1&&<p className="field-help">Per riordinare i dipendenti, seleziona una sola Sede.</p>}<ScheduleView {...scheduleProps} employees={visiblePlannerEmployees} immersive={immersive} onEnterImmersive={()=>setImmersiveRequested(true)} onExitImmersive={()=>setImmersiveRequested(false)} onSelectBranches={selectBranches} modalOpen={!!modal} onMobileCopy={canWrite?()=>setModal({type:'copy'}):undefined}/></>}
      {view==='archive'&&<ArchiveView archive={archive} targetMonth={archiveTarget} setArchive={setArchive} repository={repository} account={account} snapshot={storageState.snapshot} requests={requestRecords} scheduleProps={{...scheduleProps,employees:visiblePlannerEmployees,minimumEditableDate:''}} onExport={anchor=>setModal({type:'export',week:anchor})} onError={setError}/>}
      {view==='employees'&&<EmployeeFilterView employees={alphabeticalEmployees} branches={storageState.branches} draft={draftFilter} setDraft={setDraftFilter} onApply={applyEmployeeVisibility} onEmployee={employee} canManage={canWrite&&!readOnly} Icon={Icon}/>}
      {view==='notes'&&<NotesView disabled={!canWrite||readOnly} notes={notes} employees={data.employees} Icon={Icon} onSave={note=>saveNotes(upsertNote(notes,{...note,branchId:notes.find(item=>item.id===note.id)?.branchId||selectedBranchIds[0]}))} onDelete={id=>saveNotes(deleteNote(notes,id))}/>}
      {view==='requests'&&<><RequestsView repository={repository} account={account} employees={data.employees} plannerRevision={storageState.revision} branchRevisions={storageState.branchRevisions} attentionRequestIds={requestAttentionIds} onPlannerChanged={()=>store.connect()} onRequestsChanged={setRequestRecords} Icon={Icon}/><CrossBranchRequests repository={repository} onChanged={()=>store.connect()}/></>}
      {view==='absences'&&canWrite&&<AbsencesView data={data} requests={requestRecords} Icon={Icon}/>} {view==='hours'&&<HoursReportView data={{...data,employees:orderedEmployees}} variations={variations} requestEffects={requestEffects} Icon={Icon} allowedEmployeeIds={account.role==='viewer'?reportEmployeeIds(account,orderedEmployees):null} unlinkedMessage="Il tuo account non è ancora associato a un dipendente. Contatta l’amministratore."/>} {canWrite&&view==='settings'&&<><AccountSettingsView account={account} onUpdated={onUpdated} allowOrganization={account.role==='admin'}/><SettingsView branchPreferences={branchPreferences} onTemplateSort={(branchId,sort)=>saveBranchPreferences(branchId,{template_sort:normalizeTemplateSort(sort)})} key={JSON.stringify(storageState.snapshot.settings)} disabled={readOnly} settings={storageState.snapshot.settings} data={storageState.snapshot.data} branches={readableBranches} selectedBranchIds={selectedBranchIds} onSave={saveSettings}/><BackupPanel snapshot={storageState.snapshot} disabled={readOnly} onImport={persist}/></>}
      {view==='account'&&account.role==='viewer'&&<AccountSettingsView account={account} onUpdated={onUpdated}/>}
      {account.role==='admin'&&view==='access'&&<AccessView repository={repository} employees={data.employees} branches={storageState.branches} account={account}/>}
      {account.organization_role==='owner'&&view==='branches'&&<BranchesView repository={repository} account={account} onChanged={()=>store.connect()}/>}
      {error&&<div role="alert" className="error global-error">{error}</div>}<footer><Icon name="check"/> {statusLabel[storageState.status]} · Le ore sono attribuite al giorno di inizio del turno.</footer>
    </main>
    {modal?.type==='range'&&<RangeDialog branchPreferences={branchPreferences} branches={storageState.branches} selectedBranchIds={selectedBranchIds} busy={storageState.status==='saving'} data={awareness.data} week={week} settings={storageState.snapshot.settings} onClose={()=>setModal(null)} onApply={commit}/>}
    {modal?.type==='export'&&<ExportDialog data={data} variations={variations} settings={settings} week={modal.week||week} visibleDays={modal.week?monthRange(modal.week).days:visibleDays} onClose={()=>setModal(null)}/>}
    {modal?.type==='copy'&&<CopyDialog branches={storageState.branches} selectedBranchIds={selectedBranchIds} sourceData={data} busy={storageState.status==='saving'} data={awareness.data} settings={settings} visibleStart={week} onClose={()=>setModal(null)} onApply={commit}/>}
    {modal?.type==='bulkDelete'&&deleteBranch?.id===modal.branch.id&&<BulkDeleteDialog branch={modal.branch} snapshot={filterSnapshotByBranches(storageState.snapshot,[modal.branch.id])} week={week} busy={storageState.status==='saving'} onClose={()=>setModal(null)} onApply={bulkDelete}/>}
    {modal&&!['range','export','copy','bulkDelete'].includes(modal.type)&&<dialog inert={storageState.status==='saving' ? true : undefined} aria-label="Modifica pianificazione" ref={dialog} onCancel={()=>setModal(null)} onClick={event=>{if(event.target===dialog.current)setModal(null)}}>
      <div className="dialog-heading"><div><h2>{modal.type==='employee'?(modal.employee?'Modifica dipendente':'Nuovo dipendente'):modal.type==='remove'?'Rimuovi dipendente':modal.type==='rangeConflict'?'Conferma sostituzione':modal.type==='rangeDeleteConfirm'?'Elimina turni selezionati':modal.type==='dragConflict'?'Destinazione già pianificata':modal.type==='crossShiftDetails'?'Turno in altra Sede':modal.type==='variation'?(variations[modal.key]?'Modifica variazione':'Variazione turno'):'Organizza il turno'}</h2><p>{['shift','variation','crossShiftDetails'].includes(modal.type)?`${modal.employee.name} · ${modal.date.toLocaleDateString('it-IT',{weekday:'long',day:'numeric',month:'long'})}`:['rangeConflict','rangeDeleteConfirm'].includes(modal.type)?`${modal.employee.name} · ${modal.targetDates.length} giorni selezionati`:modal.type==='dragConflict'?`${modal.entry.employeeName} · ${parseDate(modal.entry.destinationDate).toLocaleDateString('it-IT',{weekday:'long',day:'numeric',month:'long'})}`:'La tua squadra, sempre aggiornata.'}</p></div><button className="icon-button" aria-label="Chiudi" onClick={()=>setModal(null)}><Icon name="close"/></button></div>
      {error&&<p role="alert" className="error">{error}</p>}
      {modal.type==='crossShiftDetails'?<><div className="conflict-warning" role="status"><strong>Turno in altra Sede · {branchMarker(modal.shift,storageState.branches)}</strong><p>Questo dipendente è già assegnato in questa data. Per modificare il turno, passa alla sua Sede.</p></div><div className="planned-shift" data-branch-id={modal.shift.branchId}><strong>{shiftType(modal.shift)}</strong>{!isAbsence(shiftType(modal.shift))&&<small>{modal.shift.start} – {modal.shift.end}</small>}<span>{modal.employee.name} · {dateKey(modal.date)}</span><span>Sede {branchMarker(modal.shift,storageState.branches)}</span>{modal.variation&&<small>Orario effettivo {modal.variation.start} – {modal.variation.end}</small>}</div><div className="dialog-actions"><button onClick={()=>setModal(null)}>Chiudi dettagli</button>{storageState.branches.some(b=>b.id===modal.shift.branchId&&b.active&&b.readable)&&<button className="primary" onClick={()=>{selectBranches([modal.shift.branchId]);setModal(null);}}>Passa alla Sede {branchMarker(modal.shift,storageState.branches)}</button>}</div></>:modal.type==='rangeConflict'?<><div className="conflict-warning" role="alert"><strong>{modal.conflicts.length} giorni contengono già un turno o uno stato.</strong><p>{protectedRange?'Un turno per dipendente e data. I turni delle altre Sedi non possono essere sostituiti: passa alla Sede indicata.':'Confermando, lo stesso turno sostituirà le assegnazioni esistenti in tutto l’intervallo selezionato.'}</p><ul className="conflict-list">{modal.conflicts.map(d=>{const existing=awareness.data.shifts[`${modal.employee.id}|${d}`];return <li key={d}><strong>{d}</strong><span>{shiftType(existing)} · {existing.start}–{existing.end} · Sede {branchMarker(existing,storageState.branches)}</span></li>})}</ul></div><div className="dialog-actions"><button autoFocus onClick={()=>setModal({...modal,type:'shift'})}>Annulla</button><div className="action-spacer"/><button disabled={!modal.targetDates.some(d=>!awareness.data.shifts[`${modal.employee.id}|${d}`])} onClick={assignEmptyRange}>Applica solo alle date vuote</button><button disabled={protectedRange} className="danger-solid" onClick={confirmRangeAssignment}>Sostituisci e applica</button></div></>:modal.type==='rangeDeleteConfirm'?<><div className="conflict-warning" role="alert"><strong>Stai per eliminare {modal.targets.length} turni.</strong><p>L’eliminazione riguarda soltanto {modal.employee.name} nelle date selezionate e non può essere annullata.</p></div><div className="dialog-actions"><button autoFocus onClick={()=>setModal({...modal,type:'shift'})}>Annulla</button><div className="action-spacer"/><button className="danger-solid" disabled={!modal.targets.length} onClick={confirmRangeDelete}>Elimina turni</button></div></>:modal.type==='dragConflict'?<><div className="conflict-warning" role="alert"><strong>La destinazione contiene già un turno o uno stato.</strong><p>Il turno di origine rimarrà invariato. Un turno per dipendente e data: per modificare un turno di un’altra Sede, passa alla sua Sede.</p></div><div className="drag-conflict-details"><span>Turno esistente</span><strong>{shiftType(awareness.data.shifts[modal.key])} · Sede {branchMarker(awareness.data.shifts[modal.key],storageState.branches)}</strong><span>Turno da copiare</span><strong>{shiftType(modal.entry.shift)}</strong></div><div className="dialog-actions"><button autoFocus onClick={()=>setModal(null)}>Annulla</button><div className="action-spacer"/><button className="primary" onClick={()=>commit(applyShiftCopy(awareness.data,modal.entries,'empty'))}>Copia solo nei giorni vuoti</button><button disabled={protectedCopy} className="danger" onClick={replaceDragCopy}>Sostituisci</button></div></>:modal.type==='remove'?<><p>Vuoi rimuovere <strong>{modal.employee.name}</strong>? Verranno eliminati anche tutti i suoi turni e le relative variazioni, in ogni settimana. Le note saranno conservate senza collegamento al dipendente. Questa azione non può essere annullata.</p><div className="dialog-actions"><button onClick={()=>setModal(null)}>Annulla</button><button className="danger-solid" onClick={removeEmployee}>Rimuovi dipendente</button></div></>:modal.type==='variation'?<form noValidate onSubmit={saveVariation}><div className="planned-shift"><span>Turno pianificato</span><strong>{shiftType(data.shifts[modal.key])}</strong><small>{data.shifts[modal.key].start} – {data.shifts[modal.key].end}</small></div><VariationFields start={actualStart} setStart={setActualStart} end={actualEnd} setEnd={setActualEnd} reason={variationReasonValue} setReason={setVariationReasonValue} customReason={customReason} setCustomReason={setCustomReason} note={variationNote} setNote={setVariationNote}/><div className="dialog-actions"><button type="button" onClick={()=>setModal({...modal,type:'shift'})}>Annulla</button><div className="action-spacer"/><button className="primary" disabled={!makeVariation(modal.employee.id,dateKey(modal.date),actualStart,actualEnd,variationReasonValue,customReason,variationNote)}>Salva variazione</button></div></form>:<form noValidate onSubmit={save}>{modal.type==='employee'?<><label>Nome e cognome<input autoFocus value={name} maxLength={100} required placeholder="Es. Dipendente Demo" onChange={event=>setName(event.target.value)}/></label></>:<>{shiftBranchOptions.length>1&&<label>Sede del turno<select value={shiftBranchId} onChange={event=>{setShiftBranchId(event.target.value);setType('');}} disabled={!!data.shifts[modal.key]}>{shiftBranchOptions.map(branch=><option key={branch.id} value={branch.id}>{branch.name}{!branch.operable&&!(modal.employee.branchIds||[modal.employee.homeBranchId]).includes(branch.id)?' · proposta':''}</option>)}</select></label>}<ShiftFields {...{type,setType,start,setStart,end,setEnd}} settings={assignmentSettings} snapshot={data.shifts[modal.key]} onInstantSelect={saveInstantShift}/>{modal.targetDates?.length>1&&<p className="range-edit-notice">Il turno sarà applicato a tutte le {modal.targetDates.length} date selezionate.</p>}{data.shifts[modal.key]&&!isAbsence(shiftType(data.shifts[modal.key]))&&(variations[modal.key]?<div className="variation-card"><div><span>Turno pianificato</span><strong>{shiftType(data.shifts[modal.key])}</strong><small>{data.shifts[modal.key].start} – {data.shifts[modal.key].end}</small></div><div><span>Orario effettivo</span><strong>{variations[modal.key].start} – {variations[modal.key].end}</strong><small>{hours(actualMinutes(data.shifts[modal.key],variations[modal.key]))}</small></div><dl><div><dt>Motivo</dt><dd>{variationReason(variations[modal.key])}</dd></div>{variations[modal.key].note&&<div><dt>Nota</dt><dd>{variations[modal.key].note}</dd></div>}<div><dt>Ore pianificate</dt><dd>{hours(minutes(data.shifts[modal.key]))}</dd></div><div><dt>Ore effettive</dt><dd>{hours(actualMinutes(data.shifts[modal.key],variations[modal.key]))}</dd></div></dl><div className="variation-actions"><button type="button" onClick={editVariation}>Modifica variazione</button><button type="button" className="danger" onClick={removeVariation}>Elimina variazione</button></div></div>:<button type="button" className="variation-button" onClick={editVariation}>Variazione turno</button>)}</>}<div className="dialog-actions">{modal.type==='employee'&&modal.employee?<button type="button" className="danger" onClick={()=>setModal({...modal,type:'remove'})}>Rimuovi dipendente</button>:modal.type==='shift'&&data.shifts[modal.key]?<button type="button" className="danger" onClick={removeShift}>{modal.targetDates?.length>1?'Elimina nell’intervallo':'Elimina turno'}</button>:null}<div className="action-spacer"/><button type="button" onClick={()=>setModal(null)}>Annulla</button>{(modal.type==='employee'||type==='snapshot')&&<button className="primary" disabled={readOnly||(modal.type==='employee'?!name.trim():!selectedEntry())}>{modal.type==='shift'?'Conferma':'Salva'}</button>}</div></form>}
    </dialog>}
  </div>;
}
createRoot(document.getElementById('root')).render(<AuthGate>{props=><App {...props}/>}</AuthGate>);
