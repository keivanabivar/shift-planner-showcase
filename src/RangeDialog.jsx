import React,{useState,useRef,useEffect} from 'react';
import ShiftFields from './ShiftFields';
import {dateKey,addDays,parseDate,rangePlan,applyRange,shiftText,makeShift,settingsForBranch} from './schedule';
import {protectedAssignment,branchMarker} from './plannerAwareness';
import {employeeBranchOptions,defaultShiftBranchId} from './branchPersistence';
const dateLabel=d=>parseDate(d).toLocaleDateString('it-IT',{day:'numeric',month:'long',year:'numeric'});
export default function RangeDialog({busy,data,week,onClose,onApply,settings,branches=[],selectedBranchIds=[],branchPreferences={}}) {
  const ref=useRef(null);
  const [employeeId,setEmployeeId]=useState(data.employees[0]?.id||'');
  const [from,setFrom]=useState(dateKey(week)),[to,setTo]=useState(dateKey(addDays(week,6)));
  const [excluded,setExcluded]=useState([]),[exclusion,setExclusion]=useState('');
  const [type,setType]=useState(''),[start,setStart]=useState(''),[end,setEnd]=useState('');
  const [review,setReview]=useState(null),[error,setError]=useState('');
  useEffect(()=>{ref.current.showModal();},[]);
  const plan=rangePlan(data,employeeId,from,to,excluded);
  const validDates=parseDate(from)&&parseDate(to)&&parseDate(from)<=parseDate(to);
  const employee=data.employees.find(e=>e.id===employeeId),options=employeeBranchOptions(employee,branches);
  const [preferredBranch,setPreferredBranch]=useState('');
  const branchId=options.some(b=>b.id===preferredBranch)?preferredBranch:defaultShiftBranchId(employee,branches,selectedBranchIds);
  const scopedSettings=settingsForBranch(settings,branchId,branchPreferences[branchId]?.template_sort),entry=makeShift(type,start,end,scopedSettings);
  const selectedShift=entry&&branchId?{...entry,branchId}:null;
  const protectedConflicts=review?.conflicts.some(d=>protectedAssignment(data.shifts[`${employeeId}|${d}`],selectedBranchIds,review.shift.branchId));
  const ready=employeeId&&validDates&&plan.dates.length&&selectedShift;
  function addExclusion(){if(!parseDate(exclusion)||exclusion<from||exclusion>to){setError('Scegli una data compresa nell’intervallo selezionato.');return;}setExcluded([...new Set([...excluded,exclusion])].sort());setExclusion('');setError('');}
  function submit(e){e.preventDefault();if(!ready)return;const shift=selectedShift; if(plan.conflicts.length)setReview({...plan,shift});else apply(plan.dates,shift,'empty');}
  async function apply(dates,shift,mode){if(mode==='replace'&&dates.some(d=>protectedAssignment(data.shifts[`${employeeId}|${d}`],selectedBranchIds,shift.branchId))){setError('Passa alla Sede del turno prima di modificarlo.');return;}const result=await onApply(applyRange(data,employeeId,dates,shift,mode));if(result===false)setError('Salvataggio non riuscito. Nessuna modifica applicata.');}
  return <dialog inert={busy ? true : undefined} className="wide-dialog" ref={ref} aria-label="Assegna un intervallo" onCancel={onClose}><div className="dialog-heading"><div><h2>{review?'Turni già presenti':'Assegna un intervallo'}</h2><p>{review?'Scegli come gestire le date già pianificate.':'Un dipendente, più giorni. Le date escluse restano invariate.'}</p></div><button className="icon-button" aria-label="Chiudi" onClick={onClose}>×</button></div>
    {error&&<p className="error" role="alert">{error}</p>}
    {review?<><div className="conflict-warning" role="alert"><strong>Attenzione: {review.conflicts.length} date contengono già un turno o uno stato.</strong><p>{protectedConflicts?'Un turno per dipendente e data. I turni delle altre Sedi restano invariati; per modificarli, passa alla loro Sede.':<>Nessun dato è stato modificato. «Sostituisci turni esistenti» applicherà il nuovo turno a tutte le {review.dates.length} date incluse, sovrascrivendo quelle elencate.</>}</p></div><ul className="conflict-list">{review.conflicts.map(d=><li key={d}><strong>{dateLabel(d)}</strong><span>{shiftText(data.shifts[`${employeeId}|${d}`])} · Sede {branchMarker(data.shifts[`${employeeId}|${d}`],branches)}</span></li>)}</ul><div className="dialog-actions wrap-actions"><button autoFocus onClick={onClose}>Annulla</button><button className="primary" disabled={review.dates.length===review.conflicts.length} onClick={()=>apply(review.dates,review.shift,'empty')}>Applica solo alle date vuote</button><button disabled={protectedConflicts} className="danger" onClick={()=>apply(review.dates,review.shift,'replace')}>Sostituisci turni esistenti</button></div>{review.dates.length===review.conflicts.length&&<p className="field-help">Non ci sono date vuote nell’intervallo incluso.</p>}</>:<form noValidate onSubmit={submit}>
      <label>Dipendente<select aria-label="Dipendente" value={employeeId} onChange={e=>{setEmployeeId(e.target.value);setType('');}}>{data.employees.map(e=><option key={e.id} value={e.id}>{e.name}</option>)}</select></label>
      <div className="date-fields"><label>Data di inizio<input type="date" value={from} onInput={e=>{setFrom(e.target.value);}}/></label><label>Data di fine<input type="date" value={to} onInput={e=>{setTo(e.target.value);}}/></label></div>
      {!validDates&&<p className="form-error" role="alert">Inserisci date valide. La data di fine deve essere uguale o successiva alla data di inizio.</p>}
      {options.length>1&&<label>Sede del turno<select value={branchId} onChange={e=>{setPreferredBranch(e.target.value);setType('');}}>{options.map(b=><option key={b.id} value={b.id}>{b.name}</option>)}</select></label>}
      <ShiftFields {...{type,setType,start,setStart,end,setEnd}} settings={scopedSettings}/>
      <fieldset className="exclusions"><legend>Date da escludere</legend><div className="exclusion-entry"><label>Escludi una data<input type="date" value={exclusion} min={from} max={to} onInput={e=>setExclusion(e.target.value)}/></label><button type="button" onClick={addExclusion} disabled={!exclusion||!validDates}>Escludi data</button></div>{excluded.length>0&&<ul>{excluded.map(d=><li key={d}>{dateLabel(d)}<button type="button" aria-label={`Includi nuovamente ${dateLabel(d)}`} onClick={()=>setExcluded(excluded.filter(x=>x!==d))}>Includi</button></li>)}</ul>}<p className="field-help">Le date escluse conservano tutti i turni e gli stati già presenti, anche se modifichi l’intervallo.</p></fieldset>
      <p className="range-summary" aria-live="polite">{plan.dates.length} date incluse · {excluded.length} escluse</p>
      <div className="dialog-actions"><button type="button" onClick={onClose}>Annulla</button><div className="action-spacer"/><button className="primary" disabled={!ready}>Verifica e applica</button></div>
    </form>}
  </dialog>;
}
