import React, {useEffect, useLayoutEffect, useMemo, useRef, useState} from 'react';
import {addDays, dateKey, dateRange, dateRangeTitle, hours, isAbsence, parseDate, scheduleTypes, customPresets, shiftColor, shiftText, shiftType, SHIFT_TYPES} from './schedule';
import {absenceRows, DEFAULT_SETTINGS, sortNotesChronologically} from './preferences';
import {attendanceTotals, variationKey} from './attendance';
import {canDragCopy} from './copyShifts';
import CustomPresetSettings from './CustomPresetSettings';
import {EMPTY_SCHEDULE_FILTERS,cleanSearch,filterAbsenceRows,filterSchedule,quickFilter} from './filters';
import {approvedPermissionRows} from './requestEffects';
import {MAX_VISIBLE_DAYS,MIN_VISIBLE_DAYS,TIMELINE_BUFFER_DAYS,clampVisibleDays,densityForDays,isWeekend,monthRange,shiftAbbreviation,startOfWeek,timelineDays,zoomAnchorPosition,zoomStartForAnchor} from './timeline';
import {selectedRangeDates} from './bulkEditing';
import {clampEmployeeColumnWidth} from './userPreferences';
import {isForeignShift,branchMarker} from './plannerAwareness';
import {branchLabelForShift} from './branchPersistence';
import {MobilePlannerControls,useMobilePlannerViewport,useMobileSheet} from './MobilePlanner';
import {employeeInitials} from './plannerSheet';
const formatDateShort=value=>parseDate(value)?.toLocaleDateString('it-IT',{day:'numeric',month:'short'})||value;

