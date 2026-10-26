import {dateKey,shiftType} from './schedule.js';

export const EMPTY_SCHEDULE_FILTERS={name:'',shiftTypes:[],variation:'all',reasons:[],from:'',to:''};
export const VARIATION_FILTERS=[['all','Tutti'],['with','Con variazione'],['without','Senza variazione']];

export function cleanSearch(value=''){
  return value.trim().toLocaleLowerCase('it').normalize('NFD').replace(/[\u0300-\u036f]/g,'');
}
export function hasEntryFilters(filters){return !!(filters.shiftTypes.length||filters.variation!=='all'||filters.reasons.length||filters.from||filters.to);}
export function hasScheduleFilters(filters){return !!cleanSearch(filters.name)||hasEntryFilters(filters);}
export function dateMatches(date,filters){return !(filters.from&&date<filters.from||filters.to&&date>filters.to);}
export function entryMatches(shift,variation,date,filters){
  if(!dateMatches(date,filters))return false;
  if(filters.shiftTypes.length&&!filters.shiftTypes.includes(shiftType(shift)))return false;
  if(filters.variation==='with'&&!variation||filters.variation==='without'&&!!variation)return false;
  if(filters.reasons.length&&!filters.reasons.includes(variation?.reason))return false;
  return !!shift||(!filters.shiftTypes.length&&filters.variation==='all'&&!filters.reasons.length);
}
export function filterSchedule(data,variations,filters,visibleDates=null,employeeIds=null){
  const query=cleanSearch(filters.name),selected=employeeIds?new Set(employeeIds):null;
  const dates=visibleDates?.map(value=>typeof value==='string'?value:dateKey(value)) || [...new Set(Object.keys(data.shifts).map(key=>key.slice(key.indexOf('|')+1)))].filter(date=>dateMatches(date,filters));
  const restrictEntries=hasEntryFilters(filters),visibleKeys=new Set();
  const employees=data.employees.filter(employee=>{
    if(selected&&!selected.has(employee.id)||query&&!cleanSearch(employee.name).includes(query))return false;
    if(!restrictEntries)return true;
    let found=false;
    for(const date of dates){const key=`${employee.id}|${date}`;if(entryMatches(data.shifts[key],variations[key],date,filters)){visibleKeys.add(key);found=true;}}
    return found;
  });
  if(!restrictEntries)for(const employee of employees)for(const date of dates)visibleKeys.add(`${employee.id}|${date}`);
  return {employees,visibleKeys,active:hasScheduleFilters(filters)};
}
export function quickFilter(name,today){
  const key=dateKey(today),day=today.getDay(),monday=new Date(today);monday.setDate(today.getDate()-(day+6)%7);monday.setHours(12,0,0,0);const sunday=new Date(monday);sunday.setDate(monday.getDate()+6);
  if(name==='today')return {...EMPTY_SCHEDULE_FILTERS,from:key,to:key};
  if(name==='week')return {...EMPTY_SCHEDULE_FILTERS,from:dateKey(monday),to:dateKey(sunday)};
  if(name==='sick')return {...EMPTY_SCHEDULE_FILTERS,shiftTypes:['Malattia']};
  if(name==='vacation')return {...EMPTY_SCHEDULE_FILTERS,shiftTypes:['Ferie']};
  if(name==='variations')return {...EMPTY_SCHEDULE_FILTERS,variation:'with'};
  return {...EMPTY_SCHEDULE_FILTERS};
}
export function filterAbsenceRows(rows,{name='',types=[],from='',to=''}){
  const query=cleanSearch(name);
  return rows.filter(row=>(!query||cleanSearch(row.employeeName).includes(query))&&(!types.length||types.includes(row.type))&&(!from||row.date>=from)&&(!to||row.date<=to));
}
