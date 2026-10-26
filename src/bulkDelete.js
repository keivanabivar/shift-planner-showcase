import {parseDate,shiftType} from './schedule.js';

export function buildBulkDeletePlan(data,employeeIds,from,to,types=[],branchId){
  if(typeof branchId!=='string'||!branchId)return [];
  if(!parseDate(from)||!parseDate(to)||parseDate(from)>parseDate(to))return [];
  const employees=new Set(employeeIds),selectedTypes=new Set(types),allTypes=!types.length;
  return Object.entries(data.shifts).flatMap(([key,shift])=>{
    const separator=key.lastIndexOf('|'),employeeId=key.slice(0,separator),date=key.slice(separator+1),type=shiftType(shift);
    if(shift.branchId!==branchId||!employees.has(employeeId)||date<from||date>to||!allTypes&&!selectedTypes.has(type))return [];
    return [{key,branchId,employeeId,employeeName:data.employees.find(item=>item.id===employeeId)?.name||'Dipendente non disponibile',date,type}];
  }).sort((a,b)=>a.date.localeCompare(b.date)||a.employeeName.localeCompare(b.employeeName,'it'));
}

export function applyBulkDelete(snapshot,plan,branchId){
  if(!branchId||!Array.isArray(plan)||new Set(plan.map(item=>item.key)).size!==plan.length||plan.some(item=>item.branchId!==branchId||snapshot.data.shifts[item.key]?.branchId!==branchId))throw Error('Seleziona una sola Sede e aggiorna l’anteprima prima di eliminare i turni.');
  const keys=new Set(plan.map(item=>item.key)),shifts={...snapshot.data.shifts},variations={...snapshot.variations};
  for(const key of keys){delete shifts[key];delete variations[key];}
  return {...snapshot,data:{...snapshot.data,shifts},variations};
}

export function bulkDeleteBranch(branches,selectedBranchIds){
  return selectedBranchIds.length===1?branches.find(branch=>branch.id===selectedBranchIds[0]&&branch.active&&branch.readable&&branch.operable)||null:null;
}
export function bulkDeleteConfirmation(count,branchName){
  return `Stai per eliminare ${count} ${count===1?'turno':'turni'} dalla Sede ${branchName}.`;
}
