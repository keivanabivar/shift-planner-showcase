import {dateKey,parseDate,shiftType,minutes} from './schedule.js';
import {monthlySchedule,monthlyShiftText} from './export.js';
import {actualMinutes} from './attendance.js';

export const monthKey=value=>{const date=value instanceof Date?value:parseDate(value);return date?dateKey(new Date(date.getFullYear(),date.getMonth(),1)):'';};
export const monthLabel=value=>parseDate(value).toLocaleDateString('it-IT',{month:'long',year:'numeric'});
export const archiveDeletionConfirmation=value=>`ELIMINA ${monthLabel(value).toLocaleUpperCase('it-IT')}`;
export const isCompletedMonth=(value,today=new Date())=>parseDate(monthKey(value))<new Date(today.getFullYear(),today.getMonth(),1);
export function dateNavigationTarget(value,today=new Date()){
 const date=value instanceof Date&&!Number.isNaN(value.getTime())?new Date(value):parseDate(value);if(!date)return null;
 return isCompletedMonth(date,today)?{view:'archive',date,month:monthKey(date)}:{view:'planning',date,month:monthKey(date)};
}
export function clampPlanningDate(value,today=new Date()){
 const parsed=value instanceof Date&&!Number.isNaN(value.getTime())?new Date(value):parseDate(value),date=parsed||today,first=new Date(today.getFullYear(),today.getMonth(),1);
 return date<first?first:date;
}
export function groupArchiveMonths(months){
 return months.reduce((groups,item)=>{const year=item.month_start.slice(0,4);(groups[year]??=[]).push(item);return groups;},{});
}
export function monthsForScope(months,scope,anchor){
 if(scope==='all')return months.map(item=>item.month_start);
 const key=monthKey(anchor);
 return months.map(item=>item.month_start).filter(month=>scope==='year'?month.startsWith(key.slice(0,4)):month===key);
}
export function filterSnapshotForMonths(snapshot,months){
 const selected=new Set(months.map(monthKey));
 const shifts=Object.fromEntries(Object.entries(snapshot.data.shifts).filter(([key])=>selected.has(monthKey(key.slice(-10)))));
 const variations=Object.fromEntries(Object.entries(snapshot.variations).filter(([key])=>selected.has(monthKey(key.slice(-10)))&&shifts[key]));
 const notes=snapshot.notes.filter(note=>note.date&&selected.has(monthKey(note.date)));
 return {...snapshot,data:{...snapshot.data,shifts},variations,notes};
}
const requestInMonths=(request,months)=>months.some(month=>{const start=parseDate(month),end=new Date(start.getFullYear(),start.getMonth()+1,0);return parseDate(request.start_date)<=end&&parseDate(request.end_date)>=start;});
const csv=value=>`"${String(value??'').replaceAll('"','""')}"`;
export function archiveCsv(snapshot,requests,months){
 const selected=new Set(months.map(monthKey)),employees=new Map(snapshot.data.employees.map(item=>[item.id,item.name]));
 const rows=[['Categoria','Mese','Data inizio','Data fine','Dipendente','Tipo','Inizio pianificato','Fine pianificata','Ore pianificate','Inizio effettivo','Fine effettiva','Ore effettive','Stato','Nota']];
 for(const [key,shift] of Object.entries(snapshot.data.shifts)){
  const date=key.slice(-10);if(!selected.has(monthKey(date)))continue;
  const employeeId=key.slice(0,-11),variation=snapshot.variations[key];
  rows.push(['Turno',monthKey(date),date,date,employees.get(employeeId)||employeeId,shiftType(shift),shift.start||'',shift.end||'',minutes(shift)/60,variation?.start||'',variation?.end||'',variation?actualMinutes(shift,variation)/60:'','',variation?.note||'']);
 }
 for(const request of requests){if(!requestInMonths(request,months))continue;rows.push(['Richiesta',months.find(month=>requestInMonths(request,[month]))||monthKey(request.start_date),request.start_date,request.end_date,request.employee_name||employees.get(request.employee_id)||request.employee_id,request.approved_type||request.type,request.approved_start_time||request.start_time||'',request.approved_end_time||request.end_time||'','','','',request.status,request.note||'']);}
 return `\ufeff${rows.map(row=>row.map(csv).join(';')).join('\n')}`;
}
export function archiveJson({snapshot,requests,months,scope,organizationId,createdAt=new Date().toISOString()}){
 return JSON.stringify({format:'turni.archive',version:1,scope,createdAt,organizationId,months,archive:filterSnapshotForMonths(snapshot,months),requests:requests.filter(item=>requestInMonths(item,months))},null,2);
}

