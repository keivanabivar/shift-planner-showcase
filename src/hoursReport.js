import {dateRange,hours,isAbsence,minutes,parseDate,shiftType} from './schedule.js';
import {actualMinutes,variationReason} from './attendance.js';
import {dayAccounting} from './requestEffects.js';

export function signedHours(value){if(!value)return '0 h';return `${value>0?'+':'−'}${hours(Math.abs(value))}`;}
export function buildHoursReport(data,variations,employeeIds,from,to,requestEffects={}){
  const dates=dateRange(from,to),selected=new Set(employeeIds),employees=data.employees.filter(employee=>selected.has(employee.id));
  return employees.map(employee=>{
    const row={employeeId:employee.id,name:employee.name,planned:0,actual:0,difference:0,late:0,early:0,leave:0,leaveMinutes:0,sick:0,vacation:0,days:[]};
    for(const date of dates){const key=`${employee.id}|${date}`,shift=data.shifts[key],variation=variations[key],type=shiftType(shift),absence=isAbsence(type),accounting=dayAccounting(shift,variation,requestEffects[key]),planned=accounting.scheduled,actual=accounting.actual;row.planned+=planned;row.actual+=actual;row.leaveMinutes+=accounting.permission;if(variation?.reason==='Ritardo')row.late++;if(variation?.reason==='Uscita anticipata')row.early++;if(variation?.reason==='Permesso'||accounting.permission)row.leave++;if(type==='Malattia')row.sick++;if(type==='Ferie')row.vacation++;
      row.days.push({date,type:type||'Non assegnato',plannedTime:shift&&!absence?`${shift.start} – ${shift.end}`:'—',actualTime:shift?(absence?type:(variation?`${variation.start} – ${variation.end}`:`${shift.start} – ${shift.end}`)):'—',planned,...(accounting.permission?{permission:accounting.permission}:{}),actual,difference:actual-planned,reason:accounting.permission?`Permesso approvato (${hours(accounting.permission)})`:variation?`${variationReason(variation)}${variation.note?` – ${variation.note}`:''}`:'—'});
    }
    row.difference=row.actual-row.planned;return row;
  });
}
export function reportDateLabel(value){return parseDate(value)?.toLocaleDateString('it-IT',{day:'2-digit',month:'2-digit',year:'numeric'})||value;}
