export const STORAGE_KEY = 'turni.planner.v1';
export function dateKey(date) { return `${String(date.getFullYear()).padStart(4,'0')}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`; }
export function monday(date = new Date()) { const d = new Date(date); d.setHours(12,0,0,0); d.setDate(d.getDate() - (d.getDay()+6)%7); return d; }
export function addDays(date,n) { const d = new Date(date); d.setDate(d.getDate()+n); return d; }
export function dateRangeTitle(first,last) {
  const sameYear=first.getFullYear()===last.getFullYear();
  const startOptions={day:'numeric',month:'long',...(sameYear?{}:{year:'numeric'})};
  return `${first.toLocaleDateString('it-IT',startOptions)} – ${last.toLocaleDateString('it-IT',{day:'numeric',month:'long',year:'numeric'})}`;
}
export function horizontalWeekDelta(deltaX,deltaY) {
  return Math.abs(deltaX)>=2 && Math.abs(deltaX)>Math.abs(deltaY)*1.25 ? Math.sign(deltaX) : 0;
}
export function minutes(shift) { if (!shift || isAbsence(shiftType(shift))) return 0; const [h,m]=shift.start.split(':').map(Number); const [eh,em]=shift.end.split(':').map(Number); return (eh*60+em-h*60-m+1440)%1440; }
export function hours(value) { const h=Math.floor(value/60), m=value%60; return `${h} h${m ? ` ${m} min` : ''}`; }
export function validData(data) { return data?.version===1 && Array.isArray(data.employees) && data.employees.every(e=> typeof e.id==='string' && typeof e.name==='string') && new Set(data.employees.map(e=>e.id)).size===data.employees.length && data.shifts && typeof data.shifts==='object' && !Array.isArray(data.shifts) && Object.values(data.shifts).every(validShift); }

export const PRESETS = []; // No system work templates.
export function normalizeTime(value) {
  const text = value.trim();
  let h, m;
  if (/^\d{1,2}$/.test(text)) { h=Number(text); m=0; }
  else if (/^\d{3,4}$/.test(text)) { h=Number(text.slice(0,-2)); m=Number(text.slice(-2)); }
  else if (/^\d{1,2}:\d{2}$/.test(text)) { [h,m]=text.split(':').map(Number); }
  else return null;
  return h<24 && m<60 ? `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}` : null;
}
export function parseDate(value) {
  if (!/^\d{4,}-\d{2}-\d{2}$/.test(value)) return null;
  const [y,m,d]=value.split('-').map(Number);
  const result=new Date(0); result.setFullYear(y,m-1,d); result.setHours(12,0,0,0);
  return result.getFullYear()===y && result.getMonth()===m-1 && result.getDate()===d ? result : null;
}
export function dateRange(from,to) {
  const first=parseDate(from), last=parseDate(to);
  if (!first || !last || first>last) return [];
  const result=[];
  for(let day=first;day<=last;day=addDays(day,1)) result.push(dateKey(day));
  return result;
}
export function rangePlan(data,employeeId,from,to,excluded=[]) {
  const exclusions=new Set(excluded);
  const dates=dateRange(from,to).filter(day=>!exclusions.has(day));
  return {dates,conflicts:dates.filter(day=>Object.hasOwn(data.shifts,`${employeeId}|${day}`))};
}
export function applyRange(data,employeeId,dates,shift,mode='empty') {
  if(!data.employees.some(e=>e.id===employeeId)) throw new Error('Dipendente non trovato.');
  const shifts={...data.shifts};
  for (const day of dates) {
    const key=`${employeeId}|${day}`;
    if(mode==='replace' || !Object.hasOwn(shifts,key)) shifts[key]={...shift};
  }
  return {...data,shifts};
}
export function shiftText(shift) {
  if(!shift) return 'Non assegnato';
  const type=shiftType(shift);
  return isAbsence(type) ? type : `${type}: ${shift.start} - ${shift.end}${shift.end<shift.start?' (+1 giorno)':''}`;
}
export function reportWeeks(data,employeeId,from,to,variations={},settings=null) {
  const employees=employeeId ? data.employees.filter(e=>e.id===employeeId) : data.employees;
  const weeks=[];
  for(const date of dateRange(from,to)) {
    const key=dateKey(monday(parseDate(date)));
    if(weeks.at(-1)?.key!==key) weeks.push({key,dates:[]});
    weeks.at(-1).dates.push(date);
  }
  return weeks.map(week=>({...week,rows:employees.map(e=>({name:e.name,shifts:week.dates.map(d=>shiftText(data.shifts[`${e.id}|${d}`])),colors:week.dates.map(d=>shiftColor(data.shifts[`${e.id}|${d}`],settings)||''),variations:week.dates.map(d=>variations[`${e.id}|${d}`]),total:hours(week.dates.reduce((sum,d)=>sum+minutes(data.shifts[`${e.id}|${d}`]),0))}))}));
}
export function reportPeriod(data,employeeId,from,to,variations={}) {
  const dates=dateRange(from,to),employees=employeeId?data.employees.filter(e=>e.id===employeeId):data.employees;
  return {key:dates[0]||'',dates,rows:employees.map(e=>({name:e.name,shifts:dates.map(d=>shiftText(data.shifts[`${e.id}|${d}`])),variations:dates.map(d=>variations[`${e.id}|${d}`]),total:hours(dates.reduce((sum,d)=>sum+minutes(data.shifts[`${e.id}|${d}`]),0))}))};
}

