import React,{useState} from 'react';
import {customPresets,sortedCustomPresets,normalizeTime,minutes,hours} from './schedule';

const DEFAULT_COLOR='#A78BFA';
export default function CustomPresetSettings({disabled,draft,setDraft,data,setSaved,branchId,templateSort,onTemplateSort}){
  const [error,setError]=useState('');
  const presets=sortedCustomPresets({...draft,templateSort},branchId);
  function update(id,field,value){
    setDraft(current=>({...current,presets:{...current.presets,custom:customPresets(current).map(item=>item.id===id?{...item,[field]:field==='color'?value.toUpperCase():value}:item)}}));
    setSaved(false);setError('');
  }
  function add(){
    setDraft(current=>({...current,presets:{...current.presets,custom:[...customPresets(current),{id:crypto.randomUUID(),branchId,name:'',start:'09:00',end:'17:00',color:DEFAULT_COLOR}]}}));setSaved(false);
  }
  function remove(item){
    const count=Object.values(data.shifts).filter(shift=>shift.presetId===item.id).length;
    const subject=item.name||'Questo turno',uses=count===1?'turno pianificato':'turni pianificati';
    const message=count?subject+' è usato in '+count+' '+uses+'. Eliminando il preset, i turni già assegnati conserveranno nome, orari e colore. Continuare?':'Eliminare questo turno predefinito?';
    if(!window.confirm(message))return;
    setDraft(current=>({...current,presets:{...current.presets,custom:customPresets(current).filter(preset=>preset.id!==item.id)}}));setSaved(false);
  }
  function validateName(item,value){
    const name=value.trim().toLocaleLowerCase('it-IT'),reserved=['riposo','malattia','ferie'];
    if(!name)setError('Il nome del turno è obbligatorio.');
    else if(reserved.includes(name))setError('Riposo, Malattia e Ferie sono stati riservati.');
    else setError('');
  }
  return <fieldset disabled={disabled} className="custom-presets"><legend>Turni predefiniti</legend>
    <p className="field-help">Crea turni di lavoro riutilizzabili. Gli orari che attraversano la mezzanotte sono supportati.</p>
    <div className="template-sort-controls">
      <label>Ordina turni per<select value={templateSort?.key||'name'} onChange={event=>onTemplateSort({key:event.target.value,direction:templateSort?.direction||'asc'})}>
        <option value="name">Nome</option><option value="start">Ora di inizio</option><option value="end">Ora di fine</option><option value="duration">Durata</option>
      </select></label>
      <label>Direzione ordinamento<select value={templateSort?.direction||'asc'} onChange={event=>onTemplateSort({key:templateSort?.key||'name',direction:event.target.value})}>
        <option value="asc">Crescente ↑</option><option value="desc">Decrescente ↓</option>
      </select></label>
    </div>
    {presets.map(item=><div className="custom-preset-row" data-template-id={item.id} key={item.id}>
      <label>Nome<input required maxLength={100} value={item.name} onBlur={event=>{const value=event.target.value.trim();update(item.id,'name',value);validateName(item,value)}} onChange={event=>update(item.id,'name',event.target.value)}/></label>
      <label>Ora di inizio<input type="time" required value={item.start} onChange={event=>update(item.id,'start',event.target.value)}/></label>
      <label>Ora di fine<input type="time" required value={item.end} onChange={event=>update(item.id,'end',event.target.value)}/></label>
      <label>Colore<input aria-label={'Colore '+(item.name||'nuovo turno')} type="color" value={item.color} onChange={event=>update(item.id,'color',event.target.value)}/></label>
      <button type="button" className="danger" onClick={()=>remove(item)}>Elimina</button>
      {normalizeTime(item.start)&&normalizeTime(item.end)&&<small className="template-duration">{item.start}–{item.end} · {hours(minutes(item))}{item.end<item.start?' · Termina il giorno successivo.':''}</small>}
    </div>)}
    {error&&<p role="alert" className="form-error">{error}</p>}
    <button type="button" onClick={add}>Aggiungi turno predefinito</button>
  </fieldset>;
}