export function ScheduleView({data, variations, awarenessData=data, awarenessVariations=variations, requestEffects={}, employees, settings, week, setWeek, visibleDays, setVisibleDays, onEmployee, onShift, onDragCopy, onFastDelete, onExport, onReorderEmployee, onMoveEmployee, onNavigateDate, disabled, Icon, filters=EMPTY_SCHEDULE_FILTERS, onClearFilters, employeeColumnWidth=190, onEmployeeColumnWidth, archiveMode=false, allowEmployeeEditing=true, minimumEditableDate='',branches=[],selectedBranchIds=[],immersive=false,onEnterImmersive,onExitImmersive,onSelectBranches,modalOpen=false,onMobileCopy}) {
  const scrollRef=useRef(null),settleTimer=useRef(null),pendingOffset=useRef(0),hoverAnchor=useRef(null),pan=useRef(null);
  const [viewportWidth,setViewportWidth]=useState(1100),[drag,setDrag]=useState(null),[dragTarget,setDragTarget]=useState(''),[rowDrag,setRowDrag]=useState(null),[rowDrop,setRowDrop]=useState(null),[focusRange,setFocusRange]=useState(null),[fastMode,setFastMode]=useState(null),[jumpDate,setJumpDate]=useState(()=>dateKey(week)),[liveEmployeeWidth,setLiveEmployeeWidth]=useState(()=>clampEmployeeColumnWidth(employeeColumnWidth));
  const selecting=useRef(null),suppressClick=useRef(false),resizeState=useRef(null),mobile=useMobilePlannerViewport();
  const sheet=useMobileSheet({active:immersive,scrollRef,width:viewportWidth,days:visibleDays,week,suppressClick});
  const employeeWidth=immersive?sheet.metrics.employeeWidth:liveEmployeeWidth,totalWidth=immersive?sheet.metrics.totalWidth:visibleDays===7?105:82;
  const dayWidth=immersive?sheet.metrics.dayWidth:Math.max(18,(viewportWidth-employeeWidth-totalWidth)/visibleDays);
  const renderDays=useMemo(()=>timelineDays(week,visibleDays,immersive?0:TIMELINE_BUFFER_DAYS),[week,visibleDays,immersive]);
  const days=useMemo(()=>Array.from({length:visibleDays},(_,index)=>addDays(week,index)),[week,visibleDays]);
  const visibleDateKeys=useMemo(()=>new Set(days.map(dateKey)),[days]);
  const filtered=filterSchedule({...awarenessData,employees},awarenessVariations,filters,renderDays,employees.map(item=>item.id)),shownEmployees=filtered.employees;
  const totalsFor = employee => attendanceTotals(data,variations,employee.id,days.map(dateKey).filter(date=>filtered.visibleKeys.has(`${employee.id}|${date}`)),requestEffects);
  const dateFormat = {day: 'numeric', month: 'long'},density=immersive?(dayWidth>=85?'comfortable':dayWidth>=40?'condensed':'compact'):densityForDays(visibleDays),allTypes=scheduleTypes(settings,awarenessData);
  const baseOffset=immersive?0:TIMELINE_BUFFER_DAYS*dayWidth;
  useLayoutEffect(()=>{const node=scrollRef.current;if(!node||immersive)return;node.scrollLeft=baseOffset+pendingOffset.current;pendingOffset.current=0;},[week,visibleDays,dayWidth,immersive]);
  useEffect(()=>{const node=scrollRef.current;if(!node)return;const observer=new ResizeObserver(()=>setViewportWidth(node.clientWidth));observer.observe(node);setViewportWidth(node.clientWidth);return()=>observer.disconnect();},[]);
  useEffect(()=>()=>clearTimeout(settleTimer.current),[]);
  useLayoutEffect(()=>{clearTimeout(settleTimer.current);pan.current=null;selecting.current=null;},[immersive]);
  useEffect(()=>setLiveEmployeeWidth(clampEmployeeColumnWidth(employeeColumnWidth)),[employeeColumnWidth]);
  useEffect(()=>setJumpDate(dateKey(week)),[week]);
  useEffect(()=>{const cancel=event=>{if(event.key==='Escape')setFastMode(null)};window.addEventListener('keydown',cancel);return()=>window.removeEventListener('keydown',cancel);},[]);
  function settleScroll(){
   if(immersive)return;
   clearTimeout(settleTimer.current);settleTimer.current=setTimeout(()=>{const node=scrollRef.current;if(!node)return;const delta=Math.trunc((node.scrollLeft-baseOffset)/dayWidth);if(!delta)return;pendingOffset.current=node.scrollLeft-baseOffset-delta*dayWidth;setWeek(current=>addDays(current,delta));},120);
  }
  function pointerDown(event){if(sheet.down(event)||event.pointerType==='touch')return;if(event.button!==0||event.target.closest('[draggable="true"], [data-range-date]'))return;pan.current={id:event.pointerId,x:event.clientX,left:scrollRef.current.scrollLeft,moved:false};}
  function pointerMove(event){if(sheet.move(event)||event.pointerType==='touch')return;const dateCell=event.target.closest('[data-planner-date]');hoverAnchor.current=dateCell?{clientX:event.clientX,date:dateCell.dataset.plannerDate,inside:true,at:performance.now()}:null;const state=pan.current;if(!state||state.id!==event.pointerId)return;const distance=event.clientX-state.x;if(!state.moved&&Math.abs(distance)<5)return;state.moved=true;suppressClick.current=true;scrollRef.current.setPointerCapture(event.pointerId);scrollRef.current.classList.add('is-panning');scrollRef.current.scrollLeft=state.left-distance;settleScroll();}
  function pointerUp(event){if(sheet.up(event))return;const state=pan.current;if(!state||state.id!==event.pointerId)return;pan.current=null;scrollRef.current.classList.remove('is-panning');if(scrollRef.current.hasPointerCapture(event.pointerId))scrollRef.current.releasePointerCapture(event.pointerId);if(state.moved)setTimeout(()=>{suppressClick.current=false},0);}
  function anchorInfo(nextDays){
   const node=scrollRef.current,rect=node.getBoundingClientRect(),position=zoomAnchorPosition({hover:hoverAnchor.current,now:performance.now(),rectLeft:rect.left,viewportWidth:node.clientWidth,employeeWidth,totalWidth});
   const contentX=position.x-employeeWidth,offset=(node.scrollLeft-baseOffset+contentX)/dayWidth,anchor=position.date?parseDate(position.date):addDays(week,Math.floor(offset));
   const nextWidth=Math.max(18,(node.clientWidth-employeeWidth-(nextDays===7?105:82))/nextDays);
   return {anchor,contentX,nextWidth};
  }
  function zoom(next){next=clampVisibleDays(next);if(next===visibleDays)return;const {anchor,contentX,nextWidth}=anchorInfo(next);setWeek(zoomStartForAnchor(anchor,contentX,nextWidth));setVisibleDays(next);}
  function weekPreset(){const {anchor}=anchorInfo(7);setWeek(startOfWeek(anchor));setVisibleDays(7);}
  function monthPreset(){const {anchor}=anchorInfo(31),range=monthRange(anchor);setWeek(range.start);setVisibleDays(range.days);}
  function todayPreset(){setWeek(startOfWeek(new Date()));setVisibleDays(7);}
  function jump(event){event.preventDefault();const date=parseDate(jumpDate);if(date)(onNavigateDate||setWeek)(date);}
  function startDrag(event,employee,day,shift){if(!shift||disabled||isForeignShift(shift,selectedBranchIds)){event.preventDefault();return;}suppressClick.current=true;event.dataTransfer.effectAllowed='copy';event.dataTransfer.setData('text/plain',`${employee.id}|${dateKey(day)}`);setDrag({employeeId:employee.id,sourceDate:dateKey(day),shift});}
  function finishDrag(){setDrag(null);setDragTarget('');setTimeout(()=>{suppressClick.current=false},0)}
  function dragOver(event,employee,day){const destination=dateKey(day);if(!canDragCopy(drag?.employeeId,employee.id,drag?.sourceDate,destination))return;event.preventDefault();event.dataTransfer.dropEffect='copy';setDragTarget(`${employee.id}|${destination}`);}
  function drop(event,employee,day){const destination=dateKey(day);if(!canDragCopy(drag?.employeeId,employee.id,drag?.sourceDate,destination)){finishDrag();return;}event.preventDefault();const destinations=focusRange&&destination>=focusRange.start&&destination<=focusRange.end?dateRange(focusRange.start,focusRange.end):[destination];onDragCopy(employee,drag.sourceDate,destinations,drag.shift);finishDrag();}
  function startRowDrag(event,employee){event.stopPropagation();event.dataTransfer.effectAllowed='move';event.dataTransfer.setData('text/plain',employee.id);setRowDrag(employee.id);setRowDrop(null);}
  function rowDragOver(event,employee){if(!rowDrag||rowDrag===employee.id)return;event.preventDefault();event.stopPropagation();event.dataTransfer.dropEffect='move';const rect=event.currentTarget.getBoundingClientRect();setRowDrop({id:employee.id,position:event.clientY<rect.top+rect.height/2?'before':'after'});}
  function finishRowDrag(){setRowDrag(null);setRowDrop(null);}
  function dropRow(event,employee){if(!rowDrag||rowDrag===employee.id){finishRowDrag();return;}event.preventDefault();event.stopPropagation();const rect=event.currentTarget.getBoundingClientRect(),position=rowDrop?.id===employee.id?rowDrop.position:event.clientY<rect.top+rect.height/2?'before':'after';onReorderEmployee?.(rowDrag,employee.id,position);finishRowDrag();}
  function rangeStart(event,date){if(mobile||event.pointerType==='touch')return;if(event.button!==0||(minimumEditableDate&&date<minimumEditableDate))return;event.preventDefault();selecting.current=date;setFocusRange({start:date,end:date});}
  function rangeEnter(date){if(!selecting.current)return;setFocusRange({start:selecting.current<date?selecting.current:date,end:selecting.current<date?date:selecting.current});}
  function rangeEnd(){selecting.current=null;}
  function resizeStart(event){
   if(event.button!==0)return;event.preventDefault();event.stopPropagation();
   resizeState.current={x:event.clientX,width:employeeWidth};let nextWidth=employeeWidth;
   const move=moveEvent=>{nextWidth=clampEmployeeColumnWidth(resizeState.current.width+moveEvent.clientX-resizeState.current.x);setLiveEmployeeWidth(nextWidth);};
   const end=()=>{resizeState.current=null;document.removeEventListener('pointermove',move);document.removeEventListener('pointerup',end);onEmployeeColumnWidth?.(nextWidth);};
   document.addEventListener('pointermove',move);document.addEventListener('pointerup',end,{once:true});
  }
  function cellClick(event,employee,day,shift){
   if(suppressClick.current||disabled||(minimumEditableDate&&dateKey(day)<minimumEditableDate))return;
   const modifier=event.ctrlKey||event.metaKey,dayKey=dateKey(day);
   if(isForeignShift(shift,selectedBranchIds)&&fastMode?.type!=='copy'){onShift(employee,day);return;}
   if(modifier&&fastMode?.type==='delete'){
    if(shift)onFastDelete?.(employee,dayKey);
    return;
   }
   if(modifier&&fastMode?.type==='copy'){
    if(employee.id!==fastMode.employeeId)return;
    if(employee.id===fastMode.employeeId&&dayKey===fastMode.sourceDate)return;
    onDragCopy(employee,fastMode.sourceDate,[dayKey],fastMode.shift);
    return;
   }
   if(modifier&&shift){setFastMode({type:'copy',employeeId:employee.id,employeeName:employee.name,sourceDate:dayKey,shift});return;}
   onShift(employee,day,{dates:selectedRangeDates(focusRange,dayKey)});
  }
  const inFocus=date=>focusRange&&date>=focusRange.start&&date<=focusRange.end;
  const today=parseDate(dateKey(new Date())),weekActive=visibleDays===7&&dateKey(week)===dateKey(startOfWeek(week)),month=monthRange(week),monthActive=visibleDays===month.days&&dateKey(week)===dateKey(month.start);
  return <section className={`schedule density-${density}${immersive?' mobile-sheet':''}`} data-sheet-scale={immersive?sheet.scale:undefined} aria-label={`Pianificazione su ${visibleDays} giorni`} style={{'--day-width':`${dayWidth}px`,'--employee-width':`${employeeWidth}px`,'--total-width':`${totalWidth}px`,'--render-days':renderDays.length,...(immersive?{'--sheet-row-height':`${sheet.metrics.rowHeight}px`,'--sheet-font-size':`${sheet.metrics.fontSize}px`,'--sheet-header-font-size':`${sheet.metrics.headerFontSize}px`}: {})}}>
    {mobile&&!archiveMode&&!immersive&&<button className="mobile-planner-entry" onClick={onEnterImmersive}>Apri tabella a schermo intero</button>}
    {immersive&&<MobilePlannerControls onExit={onExitImmersive} week={week} setWeek={setWeek} visibleDays={visibleDays} setVisibleDays={setVisibleDays} branches={branches} selectedBranchIds={selectedBranchIds} onSelectBranches={onSelectBranches} scale={sheet.scale} onZoom={sheet.zoom} onFit={sheet.reset} modalOpen={modalOpen}/> }
    <div className="schedule-toolbar"><div className="week-title"><div><h2>{dateRangeTitle(days[0],days[days.length-1])}</h2><p>{visibleDays} giorni visibili</p></div></div>
      <div className="week-controls">{!archiveMode&&<><button className="icon-button" aria-label="Giorno precedente" onClick={()=>setWeek(addDays(week,-1))}><Icon name="left"/></button><button className="icon-button" aria-label="Giorno successivo" onClick={()=>setWeek(addDays(week,1))}><Icon name="right"/></button><button onClick={todayPreset}>Oggi</button><button className={weekActive?'preset-selected':''} onClick={weekPreset}>Settimana</button><button className={monthActive?'preset-selected':''} onClick={monthPreset}>Mese</button><div className="zoom-control" aria-label="Giorni visibili"><button aria-label="Mostra meno giorni" disabled={visibleDays<=MIN_VISIBLE_DAYS} onClick={()=>zoom(visibleDays-1)}>−</button><input aria-label="Numero di giorni visibili" type="range" min={MIN_VISIBLE_DAYS} max={MAX_VISIBLE_DAYS} value={visibleDays} onChange={event=>zoom(Number(event.target.value))}/><output>{visibleDays} giorni</output><button aria-label="Mostra più giorni" disabled={visibleDays>=MAX_VISIBLE_DAYS} onClick={()=>zoom(visibleDays+1)}>+</button></div><form className="jump-date" onSubmit={jump}><label><span>Vai alla data</span><input type="date" value={jumpDate} aria-label="Vai alla data" onChange={event=>setJumpDate(event.target.value)}/></label><button type="submit">Vai</button></form></>}<button className="export-button" onClick={onExport} disabled={!data.employees.length}>Stampa / Esporta PDF</button></div>
    </div>
    {(focusRange||fastMode||!disabled)&&<div className="focus-range-summary" role="status"><span>{fastMode?.type==='copy'?`Copia rapida: ${fastMode.employeeName}, ${formatDateShort(fastMode.sourceDate)} · Ctrl/Cmd + clic sui target`:fastMode?.type==='delete'?'Eliminazione rapida attiva · Ctrl/Cmd + clic sui turni da rimuovere':focusRange?`Intervallo selezionato: ${formatDateShort(focusRange.start)} – ${formatDateShort(focusRange.end)} · scegli un turno o elimina dalla cella`:'Ctrl/Cmd + clic su un turno per avviare la copia rapida'}</span><div>{!disabled&&<button className={fastMode?.type==='delete'?'mode-active':''} onClick={()=>setFastMode(current=>current?.type==='delete'?null:{type:'delete'})}>Eliminazione rapida</button>}{(focusRange||fastMode)&&<button onClick={()=>{setFocusRange(null);setFastMode(null)}}>Annulla modalità</button>}</div></div>}
    <div ref={scrollRef} className="table-scroll timeline-scroll" onClickCapture={event=>{if(suppressClick.current){event.preventDefault();event.stopPropagation();}}} onScroll={settleScroll} onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={event=>{pointerUp(event);rangeEnd()}} onPointerLeave={()=>{hoverAnchor.current=null;rangeEnd()}} onPointerCancel={event=>{hoverAnchor.current=null;pointerUp(event);rangeEnd()}}><table><colgroup><col className="employee-track"/>{renderDays.map(day=><col key={dateKey(day)} className="day-track"/>)}<col className="total-track"/></colgroup><thead><tr><th className="employee-col">{immersive?'Dip.':'Dipendente'} <span className="count">{shownEmployees.length}</span><span hidden={mobile} className="employee-column-resizer" role="separator" aria-label="Ridimensiona colonna dipendenti" aria-valuemin="140" aria-valuemax="320" aria-valuenow={employeeWidth} onPointerDown={resizeStart}/></th>{renderDays.map(day=>{const key=dateKey(day),accessible=visibleDateKeys.has(key);return <th scope="col" aria-hidden={accessible?undefined:true} data-range-date={key} data-planner-date={key} key={key} onPointerDown={event=>rangeStart(event,key)} onPointerEnter={()=>rangeEnter(key)} className={`${isWeekend(day)?'weekend ':''}${key===dateKey(today)?'today ':''}${inFocus(key)?'range-focused':''}`}><span>{day.toLocaleDateString('it-IT',{weekday:'short'}).replace('.','')}</span><strong>{day.getDate()}</strong></th>})}<th className="total-col">{immersive?'Ore':visibleDays===7?<>Totale<br/>settimanale</>:<>Totale<br/>intervallo</>}</th></tr></thead>
      <tbody>{shownEmployees.map((employee,index)=>{const totals=totalsFor(employee),hasVariation=days.some(day=>filtered.visibleKeys.has(variationKey(employee.id,dateKey(day)))&&variations[variationKey(employee.id,dateKey(day))]),dropClass=rowDrop?.id===employee.id?`row-drop-${rowDrop.position}`:'';return <tr key={employee.id} data-employee-id={employee.id} className={`${rowDrag===employee.id?'row-dragging ':''}${dropClass}`} onDragOver={event=>rowDragOver(event,employee)} onDrop={event=>dropRow(event,employee)}><th scope="row"><div className="employee-cell-content">{!archiveMode&&!mobile&&onReorderEmployee&&<span className="employee-drag-handle" role="button" tabIndex="0" draggable="true" aria-label={`Riordina ${employee.name}`} title="Trascina per riordinare" onDragStart={event=>startRowDrag(event,employee)} onDragEnd={finishRowDrag} onKeyDown={event=>{if(event.key==='ArrowUp'||event.key==='ArrowDown'){event.preventDefault();onMoveEmployee?.(employee.id,event.key==='ArrowUp'?-1:1);}}}>⋮⋮</span>}<button className="employee-button" disabled={disabled||!allowEmployeeEditing} onClick={()=>onEmployee(employee)} aria-label={`${disabled||!allowEmployeeEditing?'Dipendente':'Modifica'} ${employee.name}`}><span className={`avatar color-${index%4}`}>{employee.name.split(' ').filter(Boolean).slice(0,2).map(part=>part[0]).join('').toUpperCase()}</span><span className="employee-name" title={immersive?employee.name:undefined}>{immersive?employeeInitials(employee.name):employee.name}</span>{!disabled&&allowEmployeeEditing&&<Icon name="edit" width="15"/>}</button></div></th>{renderDays.map(day=>{const dayKey=dateKey(day),key=variationKey(employee.id,dayKey),accessible=visibleDateKeys.has(dayKey),visible=filtered.visibleKeys.has(key),shift=visible?awarenessData.shifts[key]:null,variation=visible?awarenessVariations[key]:null,foreign=isForeignShift(shift,selectedBranchIds),isSource=drag?.employeeId===employee.id&&drag.sourceDate===dayKey,validTarget=visible&&canDragCopy(drag?.employeeId,employee.id,drag?.sourceDate,dayKey),type=shift&&shiftType(shift);return <td key={dayKey} aria-hidden={accessible?undefined:true} data-planner-date={dayKey} className={`${isWeekend(day)?'weekend-cell ':''}${dayKey===dateKey(today)?'today-cell ':''}${inFocus(dayKey)?'range-focused-cell ':''}${validTarget?'drag-valid ':''}${dragTarget===key?'drag-target':''}`} onDragOver={event=>dragOver(event,employee,day)} onDragEnter={event=>dragOver(event,employee,day)} onDrop={event=>drop(event,employee,day)}>{visible?<button tabIndex={accessible?undefined:-1} style={shift&&!isAbsence(type)?{
  background:shiftColor(shift,settings),
  color:(()=>{
    const c=shiftColor(shift,settings)?.replace('#','');
    if(!/^[0-9a-f]{6}$/i.test(c||'')) return '#FFFFFF';
    const r=parseInt(c.slice(0,2),16);
    const g=parseInt(c.slice(2,4),16);
    const b=parseInt(c.slice(4,6),16);
    return (r*299+g*587+b*114)/1000>150 ? '#142536' : '#FFFFFF';
  })()
}:undefined} draggable={!!shift&&!foreign&&!disabled&&!mobile} data-branch-id={shift?.branchId} data-cross-sede={foreign?"true":undefined} onDragStart={event=>startDrag(event,employee,day,shift)} onDragEnd={finishDrag} className={`shift-cell ${foreign?'cross-sede ':''}${shift?`type-${type.toLowerCase()}`:'unassigned'} ${isSource?'dragging':''} ${fastMode?.type==='copy'&&fastMode.employeeId===employee.id&&fastMode.sourceDate===dayKey?'fast-copy-source':''} ${fastMode?.type==='delete'&&shift?'fast-delete-target':''}`} onClick={event=>cellClick(event,employee,day,shift)} aria-label={`${employee.name}, ${day.toLocaleDateString('it-IT',{weekday:'long',...dateFormat})}: ${shift?shiftText(shift):'Assegna turno'}${shift?.branchId?`, Sede ${branchMarker(shift,branches)}${foreign?', turno in altra Sede, sola lettura':''}`:''}${variation?', variazione turno registrata':''}`} disabled={disabled}>{shift?<>
  <strong style={shift&&!isAbsence(type)?{color:'inherit'}:undefined}>
    {density==='comfortable'?type:shiftAbbreviation(type,allTypes)}
  </strong>
  {density!=='compact'&&(!immersive||dayWidth>=72)&&!isAbsence(type)&&
    <small style={shift&&!isAbsence(type)?{color:'inherit'}:undefined}>
      {density==='comfortable'?`${shift.start} – ${shift.end}`:`${shift.start}–${shift.end}`}
    </small>
  }{branchLabelForShift(shift,employee,branches,selectedBranchIds)&&<small className="shift-branch-label" title={`Sede ${branchMarker(shift,branches)}`} aria-label={`Sede ${branchMarker(shift,branches)}`}>{branchMarker(shift,branches,density==='compact'||immersive&&dayWidth<72)}</small>}{variation&&<span className="variation-indicator" title="Variazione turno" aria-label="Variazione turno"/>}{data.shifts[key]&&requestEffects[key]?.minutes>0&&<span className="permission-indicator" title={`Permesso approvato: ${hours(requestEffects[key].minutes)}`}>P {hours(requestEffects[key].minutes)}</span>}</>:<Icon name="plus" width="17"/>}</button>:<span className="filtered-cell" aria-label="Voce esclusa dai filtri">—</span>}</td>})}<td className="weekly-total"><strong>{hours(totals.planned)}</strong>{totals.permission>0&&<small>Permessi {hours(totals.permission)} · da lavorare {hours(totals.actual)}</small>}{!totals.permission&&hasVariation&&<small>Effettivo {hours(totals.actual)}</small>}</td></tr>})}</tbody></table></div>
    {!shownEmployees.length&&<div className="empty compact-empty"><div className="empty-icon"><Icon name="people" width="30" height="30"/></div><h3>{filtered.active?'Nessun risultato per i filtri selezionati.':data.employees.length?'Nessun dipendente selezionato.':'Una buona pianificazione inizia dalle persone.'}</h3><p>{filtered.active?'Modifica la ricerca oppure rimuovi i filtri.':data.employees.length?'Apri Dipendenti e applica un filtro.':'Aggiungi il primo dipendente, poi scegli un giorno per assegnare un turno.'}</p>{filtered.active&&onClearFilters&&<button onClick={onClearFilters}>Rimuovi filtri</button>}{!data.employees.length&&<button className="primary" onClick={()=>onEmployee()} disabled={disabled}><Icon name="plus"/> Aggiungi il primo dipendente</button>}</div>}
    <div className="table-footer"><div className="schedule-legend">{scheduleTypes(settings,awarenessData).map(type=>{const assigned=Object.values(awarenessData.shifts).find(s=>shiftType(s)===type),color=shiftColor(assigned,settings);return <span key={type}><i style={color?{background:color}:undefined} className={`legend type-${type.toLowerCase()}`}/>{type}</span>})}</div><span>{disabled?'Visualizzazione in sola lettura.':'Clicca su una cella per modificare il turno.'}</span></div>
  </section>;
}

