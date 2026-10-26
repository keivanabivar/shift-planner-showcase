export function branchActionVisibility(branch){
 return {
  rename:true,
  deactivate:branch.active,
  reactivate:!branch.active,
  delete:branch.can_delete===true,
  recovery:branch.active
 };
}

const blockerLabels={
 requests:'Richieste',cross_branch_requests:'Richieste tra sedi',memberships:'Amministratori e redattori',user_assignments:'Accessi operativi utenti',employee_assignments:'Assegnazioni dipendenti',
 shifts:'Turni',notes:'Note',invitations:'Inviti'
};
const historyLabels={requests:'Richieste concluse',cross_branch_requests:'Richieste tra sedi concluse',memberships:'Membership non attive',invitations:'Inviti conclusi o scaduti',audit_events:'Eventi audit'};

export function branchDeletionInfo(branch){
 const blockers=Object.entries(blockerLabels)
  .map(([key,label])=>({key,label,count:Number(branch.blocker_counts?.[key]||0)}))
  .filter(item=>item.count>0);
 const history=Object.entries(historyLabels)
  .map(([key,label])=>({key,label,count:Number(branch.history_counts?.[key]||0)}))
  .filter(item=>item.count>0);
 const reasons=[];
 if(blockers.length)reasons.push('Contiene dati operativi o assegnazioni attive da risolvere.');
 const qualifier=blockers.length?'blocchi attivi':'verifica necessaria';
 return {available:branch.can_delete===true,status:branch.can_delete===true?'Eliminazione disponibile':`Eliminazione non disponibile · ${qualifier}`,reasons,blockers,history,hasDetails:reasons.length>0||blockers.length>0||history.length>0};
}
