import {dateKey, isAbsence, minutes, normalizeTime, parseDate, shiftType} from './schedule.js';
import {dayAccounting} from './requestEffects.js';

export const VARIATIONS_KEY='turni.variations.v1';
export const VARIATION_REASONS=['Ritardo','Uscita anticipata','Permesso','Malessere','Altro'];

export function variationKey(employeeId,date){return `${employeeId}|${typeof date==='string'?date:dateKey(date)}`;}
export function validVariation(value){
  return !!value&&typeof value==='object'&&typeof value.employeeId==='string'&&!!parseDate(value.date)&&
    !!normalizeTime(value.start)&&!!normalizeTime(value.end)&&normalizeTime(value.start)!==normalizeTime(value.end)&&
    VARIATION_REASONS.includes(value.reason)&&typeof value.customReason==='string'&&
    (value.reason!=='Altro'||!!value.customReason.trim())&&typeof value.note==='string';
}
export function makeVariation(employeeId,date,start,end,reason,customReason='',note=''){
  const variation={employeeId,date:typeof date==='string'?date:dateKey(date),start:normalizeTime(start)||'',end:normalizeTime(end)||'',reason,customReason:customReason.trim(),note:note.trim()};
  return validVariation(variation)?variation:null;
}
export function loadVariations(storage){
  try{const parsed=JSON.parse(storage.getItem(VARIATIONS_KEY));return parsed&&typeof parsed==='object'&&!Array.isArray(parsed)&&Object.values(parsed).every(validVariation)?parsed:{};}catch{return {};}
}
export function upsertVariation(variations,variation){return validVariation(variation)?{...variations,[variationKey(variation.employeeId,variation.date)]:variation}:variations;}
export function deleteVariation(variations,key){const next={...variations};delete next[key];return next;}
export function actualMinutes(planned,variation){return !planned||isAbsence(shiftType(planned))?0:variation?minutes(variation):minutes(planned);}
export function attendanceTotals(data,variations,employeeId,dates,requestEffects={}){
  return dates.reduce((totals,date)=>{const key=variationKey(employeeId,date),value=dayAccounting(data.shifts[key],variations[key],requestEffects[key]);totals.planned+=value.scheduled;totals.actual+=value.actual;if(value.permission)totals.permission=(totals.permission||0)+value.permission;return totals;},{planned:0,actual:0});
}
export function sanitizeVariations(data,variations){
  return Object.fromEntries(Object.entries(variations).filter(([key])=>data.shifts[key]&&!isAbsence(shiftType(data.shifts[key]))));
}
export function variationReason(variation){return variation.reason==='Altro'?variation.customReason:variation.reason;}
