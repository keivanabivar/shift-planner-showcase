import React,{useEffect,useLayoutEffect,useRef,useState} from 'react';
import {MOBILE_PLANNER_QUERY,PAN_THRESHOLD,anchoredScroll,clampSheetScale,fitSheetScale,sheetMetrics,touchPair} from './plannerSheet';
import {addDays,dateKey} from './schedule';
import {clampVisibleDays,startOfWeek} from './timeline';

export function useMobilePlannerViewport(){
 const [mobile,setMobile]=useState(()=>window.matchMedia(MOBILE_PLANNER_QUERY).matches);
 useEffect(()=>{const query=window.matchMedia(MOBILE_PLANNER_QUERY),change=()=>setMobile(query.matches);query.addEventListener('change',change);change();return()=>query.removeEventListener('change',change);},[]);
 return mobile;
}

// Only the sheet dimensions change. Frozen initials and totals retain their widths.
export function useMobileSheet({active,scrollRef,width,days,week,suppressClick}){
 const [scale,setScale]=useState(1),fitted=useRef(true),points=useRef(new Map()),gesture=useRef(null),pending=useRef(null),releaseTimer=useRef(null),wasActive=useRef(false);
 const metrics=sheetMetrics(scale);
 function reset(){fitted.current=true;pending.current={left:0,top:0};if(scrollRef.current){scrollRef.current.scrollLeft=0;scrollRef.current.scrollTop=0;}setScale(fitSheetScale(width,days));}
 useLayoutEffect(()=>{
  if(active)reset();
  if(active||wasActive.current){points.current.clear();gesture.current=null;suppressClick.current=false;clearTimeout(releaseTimer.current);}
  wasActive.current=active;
 },[active,days,dateKey(week)]);
 useLayoutEffect(()=>{if(active&&fitted.current)setScale(fitSheetScale(width,days));},[active,width,days]);
 useLayoutEffect(()=>{if(active&&pending.current&&scrollRef.current){scrollRef.current.scrollLeft=pending.current.left;scrollRef.current.scrollTop=pending.current.top;pending.current=null;}},[active,scale]);
 useEffect(()=>()=>clearTimeout(releaseTimer.current),[]);
 function zoom(next){
  const node=scrollRef.current;if(!node)return;
  const value=clampSheetScale(next),nextMetrics=sheetMetrics(value),anchor=(node.clientWidth-metrics.employeeWidth-metrics.totalWidth)/2;
  fitted.current=false;pending.current={left:anchoredScroll(node.scrollLeft,anchor,metrics.dayWidth,nextMetrics.dayWidth),top:anchoredScroll(node.scrollTop,node.clientHeight/2,metrics.rowHeight,nextMetrics.rowHeight)};setScale(value);
 }
 function down(event){
  if(!active||event.pointerType!=='touch')return false;
  clearTimeout(releaseTimer.current);
  if(!points.current.size){suppressClick.current=false;gesture.current={type:'pan',x:event.clientX,y:event.clientY,left:scrollRef.current.scrollLeft,top:scrollRef.current.scrollTop,moved:false};}
  points.current.set(event.pointerId,{x:event.clientX,y:event.clientY});
  if(points.current.size===2){
   const node=scrollRef.current,rect=node.getBoundingClientRect(),pair=touchPair([...points.current.values()]);
   gesture.current={type:'pinch',pair,scale,left:node.scrollLeft,top:node.scrollTop,x:Math.max(0,pair.x-rect.left-metrics.employeeWidth),y:pair.y-rect.top,metrics};
   suppressClick.current=true;fitted.current=false;
  }
  return true;
 }
 function move(event){
  if(!active||event.pointerType!=='touch')return false;
  if(!points.current.has(event.pointerId))return true;
  points.current.set(event.pointerId,{x:event.clientX,y:event.clientY});
  const state=gesture.current,node=scrollRef.current;if(!state)return true;
  if(state.type==='pinch'){
   if(points.current.size!==2)return true;
   const pair=touchPair([...points.current.values()]),value=clampSheetScale(state.scale*pair.distance/state.pair.distance),next=sheetMetrics(value);
   pending.current={left:anchoredScroll(state.left,state.x,state.metrics.dayWidth,next.dayWidth)-(pair.x-state.pair.x),top:anchoredScroll(state.top,state.y,state.metrics.rowHeight,next.rowHeight)-(pair.y-state.pair.y)};
   if(value===scale){node.scrollLeft=pending.current.left;node.scrollTop=pending.current.top;pending.current=null;}
   setScale(value);
  }else{
   const dx=event.clientX-state.x,dy=event.clientY-state.y;
   if(!state.moved&&Math.hypot(dx,dy)<PAN_THRESHOLD)return true;
   state.moved=true;suppressClick.current=true;node.scrollLeft=state.left-dx;node.scrollTop=state.top-dy;
  }
  event.preventDefault();node.setPointerCapture(event.pointerId);return true;
 }
 function up(event){
  if(!active||event.pointerType!=='touch')return false;
  const node=scrollRef.current;points.current.delete(event.pointerId);
  if(event.type==='pointercancel')suppressClick.current=true;
  if(node?.hasPointerCapture(event.pointerId))node.releasePointerCapture(event.pointerId);
  if(!points.current.size){gesture.current=null;releaseTimer.current=setTimeout(()=>{suppressClick.current=false},350);}
  return true;
 }
 return {scale,metrics,reset,zoom,down,move,up};
}