export function EmployeeFilterView({employees, branches=[],draft, setDraft, onApply, onEmployee, canManage, Icon}) {
  const [search,setSearch]=useState(''),[branchId,setBranchId]=useState(''),[open,setOpen]=useState(false),wrapperRef=useRef(null),buttonRef=useRef(null),searchRef=useRef(null);
  useEffect(()=>{
    if(!open)return;
    searchRef.current?.focus();
    const outside=event=>{if(!wrapperRef.current?.contains(event.target))setOpen(false);};
    const escape=event=>{if(event.key==='Escape'){event.preventDefault();setOpen(false);buttonRef.current?.focus();}};
    document.addEventListener('pointerdown',outside,true);document.addEventListener('keydown',escape);
    return()=>{document.removeEventListener('pointerdown',outside,true);document.removeEventListener('keydown',escape);};
  },[open]);
  function toggle(id){setDraft(current=>current.includes(id)?current.filter(item=>item!==id):[...current,id]);}
  const query=cleanSearch(search),shown=employees.filter(employee=>(!query||cleanSearch(employee.name).includes(query))&&(!branchId||employee.homeBranchId===branchId)),branchName=id=>branches.find(item=>item.id===id)?.name;
  return <section className="content-panel employee-panel"><div className="panel-heading"><div><p className="eyebrow">DIPENDENTI</p><h2>Dipendenti nella pianificazione</h2><p>Elenco alfabetico. Seleziona chi mostrare; l’ordine personale si modifica direttamente in Pianificazione.</p></div>{canManage&&<button className="primary" onClick={()=>onEmployee()}><Icon name="plus"/> Aggiungi dipendente</button>}</div>
    <div className="employee-visibility-dropdown" ref={wrapperRef}>
      <button ref={buttonRef} className="employee-visibility-trigger" aria-expanded={open} aria-controls="employee-visibility-menu" aria-haspopup="dialog" onClick={()=>setOpen(value=>!value)} onKeyDown={event=>{if(!open&&['ArrowDown','Enter',' '].includes(event.key)){event.preventDefault();setOpen(true);}}}><span>Dipendenti visibili</span><strong>{draft.length} di {employees.length}</strong><span aria-hidden="true" className="dropdown-chevron">⌄</span></button>
      {open&&<div id="employee-visibility-menu" className="employee-visibility-menu" role="dialog" aria-label="Seleziona dipendenti visibili">
        <label className="employee-search">Cerca dipendente<input ref={searchRef} type="search" value={search} placeholder="Cerca dipendente…" onChange={event=>setSearch(event.target.value)}/></label>{branches.filter(item=>item.readable).length>1&&<label>Sede<select value={branchId} onChange={event=>setBranchId(event.target.value)}><option value="">Tutte le Sedi</option>{branches.filter(item=>item.readable).map(branch=><option key={branch.id} value={branch.id}>{branch.name}</option>)}</select></label>}
        <div className="filter-actions"><button onClick={()=>setDraft(employees.map(item=>item.id))}>Seleziona tutti</button><button onClick={()=>setDraft([])}>Deseleziona tutti</button><span className="employee-selection-count" role="status">{draft.length} di {employees.length} selezionati</span></div>
        <div className="employee-filter-list" tabIndex="0" aria-label="Elenco dipendenti">{shown.map(employee=><div className={`employee-order-row ${draft.includes(employee.id)?'selected':''}`} key={employee.id}><label><input type="checkbox" checked={draft.includes(employee.id)} onChange={()=>toggle(employee.id)}/><span className="avatar">{employee.name.split(' ').filter(Boolean).slice(0,2).map(part=>part[0]).join('').toUpperCase()}</span><span className="employee-list-name">{employee.name}{branches.length>1&&employee.homeBranchId&&<small>{branchName(employee.homeBranchId)||'Sede non disponibile'}</small>}</span></label>{canManage&&<button className="employee-manage-button" onClick={()=>onEmployee(employee)} aria-label={`Modifica ${employee.name}`}><Icon name="edit" width="15"/> Modifica</button>}</div>)}</div>
        {!!employees.length&&!shown.length&&<div className="employee-no-results" role="status">Nessun dipendente corrisponde alla ricerca.</div>}
        <div className="employee-visibility-footer"><button onClick={()=>setOpen(false)}>Chiudi</button><button className="primary" onClick={async()=>{if(await onApply())setOpen(false);}}>Applica alla pianificazione</button></div>
      </div>}
    </div>
    {!employees.length&&<div className="empty-state"><Icon name="people"/><p>Non ci sono ancora dipendenti.</p></div>}
  </section>;
}

