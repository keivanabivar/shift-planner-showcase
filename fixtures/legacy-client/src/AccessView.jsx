import React,{useEffect,useState} from 'react';
import {employeeAssignmentGroups} from './employeeAssignmentGroups';
import {buildInviteLink,memberChangeConfirmation,ROLE_LABELS} from './accessActions';

function employeeName(employees,id){
  return employees.find(item=>item.id===id)?.name||'Nessun dipendente';
}

function BranchChecks({branches,value,onChange,disabled,label}){
 const active=branches.filter(item=>item.active&&item.admin),selected=new Set(value||[]);
 return <fieldset className="branch-checks" disabled={disabled}><legend>{label}</legend>{active.map(branch=><label key={branch.id}><input type="checkbox" checked={selected.has(branch.id)} onChange={event=>onChange(event.target.checked?[...selected,branch.id]:[...selected].filter(id=>id!==branch.id))}/><span>{branch.name}</span></label>)}</fieldset>;
}

export default function AccessView({repository,employees,branches=[],account}){
  const assignmentBranches=account.organization_role==='owner'?branches.map(branch=>({...branch,admin:true})):branches;
  const [employeeSearch,setEmployeeSearch]=useState(''),[employeeBranchFilter,setEmployeeBranchFilter]=useState('all');
  const [members,setMembers]=useState([]);
  const [invitations,setInvitations]=useState([]);
  const [employeeAssignments,setEmployeeAssignments]=useState([]);
  const [loading,setLoading]=useState(true);
  const [busy,setBusy]=useState('');
  const [error,setError]=useState('');
  const [message,setMessage]=useState('');

  const [email,setEmail]=useState('');
  const [role,setRole]=useState('viewer');
  const [employeeId,setEmployeeId]=useState('');
  const [branchId,setBranchId]=useState(''),[visibility,setVisibility]=useState('all_branches');
  const [createdInvite,setCreatedInvite]=useState(null);
  const [copyStatus,setCopyStatus]=useState('');

  async function load(){
    setLoading(true);
    setError('');
    try{
      const [nextMembers,nextInvitations,nextAssignments]=await Promise.all([
        repository.members(),
        repository.invitations(),
        repository.employeeAssignments()
      ]);
      setMembers(nextMembers);
      setInvitations(nextInvitations);
      setEmployeeAssignments(nextAssignments);
    }catch(error){
      setError(error.message||'Impossibile caricare gli accessi.');
    }finally{
      setLoading(false);
    }
  }

  useEffect(()=>{load();},[]);
  useEffect(()=>{if(!branchId){const first=assignmentBranches.find(item=>item.active&&item.admin);if(first)setBranchId(first.id)}},[branches,branchId]);

  async function updateMember(member,patch){
    const confirmation=memberChangeConfirmation(member,patch);
    if(confirmation&&!window.confirm(confirmation))return false;
    setBusy(member.user_id);
    setError('');
    setMessage('');

    try{
      await repository.updateMember({
        userId:member.user_id,
        role:patch.role??member.role,
        employeeId:patch.employeeId!==undefined?patch.employeeId:member.employee_id,
        branchIds:patch.branchIds??member.branch_ids??[],
        visibility:patch.visibility??member.visibility_level??'all_branches',
        isActive:patch.isActive!==undefined?patch.isActive:member.is_active
      });

      await load();
      setMessage('Accesso aggiornato.');
      return true;
    }catch(error){
      setError(error.message||'Modifica non riuscita.');
      return false;
    }finally{
      setBusy('');
    }
  }

  async function updateEmployeeBranches(employee,branchIds){
    if(!branchIds.length){setError('Assegna almeno una Sede.');return}
    setBusy(`employee:${employee.employee_id}`);setError('');setMessage('');
    try{await repository.updateEmployeeAssignments(employee.employee_id,branchIds);await load();setMessage('Sedi del dipendente aggiornate.')}catch(error){setError(error.message||'Modifica non riuscita.')}finally{setBusy('')}
  }

  async function createInvite(event){
    event.preventDefault();
    setBusy('invite');
    setError('');
    setMessage('');
    setCreatedInvite(null);
    setCopyStatus('');

    try{
      const result=await repository.createInvitation({
        email:email.trim(),
        role,
        employeeId:employeeId||null,branchId:branchId||assignmentBranches.find(item=>item.active&&item.admin)?.id||null,visibility
      });

      setCreatedInvite(result);
      setEmail('');
      setRole('viewer');
      setEmployeeId('');
      await load();
    }catch(error){
      setError(error.message||'Invito non creato.');
    }finally{
      setBusy('');
    }
  }

  async function copyInviteLink(){
    try{
      await navigator.clipboard.writeText(buildInviteLink(createdInvite.token));
      setCopyStatus('Link invito copiato.');
    }catch{
      setCopyStatus('Impossibile copiare il link. Selezionalo e copialo manualmente.');
    }
  }

  async function revokeInvite(id){
    setBusy(id);
    setError('');
    setMessage('');

    try{
      await repository.revokeInvitation(id);
      await load();
      setMessage('Invito revocato.');
    }catch(error){
      setError(error.message||'Revoca non riuscita.');
    }finally{
      setBusy('');
    }
  }

  const assignmentGroups=employeeAssignmentGroups(employeeAssignments,assignmentBranches,employeeSearch,employeeBranchFilter);
  function assignmentList(items){return <div className="employee-assignment-list">{items.map(employee=><article key={employee.employee_id}><div><strong>{employee.employee_name}</strong><small>{employee.user_id?'Account collegato':'Senza account'}</small></div><BranchChecks label={`Sedi di ${employee.employee_name}`} branches={assignmentBranches} value={employee.branch_ids} disabled={!!busy||loading} onChange={ids=>updateEmployeeBranches(employee,ids)}/></article>)}</div>;}

  const pendingInvitations=invitations.filter(
    item=>!item.accepted_at&&!item.revoked_at
  );

  return <section className="content-panel access-panel">
    <div className="panel-heading">
      <div>
        <p className="eyebrow">UTENTI E ACCESSI</p>
        <h2>Gestione accessi</h2>
        <p>Gestisci ruoli, dipendenti collegati e inviti alla tua organizzazione.</p>
      </div>
    </div>

    {error&&<p className="error" role="alert">{error}</p>}
    {message&&<p className="save-confirmation" role="status">{message}</p>}

    <div className="access-section">
      <div className="access-section-heading">
        <div>
          <h3>Utenti</h3>
          <p>Solo gli Admin possono modificare gli accessi.</p>
        </div>
        <button onClick={load} disabled={loading||!!busy}>Aggiorna</button>
      </div>

      {loading?<p>Caricamento…</p>:
      <div className="access-table-wrap">
        <table className="access-table">
          <thead>
            <tr>
              <th>Utente</th>
              <th>Ruolo</th>
              <th>Sedi autorizzate</th>
              <th>Visibilità</th>
              <th>Dipendente collegato</th>
              <th>Accesso</th>
            </tr>
          </thead>
          <tbody>
            {members.map(member=><tr key={member.user_id}>
              <td>
                <strong>{member.full_name||'Utente'}</strong>
                {member.user_id===account.user_id&&<small>Tu</small>}
              </td>

              <td>
                <select
                  value={member.role}
                  disabled={busy===member.user_id||member.organization_role==='owner'}
                  onChange={async event=>{const control=event.currentTarget,next=event.target.value;if(!await updateMember(member,{role:next}))control.value=member.role}}
                >
                  <option value="admin">Admin</option>
                  <option value="editor">Editor</option>
                  <option value="viewer">Viewer</option>
                </select>
              </td>

              <td><BranchChecks label={`Sedi di ${member.full_name||'Utente'}`} branches={assignmentBranches} value={member.branch_ids} disabled={busy===member.user_id} onChange={branchIds=>updateMember(member,{branchIds})}/></td>

              <td><select value={member.visibility_level||'all_branches'} disabled={busy===member.user_id} onChange={event=>updateMember(member,{visibility:event.target.value})}><option value="own">Solo propri turni</option><option value="home_branch">Sedi assegnate</option><option value="all_branches">Tutte autorizzate</option></select></td>

              <td>
                <select
                  value={member.employee_id||''}
                  disabled={busy===member.user_id}
                  onChange={event=>updateMember(member,{employeeId:event.target.value||null})}
                >
                  <option value="">Nessun dipendente</option>
                  {employees.map(employee=>
                    <option key={employee.id} value={employee.id}>
                      {employee.name}
                    </option>
                  )}
                </select>
              </td>

              <td>
                <label className="access-toggle">
                  <input
                    type="checkbox"
                    checked={member.is_active}
                    disabled={busy===member.user_id||member.organization_role==='owner'}
                    onChange={async event=>{const control=event.currentTarget,next=event.target.checked;if(!await updateMember(member,{isActive:next}))control.checked=member.is_active}}
                  />
                  <span>{member.is_active?'Attivo':'Disattivato'}</span>
                </label>
              </td>
            </tr>)}
          </tbody>
        </table>
      </div>}
    </div>

    <div className="access-section">
      <div className="access-section-heading"><div><h3>Sedi dei dipendenti</h3><p>Questa è l’unica sezione in cui si assegna un dipendente a una o più Sedi, anche senza account.</p></div></div>
      <div className="employee-assignment-filters">
        <label>Cerca dipendente<input type="search" value={employeeSearch} onChange={event=>setEmployeeSearch(event.target.value)} placeholder="Nome dipendente"/></label>
        <label>Filtra per Sede<select value={employeeBranchFilter} onChange={event=>setEmployeeBranchFilter(event.target.value)}>
          <option value="all">Tutte le sedi</option>{assignmentBranches.map(branch=><option key={branch.id} value={branch.id}>{branch.name}{branch.active?'':' (disattivata)'}</option>)}
        </select></label>
      </div>
      {loading?<p>Caricamento…</p>:assignmentGroups.length?assignmentGroups.map(group=>employeeBranchFilter==='all'?
        <details className="employee-assignment-group" key={group.id} open={employeeSearch.trim()?true:undefined}>
          <summary>{group.name} · {group.employees.length} dipendenti</summary>{assignmentList(group.employees)}
        </details>:<div key={group.id}><p>{group.employees.length} dipendenti</p>{assignmentList(group.employees)}</div>):<p>Nessun dipendente trovato.</p>}

    </div>

    <div className="access-section">
      <div className="access-section-heading">
        <div>
          <h3>Invita utente</h3>
          <p>L’invito è valido per 7 giorni.</p>
        </div>
      </div>

      <form className="invite-form" onSubmit={createInvite}>
        <label>
          Email
          <input
            type="email"
            required
            value={email}
            onChange={event=>setEmail(event.target.value)}
            placeholder="nome@email.com"
          />
        </label>

        <label>
          Ruolo
          <select value={role} onChange={event=>setRole(event.target.value)}>
            <option value="viewer">Viewer</option>
            <option value="employee">Dipendente</option>
            <option value="editor">Editor di Sede</option>
            <option value="branch_admin">Branch Admin</option>
          </select>
        </label>

        {assignmentBranches.length>0&&<label>Sede<select required value={branchId} onChange={event=>setBranchId(event.target.value)}><option value="">Seleziona Sede</option>{assignmentBranches.filter(item=>item.active&&item.admin).map(branch=><option key={branch.id} value={branch.id}>{branch.name}</option>)}</select></label>}

        <label>Visibilità<select value={visibility} onChange={event=>setVisibility(event.target.value)}><option value="own">Solo i propri turni</option><option value="home_branch">Le Sedi assegnate</option><option value="all_branches">Tutte le Sedi autorizzate</option></select></label>

        <label>
          Dipendente collegato
          <select value={employeeId} onChange={event=>setEmployeeId(event.target.value)}>
            <option value="">Nessun dipendente</option>
            {employees.map(employee=>
              <option key={employee.id} value={employee.id}>
                {employee.name}
              </option>
            )}
          </select>
        </label>

        <button className="primary" disabled={busy==='invite'}>
          {busy==='invite'?'Creazione…':'Crea invito'}
        </button>
      </form>

      {createdInvite&&<div className="invite-token">
        <strong>Link invito creato</strong>
        <p>Invia questo link al destinatario: dovrà aprirlo e registrarsi con l’email invitata.</p>
        <input aria-label="Link invito" readOnly value={buildInviteLink(createdInvite.token)} onFocus={event=>event.target.select()}/>
        <button
          className="primary"
          type="button"
          onClick={copyInviteLink}
        >
          Copia link invito
        </button>
        <details><summary>Dettagli tecnici</summary><code>{createdInvite.token}</code></details>
        {copyStatus&&<p role="status">{copyStatus}</p>}
      </div>}
    </div>

    <div className="access-section">
      <div className="access-section-heading">
        <div>
          <h3>Inviti in attesa</h3>
          <p>{pendingInvitations.length} inviti ancora utilizzabili.</p>
        </div>
      </div>

      {!pendingInvitations.length?
        <div className="empty-state"><p>Nessun invito in attesa.</p></div>
        :
        <div className="invitation-list">
          {pendingInvitations.map(invite=><article key={invite.id}>
            <div>
              <strong>{invite.email}</strong>
              <span>{ROLE_LABELS[invite.role]||invite.role}</span>
              {invite.employee_id&&
                <span>{employeeName(employees,invite.employee_id)}</span>}
            </div>

            <div>
              <small>
                Scade: {new Date(invite.expires_at).toLocaleString('it-IT')}
              </small>
              <button
                className="danger"
                disabled={busy===invite.id}
                onClick={()=>revokeInvite(invite.id)}
              >
                Revoca
              </button>
            </div>
          </article>)}
        </div>}
    </div>
  </section>;
}
