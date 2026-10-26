import React from 'react';
import {SHIFT_TYPES} from './schedule';
import {EMPTY_SCHEDULE_FILTERS,VARIATION_FILTERS,hasScheduleFilters,quickFilter} from './filters';
import {VARIATION_REASONS} from './attendance';

const toggle=(items,value)=>items.includes(value)?items.filter(item=>item!==value):[...items,value];
export function ActiveFilterChips({filters,onChange}){
  const chips=[];
  if(filters.name)chips.push(['name',filters.name]);
  filters.shiftTypes.forEach(type=>chips.push([`type:${type}`,type]));
  if(filters.variation!=='all')chips.push(['variation',VARIATION_FILTERS.find(item=>item[0]===filters.variation)?.[1]]);
  filters.reasons.forEach(reason=>chips.push([`reason:${reason}`,reason]));
  if(filters.from)chips.push(['from',`Dal ${filters.from.split('-').reverse().join('/')}`]);
  if(filters.to)chips.push(['to',`Al ${filters.to.split('-').reverse().join('/')}`]);
  function remove(key){let next={...filters};if(key==='name')next.name='';else if(key==='variation')next.variation='all';else if(key==='from'||key==='to')next[key]='';else if(key.startsWith('type:'))next.shiftTypes=next.shiftTypes.filter(item=>item!==key.slice(5));else next.reasons=next.reasons.filter(item=>item!==key.slice(7));onChange(next)}
  if(!chips.length)return null;
  return <div className="active-filter-chips" aria-label="Filtri attivi">{chips.map(([key,label])=><button key={key} onClick={()=>remove(key)}>{label}<span aria-hidden="true">×</span></button>)}<button className="clear-filters" onClick={()=>onChange({...EMPTY_SCHEDULE_FILTERS})}>Rimuovi tutti i filtri</button></div>;
}
export default function FilterControls({filters,onChange,showDates=true,compact=false,shiftTypes=SHIFT_TYPES}){
  const update=(field,value)=>onChange({...filters,[field]:value});
  return <div className={`filter-controls ${compact?'compact-filters':''}`}>
    <div className="quick-filters" aria-label="Filtri rapidi"><span>Rapidi</span>{[['today','Oggi'],['week','Questa settimana'],['sick','Malattia'],['vacation','Ferie'],['variations','Con variazioni']].map(([key,label])=><button key={key} onClick={()=>onChange(quickFilter(key,new Date()))}>{label}</button>)}</div>
    <div className="filter-grid"><label>Cerca dipendente<input type="search" value={filters.name} placeholder="Nome dipendente" onChange={event=>update('name',event.target.value)}/></label>{showDates&&<><label>Data iniziale<input type="date" value={filters.from} onChange={event=>update('from',event.target.value)}/></label><label>Data finale<input type="date" value={filters.to} onChange={event=>update('to',event.target.value)}/></label></>}
      <fieldset><legend>Tipi di turno</legend><div className="filter-checks">{shiftTypes.map(type=><label key={type} className={filters.shiftTypes.includes(type)?'selected':''}><input type="checkbox" checked={filters.shiftTypes.includes(type)} onChange={()=>update('shiftTypes',toggle(filters.shiftTypes,type))}/>{type}</label>)}</div></fieldset>
      <label>Variazione turno<select value={filters.variation} onChange={event=>update('variation',event.target.value)}>{VARIATION_FILTERS.map(([value,label])=><option value={value} key={value}>{label}</option>)}</select></label>
      <fieldset><legend>Motivo variazione</legend><div className="filter-checks">{VARIATION_REASONS.map(reason=><label key={reason} className={filters.reasons.includes(reason)?'selected':''}><input type="checkbox" checked={filters.reasons.includes(reason)} onChange={()=>update('reasons',toggle(filters.reasons,reason))}/>{reason}</label>)}</div></fieldset>
    </div>
    {hasScheduleFilters(filters)&&<button className="filter-reset" onClick={()=>onChange({...EMPTY_SCHEDULE_FILTERS})}>Rimuovi tutti i filtri</button>}
  </div>;
}