export function NotesView({disabled,notes, employees, onSave, onDelete, Icon}) {
  const [editing,setEditing]=useState(null); const ref=useRef(null);
  useEffect(()=>{if(editing)ref.current?.showModal()},[editing]);
  async function submit(event){event.preventDefault();const form=new FormData(event.currentTarget);const saved=await onSave({id:editing.id||crypto.randomUUID(),text:String(form.get('text')).trim(),date:String(form.get('date')),employeeId:String(form.get('employeeId'))});if(saved!==false)setEditing(null)}
  const employeeName=id=>employees.find(item=>item.id===id)?.name;
  const ordered=sortNotesChronologically(notes);
  return <><section className="content-panel"><div className="panel-heading"><div><p className="eyebrow">NOTE</p><h2>Note operative</h2><p>Elenco cronologico, dalla data più vecchia alla più recente.</p></div><button className="primary" disabled={disabled} onClick={()=>setEditing({id:'',text:'',date:dateKey(new Date()),employeeId:''})}><Icon name="plus"/> Nuova nota</button></div>
    <div className="notes-list">{ordered.map(note=><article key={note.id}><p>{note.text}</p><div className="note-meta"><span>{parseDate(note.date)?.toLocaleDateString('it-IT',{day:'numeric',month:'long',year:'numeric'})}</span>{note.employeeId&&<span>{employeeName(note.employeeId)||'Dipendente non disponibile'}</span>}</div><div className="note-actions"><button disabled={disabled} onClick={()=>setEditing(note)}>Modifica nota</button><button className="danger" disabled={disabled} onClick={()=>onDelete(note.id)}>Elimina nota</button></div></article>)}</div>
    {!notes.length&&<div className="empty-state"><Icon name="note"/><p>Nessuna nota. Aggiungi un promemoria quando serve.</p></div>}
  </section>{editing&&<dialog ref={ref} aria-label={editing.id?'Modifica nota':'Nuova nota'} onCancel={()=>setEditing(null)}><div className="dialog-heading"><div><h2>{editing.id?'Modifica nota':'Nuova nota'}</h2><p>Testo e data sono obbligatori.</p></div><button className="icon-button" aria-label="Chiudi" onClick={()=>setEditing(null)}>×</button></div><form onSubmit={submit}><label>Testo<textarea name="text" required defaultValue={editing.text} autoFocus/></label><div className="date-fields"><label>Data<input name="date" type="date" required defaultValue={editing.date}/></label><label>Dipendente facoltativo<select name="employeeId" defaultValue={editing.employeeId}><option value="">Nessun dipendente</option>{employees.map(employee=><option key={employee.id} value={employee.id}>{employee.name}</option>)}</select></label></div><div className="dialog-actions"><button type="button" onClick={()=>setEditing(null)}>Annulla</button><div className="action-spacer"/><button disabled={disabled} className="primary">Salva nota</button></div></form></dialog>}</>;
}