export function MobilePlannerControls({onExit,week,setWeek,visibleDays,setVisibleDays,branches,selectedBranchIds,onSelectBranches,scale,onZoom,onFit,modalOpen,onUndo,canUndo=false}){
 const [open,setOpen]=useState(true),[activity,setActivity]=useState(0),zone=useRef(null),bar=useRef(null),revealStart=useRef(null);
 const readableBranches=branches.filter(branch=>branch.active&&branch.readable);
 useEffect(()=>{
  if(!open||modalOpen)return;
  const timer=setTimeout(()=>{if(bar.current?.contains(document.activeElement))return;setOpen(false);},6000);
  return()=>clearTimeout(timer);
 },[open,modalOpen,activity]);
 useEffect(()=>{
  const previousOverflow=document.body.style.overflow;document.body.style.overflow='hidden';
  const escape=event=>{if(event.key==='Escape'&&!document.querySelector('dialog[open]')){if(open){setOpen(false);zone.current?.focus();}else onExit();}};
  window.addEventListener('keydown',escape);return()=>{document.body.style.overflow=previousOverflow;window.removeEventListener('keydown',escape);};
 },[onExit,open]);
 function dismiss(){setOpen(false);zone.current?.focus();}
 return <>
  <div className="mobile-planner-edge">
   <button ref={zone} className="mobile-reveal-zone" aria-label="Mostra controlli pianificazione: scorri verso il basso" aria-expanded={open} aria-controls="mobile-planner-controls" onClick={()=>{setOpen(true);setActivity(value=>value+1)}} onPointerDown={event=>{revealStart.current={id:event.pointerId,y:event.clientY};event.currentTarget.setPointerCapture(event.pointerId)}} onPointerMove={event=>{if(revealStart.current?.id===event.pointerId&&event.clientY-revealStart.current.y>18){setOpen(true);setActivity(value=>value+1)}}} onPointerUp={()=>{revealStart.current=null}} onPointerCancel={()=>{revealStart.current=null}}><span/></button>
   <button className="mobile-immersive-exit" aria-label="Esci dalla tabella a schermo intero" onClick={onExit}>×</button>
  </div>
  {open&&<div id="mobile-planner-controls" ref={bar} className="mobile-planner-controls" role="region" aria-label="Controlli pianificazione" onPointerDown={()=>setActivity(value=>value+1)} onKeyDown={()=>setActivity(value=>value+1)} onFocus={()=>setActivity(value=>value+1)} onBlur={()=>setActivity(value=>value+1)}>
   <div className="mobile-control-navigation">
    <button aria-label="Esci dalla tabella" title="Esci dalla tabella" onClick={onExit}>×</button>
    <button aria-label="Intervallo precedente" onClick={()=>setWeek(addDays(week,-visibleDays))}>‹</button>
    <button onClick={()=>setWeek(startOfWeek(new Date()))}>Oggi</button>
    <button aria-label="Intervallo successivo" onClick={()=>setWeek(addDays(week,visibleDays))}>›</button>
    <select aria-label="Giorni nella tabella mobile" title="Giorni visibili" value={visibleDays} onChange={event=>setVisibleDays(clampVisibleDays(event.target.value))}>{Array.from({length:25},(_,index)=>index+7).map(days=><option key={days}>{days}</option>)}</select>
    <button onClick={onFit}>Adatta</button>
    <button onClick={dismiss} aria-label="Nascondi controlli pianificazione" title="Nascondi controlli">⌃</button>
   </div>
   <div className="mobile-control-zoom"><button aria-label="Riduci zoom tabella" onClick={()=>onZoom(scale/1.35)}>−</button><output aria-label="Zoom tabella">{Math.round(scale*100)}%</output><button aria-label="Aumenta zoom tabella" onClick={()=>onZoom(scale*1.35)}>+</button></div>
   {onUndo&&<button disabled={!canUndo} onClick={onUndo} title="Annulla ultima modifica del Planner">Annulla</button>}
   {readableBranches.length>1&&<select className="mobile-control-branch" aria-label="Sede" title="Sede" value={selectedBranchIds.length===readableBranches.length?'all':selectedBranchIds[0]||'all'} onChange={event=>onSelectBranches(event.target.value==='all'?readableBranches.map(branch=>branch.id):[event.target.value])}><option value="all">Tutte le sedi</option>{readableBranches.map(branch=><option key={branch.id} value={branch.id}>{branch.name}</option>)}</select>}
  </div>}
 </>;
}
