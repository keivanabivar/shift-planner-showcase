import {dateRange} from './schedule.js';

const key=(employeeId,date)=>`${employeeId}|${date}`;

export function selectedRangeDates(range,clickedDate){
 return range&&clickedDate>=range.start&&clickedDate<=range.end?dateRange(range.start,range.end):[clickedDate];
}

export function assignmentConflicts(data,employeeId,dates,entry){
 return dates.filter(date=>{
  const existing=data.shifts[key(employeeId,date)];
  return existing&&JSON.stringify(existing)!==JSON.stringify(entry);
 });
}

export function applyBulkAssignment(data,employeeId,dates,entry){
 if(!data.employees.some(item=>item.id===employeeId)||!entry)return data;
 const shifts={...data.shifts};
 for(const date of [...new Set(dates)])shifts[key(employeeId,date)]={...entry};
 return {...data,shifts};
}

export function bulkDeletionTargets(data,employeeId,dates){
 return [...new Set(dates)].filter(date=>data.shifts[key(employeeId,date)]);
}

export function applyBulkDeletion(data,employeeId,dates){
 const shifts={...data.shifts};
 for(const date of [...new Set(dates)])delete shifts[key(employeeId,date)];
 return {...data,shifts};
}
