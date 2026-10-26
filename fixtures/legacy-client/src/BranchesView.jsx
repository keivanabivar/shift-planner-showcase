import React,{useEffect,useState} from 'react';
import {refreshBranches} from './branchRefresh.js';
import {branchActionVisibility,branchDeletionInfo} from './branchActions.js';

function BranchDeletionDetails({branch,open,onToggle}){
 const info=branchDeletionInfo(branch);
 if(!info.hasDetails)return null;
 const id=`branch-delete-details-${branch.id}`;
 return <><span className={`branch-delete-status ${info.available?'available':''}`}>{info.status}</span>{open&&<div id={id} className="branch-delete-details">{!!info.reasons.length&&<section><strong>Motivi</strong>{info.reasons.map(reason=><p key={reason}>{reason}</p>)}</section>}<section><strong>Blocchi attivi</strong>{info.blockers.length?<ul>{info.blockers.map(item=><li key={item.key}><span>{item.label}</span><strong>{item.count}</strong></li>)}</ul>:<p>Nessun blocco attivo.</p>}</section><section><strong>Storico</strong>{info.history.length?<ul>{info.history.map(item=><li key={item.key}><span>{item.label}</span><strong>{item.count}</strong></li>)}</ul>:<p>Nessun dato storico.</p>}</section></div>}<button className="branch-details-button" aria-expanded={open} aria-controls={id} onClick={onToggle}>Dettagli</button></>;
}

export function BranchSelector({branches,selected,onChange}){
 const readable=branches.filter(item=>item.active&&item.readable);
 if(readable.length<=1)return null;
 return <label className="branch-selector"><span>Sede</span><select value={selected.length===readable.length?'all':selected[0]||'all'} onChange={event=>onChange(event.target.value==='all'?readable.map(item=>item.id):[event.target.value])}><option value="all">Tutte le sedi</option>{readable.map(branch=><option key={branch.id} value={branch.id}>{branch.name}</option>)}</select></label>;
}

