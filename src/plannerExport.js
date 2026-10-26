import {hours,minutes,parseDate,reportWeeks} from './schedule.js';
export function exportData(data,awarenessData,includeOtherSedi){
 const ids=new Set(data.employees.map(e=>e.id));
 return {...data,shifts:includeOtherSedi?Object.fromEntries(Object.entries(awarenessData.shifts).filter(([key])=>ids.has(key.slice(0,-11)))):data.shifts};
}
export function sedeTotals(data,employeeId,dates,branches=[]){
 const totals=new Map();
 for(const date of dates){const shift=data.shifts[`${employeeId}|${date}`];if(!shift)continue;const value=minutes(shift);if(value)totals.set(shift.branchId,(totals.get(shift.branchId)||0)+value);}
 const sum=[...totals.values()].reduce((a,b)=>a+b,0);
 if(!totals.size||!branches.length)return hours(sum);
 const lines=[...totals].map(([id,value])=>`${hours(value)} · ${branches.find(b=>b.id===id)?.name||'Altra Sede'}`);
 if(totals.size>1)lines.push(`${hours(sum)} · Totale`);
 return lines.join('\n');
}
export function exportWeeks(data,employeeId,first,last,variations,settings,branches,selectedBranchIds){
 const employees=employeeId?data.employees.filter(e=>e.id===employeeId):data.employees;
 return reportWeeks(data,employeeId,first,last,variations,settings).map(week=>({...week,rows:week.rows.map((row,index)=>{
  const employee=employees[index];return {...row,total:sedeTotals(data,employee.id,week.dates,branches),branchNames:week.dates.map(date=>{
   const shift=data.shifts[`${employee.id}|${date}`];return shift&&(selectedBranchIds.length>1||!selectedBranchIds.includes(shift.branchId))?branches.find(b=>b.id===shift.branchId)?.name||'Altra Sede':'';
  })};
 })}));
}
export function scheduleFilename(mode,first,last){
 const date=parseDate(first),end=parseDate(last);
 const fullMonth=date&&end&&date.getDate()===1&&date.getMonth()===end.getMonth()&&date.getFullYear()===end.getFullYear()&&end.getDate()===new Date(date.getFullYear(),date.getMonth()+1,0).getDate();
 return mode==='monthly'||fullMonth?`turni_mensile_${date.toLocaleDateString('it-IT',{month:'long'})}_${date.getFullYear()}.pdf`:`turni_${first}_${last}.pdf`;
}
