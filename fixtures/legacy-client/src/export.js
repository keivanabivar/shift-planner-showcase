import {dateKey,hours,minutes,parseDate,scheduleTypes,shiftColor,shiftType,shiftText} from './schedule.js';
import {variationReason} from './attendance.js';
import {isWeekend,monthRange,shiftAbbreviation} from './timeline.js';
export const readableDate=value=>parseDate(value).toLocaleDateString('it-IT',{day:'2-digit',month:'2-digit',year:'numeric'});
const weekday=value=>parseDate(value).toLocaleDateString('it-IT',{weekday:'short'});
const titleFor=week=>`Dal ${readableDate(week.dates[0])} al ${readableDate(week.dates.at(-1))}`;
const totalLabel=week=>week.dates.length===7?'Totale settimanale':'Totale nel periodo';
const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function shiftCellParts(value,variation) {
  const match=String(value).match(/^(.*):\s+(\d{2}:\d{2}) - (\d{2}:\d{2})(.*)$/);
  const cell=match?{name:match[1],time:`${match[2]} – ${match[3]}${match[4]}`}:{name:String(value),time:''};
  // Keep absent endpoints explicit; the planned time is not an actual time.
  return cell.time&&variation?{...cell,actual:`${variation.start||'—'} – ${variation.end||'—'}${variation.start&&variation.end&&variation.end<variation.start?' (+1 giorno)':''}`,reason:variationReason(variation)||''}:cell;
}
const printTime=(value,className,label='')=>`<div class="${className}">${label}${escape(value.replace(' (+1 giorno)',''))}</div>${value.endsWith(' (+1 giorno)')?'<div class="shift-next-day">(+1 giorno)</div>':''}`;
const printShift=(value,variation)=>{
  const cell=shiftCellParts(value,variation);
  return `<div class="shift-name">${escape(cell.name)}</div>${cell.time?printTime(cell.time,'shift-time',cell.actual?'Pian. ':''):''}${cell.actual?`${printTime(cell.actual,'shift-actual','Eff. ')}<div class="shift-reason">${escape(cell.reason)}</div>`:''}`;
};
const pdfShift=(value,variation)=>{
  const cell=shiftCellParts(value,variation);
  return [cell.name,...(cell.time?[`${cell.actual?'Pian. ':''}${cell.time}`]:[]),...(cell.actual?[`Eff. ${cell.actual}`,cell.reason]:[])].join('\n');
};
const monthlyAttendanceLines=cell=>cell.attendance?[
  `P ${cell.attendance.planned.split(' – ')[0]}`,`– ${cell.attendance.planned.split(' – ')[1].replace(' (+1 giorno)',' +1')}`,
  `E ${cell.attendance.actual.split(' – ')[0]}`,`– ${cell.attendance.actual.split(' – ')[1].replace(' (+1 giorno)',' +1')}`,cell.attendance.reason
]:[];
export const monthlyShiftText=cell=>[cell.abbreviation,...monthlyAttendanceLines(cell)].join('\n');
export function printDocument(weeks) {
  return `<!doctype html><html lang="it"><head><meta charset="utf-8"><title>Pianificazione turni</title><style>
  @page {size:A4 landscape;margin:14mm}*{box-sizing:border-box}body{font:11px Arial,sans-serif;color:#202737;margin:0;-webkit-print-color-adjust:exact;print-color-adjust:exact}h1{font-size:22px;margin:0 0 6px}h2{font-size:15px;margin:0 0 15px;font-weight:normal}section+section{break-before:page}table{border-collapse:collapse;width:100%;table-layout:fixed}thead{display:table-header-group}th,td{border:1px solid #d5dce8;padding:9px 5px;text-align:center;overflow:hidden;vertical-align:middle}th{background:#edf2ff}th:first-child,td:first-child{text-align:left;width:18%}tr{break-inside:avoid;height:46px}.shift-name{font-weight:700;line-height:1.25}.shift-time{font-size:10px;font-weight:normal;line-height:1.35;margin-top:3px;white-space:nowrap}.shift-actual{font-size:10px;line-height:1.35;margin-top:2px;white-space:nowrap;font-weight:700}.shift-next-day{font-size:9px;line-height:1.2;margin-top:2px}.shift-reason{font-size:9px;line-height:1.25;margin-top:2px;overflow-wrap:anywhere}.note{margin-top:14px;color:#5b6474}footer{margin-top:14px;color:#5b6474;font-size:10px}
  </style></head><body>${weeks.map(week=>`<section><h1>Pianificazione turni</h1><h2>${escape(titleFor(week))}</h2><table><thead><tr><th>Dipendente</th>${week.dates.map(d=>`<th>${escape(weekday(d))}<br>${escape(readableDate(d))}</th>`).join('')}<th>${totalLabel(week)}</th></tr></thead><tbody>${week.rows.map(row=>`<tr><td>${escape(row.name)}</td>${row.shifts.map((s,index)=>`<td${row.colors?.[index]?` style="background:${escape(row.colors[index])};color:${contrastColor(row.colors[index])}"`:''}>${printShift(s,row.variations?.[index])}</td>`).join('')}<td><strong>${escape(row.total)}</strong></td></tr>`).join('')}</tbody></table><p class="note">(+1 giorno): il turno termina il giorno successivo. Le ore sono attribuite al giorno di inizio. I totali sono ore pianificate.</p>${week.dates.length<7?'<footer>Il totale include soltanto le date esportate di questo intervallo.</footer>':''}</section>`).join('')}</body></html>`;
}
export function printSchedule(weeks) {
  return new Promise((resolve,reject)=>{
    document.querySelector('iframe[data-turni-print]')?.remove();
    const frame=document.createElement('iframe');
    frame.dataset.turniPrint='true';
    frame.title='Stampa pianificazione';
    frame.style.cssText='position:fixed;width:0;height:0;border:0;bottom:0;right:0';
    frame.onload=()=>{
      try {frame.contentWindow.addEventListener('afterprint',()=>frame.remove(),{once:true});frame.contentWindow.focus();frame.contentWindow.print();resolve();}
      catch(error){frame.remove();reject(error);}
    };
    frame.srcdoc=printDocument(weeks);
    document.body.appendChild(frame);
  });
}
export async function createSchedulePdf(weeks) {
  const [{jsPDF},{autoTable}]=await Promise.all([import('jspdf'),import('jspdf-autotable')]);
  const doc=new jsPDF({orientation:'landscape',unit:'mm',format:'a4'});
  doc.setProperties({title:'Pianificazione turni',subject:'Turni di lavoro e riposi',creator:'SHIFT PLANNER'});
  weeks.forEach((week,index)=>{
    if(index)doc.addPage();
    autoTable(doc,{
      head:[['Dipendente',...week.dates.map(d=>`${weekday(d)}\n${readableDate(d)}`),totalLabel(week)]],
      body:week.rows.map(row=>[row.name,...row.shifts.map((value,index)=>pdfShift(value,row.variations?.[index])),row.total]),
      startY:36,margin:{top:36,left:14,right:14,bottom:24},
      theme:'grid',styles:{font:'helvetica',fontSize:8,cellPadding:3,halign:'center',valign:'middle',overflow:'linebreak',minCellHeight:14,lineColor:[216,222,234],lineWidth:.2},
      headStyles:{fillColor:[237,242,255],textColor:[37,59,108],fontStyle:'bold'},
      columnStyles:{0:{cellWidth:48,halign:'left'}},rowPageBreak:'avoid',
      didParseCell:hook=>{
        if(hook.section==='body'&&hook.column.index>0&&hook.column.index<=week.dates.length){
          const color=week.rows[hook.row.index]?.colors?.[hook.column.index-1];
          if(color){hook.cell.styles.fillColor=hexRgb(color);hook.cell.styles.textColor=hexRgb(contrastColor(color));}
        }
      },
      willDrawPage:()=>{doc.setTextColor(32,39,55);doc.setFont('helvetica','bold');doc.setFontSize(18);doc.text('Pianificazione turni',14,19);doc.setFont('helvetica','normal');doc.setFontSize(11);doc.text(titleFor(week),14,27);},
      didDrawPage:()=>{doc.setFontSize(8);doc.setTextColor(90,100,116);doc.text('(+1 giorno): termina il giorno successivo. Le ore sono attribuite al giorno di inizio. I totali sono ore pianificate.',14,195);if(week.dates.length<7)doc.text('Il totale include soltanto le date esportate di questa settimana.',14,200);}
    });
  });
  for(let page=1;page<=doc.getNumberOfPages();page++){doc.setPage(page);doc.setFontSize(8);doc.text(`Pagina ${page} di ${doc.getNumberOfPages()}`,283,200,{align:'right'});}
  return doc;
}