export function BranchesView({repository,account,onChanged}){
 const [branches,setBranches]=useState([]),[name,setName]=useState(''),[busy,setBusy]=useState(''),[error,setError]=useState(''),[message,setMessage]=useState(''),[details,setDetails]=useState('');
 async function load(){setError('');try{setBranches(await repository.branches())}catch(error){setError(error.message||'Impossibile caricare le sedi.')}}
 useEffect(()=>{load()},[]);
 async function action(key,run,success){if(!window.confirm(key))return;setBusy(key);setError('');setMessage('');try{await run();await refreshBranches(load,onChanged);setMessage(success)}catch(error){setError(error.message||'Operazione non riuscita.')}finally{setBusy('')}}
 async function remove(branch){
  const expected=`ELIMINA ${branch.name}`,confirmation=window.prompt(`Eliminazione permanente: la Sede e la sua configurazione verranno eliminate e non potranno essere recuperate.\n\nPer confermare, scrivi esattamente:\n${expected}`,'');
  if(confirmation!==expected){if(confirmation!==null)setError('Conferma non corrispondente. La Sede non è stata eliminata.');return}
  setBusy(`delete-${branch.id}`);setError('');setMessage('');
  try{await repository.deleteBranch({id:branch.id,confirmation});await refreshBranches(load,onChanged);setMessage('Sede eliminata definitivamente.')}catch(error){setError(error.message||'Eliminazione non riuscita.')}finally{setBusy('')}
 }
 async function create(event){event.preventDefault();const value=name.trim();if(!value)return;setBusy('create');try{await repository.createBranch(value);setName('');await refreshBranches(load,onChanged);setMessage('Sede creata in stato di configurazione.')}catch(error){setError(error.message||'Creazione non riuscita.')}finally{setBusy('')}}
 return <section className="content-panel branches-panel">
  <div className="panel-heading"><div><p className="eyebrow">SEDI</p><h2>Gestione Sedi</h2><p>Configura le sedi, verifica il presidio amministrativo e usa il recupero solo quando è necessario.</p></div></div>
  {error&&<p role="alert" className="error">{error}</p>}{message&&<p role="status" className="save-confirmation">{message}</p>}
  <form className="branch-create" onSubmit={create}><label>Nome nuova Sede<input required maxLength="200" value={name} onChange={event=>setName(event.target.value)}/></label><button className="primary" disabled={!!busy}>Crea Sede</button></form>
  <div className="branch-list">{branches.map(branch=>{const actions=branchActionVisibility(branch);return <article key={branch.id}>
   <div><strong>{branch.name}</strong><span className={`branch-state state-${branch.control_state}`}>{branch.active?'Attiva':'Disattivata'} · {branch.control_state==='managed'?'Gestita':branch.control_state==='recovery'?'Recupero':'Configurazione'}</span><BranchDeletionDetails branch={branch} open={details===branch.id} onToggle={()=>setDetails(details===branch.id?'':branch.id)}/></div>
   <div className="branch-actions"><button disabled={!!busy} onClick={()=>{const next=window.prompt('Nuovo nome della Sede',branch.name)?.trim();if(next&&next!==branch.name)action(`Rinominare “${branch.name}” in “${next}”?`,()=>repository.updateBranch({id:branch.id,name:next,active:branch.active}),'Sede rinominata.')}}>Rinomina</button>{actions.deactivate&&<button disabled={!!busy} onClick={()=>action(`Disattivare la Sede “${branch.name}”? La cronologia resterà conservata; turni futuri o inviti attivi devono essere risolti prima.`,()=>repository.updateBranch({id:branch.id,name:branch.name,active:false}),'Sede disattivata.')}>Disattiva</button>}{actions.reactivate&&<button className="primary" disabled={!!busy} onClick={()=>action(`Riattivare la Sede “${branch.name}”?`,()=>repository.updateBranch({id:branch.id,name:branch.name,active:true}),'Sede riattivata.')}>Riattiva</button>}{actions.delete&&<button className="danger" disabled={!!busy} onClick={()=>remove(branch)}>Elimina definitivamente</button>}{actions.recovery&&(branch.control_state==='recovery'?<button disabled={!!busy} onClick={()=>{const reason=window.prompt('Motivo della chiusura del recupero')??'';action(`Chiudere il recupero per “${branch.name}”?`,()=>repository.endBranchRecovery(branch.id,reason),'Recupero chiuso.')}}>Chiudi recupero</button>:<button disabled={!!busy} onClick={()=>{const reason=window.prompt('Motivo obbligatorio per il recupero')?.trim();if(reason)action(`Aprire il recupero Owner per “${branch.name}”?`,()=>repository.startBranchRecovery(branch.id,reason),'Recupero aperto e registrato.')}}>Avvia recupero</button>)}</div>
  </article>})}</div>
  {!branches.length&&<div className="empty-state"><p>Non ci sono ancora Sedi. Creane una quando vuoi iniziare a pianificare.</p></div>}<p className="branch-safety-note"><strong>Eliminazione permanente:</strong> disponibile per qualsiasi Sede senza blocchi attivi. Richieste concluse ed eventi audit restano conservati nello storico.</p>
 </section>;
}

export function CrossBranchRequests({repository,onChanged}){
 const [items,setItems]=useState([]),[error,setError]=useState(''),[busy,setBusy]=useState('');
 async function load(){try{setItems(await repository.crossBranchRequests())}catch(error){setError(error.message||'Impossibile caricare le proposte tra sedi.')}}
 useEffect(()=>{load()},[]);
 async function decide(item,approve){const note=window.prompt(approve?'Nota di approvazione facoltativa':'Motivo del rifiuto')??'';setBusy(item.id);try{await repository.decideCrossBranch(item.id,approve,note);await load();await onChanged?.()}catch(error){setError(error.message||'Decisione non salvata.')}finally{setBusy('')}}
 const pending=items.filter(item=>item.status==='pending');
 return <section className="content-panel cross-branch-panel"><div className="panel-heading"><div><p className="eyebrow">TRA SEDI</p><h2>Proposte di turno</h2><p>La sede di destinazione approva o rifiuta prima che il turno entri in pianificazione.</p></div><button onClick={load}>Aggiorna</button></div>{error&&<p className="error" role="alert">{error}</p>}<div className="cross-branch-list">{pending.map(item=><article key={item.id}><div><strong>{item.employee_name}</strong><span>{item.home_branch_name} → {item.destination_branch_name}</span><span>{new Date(`${item.shift_date}T12:00:00`).toLocaleDateString('it-IT')} · {item.shift_type}{item.start_time?` · ${item.start_time.slice(0,5)}–${item.end_time.slice(0,5)}`:''}</span></div><div><button disabled={busy===item.id} onClick={()=>decide(item,false)}>Rifiuta</button><button className="primary" disabled={busy===item.id} onClick={()=>decide(item,true)}>Approva</button></div></article>)}</div>{!pending.length&&<div className="empty-state"><p>Nessuna proposta in attesa.</p></div>}</section>;
}
