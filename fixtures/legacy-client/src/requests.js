export const REQUEST_STATUS_LABELS={pending:'In attesa',approved:'Approvata',rejected:'Rifiutata',cancelled:'Annullata',revoked:'Revocata'};
export const REQUEST_TYPES=['Ferie','Permesso','Cambio turno','Indisponibilità','Altro'];

export function visibleRequests(requests,account){
 if(account?.role!=='viewer')return requests;
 return requests.filter(item=>item.employee_id===account.employee_id||item.status==='pending');
}

export function canEditRequest(item,account){
 if(item.status!=='pending')return false;
 if(account?.role!=='viewer')return ['admin','editor'].includes(account?.role);
 return item.created_by_user_id===account.user_id&&item.employee_id===account.employee_id;
}

export function canCancelRequest(item,account){return canEditRequest(item,account);}
export function canRevokeRequest(item,account){return item.status==='approved'&&['admin','editor'].includes(account?.role);}

export function requestWasAdjusted(item){
 return !!item.adjusted||['type','start_date','end_date','start_time','end_time'].some(field=>item[`approved_${field}`]!=null&&item[`approved_${field}`]!==item[field]);
}

export function normalizeRequest(item){
 return {...item,start_time:item.start_time?.slice(0,5)||'',end_time:item.end_time?.slice(0,5)||'',approved_start_time:item.approved_start_time?.slice(0,5)||null,approved_end_time:item.approved_end_time?.slice(0,5)||null};
}
