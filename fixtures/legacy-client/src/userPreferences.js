export const MIN_EMPLOYEE_COLUMN_WIDTH=140;
export const MAX_EMPLOYEE_COLUMN_WIDTH=320;
export const DEFAULT_EMPLOYEE_COLUMN_WIDTH=190;

export function clampEmployeeColumnWidth(value){
 const number=Number(value);
 if(!Number.isFinite(number))return DEFAULT_EMPLOYEE_COLUMN_WIDTH;
 return Math.min(MAX_EMPLOYEE_COLUMN_WIDTH,Math.max(MIN_EMPLOYEE_COLUMN_WIDTH,Math.round(number)));
}

export function normalizeEmployeeOrder(order,employees){
 const ids=employees.map(item=>item.id),available=new Set(ids),seen=new Set(),result=[];
 for(const id of Array.isArray(order)?order:[]){
  if(typeof id==='string'&&available.has(id)&&!seen.has(id)){seen.add(id);result.push(id);}
 }
 for(const id of ids)if(!seen.has(id))result.push(id);
 return result;
}

export function orderEmployees(employees,order){
 const byId=new Map(employees.map(item=>[item.id,item]));
 return normalizeEmployeeOrder(order,employees).map(id=>byId.get(id));
}

export function sortEmployeesAlphabetically(employees){
 const collator=new Intl.Collator('it',{sensitivity:'base',numeric:true});
 return employees.map((employee,index)=>({employee,index})).sort((left,right)=>
  collator.compare(left.employee.name,right.employee.name)||left.index-right.index
 ).map(item=>item.employee);
}

export function moveEmployee(order,employees,id,direction){
 const next=normalizeEmployeeOrder(order,employees),index=next.indexOf(id),target=index+direction;
 if(index<0||target<0||target>=next.length)return next;
 [next[index],next[target]]=[next[target],next[index]];
 return next;
}

export function moveEmployeeTo(order,employees,sourceId,targetId,position='before'){
 const normalized=normalizeEmployeeOrder(order,employees);
 if(sourceId===targetId||!normalized.includes(sourceId)||!normalized.includes(targetId))return normalized;
 const next=normalized.filter(id=>id!==sourceId),target=next.indexOf(targetId);
 next.splice(target+(position==='after'?1:0),0,sourceId);
 return next;
}

export function normalizeUserPreferences(value,employees=[]){
 return {
  employeeColumnWidth:clampEmployeeColumnWidth(value?.employee_column_width??value?.employeeColumnWidth),
  employeeOrder:normalizeEmployeeOrder(value?.employee_order??value?.employeeOrder,employees)
 };
}
