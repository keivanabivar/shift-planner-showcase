function equal(a,b){return JSON.stringify(a)===JSON.stringify(b)}
function mapBy(items,key='id'){return new Map(items.map((item,index)=>[item[key],{item,index}]))}

export function employeeBranchIds(employee){
 return [...new Set((Array.isArray(employee?.branchIds)&&employee.branchIds.length?employee.branchIds:[employee?.homeBranchId]).filter(Boolean))];
}

export function employeeBranchOptions(employee,branches){
 const allowed=new Set(employeeBranchIds(employee));
 return branches.filter(branch=>branch.active&&allowed.has(branch.id));
}

export function defaultShiftBranchId(employee,branches,selectedBranchIds=[],existingBranchId=''){
 const allowed=employeeBranchOptions(employee,branches);
 return existingBranchId||allowed.find(branch=>selectedBranchIds.includes(branch.id))?.id||allowed[0]?.id||'';
}

export function assertAuthorizedShiftBranches(data,previousData=null){
 const employees=new Map(data.employees.map(employee=>[employee.id,employee]));
 for(const [key,shift] of Object.entries(data.shifts)){
  if(previousData&&equal(previousData.shifts[key],shift))continue;
  const employee=employees.get(key.slice(0,-11));
  if(!employee||!employeeBranchIds(employee).includes(shift.branchId||employee.homeBranchId))
   throw Object.assign(Error('La Sede selezionata non è assegnata a questo dipendente.'),{userFacing:true});
 }
 return true;
}

export function branchOperations(previous,next,branchIds=[]){
 assertAuthorizedShiftBranches(next.data,previous.data);
 const operations=[];
 const beforeEmployees=mapBy(previous.data.employees),afterEmployees=mapBy(next.data.employees);
 for(const [id,{item,index}] of afterEmployees){
  const prior=beforeEmployees.get(id)?.item;
  if(!prior||prior.name!==item.name||prior.homeBranchId!==item.homeBranchId||beforeEmployees.get(id).index!==index)
   operations.push({kind:'employee_upsert',id,name:item.name,position:index,branchId:item.homeBranchId});
 }
 for(const [id,{item}] of beforeEmployees)if(!afterEmployees.has(id))operations.push({kind:'employee_delete',id,branchId:item.homeBranchId});

 const beforeShifts=previous.data.shifts,afterShifts=next.data.shifts;
 for(const [id,shift] of Object.entries(afterShifts))if(!equal(beforeShifts[id],shift)){
  const employeeId=id.slice(0,-11),date=id.slice(-10);
  operations.push({kind:'shift_upsert',id,employeeId,date,branchId:shift.branchId||afterEmployees.get(employeeId)?.item.homeBranchId,...shift});
 }
 for(const [id,shift] of Object.entries(beforeShifts))if(!afterShifts[id])operations.push({kind:'shift_delete',id,branchId:shift.branchId||beforeEmployees.get(id.slice(0,-11))?.item.homeBranchId});

 for(const [id,value] of Object.entries(next.variations))if(!equal(previous.variations[id],value))
  operations.push({kind:'variation_upsert',id,branchId:value.branchId||afterShifts[id]?.branchId,...value});
 for(const [id,value] of Object.entries(previous.variations))if(!next.variations[id])
  operations.push({kind:'variation_delete',id,branchId:value.branchId||beforeShifts[id]?.branchId});

 const beforeNotes=mapBy(previous.notes),afterNotes=mapBy(next.notes);
 for(const [id,{item}] of afterNotes)if(!equal(beforeNotes.get(id)?.item,item))operations.push({kind:'note_upsert',...item,branchId:item.branchId});
 for(const [id,{item}] of beforeNotes)if(!afterNotes.has(id))operations.push({kind:'note_delete',id,branchId:item.branchId});

 const beforeTemplates=mapBy(previous.settings.presets?.custom||[]),afterTemplates=mapBy(next.settings.presets?.custom||[]);
 for(const [id,{item}] of afterTemplates)if(!equal(beforeTemplates.get(id)?.item,item))operations.push({kind:'template_upsert',...item});
 for(const [id,{item}] of beforeTemplates)if(!afterTemplates.has(id))operations.push({kind:'template_delete',id,branchId:item.branchId});
 const metadata=value=>({...value,presets:{custom:[]}});
 if(!equal(metadata(previous.settings),metadata(next.settings)))throw Object.assign(Error('Le impostazioni di sistema non sono modificabili da questa schermata.'),{userFacing:true});
 if(operations.some(item=>!item.branchId))throw Object.assign(Error('Sede mancante: ricarica i dati prima di salvare.'),{userFacing:true});
 return operations;
}