export function AbsencesView({data, requests=[], Icon}) {
  const [filters,setFilters]=useState({name:'',types:[],from:'',to:''});
  const allRows=[...absenceRows(data),...approvedPermissionRows(requests,data.employees)].sort((a,b)=>a.date.localeCompare(b.date)||a.employeeName.localeCompare(b.employeeName,'it'));
  const rows=filterAbsenceRows(allRows,filters),toggleType=type=>setFilters(current=>({...current,types:current.types.includes(type)?current.types.filter(item=>item!==type):[...current.types,type]}));
  function preset(name){const quick=quickFilter(name,new Date());setFilters({name:'',types:name==='permission'?['Permesso']:quick.shiftTypes.filter(type=>['Riposo','Malattia','Ferie'].includes(type)),from:quick.from,to:quick.to});}
  const active=!!(filters.name||filters.types.length||filters.from||filters.to);
  return <section className="content-panel"><div className="panel-heading"><div><p className="eyebrow">ASSENZE</p><h2>Panoramica assenze</h2><p>Questa vista riunisce Riposo, Malattia e Ferie dalla pianificazione con i Permessi approvati nelle Richieste.</p></div></div>
    <div className="absence-quick-filters"><button onClick={()=>preset('today')}>Oggi</button><button onClick={()=>preset('week')}>Questa settimana</button><button onClick={()=>preset('sick')}>Malattia</button><button onClick={()=>preset('vacation')}>Ferie</button><button onClick={()=>preset('permission')}>Permesso</button>{active&&<button className="clear-filters" onClick={()=>setFilters({name:'',types:[],from:'',to:''})}>Rimuovi tutti i filtri</button>}</div>
    <div className="absence-filters"><label>Cerca dipendente<input type="search" value={filters.name} placeholder="Nome dipendente" onChange={event=>setFilters(current=>({...current,name:event.target.value}))}/></label><label>Data iniziale<input type="date" value={filters.from} onChange={event=>setFilters(current=>({...current,from:event.target.value}))}/></label><label>Data finale<input type="date" value={filters.to} onChange={event=>setFilters(current=>({...current,to:event.target.value}))}/></label><fieldset><legend>Tipo</legend><div className="filter-checks">{['Riposo','Malattia','Ferie','Permesso'].map(type=><label className={filters.types.includes(type)?'selected':''} key={type}><input type="checkbox" checked={filters.types.includes(type)} onChange={()=>toggleType(type)}/>{type}</label>)}</div></fieldset></div>
    <div className="absence-table"><div className="absence-row absence-head"><span>Dipendente</span><span>Data</span><span>Tipo</span></div>{rows.map(row=><div className="absence-row" key={row.id||`${row.employeeId}|${row.date}|${row.type}`}><strong>{row.employeeName}</strong><span>{parseDate(row.date)?.toLocaleDateString('it-IT',{day:'numeric',month:'long',year:'numeric'})}</span><span className={`absence-badge type-${row.type.toLowerCase()}`}>{row.type}{row.time&&<small>{row.time}</small>}</span></div>)}</div>
    {!rows.length&&<div className="empty-state"><Icon name="absence"/><p>{active?'Nessun risultato per i filtri selezionati.':'Nessuna assenza registrata.'}</p>{active&&<button onClick={()=>setFilters({name:'',types:[],from:'',to:''})}>Rimuovi filtri</button>}</div>}
  </section>;
}

