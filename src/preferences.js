export const NOTES_KEY = 'turni.notes.v1';
export const SETTINGS_KEY = 'turni.settings.v1';

export const DEFAULT_SETTINGS = {version:2,presets:{custom:[]},colors:{Riposo:'#D84A4A',Malattia:'#E6C65C',Ferie:'#B8C4D1'},legacyColors:{}};

const cloneDefaults = () => JSON.parse(JSON.stringify(DEFAULT_SETTINGS));

export function validSettings(value) {
  if (!value || typeof value !== 'object') return false;
  const time=/^([01]\d|2[0-3]):[0-5]\d$/,color=/^#[0-9A-F]{6}$/i,ids=new Set();
  const custom=value.presets?.custom??[];
  if(!Array.isArray(custom)||!custom.every(item=>{
    if(!item||typeof item.id!=='string'||!item.id||ids.has(item.id)||typeof item.name!=='string'||!item.name.trim()||item.name!==item.name.trim()||item.name.length>100||
      !time.test(item.start)||!time.test(item.end)||item.start===item.end||!color.test(item.color)||['riposo','malattia','ferie'].includes(item.name.toLocaleLowerCase('it-IT'))||
      (value.version===2&&(typeof item.branchId!=='string'||!item.branchId)))return false;
    ids.add(item.id);return true;
  }))return false;
  if(value.version!==undefined&&value.version!==2)return false;
  if(value.version!==2&&!['Mattina','Pomeriggio'].every(type=>time.test(value.presets?.[type]?.start)&&time.test(value.presets?.[type]?.end)&&value.presets[type].start!==value.presets[type].end))return false;
  if(value.statusStyles!==undefined){
    if(!value.statusStyles||typeof value.statusStyles!=='object'||Array.isArray(value.statusStyles))return false;
    for(const styles of Object.values(value.statusStyles)){
      if(!styles||typeof styles!=='object'||Array.isArray(styles)||Object.keys(styles).some(t=>!['Riposo','Ferie','Malattia'].includes(t)))return false;
      for(const style of Object.values(styles))if(!style||typeof style.name!=='string'||!style.name.trim()||style.name!==style.name.trim()||style.name.length>100||!color.test(style.color))return false;
    }
  }
  return Object.keys(DEFAULT_SETTINGS.colors).every(type=>color.test(value.colors?.[type]))&&Object.values(value.legacyColors||{}).every(c=>color.test(c));
}

export function loadSettings(storage) {
  try {
    const parsed = JSON.parse(storage.getItem(SETTINGS_KEY));
    return validSettings(parsed) ? parsed : cloneDefaults();
  } catch {
    return cloneDefaults();
  }
}

export function validNote(note) {
  return note && typeof note.id === 'string' && typeof note.text === 'string' && note.text.trim() &&
    (note.date === '' || /^\d{4}-\d{2}-\d{2}$/.test(note.date)) && typeof note.employeeId === 'string';
}

export function sortNotesChronologically(notes){return [...notes].sort((a,b)=>a.date.localeCompare(b.date)||a.id.localeCompare(b.id));}

export function loadNotes(storage) {
  try {
    const parsed = JSON.parse(storage.getItem(NOTES_KEY));
    return Array.isArray(parsed) && parsed.every(validNote) ? parsed : [];
  } catch {
    return [];
  }
}

export function upsertNote(notes, note) {
  if (!validNote(note)) return notes;
  return notes.some(item => item.id === note.id) ? notes.map(item => item.id === note.id ? note : item) : [note, ...notes];
}

export function deleteNote(notes, id) {
  return notes.filter(item => item.id !== id);
}

export function filterEmployees(employees, selectedIds) {
  if (selectedIds === null) return employees;
  const selected = new Set(selectedIds);
  return employees.filter(item => selected.has(item.id));
}

export function absenceRows(data, employeeId = '', from = '', to = '', type = '') {
  return Object.entries(data.shifts).flatMap(([key, shift]) => {
    const separator = key.indexOf('|');
    const id = key.slice(0, separator), date = key.slice(separator + 1);
    const employee = data.employees.find(item => item.id === id);
    const absenceType = shift?.type || (shift?.off ? 'Riposo' : '');
    if (!employee || !['Riposo', 'Malattia', 'Ferie'].includes(absenceType)) return [];
    if (employeeId && employeeId !== id || from && date < from || to && date > to || type && type !== absenceType) return [];
    return [{employeeId: id, employeeName: employee.name, date, type: absenceType}];
  }).sort((a, b) => a.date.localeCompare(b.date) || a.employeeName.localeCompare(b.employeeName, 'it'));
}