let crcTable;
function crc32(bytes){
 crcTable??=Array.from({length:256},(_,n)=>{let c=n;for(let k=0;k<8;k++)c=(c&1)?0xedb88320^(c>>>1):c>>>1;return c>>>0;});
 let crc=0xffffffff;for(const byte of bytes)crc=crcTable[(crc^byte)&255]^(crc>>>8);return (crc^0xffffffff)>>>0;
}
function u16(value){return [value&255,(value>>>8)&255]}
function u32(value){return [value&255,(value>>>8)&255,(value>>>16)&255,(value>>>24)&255]}
export function createZip(files){
 const encoder=new TextEncoder(),local=[],central=[];let offset=0;
 for(const file of files){const name=encoder.encode(file.name),data=file.data instanceof Uint8Array?file.data:encoder.encode(String(file.data)),crc=crc32(data),header=new Uint8Array([...u32(0x04034b50),...u16(20),...u16(0x800),...u16(0),...u16(0),...u16(0),...u32(crc),...u32(data.length),...u32(data.length),...u16(name.length),...u16(0),...name]);local.push(header,data);const entry=new Uint8Array([...u32(0x02014b50),...u16(20),...u16(20),...u16(0x800),...u16(0),...u16(0),...u16(0),...u32(crc),...u32(data.length),...u32(data.length),...u16(name.length),...u16(0),...u16(0),...u16(0),...u16(0),...u32(0),...u32(offset),...name]);central.push(entry);offset+=header.length+data.length;}
 const centralSize=central.reduce((sum,item)=>sum+item.length,0),end=new Uint8Array([...u32(0x06054b50),...u16(0),...u16(0),...u16(files.length),...u16(files.length),...u32(centralSize),...u32(offset),...u16(0)]);
 return new Blob([...local,...central,end],{type:'application/zip'});
}
export async function archivePdf(snapshot,months,settings){
 const [{jsPDF},{autoTable}]=await Promise.all([import('jspdf'),import('jspdf-autotable')]);
 const doc=new jsPDF({orientation:'landscape',unit:'mm',format:'a3'});
 months.forEach((month,index)=>{if(index)doc.addPage('a3','landscape');const report=monthlySchedule(snapshot.data,'',parseDate(month),settings,undefined,snapshot.variations);doc.setFontSize(16);doc.text('Archivio pianificazione',10,12);doc.setFontSize(10);doc.text(monthLabel(month),10,18);autoTable(doc,{startY:23,head:[['Dipendente',...report.dates.map(day=>`${day.weekday} ${day.day}`)]],body:report.rows.map(row=>[`${row.name} (${row.total})`,...row.cells.map(monthlyShiftText)]),styles:{fontSize:6,cellPadding:1,halign:'center'},headStyles:{fillColor:[37,55,78]},columnStyles:{0:{cellWidth:42,halign:'left'}},rowPageBreak:'avoid',didDrawPage:()=>{doc.setFontSize(6);doc.setTextColor(105,115,134);doc.text('P: pianificato · E: effettivo · +1: giorno successivo · —: orario non registrato · Totali: ore pianificate',10,doc.internal.pageSize.getHeight()-8);doc.setTextColor(0,0,0);}});});
 return new Uint8Array(doc.output('arraybuffer'));
}
export async function createArchivePackage({snapshot,requests,archiveMonths,scope,anchor,organizationId,createdAt=new Date().toISOString()}){
 const months=monthsForScope(archiveMonths,scope,anchor);if(!months.length)throw Error('Nessun mese disponibile per il backup selezionato.');
 const filtered=filterSnapshotForMonths(snapshot,months),pdf=await archivePdf(filtered,months,snapshot.settings),label=scope==='month'?months[0]:scope==='year'?months[0].slice(0,4):'completo';
 const manifest={format:'turni.archive.package',version:1,scope,label,createdAt,organizationId,months,files:['archivio.pdf','archivio.csv','archivio.json']};
 return {blob:createZip([{name:'manifest.json',data:JSON.stringify(manifest,null,2)},{name:'archivio.pdf',data:pdf},{name:'archivio.csv',data:archiveCsv(filtered,requests,months)},{name:'archivio.json',data:archiveJson({snapshot:filtered,requests,months,scope,organizationId,createdAt})}]),filename:`backup_archivio_${label}_${createdAt.slice(0,10)}.zip`,months};
}
export function downloadBlob(blob,filename){const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=filename;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
