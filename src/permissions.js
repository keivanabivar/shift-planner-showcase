export const NAV_ITEMS=[
 ['planning','calendar','Pianificazione'],
 ['employees','people','Dipendenti'],
 ['notes','note','Note'],
 ['requests','note','Richieste'],
 ['absences','absence','Assenze'],
 ['hours','report','Report ore'],
 ['archive','archive','Archivio'],
 ['branches','people','Sedi'],
 ['access','people','Utenti e accessi'],
 ['invite','people','Invita utente'],
 ['backup','archive','Backup dei dati'],
 ['settings','settings','Impostazioni'],
 ['account','people','Account']
];
export function navigationForRole(role){
 if(role==='viewer')return NAV_ITEMS.filter(([id])=>['planning','archive','employees','notes','requests','hours','account'].includes(id));
 return NAV_ITEMS.filter(([id])=>!['access','invite','branches'].includes(id)||role==='admin');
}

export function reportEmployeeIds(account,employees){
 if(account?.role!=='viewer')return employees.map(item=>item.id);
 return account.employee_id&&employees.some(item=>item.id===account.employee_id)?[account.employee_id]:[];
}

export const plannerCanWrite=(role,status)=>['admin','editor'].includes(role)&&['local','connected'].includes(status);