export function SettingsView({disabled,settings,data,onSave,branches=[],selectedBranchIds=[],branchPreferences={},onTemplateSort}) {
 const [branchId,setBranchId]=useState(()=>selectedBranchIds.length===1?selectedBranchIds[0]:branches[0]?.id||'');
 const [draft,setDraft]=useState(()=>structuredClone(settings)),[saved,setSaved]=useState(false);
 const current=branches.find(b=>b.id===branchId);
 async function submit(event){event.preventDefault();setSaved((await onSave(draft))!==false);}
 return <section className="content-panel settings-panel"><div className="panel-heading"><div><p className="eyebrow">IMPOSTAZIONI</p><h2>Turni predefiniti</h2><p>Il colore si aggiorna anche nei turni già pianificati, passati e futuri, della stessa Sede. Nome e orari già assegnati restano invariati.</p></div></div>
  {branches.length>1?<label>Sede dei turni predefiniti<select value={branchId} onChange={e=>{setBranchId(e.target.value);setSaved(false);}}>{branches.map(b=><option key={b.id} value={b.id}>{b.name}</option>)}</select></label>:<p>{current?`Sede: ${current.name}`:'Nessuna Sede disponibile.'}</p>}
  <form onSubmit={submit}><CustomPresetSettings key={branchId} disabled={disabled||!branchId} draft={draft} setDraft={setDraft} data={data} setSaved={setSaved} branchId={branchId} templateSort={branchPreferences[branchId]?.template_sort} onTemplateSort={sort=>onTemplateSort(branchId,sort)}/>
   <div className="settings-actions"><button disabled={disabled||!branchId} className="primary">Salva turni predefiniti</button></div>{saved&&<p className="save-confirmation" role="status">Turni predefiniti salvati.</p>}
  </form></section>;
}