export const SHIFT_TYPES = ['Riposo','Malattia','Ferie'];
export const customPresetKey=id=>`custom:${id}`;
export const customPresets=(settings,branchId=null)=>Array.isArray(settings?.presets?.custom)?settings.presets.custom.filter(p=>!branchId||p.branchId===branchId):[];
export const settingsForBranch=(settings,branchId,templateSort)=>({...settings,presets:{custom:customPresets(settings,branchId)},templateSort});
export function normalizeTemplateSort(value){
 return {key:['name','start','end','duration'].includes(value?.key)?value.key:'name',direction:value?.direction==='desc'?'desc':'asc'};
}
export function sortedCustomPresets(settings,branchId=null){
 const sort=normalizeTemplateSort(settings?.templateSort),collator=new Intl.Collator('it',{sensitivity:'base',numeric:true});
 return [...customPresets(settings,branchId)].sort((a,b)=>{
  const compare=sort.key==='duration'?minutes(a)-minutes(b):collator.compare(a[sort.key],b[sort.key]);
  return (sort.direction==='desc'?-1:1)*compare||collator.compare(a.name,b.name)||a.id.localeCompare(b.id);
 });
}
export const shiftOptions=settings=>[...sortedCustomPresets(settings).map(p=>customPresetKey(p.id)),...SHIFT_TYPES];
export const shiftOptionLabel=(value,settings)=>value.startsWith('custom:')?customPresets(settings).find(p=>customPresetKey(p.id)===value)?.name||'Turno non disponibile':value;
export const scheduleTypes=(settings,data=null)=>[...new Set([...SHIFT_TYPES,...customPresets(settings).map(p=>p.name),...Object.values(data?.shifts||{}).map(shiftType).filter(Boolean)])];
// Snapshot color always takes precedence. Legacy metadata is frozen at migration.
export const shiftColor=(shift,settings)=>shift?.presetColor||(isAbsence(shiftType(shift))?settings?.colors?.[shiftType(shift)]:settings?.legacyColors?.[shiftType(shift)]||settings?.colors?.[shiftType(shift)]);
export const isAbsence = type => SHIFT_TYPES.includes(type);
export const isInstantShiftType = (type,settings=null) => SHIFT_TYPES.includes(type)||!!customPresets(settings).find(p=>customPresetKey(p.id)===type);
export function shiftType(shift) {
  if(!shift)return null;
  if(shift.presetName)return shift.presetName;
  if(typeof shift.type==='string'&&shift.type)return shift.type;
  if(shift.off)return 'Riposo';
  // Compatibility for the oldest untyped browser records only.
  return shift.start==='09:30'&&shift.end==='17:30'?'Mattina':shift.start==='14:00'&&shift.end==='22:00'?'Pomeriggio':'Centrale';
}
export function makeShift(type,start='',end='',settings=null) {
  if(typeof type!=='string')return null;
  const custom=type.startsWith('custom:')?customPresets(settings).find(p=>customPresetKey(p.id)===type):null;
  if(custom)return {type:custom.name,presetId:custom.id,presetName:custom.name,presetColor:custom.color,start:custom.start,end:custom.end,off:false,...(custom.branchId?{branchId:custom.branchId}:{})};
  if(isAbsence(type))return {type,off:true};
  // Explicit snapshot editing: work names have no special meaning.
  const a=normalizeTime(start),b=normalizeTime(end);
  return type.trim()&&a&&b&&a!==b?{type,start:a,end:b,off:false}:null;
}
// Retained API for legacy callers: template changes never update assignments.
export function applyPresetSettings(data){return data;}
export function applyPresetSettingsFrom(data){return data;}
export function validShift(s) {
  if(!s||typeof s!=='object')return false;
  if(s.type!==undefined&&(typeof s.type!=='string'||!s.type.trim()||s.type.length>100))return false;
  if(s.type&&isAbsence(s.type))return s.off===true&&s.start==null&&s.end==null&&!s.presetId&&!s.presetName&&!s.presetColor;
  if(s.type===undefined&&s.off===true)return true;
  if(s.presetId!==undefined||s.presetName!==undefined||s.presetColor!==undefined){
    if(typeof s.presetId!=='string'||!s.presetId||s.presetName!==s.type||!(/^#[0-9A-F]{6}$/i).test(s.presetColor))return false;
  }
  const time=/^([01]\d|2[0-3]):[0-5]\d$/;
  return time.test(s.start)&&time.test(s.end);
}