export function visibleBranchIds(branches){return branches.filter(item=>item.active&&item.readable).map(item=>item.id)}

export function filterSnapshotByBranches(snapshot,selectedBranchIds){
 const selected=new Set(selectedBranchIds);
 if(!selected.size)return snapshot;
 const employees=snapshot.data.employees.filter(employee=>
  (employee.branchIds||[employee.homeBranchId]).some(id=>selected.has(id))
 );
 const ids=new Set(employees.map(item=>item.id));
 const shifts=Object.fromEntries(Object.entries(snapshot.data.shifts).filter(([key,shift])=>
  ids.has(key.slice(0,-11))&&selected.has(shift.branchId)
 ));
 const variations=Object.fromEntries(Object.entries(snapshot.variations).filter(([key])=>shifts[key]));
 const notes=snapshot.notes.filter(note=>!note.branchId||selected.has(note.branchId));
 return {...snapshot,settings:{...snapshot.settings,presets:{custom:(snapshot.settings.presets?.custom||[]).filter(p=>selected.has(p.branchId))}},data:{...snapshot.data,employees,shifts},variations,notes};
}

export function mergeScopedSnapshot(base,current,next){
 const currentEmployees=new Set(current.data.employees.map(item=>item.id));
 const currentShifts=new Set(Object.keys(current.data.shifts));
 const currentNotes=new Set(current.notes.map(item=>item.id));
 const currentVariations=new Set(Object.keys(current.variations));
 const nextEmployees=new Map(next.data.employees.map(item=>[item.id,item])),nextNotes=new Map(next.notes.map(item=>[item.id,item]));
 const employees=base.data.employees.flatMap(item=>currentEmployees.has(item.id)?nextEmployees.has(item.id)?[nextEmployees.get(item.id)]:[]:[item]);
 for(const item of next.data.employees)if(!base.data.employees.some(old=>old.id===item.id))employees.push(item);
 const notes=base.notes.flatMap(item=>currentNotes.has(item.id)?nextNotes.has(item.id)?[nextNotes.get(item.id)]:[]:[item]);
 for(const item of next.notes)if(!base.notes.some(old=>old.id===item.id))notes.push(item);
 return {data:{...base.data,employees,shifts:{...Object.fromEntries(Object.entries(base.data.shifts).filter(([id])=>!currentShifts.has(id))),...next.data.shifts}},notes,variations:{...Object.fromEntries(Object.entries(base.variations).filter(([id])=>!currentVariations.has(id))),...next.variations},settings:{...next.settings,presets:{custom:[...(base.settings.presets?.custom||[]).filter(p=>!(current.settings.presets?.custom||[]).some(c=>c.id===p.id)),...(next.settings.presets?.custom||[])]}}};
}

export function branchLabelForShift(shift,employee,branches,selectedBranchIds){
 if(!shift?.branchId)return '';
 const branch=branches.find(item=>item.id===shift.branchId);
 if(!branch)return '';
 if(selectedBranchIds.length>1)return branch.name;
 return selectedBranchIds.length===1&&shift.branchId!==selectedBranchIds[0]?branch.name:'';
}
