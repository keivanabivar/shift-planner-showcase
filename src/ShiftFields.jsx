import React, {useState} from 'react';
import {PRESETS,customPresets,shiftOptions,shiftOptionLabel,isAbsence,isInstantShiftType,normalizeTime,minutes,hours,statusStyle} from './schedule';

export default function ShiftFields({type,setType,start,setStart,end,setEnd,settings,snapshot,onInstantSelect}) {
  const [touched,setTouched]=useState({});
  const normalizedStart=normalizeTime(start), normalizedEnd=normalizeTime(end);
  function choose(next){setType(next);setTouched({});if(isInstantShiftType(next,settings))onInstantSelect?.(next);}
  function timeField(label,value,setValue,id){
    const invalid=touched[id] && !normalizeTime(value);
    return <label>{label}<input aria-label={label} aria-invalid={!!invalid} aria-describedby={invalid?`${id}-error`:'time-help'} type="text" placeholder="Es. 930 o 09:30" value={value} onChange={e=>setValue(e.target.value)} onBlur={()=>{setTouched(t=>({...t,[id]:true}));const parsed=normalizeTime(value);if(parsed)setValue(parsed);}}/>{invalid&&<span id={`${id}-error`} className="field-error" role="alert">Orario non valido. Usa ad esempio 930, 14 o 09:30 (da 00:00 a 23:59).</span>}</label>;
  }
  const custom=type.startsWith('custom:')?customPresets(settings).find(p=>`custom:${p.id}`===type):null;
  const preset=custom||settings?.presets?.[type] || PRESETS.find(p=>p.label===type);
  const readableText=color=>{
    const hex=color?.replace('#','');
    if(!/^[0-9a-f]{6}$/i.test(hex||''))return '#FFFFFF';
    const [r,g,b]=[0,2,4].map(index=>parseInt(hex.slice(index,index+2),16));
    return (r*299+g*587+b*114)/1000>150?'#142536':'#FFFFFF';
  };
  return <>
    <div className="preset-options" aria-label="Tipo di turno">{shiftOptions(settings).map(option=>{const item=option.startsWith('custom:')?customPresets(settings).find(p=>`custom:${p.id}`===option):null,color=item?.color||statusStyle(option,settings)?.color||settings?.colors?.[option];return <button key={option} type="button" aria-pressed={type===option} className={`type-option ${item?'':`type-${option.toLowerCase()}`} ${type===option?'preset-active':''}`} style={color?{background:color,color:readableText(color)}:undefined} onClick={()=>choose(option)}>{shiftOptionLabel(option,settings)}</button>})}</div>
    {type==='snapshot'?<><p className="planned-shift"><strong>{snapshot?.presetName||snapshot?.type}</strong></p><div className="time-fields">{timeField('Ora di inizio',start,setStart,'start')}<span>→</span>{timeField('Ora di fine',end,setEnd,'end')}</div><p id="time-help" className="field-help">Puoi scrivere 930, 0930, 14 o 14:00. L’orario si completa quando esci dal campo.</p>{normalizedStart&&normalizedEnd&&<p className={normalizedStart===normalizedEnd?'form-error':'duration'}>{normalizedStart===normalizedEnd?'Inserisci orari di inizio e fine diversi.':`Durata: ${hours(minutes({start:normalizedStart,end:normalizedEnd}))}${normalizedEnd<normalizedStart?' · Termina il giorno successivo.':''}`}</p>}</>:<p className="rest-note">{isAbsence(type)?`${shiftOptionLabel(type,settings)}: nessun orario richiesto. Non aggiunge ore al totale settimanale.`:type?`${shiftOptionLabel(type,settings)} · ${preset?.start}–${preset?.end}`:'Scegli un turno predefinito o uno stato.'}</p>}
  </>;
}
