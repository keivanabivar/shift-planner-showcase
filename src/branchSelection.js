export function branchSelectionKey(organizationId,userId){
 return `turni.branch-selection.v1:${organizationId}:${userId}`;
}

export function restoreBranchSelection(storage,organizationId,userId,readableIds){
 const allowed=[...new Set(readableIds)];
 if(!allowed.length)return [];
 try{
  const saved=JSON.parse(storage.getItem(branchSelectionKey(organizationId,userId))||'null');
  if(saved==='all')return allowed;
  if(typeof saved==='string'&&allowed.includes(saved))return [saved];
 }catch{}
 return allowed;
}

export function persistBranchSelection(storage,organizationId,userId,selectedIds,readableIds){
 const allowed=[...new Set(readableIds)],selected=[...new Set(selectedIds)].filter(id=>allowed.includes(id));
 const value=selected.length===allowed.length?'all':selected.length===1?selected[0]:'all';
 try{storage.setItem(branchSelectionKey(organizationId,userId),JSON.stringify(value));}catch{}
 return value==='all'?allowed:[value];
}
