const searchText=value=>String(value||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLocaleLowerCase('it-IT').trim();

export function employeeAssignmentGroups(employees,branches,query='',branchId='all'){
 const words=searchText(query).split(/\s+/).filter(Boolean),collator=new Intl.Collator('it',{sensitivity:'base',numeric:true});
 const matching=employees.filter(employee=>words.every(word=>searchText(employee.employee_name).includes(word)))
  .sort((a,b)=>collator.compare(a.employee_name,b.employee_name)||a.employee_id.localeCompare(b.employee_id));
 const groups=branches.filter(branch=>branchId==='all'||branch.id===branchId).map(branch=>({
  id:branch.id,name:branch.name+(branch.active?'':' (disattivata)'),employees:matching.filter(employee=>employee.branch_ids?.includes(branch.id))
 }));
 if(branchId==='all'){
  const known=new Set(branches.map(branch=>branch.id));
  const unassigned=matching.filter(employee=>!employee.branch_ids?.some(id=>known.has(id)));
  if(unassigned.length)groups.push({id:'unavailable',name:'Sede non disponibile',employees:unassigned});
 }
 return groups.filter(group=>group.employees.length);
}
