// Synthetic showcase fixtures only; never derived from real accounts or exports.
import {LEGACY_SETTINGS as DEFAULT_SETTINGS} from './legacySettings.js';
import {makeLegacyShift as makeShift} from './testFixtures.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {reportWeeks} from './schedule.js';
import {compactEmployeeColumnWidth,createMonthlySchedulePdf,createSchedulePdf,monthlyPrintDocument,monthlySchedule,printDocument} from './export.js';

const monthFixture=()=>{
  const settings=structuredClone(DEFAULT_SETTINGS);
  settings.presets.custom=[{id:'night',name:'Turno notte',start:'23:00',end:'07:00',color:'#7C3AED'}];
  return {settings,data:{version:1,employees:[{id:'a',name:'Demo Sample 016 con un cognome molto lungo'},{id:'b',name:'DemoBeta'}],shifts:{
    'a|2024-02-01':makeShift('Mattina','','',settings),
    'a|2024-02-02':makeShift('Pomeriggio','','',settings),
    'a|2024-02-03':makeShift('Centrale','10','18',settings),
    'a|2024-02-04':makeShift('Riposo','','',settings),
    'a|2024-02-05':makeShift('Malattia','','',settings),
    'a|2024-02-06':makeShift('Ferie','','',settings),
    'b|2024-02-07':makeShift('custom:night','','',settings),
  }}};
};

test('stampa leggibile conserva una sezione e un salto pagina per ogni settimana',()=>{
  const {data}=monthFixture(),weeks=reportWeeks(data,'','2024-02-01','2024-02-29'),html=printDocument(weeks);
  assert.equal(weeks.length,5);
  assert.equal((html.match(/<section>/g)||[]).length,5);
  assert.match(html,/section\+section\{break-before:page\}/);
  assert.match(html,/Mattina<\/div><div class="shift-time">09:30 – 17:30/);
});

