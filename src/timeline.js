import {addDays,dateKey,parseDate} from './schedule.js';

export const MIN_VISIBLE_DAYS=7;
export const MAX_VISIBLE_DAYS=31;
export const TIMELINE_BUFFER_DAYS=31;

export function clampVisibleDays(value){
 const number=Math.round(Number(value)||MIN_VISIBLE_DAYS);
 return Math.max(MIN_VISIBLE_DAYS,Math.min(MAX_VISIBLE_DAYS,number));
}

export function startOfWeek(value){
 const date=parseDate(typeof value==='string'?value:dateKey(value));
 const weekday=date.getDay()||7;
 return addDays(date,1-weekday);
}

export function monthRange(value){
 const date=parseDate(typeof value==='string'?value:dateKey(value));
 const start=new Date(date.getFullYear(),date.getMonth(),1,12);
 const end=new Date(date.getFullYear(),date.getMonth()+1,0,12);
 return {start,days:end.getDate()};
}

export function timelineDays(start,visibleDays,buffer=TIMELINE_BUFFER_DAYS){
 return Array.from({length:visibleDays+buffer*2},(_,index)=>addDays(start,index-buffer));
}

export function densityForDays(days){
 if(days<=7)return 'comfortable';
 if(days<=14)return 'condensed';
 return 'compact';
}

const STATUS_ABBREVIATIONS={Riposo:'R',Malattia:'ML',Ferie:'F'};
const baseAbbreviation=type=>{
 if(STATUS_ABBREVIATIONS[type])return STATUS_ABBREVIATIONS[type];
 const words=String(type||'').normalize('NFC').trim().split(/\s+/u).filter(Boolean);
 return (words.length>1?words.map(w=>Array.from(w)[0]).join(''):Array.from(words[0]||'?')[0]).toLocaleUpperCase('it-IT');
};
export function shiftAbbreviation(type,allTypes=[]){
 const base=baseAbbreviation(type),peers=[...new Set([type,...allTypes])].filter(v=>baseAbbreviation(v)===base).sort();
 if(peers.length<2||STATUS_ABBREVIATIONS[type])return base;
 const work=peers.filter(v=>!STATUS_ABBREVIATIONS[v]);
 return `${base}${work.indexOf(type)+1}`;
}

export function zoomStartForAnchor(anchorDate,pointerContentX,newDayWidth){
 return addDays(anchorDate,-Math.max(0,Math.floor(pointerContentX/newDayWidth)));
}

export function zoomAnchorPosition({hover,now=Date.now(),rectLeft=0,viewportWidth,employeeWidth,totalWidth,maxAge=1500}){
 const center=(employeeWidth+viewportWidth-totalWidth)/2;
 if(!hover?.inside||!hover.date||!Number.isFinite(hover.clientX)||!Number.isFinite(hover.at)||now-hover.at<0||now-hover.at>maxAge)return {x:center,date:null,source:'center'};
 const x=hover.clientX-rectLeft;
 if(x<employeeWidth||x>viewportWidth-totalWidth)return {x:center,date:null,source:'center'};
 return {x,date:hover.date,source:'planner'};
}

export function isWeekend(date){return date.getDay()===0||date.getDay()===6;}
