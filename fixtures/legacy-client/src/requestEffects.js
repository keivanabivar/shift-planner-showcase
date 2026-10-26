import {dateRange,isAbsence,minutes,shiftType} from './schedule.js';

const clockMinutes=value=>{if(!value)return 0;const [h,m]=value.slice(0,5).split(':').map(Number);return h*60+m;};

export function requestApprovedValue(request,field){
 return request?.[`approved_${field}`]??request?.[field];
}

export function approvedPermissionMinutes(request){
 if(request?.status!=='approved'||requestApprovedValue(request,'type')!=='Permesso')return 0;
 const start=clockMinutes(requestApprovedValue(request,'start_time')),end=clockMinutes(requestApprovedValue(request,'end_time'));
 if(!requestApprovedValue(request,'start_time')||!requestApprovedValue(request,'end_time')||start===end)return 0;
 return (end-start+1440)%1440;
}

function clockSegments(startValue,endValue){
 const start=clockMinutes(startValue),end=clockMinutes(endValue);
 if(!startValue||!endValue||start===end)return [];
 return end>start?[[start,end]]:[[start,1440],[0,end]];
}

function mergedMinutes(segments){
 const ordered=segments.filter(([start,end])=>end>start).sort((a,b)=>a[0]-b[0]||a[1]-b[1]);
 let total=0,current=null;
 for(const segment of ordered){
  if(!current){current=[...segment];continue;}
  if(segment[0]<=current[1])current[1]=Math.max(current[1],segment[1]);
  else{total+=current[1]-current[0];current=[...segment];}
 }
 return total+(current?current[1]-current[0]:0);
}

export function permissionShiftOverlap(shift,startTime,endTime){
 if(!shift||isAbsence(shiftType(shift)))return 0;
 const shiftSegments=clockSegments(shift.start,shift.end),permissionSegments=clockSegments(startTime,endTime),overlaps=[];
 for(const [shiftStart,shiftEnd] of shiftSegments)for(const [permissionStart,permissionEnd] of permissionSegments){
  const start=Math.max(shiftStart,permissionStart),end=Math.min(shiftEnd,permissionEnd);
  if(end>start)overlaps.push([start,end]);
 }
 return mergedMinutes(overlaps);
}

export function approvedRequestEffects(requests=[],shifts={}){
 const ranges={};
 for(const request of requests){
  if(!approvedPermissionMinutes(request))continue;
  for(const date of dateRange(requestApprovedValue(request,'start_date'),requestApprovedValue(request,'end_date'))){
   const key=`${request.employee_id}|${date}`,shift=shifts[key];
   if(!shift)continue;
   const minutes=permissionShiftOverlap(shift,requestApprovedValue(request,'start_time'),requestApprovedValue(request,'end_time'));
   if(!minutes)continue;
   const current=ranges[key]||{segments:[],requests:[]};
   for(const [shiftStart,shiftEnd] of clockSegments(shift.start,shift.end))for(const [permissionStart,permissionEnd] of clockSegments(requestApprovedValue(request,'start_time'),requestApprovedValue(request,'end_time'))){
    const start=Math.max(shiftStart,permissionStart),end=Math.min(shiftEnd,permissionEnd);if(end>start)current.segments.push([start,end]);
   }
   current.requests.push(request);ranges[key]=current;
  }
 }
 return Object.fromEntries(Object.entries(ranges).map(([key,value])=>[key,{minutes:mergedMinutes(value.segments),requests:value.requests}]));
}

export function approvedPermissionRows(requests=[],employees=[]){
 const names=new Map(employees.map(employee=>[employee.id,employee.name])),rows=[];
 for(const request of requests){
  if(request?.status!=='approved'||requestApprovedValue(request,'type')!=='Permesso')continue;
  const employeeName=names.get(request.employee_id)||request.employee_name;
  if(!employeeName)continue;
  const startTime=requestApprovedValue(request,'start_time')?.slice(0,5)||'',endTime=requestApprovedValue(request,'end_time')?.slice(0,5)||'';
  for(const date of dateRange(requestApprovedValue(request,'start_date'),requestApprovedValue(request,'end_date'))){
   rows.push({id:`${request.id}|${date}`,employeeId:request.employee_id,employeeName,date,type:'Permesso',time:startTime&&endTime?`${startTime}–${endTime}`:''});
  }
 }
 return rows.sort((a,b)=>a.date.localeCompare(b.date)||a.employeeName.localeCompare(b.employeeName,'it'));
}

export function dayAccounting(shift,variation,effect){
 const scheduled=minutes(shift),permission=Math.min(scheduled,effect?.minutes||0);
 const baseActual=variation?minutes(variation):scheduled;
 return {scheduled,permission,actual:Math.max(0,baseActual-permission)};
}