const hexRgb=value=>{
  const hex=String(value||'').replace('#','');
  return /^[0-9a-f]{6}$/i.test(hex)?[0,2,4].map(index=>parseInt(hex.slice(index,index+2),16)):[100,116,139];
};
const contrastColor=value=>{
  const [red,green,blue]=hexRgb(value);
  return (red*299+green*587+blue*114)/1000>150?'#142536':'#FFFFFF';
};
const compactTime=shift=>shift?.start&&shift?.end?`${shift.start}–${shift.end}`:'';
const compactNameTextWidth=value=>Array.from(String(value||'')).reduce((width,character)=>{
  if(/\s/.test(character))return width+.32;
  if(/[ilI1'.,]/.test(character))return width+.3;
  if(/[MW@%]/.test(character))return width+.9;
  if(/[A-Z]/.test(character))return width+.68;
  return width+.54;
},0)*2.47;

export function compactEmployeeColumnWidth(rows,measure=compactNameTextWidth) {
  const textWidth=Math.max(measure('Dipendente'),...rows.map(row=>measure(row.name)));
  return Math.round(Math.min(58,Math.max(22,textWidth+3))*10)/10;
}

export function monthlySchedule(data,employeeId,anchor,settings,today=dateKey(new Date()),variations={}) {
  const range=monthRange(anchor),start=dateKey(range.start);
  const dates=Array.from({length:range.days},(_,index)=>{
    const date=new Date(range.start);date.setDate(date.getDate()+index);
    return {key:dateKey(date),day:date.getDate(),weekday:weekday(dateKey(date)),weekend:isWeekend(date),today:dateKey(date)===today};
  });
  const employees=employeeId?data.employees.filter(item=>item.id===employeeId):data.employees;
  const allTypes=scheduleTypes(settings,data),firstByType=new Map();
  const snapshotKey=shift=>JSON.stringify([shiftType(shift),shift.start,shift.end,shiftColor(shift,settings),shift.branchId]);
  const rows=employees.map(employee=>{
    const cells=dates.map(date=>{
      const shift=data.shifts[`${employee.id}|${date.key}`];
      if(!shift)return {abbreviation:'',type:'',color:''};
      const type=shiftType(shift);if(!firstByType.has(snapshotKey(shift)))firstByType.set(snapshotKey(shift),shift);
      const color=shiftColor(shift,settings)||'#64748B';
      const cell=shiftCellParts(shiftText(shift),variations[`${employee.id}|${date.key}`]);
      return {abbreviation:shiftAbbreviation(type,allTypes),type,color,textColor:contrastColor(color),...(cell.actual?{attendance:{planned:cell.time,actual:cell.actual,reason:cell.reason}}:{})};
    });
    const total=hours(dates.reduce((sum,date)=>sum+minutes(data.shifts[`${employee.id}|${date.key}`]),0));
    return {name:employee.name,cells,total};
  });
  const legend=[...firstByType.values()].map(shift=>{
    const type=shiftType(shift),color=shiftColor(shift,settings)||'#64748B';
    return {type,abbreviation:shiftAbbreviation(type,allTypes),color,textColor:contrastColor(color),time:compactTime(shift)};
  });
  return {mode:'monthly',start,end:dates.at(-1)?.key||start,dates,rows,legend};
}

export function monthlyPrintDocument(month) {
  const monthTitle=parseDate(month.start).toLocaleDateString('it-IT',{month:'long',year:'numeric'}),employeeWidth=compactEmployeeColumnWidth(month.rows);
  return `<!doctype html><html lang="it"><head><meta charset="utf-8"><title>Pianificazione mensile — ${escape(monthTitle)}</title><style>
  @page{size:A3 landscape;margin:8mm}*{box-sizing:border-box}html,body{margin:0;padding:0}body{font-family:Arial,sans-serif;color:#202737;font-size:7.5pt}.monthly-page{break-inside:avoid;page-break-inside:avoid;width:100%}h1{font-size:17pt;margin:0 0 1.5mm;text-transform:capitalize}h2{font-size:10pt;font-weight:normal;margin:0 0 4mm;text-transform:capitalize;color:#5b6474}.month-grid{border-collapse:collapse;table-layout:fixed;width:100%;font-size:7.5pt}.month-grid th,.month-grid td{border:.2mm solid #d5dce8;text-align:center;vertical-align:middle;padding:.8mm .25mm;height:6mm;overflow:hidden}.month-grid tr{break-inside:avoid;page-break-inside:avoid}.month-grid thead{display:table-header-group}.month-grid thead th{background:#edf2ff;font-weight:700}.month-grid .employee{width:var(--employee-column-width);text-align:left;padding:1mm 1.5mm;white-space:nowrap;line-height:1.15}.employee small{display:block;color:#697386;font-size:6.5pt;margin-top:.5mm}.day-head span{display:block;font-size:6pt;font-weight:normal;text-transform:uppercase;color:#687386}.weekend{background:#f2f4f7!important}.today{box-shadow:inset 0 0 0 .3mm #8da1bc}.shift-code{display:grid;place-items:center;min-width:4.4mm;height:4.4mm;margin:auto;border-radius:1mm;background:var(--shift-color);color:var(--shift-text);font-weight:700;line-height:1}.attendance-times{font-size:5.5pt;line-height:1.15;margin-top:.5mm;white-space:nowrap}.attendance-reason{font-size:5.5pt;line-height:1.15;margin-top:.5mm;overflow-wrap:anywhere}.legend{display:flex;flex-wrap:wrap;gap:2mm 5mm;margin-top:3mm;font-size:7pt}.legend-item{display:flex;align-items:center;gap:1.2mm;white-space:nowrap}.legend-code{display:inline-grid;place-items:center;min-width:5mm;height:4.5mm;padding:0 .8mm;border-radius:1mm;background:var(--shift-color);color:var(--shift-text);font-weight:700}.print-note{margin:2.5mm 0 0;color:#697386;font-size:6.5pt}@media print{body{-webkit-print-color-adjust:exact;print-color-adjust:exact}.monthly-page{break-after:avoid}.month-grid{font-size:7pt}}
  </style></head><body><section class="monthly-page"><h1>Pianificazione turni</h1><h2>${escape(monthTitle)}</h2><table class="month-grid" style="--employee-column-width:${employeeWidth}mm"><colgroup><col style="width:var(--employee-column-width)">${month.dates.map(()=>'<col>').join('')}</colgroup><thead><tr><th class="employee">Dipendente</th>${month.dates.map(date=>`<th class="day-head ${date.weekend?'weekend ':''}${date.today?'today':''}"><span>${escape(date.weekday)}</span>${date.day}</th>`).join('')}</tr></thead><tbody>${month.rows.map(row=>`<tr><th scope="row" class="employee">${escape(row.name)}<small>${escape(row.total)}</small></th>${row.cells.map((cell,index)=>`<td class="${month.dates[index].weekend?'weekend ':''}${month.dates[index].today?'today':''}">${cell.abbreviation?`<span class="shift-code" style="--shift-color:${escape(cell.color)};--shift-text:${escape(cell.textColor)}" title="${escape(cell.type)}">${escape(cell.abbreviation)}</span>${cell.attendance?`<div class="attendance-times">${monthlyAttendanceLines(cell).slice(0,4).map(escape).join('<br>')}</div><div class="attendance-reason">${escape(cell.attendance.reason)}</div>`:''}`:''}</td>`).join('')}</tr>`).join('')}</tbody></table><div class="legend" aria-label="Legenda turni">${month.legend.map(item=>`<span class="legend-item"><span class="legend-code" style="--shift-color:${escape(item.color)};--shift-text:${escape(item.textColor)}">${escape(item.abbreviation)}</span><strong>${escape(item.type)}</strong>${item.time?` ${escape(item.time)}`:''}</span>`).join('')}</div><p class="print-note">P: pianificato · E: effettivo · +1: giorno successivo · —: orario non registrato. I totali sono ore pianificate. Formato consigliato: A3 orizzontale. Su A4 orizzontale selezionare “Adatta all’area stampabile”.</p></section></body></html>`;
}

export function printMonthlySchedule(month) {
  return new Promise((resolve,reject)=>{
    document.querySelector('iframe[data-turni-print]')?.remove();
    const frame=document.createElement('iframe');
    frame.dataset.turniPrint='true';frame.title='Stampa pianificazione mensile';frame.style.cssText='position:fixed;width:0;height:0;border:0;bottom:0;right:0';
    frame.onload=()=>{try{frame.contentWindow.addEventListener('afterprint',()=>frame.remove(),{once:true});frame.contentWindow.focus();frame.contentWindow.print();resolve();}catch(error){frame.remove();reject(error);}};
    frame.srcdoc=monthlyPrintDocument(month);document.body.appendChild(frame);
  });
}

export async function createMonthlySchedulePdf(month) {
  const [{jsPDF},{autoTable}]=await Promise.all([import('jspdf'),import('jspdf-autotable')]);
  const doc=new jsPDF({orientation:'landscape',unit:'mm',format:'a3'}),pageWidth=doc.internal.pageSize.getWidth(),pageHeight=doc.internal.pageSize.getHeight();
  const monthTitle=parseDate(month.start).toLocaleDateString('it-IT',{month:'long',year:'numeric'});
  doc.setProperties({title:`Pianificazione turni — ${monthTitle}`,subject:'Pianificazione mensile compatta',creator:'SHIFT PLANNER'});
  doc.setFont('helvetica','bold');doc.setFontSize(7);
  const employeeWidth=compactEmployeeColumnWidth(month.rows,value=>doc.getTextWidth(String(value)));
  autoTable(doc,{
    head:[['Dipendente',...month.dates.map(date=>`${date.weekday}\n${date.day}`)]],
    body:month.rows.map(row=>[`${row.name}\n${row.total}`,...row.cells.map(monthlyShiftText)]),
    startY:20,margin:{top:20,left:8,right:8,bottom:24},theme:'grid',pageBreak:'auto',rowPageBreak:'avoid',
    styles:{font:'helvetica',fontSize:6.5,cellPadding:1.1,halign:'center',valign:'middle',overflow:'linebreak',minCellHeight:5.2,lineColor:[213,220,232],lineWidth:.15},
    headStyles:{fillColor:[237,242,255],textColor:[37,59,108],fontStyle:'bold',fontSize:6},
    columnStyles:{0:{cellWidth:employeeWidth,halign:'left',fontSize:7,overflow:'hidden'}},
    willDrawPage:()=>{doc.setTextColor(32,39,55);doc.setFont('helvetica','bold');doc.setFontSize(16);doc.text('Pianificazione turni',8,12);doc.setFont('helvetica','normal');doc.setFontSize(9);doc.text(monthTitle,8,17);},
    didDrawPage:()=>{doc.setFontSize(6);doc.setTextColor(105,115,134);doc.text('P: pianificato · E: effettivo · +1: giorno successivo · —: orario non registrato · Totali: ore pianificate · A3 orizzontale · per A4 usare “Adatta all’area stampabile”',8,pageHeight-5);},
    didParseCell:hook=>{
      if(hook.column.index>0){const date=month.dates[hook.column.index-1];if(date?.weekend)hook.cell.styles.fillColor=[242,244,247];if(date?.today)hook.cell.styles.lineColor=[120,144,180];}
      if(hook.section==='body'&&hook.column.index>0){const cell=month.rows[hook.row.index]?.cells[hook.column.index-1];if(cell?.attendance){hook.cell.styles.fontSize=5.5;hook.cell.styles.cellPadding={top:.8,bottom:.8,left:.3,right:.3};}
      if(cell?.abbreviation){hook.cell.styles.fillColor=hexRgb(cell.color);hook.cell.styles.textColor=hexRgb(cell.textColor);hook.cell.styles.fontStyle='bold';}}
    }
  });
  const legendY=Math.min((doc.lastAutoTable?.finalY||20)+4,pageHeight-17);let x=8,y=legendY;
  doc.setFontSize(6.5);
  for(const item of month.legend){const label=`${item.abbreviation}  ${item.type}${item.time?`  ${item.time}`:''}`,width=Math.min(62,doc.getTextWidth(label)+10);if(x+width>pageWidth-8){x=8;y+=6;}if(y>pageHeight-8)break;doc.setFillColor(...hexRgb(item.color));doc.roundedRect(x,y-3.5,6,4.5,.7,.7,'F');doc.setTextColor(32,39,55);doc.text(label,x+8,y);x+=width;}
  return doc;
}
