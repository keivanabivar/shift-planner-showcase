import React,{useRef,useState,useEffect} from 'react';
import {downloadBackup,parseBackup} from './persistence';
export const statusLabel={local:'Salvataggio locale',connected:'Connesso',readonly:'Aggiornamento richiesto · sola lettura',loading:'Caricamento dati…',saving:'Sincronizzazione…',migration:'Importazione da confermare',offline:'Offline',error:'Errore di sincronizzazione'};
export function ConnectionPanel({store,state,configured}){
 const busy=['loading','saving'].includes(state.status);
 return <section className="connection-panel" aria-label="Stato dati"><p role="status">{state.status==='readonly'?statusLabel.readonly:state.message||(!configured?'Salvataggio locale attivo. Configura Supabase per avviare la migrazione.':statusLabel[state.status])}</p>
 {configured&&!busy&&<button onClick={()=>store.connect()}>Riconnetti e ricarica</button>}
 {state.pending&&<div className="migration-choice"><p>{state.pending.empty?'La tua organizzazione è vuota. I dati locali precedenti sono conservati separatamente. Importali solo se appartengono a questa organizzazione.':'Il database contiene già dati. Puoi aprirli senza modificare la copia locale. L’importazione automatica è bloccata per evitare sovrascritture.'}</p>
 <button disabled={busy||!!state.localError} onClick={()=>downloadBackup(store.localBackup())}>Esporta copia locale</button>
 {state.pending.empty?<><button disabled={busy||!!state.localError} onClick={()=>{if(window.confirm('Confermi che i dati locali appartengono alla tua organizzazione e vuoi importarli? La copia locale sarà conservata.'))store.migrate('local')}}>Importa dati locali</button>{store.organizationId&&<button disabled={busy} onClick={()=>store.migrate('server')}>Inizia senza importare</button>}</>:<button disabled={busy} onClick={()=>store.migrate('server')}>Usa i dati del database</button>}</div>}
 </section>;
}
export default function BackupPanel({snapshot,onImport,disabled}){
 const [pending,setPending]=useState(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);const dialog=useRef(null),file=useRef(null);
 useEffect(()=>{if(pending)dialog.current?.showModal();},[pending]);
 async function read(event){const selected=event.target.files?.[0];event.target.value='';if(!selected)return;try{if(selected.size>20*1024*1024)throw Error();setPending(parseBackup(await selected.text()));setError('');}catch{setError('Backup non valido o incompatibile. Nessun dato modificato.');}}
 async function apply(){setBusy(true);try{if(await onImport(pending)){setPending(null);setError('');}else setError('Importazione non riuscita. Nessuna modifica confermata; verifica la connessione.');}finally{setBusy(false);}}
 return <section className="content-panel backup-panel"><h2>Backup dei dati</h2><p>Esporta i dati della tua organizzazione oppure ripristina un backup nella tua organizzazione.</p><div className="filter-actions"><button onClick={()=>downloadBackup(snapshot)}>Esporta backup</button><button disabled={disabled} onClick={()=>file.current.click()}>Importa backup</button><input hidden ref={file} type="file" accept=".json,application/json" onChange={read}/></div>{error&&<p role="alert" className="error">{error}</p>}
 {pending&&<dialog ref={dialog} aria-label="Conferma importazione backup" onCancel={()=>!busy&&setPending(null)}><h2>Importa backup</h2><p>Il backup contiene {pending.data.employees.length} dipendenti, {Object.keys(pending.data.shifts).length} turni, {Object.keys(pending.variations).length} variazioni e {pending.notes.length} note. Sostituirà tutti i dati correnti e le impostazioni. Esporta una copia prima di confermare.</p><div className="dialog-actions"><button disabled={busy} onClick={()=>setPending(null)}>Annulla</button><button onClick={()=>downloadBackup(snapshot)}>Esporta backup attuale</button><button disabled={disabled||busy} className="danger-solid" onClick={apply}>Conferma sostituzione</button></div>{error&&<p role="alert">{error}</p>}</dialog>}</section>;
}
