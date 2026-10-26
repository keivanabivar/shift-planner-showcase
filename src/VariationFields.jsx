import React,{useState} from 'react';
import {normalizeTime} from './schedule';
import {VARIATION_REASONS} from './attendance';

export default function VariationFields({start,setStart,end,setEnd,reason,setReason,customReason,setCustomReason,note,setNote}){
  const [touched,setTouched]=useState({});
  function timeField(label,value,setValue,id){const invalid=touched[id]&&!normalizeTime(value);return <label>{label}<input type="text" value={value} placeholder="Es. 930 o 09:30" aria-invalid={!!invalid} onChange={event=>setValue(event.target.value)} onBlur={()=>{setTouched(current=>({...current,[id]:true}));const normalized=normalizeTime(value);if(normalized)setValue(normalized)}}/>{invalid&&<span className="field-error" role="alert">Orario non valido. Usa ad esempio 930, 14 o 20:30.</span>}</label>}
  return <>
    <div className="time-fields">{timeField('Entrata effettiva',start,setStart,'actual-start')}<span>→</span>{timeField('Uscita effettiva',end,setEnd,'actual-end')}</div>
    <p className="field-help">Puoi scrivere 930, 1400, 20 o 20:30. L’orario si completa quando esci dal campo.</p>
    <label>Motivo<select value={reason} onChange={event=>setReason(event.target.value)}>{VARIATION_REASONS.map(item=><option key={item}>{item}</option>)}</select></label>
    {reason==='Altro'&&<label className="variation-extra">Motivo personalizzato<input value={customReason} maxLength={80} required placeholder="Descrivi brevemente il motivo" onChange={event=>setCustomReason(event.target.value)}/></label>}
    <label className="variation-extra">Nota opzionale<textarea value={note} maxLength={300} placeholder="Aggiungi un dettaglio, se necessario" onChange={event=>setNote(event.target.value)}/></label>
  </>;
}
