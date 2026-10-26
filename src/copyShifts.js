import {addDays,dateKey,dateRange,makeShift,parseDate,shiftType} from './schedule.js';

export function copyShiftValue(shift,settings){
  if(!shift)return null;
  return {...shift}; // Copy the assigned snapshot, including its Sede.
}
export function canDragCopy(sourceEmployeeId,targetEmployeeId,sourceDate,targetDate){return !!sourceEmployeeId&&sourceEmployeeId===targetEmployeeId&&sourceDate!==targetDate;}
const employeeName=(data,id)=>data.employees.find(item=>item.id===id)?.name||'Dipendente non disponibile';
const entry=(data,employeeId,sourceDate,destinationDate,settings)=>{const shift=copyShiftValue(data.shifts[`${employeeId}|${sourceDate}`],settings);return shift?{employeeId,employeeName:employeeName(data,employeeId),sourceDate,destinationDate,shift}:null;};

export function buildDayCopy(data,employeeId,sourceDate,destinationDates,settings){
  return [...new Set(destinationDates)].map(destination=>entry(data,employeeId,sourceDate,destination,settings)).filter(Boolean);
}
export function buildRangeCopy(data,employeeId,sourceFrom,sourceTo,destinationStart,settings){
  const sourceDates=dateRange(sourceFrom,sourceTo),start=parseDate(destinationStart);
  if(!start)return [];
  return sourceDates.map((sourceDate,index)=>entry(data,employeeId,sourceDate,dateKey(addDays(start,index)),settings)).filter(Boolean);
}
export function buildRepeatCopy(data,employeeIds,sourceStart,repetitions,settings){
  const start=parseDate(sourceStart),count=Number(repetitions);
  if(!start||!Number.isInteger(count)||count<1)return [];
  const result=[];
  for(const employeeId of employeeIds)for(let repeat=1;repeat<=count;repeat++)for(let offset=0;offset<7;offset++){
    const sourceDate=dateKey(addDays(start,offset)),destinationDate=dateKey(addDays(start,repeat*7+offset));
    const item=entry(data,employeeId,sourceDate,destinationDate,settings);if(item)result.push(item);
  }
  return result;
}
export function copyConflicts(data,entries){return entries.filter(item=>Object.hasOwn(data.shifts,`${item.employeeId}|${item.destinationDate}`));}
export function applyShiftCopy(data,entries,mode='empty'){
  const shifts={...data.shifts};
  for(const item of entries){const key=`${item.employeeId}|${item.destinationDate}`;if(mode==='replace'||!Object.hasOwn(shifts,key))shifts[key]={...item.shift};}
  return {...data,shifts};
}
