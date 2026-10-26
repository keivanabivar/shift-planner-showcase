import {filterSnapshotByBranches} from './branchPersistence.js';
import {shiftAbbreviation} from './timeline.js';

// The authorized snapshot supplies awareness only. It never broadens database
// read permissions. Export can explicitly include these authorized external shifts.
export function plannerAwareness(snapshot,selectedBranchIds){
 const scoped=filterSnapshotByBranches(snapshot,selectedBranchIds),ids=new Set(scoped.data.employees.map(e=>e.id));
 const shifts=Object.fromEntries(Object.entries(snapshot.data.shifts).filter(([key])=>ids.has(key.slice(0,-11))));
 return {data:{...scoped.data,shifts},variations:Object.fromEntries(Object.entries(snapshot.variations).filter(([key])=>shifts[key]))};
}
export function isForeignShift(shift,selectedBranchIds){
 return !!shift?.branchId&&selectedBranchIds.length===1&&shift.branchId!==selectedBranchIds[0];
}
export function protectedAssignment(shift,selectedBranchIds,targetBranchId){
 return !!shift&&(isForeignShift(shift,selectedBranchIds)||!!targetBranchId&&shift.branchId!==targetBranchId);
}
export function assertPlannerShiftSafety(previous,next,selectedBranchIds){
 for(const [key,shift] of Object.entries(previous.shifts)){
  const changed=JSON.stringify(shift)!==JSON.stringify(next.shifts[key]);
  if(changed&&(isForeignShift(shift,selectedBranchIds)||next.shifts[key]&&shift.branchId!==next.shifts[key].branchId))
   throw Error('Questo turno appartiene a un’altra Sede. Passa alla Sede del turno prima di modificarlo.');
 }
 return true;
}
export function branchMarker(shift,branches,compact=false){
 const name=branches.find(b=>b.id===shift?.branchId)?.name||'Altra Sede';
 return compact?shiftAbbreviation(name,branches.map(b=>b.name)):name;
}