for(const [anchor,days] of [['2023-02-15',28],['2024-02-15',29],['2026-04-12',30],['2026-07-20',31]]){
  test(`stampa mensile usa tutti i ${days} giorni del mese in un solo layout`,()=>{
    const {data,settings}=monthFixture(),month=monthlySchedule(data,'',anchor,settings,'2024-02-03'),html=monthlyPrintDocument(month);
    assert.equal(month.dates.length,days);
    assert.equal(month.start,`${anchor.slice(0,7)}-01`);
    assert.equal((html.match(/<section class="monthly-page">/g)||[]).length,1);
    assert.equal((html.match(/class="day-head /g)||[]).length,days);
    assert.match(html,/@page\{size:A3 landscape/);
    assert.match(html,/A4 orizzontale.*Adatta all’area stampabile/);
  });
}

test('modalità mensile usa sigle stabili, colori, legenda e nessun orario nelle celle',()=>{
  const {data,settings}=monthFixture(),month=monthlySchedule(data,'','2024-02-15',settings,'2024-02-03'),html=monthlyPrintDocument(month);
  assert.deepEqual(month.rows[0].cells.slice(0,6).map(cell=>cell.abbreviation),['M','P','C','R','ML','F']);
  assert.equal(month.rows[1].cells[6].abbreviation,'TN');
  assert.deepEqual(month.legend.map(item=>item.abbreviation),['M','P','C','R','ML','F','TN']);
  assert.ok(month.legend.some(item=>item.type==='Turno notte'&&item.color==='#7C3AED'&&item.time==='23:00–07:00'));
  assert.match(html,/class="shift-code"[^>]*>M<\/span>/);
  assert.doesNotMatch(html,/class="shift-code"[^>]*>09:30/);
  assert.match(html,/class="legend-code"[^>]*>M<\/span><strong>Mattina<\/strong> 09:30–17:30/);
  assert.match(html,/class="day-head weekend today"/);
});

test('la colonna nomi mensile segue il nome più lungo, non va a capo e resta entro limiti compatti',()=>{
  const short=compactEmployeeColumnWidth([{name:'DemoAlpha'}]),long=compactEmployeeColumnWidth([{name:'DemoAlpha'},{name:'Demo Fixture 102'}]);
  assert.equal(short,22);
  assert.ok(long>short&&long<40);
  assert.equal(compactEmployeeColumnWidth([{name:'W'.repeat(200)}]),58);
  const {data,settings}=monthFixture(),html=monthlyPrintDocument(monthlySchedule(data,'','2024-02-15',settings));
  assert.match(html,new RegExp(`--employee-column-width:${compactEmployeeColumnWidth([{name:'Demo Sample 016 con un cognome molto lungo'},{name:'DemoBeta'}])}mm`));
  assert.match(html,/\.month-grid \.employee\{[^}]*white-space:nowrap/);
  assert.doesNotMatch(html,/<col style="width:14%">/);
});

test('PDF mensile è A3 orizzontale e resta su una pagina',async()=>{
  const {data,settings}=monthFixture(),month=monthlySchedule(data,'','2024-02-15',settings);
  const pdf=await createMonthlySchedulePdf(month),[width,height]=[pdf.internal.pageSize.getWidth(),pdf.internal.pageSize.getHeight()];
  assert.equal(pdf.getNumberOfPages(),1);
  assert.ok(width>height);
  assert.ok(width>400&&width<430);
  assert.ok(pdf.output().startsWith('%PDF-'));
});


const variationCases=[
 ['none',null,''],
 ['start only',{start:'10:30',end:null,reason:'Ritardo'},'10:30 – —'],
 ['end only',{start:undefined,end:'16:15',reason:'Uscita anticipata'},'— – 16:15'],
 ['both',{start:'10:45',end:'16:45',reason:'Altro',customReason:'Visita <medica>'},'10:45 – 16:45']
];
function attendanceFixture(){
 const settings=structuredClone(DEFAULT_SETTINGS),data={version:1,employees:[{id:'a',name:'Demo Sample 016'},{id:'b',name:'DemoBeta'}],shifts:{}},variations={};
 variationCases.forEach(([,variation],index)=>{const date=`2026-07-0${index+1}`;for(const employee of data.employees)data.shifts[`${employee.id}|${date}`]=makeShift('Mattina');if(variation)variations[`a|${date}`]={employeeId:'a',date,...variation};});
 // A variation attached to an absent/other shift must never leak into a cell.
 variations['a|2026-07-05']={start:'11:11',end:'22:22',reason:'Permesso'};
 return {data,settings,variations};
}

for(const [index,[name,variation,actual]] of variationCases.entries())test(`readable print/PDF: ${name} stays in the employee/date cell`,async()=>{
 const {data,variations}=attendanceFixture(),before=structuredClone({data,variations}),weeks=reportWeeks(data,'','2026-07-01','2026-07-05',variations),week=weeks[0];
 const html=printDocument(weeks),rows=[...html.matchAll(/<tbody>(.*?)<\/tbody>/gs)][0][1],cells=[...rows.matchAll(/<td>(.*?)<\/td>/gs)].map(match=>match[1]);
 const cell=cells[index+1];assert.match(cell,/09:30 – 17:30/);
 if(variation){assert.ok(cell.includes(`Eff. ${actual}`));assert.match(cell,/Pian\. 09:30/);assert.ok(cell.includes(name==='both'?'Visita &lt;medica&gt;':variation.reason));}else assert.doesNotMatch(cell,/Eff\.|Pian\./);
 assert.doesNotMatch(cells[index+8],/Eff\./);assert.doesNotMatch(html,/11:11|22:22/);
 const pdf=await createSchedulePdf(weeks),text=pdf.lastAutoTable.body[0].cells[index+1].text.join(' ');assert.match(text,/09:30/);assert.match(text,/17:30/);
 if(variation){assert.ok(text.includes(`Eff. ${actual}`));assert.ok(text.includes(name==='both'?'Visita <medica>':variation.reason));}else assert.doesNotMatch(text,/Eff\./);
 assert.doesNotMatch(pdf.lastAutoTable.body[1].cells[index+1].text.join(' '),/Eff\./);assert.deepEqual({data,variations},before);
});

test('monthly print/PDF includes planned and partial actual times only in matching cells',async()=>{
 const {data,settings,variations}=attendanceFixture(),month=monthlySchedule(data,'','2026-07-15',settings,'2026-07-01',variations),html=monthlyPrintDocument(month),pdf=await createMonthlySchedulePdf(month);
 assert.equal(pdf.getNumberOfPages(),1);assert.equal(month.rows[0].cells[0].attendance,undefined);
 for(const [index,[,variation,actual]] of variationCases.entries()){
  const cell=month.rows[0].cells[index],text=pdf.lastAutoTable.body[0].cells[index+1].text.join(' ');
  if(variation){assert.equal(cell.attendance.actual,actual);assert.equal(cell.attendance.planned,'09:30 – 17:30');assert.match(text,/P 09:30/);assert.match(text,/E /);assert.ok(text.includes(variation.start||'—'));assert.ok(text.includes(variation.end||'—'));}
  else assert.doesNotMatch(text,/P 09:30|E /);
  assert.equal(month.rows[1].cells[index].attendance,undefined);assert.doesNotMatch(pdf.lastAutoTable.body[1].cells[index+1].text.join(' '),/P 09:30|E /);
 }
 assert.match(html,/P: pianificato.*E: effettivo/);assert.match(html,/Visita &lt;medica&gt;/);assert.doesNotMatch(html,/11:11|22:22/);
 const selected=monthlySchedule(data,'b','2026-07-15',settings,'2026-07-01',variations);assert.equal(selected.rows.length,1);assert.ok(selected.rows[0].cells.every(cell=>!cell.attendance));
});


test('custom shift names containing a colon preserve planned/actual times and every attendance reason',async()=>{
 const {data,settings,variations}=attendanceFixture();settings.presets.custom=[{id:'night',name:'Turno: Notte',start:'22:00',end:'06:00',color:'#7C3AED'}];
 for(const reason of ['Ritardo','Uscita anticipata','Permesso','Malessere','Altro']){
  data.shifts['a|2026-07-01']=makeShift('custom:night','','',settings);variations['a|2026-07-01']={start:'23:00',end:'06:00',reason,customReason:'Motivo personalizzato'};
  const weeks=reportWeeks(data,'a','2026-07-01','2026-07-01',variations),html=printDocument(weeks),month=monthlySchedule(data,'a','2026-07-01',settings,'2026-07-01',variations),pdf=await createSchedulePdf(weeks);
  assert.match(html,/Turno: Notte/);assert.match(html,/Pian\. 22:00 – 06:00/);assert.match(html,/Eff\. 23:00 – 06:00/);assert.ok(html.includes(reason==='Altro'?'Motivo personalizzato':reason));assert.equal(month.rows[0].cells[0].attendance.actual,'23:00 – 06:00 (+1 giorno)');assert.match(pdf.lastAutoTable.body[0].cells[1].text.join(' '),/Eff\. 23:00 – 06:00/);
 }
});


test('dense monthly attendance paginates without an orphan title and keeps each employee row together',async()=>{
 const {data,settings}=attendanceFixture(),variations={};data.employees=Array.from({length:20},(_,i)=>({id:`e${i}`,name:`Dipendente ${i+1}`}));data.shifts={};
 for(const employee of data.employees){const key=`${employee.id}|2026-07-01`;data.shifts[key]=makeShift('Mattina');variations[key]={start:'10:30',end:'17:30',reason:'Ritardo'};}
 const month=monthlySchedule(data,'','2026-07-15',settings,'2026-07-01',variations),pdf=await createMonthlySchedulePdf(month),html=monthlyPrintDocument(month);
 assert.equal(pdf.lastAutoTable.startPageNumber,1);assert.equal(pdf.getNumberOfPages(),2);assert.equal(pdf.lastAutoTable.body.length,20);
 assert.equal((pdf.output().match(/\(Pianificazione turni\)/g)||[]).length,pdf.getNumberOfPages());
 for(const row of pdf.lastAutoTable.body)assert.ok(row.cells[1].text.join(' ').includes('E 10:30'));
 assert.match(html,/\.month-grid tr\{break-inside:avoid;page-break-inside:avoid/);
});

test('monthly overnight attendance uses compact next-day labels without clipping or guessing missing times',async()=>{
 const {data,settings,variations}=attendanceFixture();data.shifts['a|2026-07-01']=makeShift('Centrale','22','06');variations['a|2026-07-01']={start:'23:00',end:'06:00',reason:'Ritardo'};
 const month=monthlySchedule(data,'a','2026-07-01',settings,'2026-07-01',variations),html=monthlyPrintDocument(month),pdf=await createMonthlySchedulePdf(month);
 assert.match(html,/P 22:00<br>– 06:00 \+1<br>E 23:00<br>– 06:00 \+1/);assert.match(pdf.lastAutoTable.body[0].cells[1].text.join(' '),/E 23:00 – 06:00 \+1/);
 variations['a|2026-07-01'].start=null;assert.equal(monthlySchedule(data,'a','2026-07-01',settings,undefined,variations).rows[0].cells[0].attendance.actual,'— – 06:00');
});


test('overnight print keeps complete planned/actual ranges together and the next-day marker in the same cell',()=>{
 const {data,variations}=attendanceFixture();data.shifts['a|2026-07-01']=makeShift('Centrale','22','06');variations['a|2026-07-01']={start:'23:00',end:'06:00',reason:'Ritardo'};
 const html=printDocument(reportWeeks(data,'a','2026-07-01','2026-07-01',variations));
 assert.match(html,/<div class="shift-time">Pian\. 22:00 – 06:00<\/div><div class="shift-next-day">\(\+1 giorno\)<\/div>/);
 assert.match(html,/<div class="shift-actual">Eff\. 23:00 – 06:00<\/div><div class="shift-next-day">\(\+1 giorno\)<\/div>/);
});
