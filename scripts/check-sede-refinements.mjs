// Synthetic showcase fixtures only; never derived from real accounts or exports.
// Called by the isolated Auth/UI harness; no real accounts or hosted backend.
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {sortedCustomPresets} from '../src/schedule.js';

export async function checkSedeRefinements({page,data,extraBranches,deletedTemplates,preferences,login,logout}){
 const original=structuredClone(data.A),originalExtra=extraBranches.A,originalPrefs=structuredClone(preferences.A||{});
 const originalDeleted=structuredClone(deletedTemplates.A||[]);
 const a='branch-A',b='branch-review-B';
 const custom=[{id:'review-6h',branchId:a,name:'Beta',start:'16:00',end:'22:00',color:'#112233'},
  {id:'review-night',branchId:a,name:'Alfa',start:'22:30',end:'06:00',color:'#445566'},
  {id:'review-8h',branchId:a,name:'Gamma',start:'09:00',end:'17:00',color:'#778899'},
  {id:'review-other',branchId:b,name:'Beta',start:'16:00',end:'22:00',color:'#abcdef'}];
 extraBranches.A=[{id:b,name:'Demo Sample 030',active:true,readable:true,operable:true,admin:true}];
 data.A.data.employees=[{id:'employee-A',name:'Dipendente A',homeBranchId:a,branchIds:[a,b]},
  {id:'shared-review',name:'Éxample Fixturé',homeBranchId:a,branchIds:[a,b]},
  ...Array.from({length:100},(_,i)=>({id:'review-'+i,name:'Persona '+i,homeBranchId:i%2?a:b,branchIds:[i%2?a:b]}))];
 data.A.settings.presets.custom=custom;
 data.A.data.shifts={
  'employee-A|2026-08-15':{type:'Beta storico',presetId:'review-6h',presetName:'Beta storico',presetColor:'#112233',start:'17:00',end:'23:30',off:false,branchId:a},
  'employee-A|2026-10-15':{type:'Beta storico',presetId:'review-6h',presetName:'Beta storico',presetColor:'#998877',start:'17:00',end:'23:30',off:false,branchId:a},
  'shared-review|2026-10-15':{type:'Beta',presetId:'review-other',presetName:'Beta',presetColor:'#abcdef',start:'16:00',end:'22:00',off:false,branchId:b}
 };
 preferences.A={employee_column_width:190,employee_order:[],branch_preferences:{}};
 await login('A');await page.getByText('Dipendente A',{exact:true}).first().waitFor();
 const select=()=>page.locator('.workspace-header .branch-selector select');
 await select().selectOption(a);
 // Blocker 2: copied history keeps its name/hours while the backend resolves
 // only the destination's color. The source remains historical until an edit.
 await page.getByLabel('Vai alla data').fill('2026-10-15');await page.getByRole('button',{name:'Vai',exact:true}).click();
 const source=page.locator('tr[data-employee-id="employee-A"] td[data-planner-date="2026-10-15"] .shift-cell');
 const target=page.locator('tr[data-employee-id="employee-A"] td[data-planner-date="2026-10-16"] .shift-cell');
 const historical=structuredClone(data.A.data.shifts['employee-A|2026-10-15']);
 await source.dispatchEvent('click',{ctrlKey:true});await page.getByText(/^Copia rapida:/).waitFor();
 const copied=page.waitForResponse(r=>r.url().endsWith('/planner_apply_branch_operations')&&r.status()===200);
 await target.dispatchEvent('click',{ctrlKey:true});const copyReply=await copied;
 assert.equal(copyReply.request().postDataJSON().p_operations[0].presetColor,'#998877');
 await page.waitForFunction(()=>document.querySelector('tr[data-employee-id="employee-A"] td[data-planner-date="2026-10-16"] .shift-cell')?.textContent.includes('Beta'));
 assert.deepEqual(data.A.data.shifts['employee-A|2026-10-16'],{...historical,type:'Beta',presetName:'Beta',presetColor:'#112233'});
 assert.deepEqual(data.A.data.shifts['employee-A|2026-10-15'],historical);
 await page.waitForFunction(()=>getComputedStyle(document.querySelector('tr[data-employee-id="employee-A"] td[data-planner-date="2026-10-16"] .shift-cell')).backgroundColor==='rgb(17, 34, 51)');
 assert.equal(await page.getByText('Verifica del salvataggio non riuscita.',{exact:true}).count(),0);
 await page.getByRole('button',{name:'Annulla modalità',exact:true}).click();
 await page.getByRole('button',{name:'Impostazioni',exact:true}).click();
 await page.getByText('16:00–22:00 · 6 h',{exact:true}).waitFor();
 for(const key of ['name','start','end','duration'])for(const direction of ['asc','desc']){
  const saved=page.waitForResponse(r=>r.url().endsWith('/user_branch_planner_preferences_save')&&r.status()===200);
  await page.getByLabel('Ordina turni per').selectOption(key);await saved;
  const savedDirection=page.waitForResponse(r=>r.url().endsWith('/user_branch_planner_preferences_save')&&r.status()===200);
  await page.getByLabel('Direzione ordinamento').selectOption(direction);await savedDirection;
  const expected=sortedCustomPresets({presets:{custom:custom.filter(t=>t.branchId===a)},templateSort:{key,direction}}).map(t=>t.name);
  assert.deepEqual(await page.locator('.custom-preset-row input[maxlength="100"]').evaluateAll(nodes=>nodes.map(n=>n.value)),expected);
  await page.getByRole('button',{name:'Pianificazione',exact:true}).click();
  await page.locator('tr[data-employee-id="employee-A"] td[data-planner-date]:not([aria-hidden="true"]) .shift-cell').first().click();
  assert.deepEqual((await page.locator('dialog .preset-options button').allTextContents()).slice(0,3),expected);
  await page.getByRole('button',{name:'Chiudi',exact:true}).click();await page.getByRole('button',{name:'Impostazioni',exact:true}).click();
 }
 await page.reload();await page.getByText('Dipendente A',{exact:true}).first().waitFor();await select().selectOption(a);await page.getByRole('button',{name:'Impostazioni',exact:true}).click();
 assert.equal(await page.getByLabel('Ordina turni per').inputValue(),'duration');assert.equal(await page.getByLabel('Direzione ordinamento').inputValue(),'desc');
 await page.getByRole('button',{name:'Pianificazione',exact:true}).click();await page.getByRole('button',{name:'Aggiungi turno',exact:true}).click();
 assert.deepEqual((await page.locator('dialog .preset-options button').allTextContents()).slice(0,3),['Gamma','Alfa','Beta']);
 await page.getByRole('button',{name:'Chiudi',exact:true}).click();await page.getByRole('button',{name:'Impostazioni',exact:true}).click();
 const prior=structuredClone(data.A.data.shifts),row=page.locator('[data-template-id="review-6h"]');
 await row.getByLabel('Nome',{exact:true}).fill('Nuovo nome');await row.getByLabel('Ora di inizio').fill('08:00');await row.locator('input[type=color]').fill('#ccddaa');
 page.once('dialog',dialog=>dialog.dismiss());const savedColor=page.waitForResponse(r=>r.url().endsWith('/planner_apply_branch_operations')&&r.status()===200);await page.getByRole('button',{name:'Salva turni predefiniti'}).click();await savedColor;
 for(const [id,shift] of Object.entries(prior))assert.deepEqual(data.A.data.shifts[id],{...shift,...(shift.branchId===a?{type:'Nuovo nome',presetName:'Nuovo nome',presetColor:'#CCDDAA'}:{})});
 // Blocker 1: wait for the accepted authoritative snapshot, not just HTTP 200.
 await page.waitForFunction(()=>document.querySelector('[data-template-id="review-6h"] input[type=color]')?.value.toLowerCase()==='#ccddaa'&&!document.querySelector('[data-template-id="review-6h"] input[type=color]')?.disabled);
 assert.equal(await page.getByText('Verifica del salvataggio non riuscita.',{exact:true}).count(),0);
 await page.getByRole('button',{name:'Pianificazione',exact:true}).click();
 assert.equal(await target.evaluate(node=>getComputedStyle(node).backgroundColor),'rgb(204, 221, 170)');
 await page.getByRole('button',{name:'Riordina Éxample Fixturé'}).dragTo(page.locator('tr[data-employee-id="employee-A"]'),{targetPosition:{x:80,y:2}});
 await page.waitForFunction(()=>document.querySelector('.timeline-scroll tbody tr')?.dataset.employeeId==='shared-review');
 await select().selectOption(b);
 assert.equal(await page.locator('.timeline-scroll tbody tr').first().getAttribute('data-employee-id'),'employee-A');
 await page.getByRole('button',{name:'Riordina Persona 0'}).focus();await page.keyboard.press('ArrowUp');
 await page.waitForFunction(()=>document.querySelector('.timeline-scroll tbody tr:nth-child(2)')?.dataset.employeeId==='review-0');
 const bOrder=await page.locator('.timeline-scroll tbody tr').evaluateAll(rows=>rows.map(r=>r.dataset.employeeId));
 await select().selectOption(a);assert.equal(await page.locator('.timeline-scroll tbody tr').first().getAttribute('data-employee-id'),'shared-review');
 await page.reload();await select().waitFor();await select().selectOption(b);assert.deepEqual(await page.locator('.timeline-scroll tbody tr').evaluateAll(rows=>rows.map(r=>r.dataset.employeeId)),bOrder);
 await select().selectOption('all');assert.equal(await page.locator('.employee-drag-handle').count(),0);
 await page.getByRole('button',{name:'Utenti e accessi',exact:true}).click();await page.locator('.employee-assignment-group').first().waitFor();
 assert.equal(await page.locator('.employee-assignment-group').count(),2);assert.equal(await page.locator('.employee-assignment-group[open]').count(),0);
 await page.locator('.employee-assignment-group summary').first().click();assert.equal(await page.locator('.employee-assignment-list article:visible').count(),52);
 await page.getByLabel('Cerca dipendente',{exact:true}).fill('EXAMPLE FIXTURE');assert.equal(await page.locator('.employee-assignment-list article:visible').count(),2);
 await page.getByLabel('Filtra per Sede').selectOption(b);assert.equal(await page.locator('.employee-assignment-list article:visible').count(),1);
 await page.getByLabel('Cerca dipendente',{exact:true}).fill('missing name');await page.getByText('Nessun dipendente trovato.',{exact:true}).waitFor();
 await page.getByLabel('Cerca dipendente',{exact:true}).fill('EXAMPLE');
 await page.setViewportSize({width:390,height:844});
 await page.getByLabel('Filtra per Sede').scrollIntoViewIfNeeded();await page.waitForTimeout(100);
 assert.ok(await page.getByLabel('Filtra per Sede').isVisible());assert.equal(await page.locator('.employee-assignment-list article:visible').count(),1);
 await mkdir('work/sede-review',{recursive:true});await page.screenshot({path:'work/sede-review/access-mobile.png',fullPage:true});await page.screenshot({path:'work/sede-review/access-mobile-viewport.png'});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true,JSON.stringify(await page.evaluate(()=>[...document.querySelectorAll('main *')].filter(n=>n.getBoundingClientRect().right>innerWidth+1).map(n=>({tag:n.tagName,class:n.className,width:n.getBoundingClientRect().width,right:n.getBoundingClientRect().right})).slice(0,20))));
 await page.getByRole('button',{name:'Impostazioni',exact:true}).click();
 await page.screenshot({path:'work/sede-review/settings-mobile.png',fullPage:true});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
 await page.setViewportSize({width:1280,height:900});
 // Delete an existing template through the UI, then reload before copying its
 // stale historical snapshot. The mock retains DB color metadata separately.
 const removed={id:'review-deleted',branchId:a,name:'Template da eliminare',start:'22:00',end:'06:00',color:'#123456'};
 const sourceKey='employee-A|2026-10-15';
 const oldShift={type:'Nome storico eliminato',presetId:removed.id,presetName:'Nome storico eliminato',presetColor:'#778899',start:'23:15',end:'07:45',off:false,branchId:a};
 data.A.settings.presets.custom.push(removed);data.A.data.shifts[sourceKey]=oldShift;
 // Valid pre-029 linkage: the active template's alias collides with the exact
 // identity of a different template, which is then deleted through the UI.
 data.A.settings.presets.custom.find(t=>t.id==='review-6h').legacyPresetId=removed.id;
 await page.reload();await select().waitFor();await select().selectOption(a);await page.getByRole('button',{name:'Impostazioni',exact:true}).click();
 page.once('dialog',dialog=>dialog.accept());await page.locator('[data-template-id="review-deleted"]').getByRole('button',{name:'Elimina',exact:true}).click();
 const deletedReply=page.waitForResponse(r=>r.url().endsWith('/planner_apply_branch_operations')&&r.status()===200);
 await page.getByRole('button',{name:'Salva turni predefiniti'}).click();await deletedReply;
 // Settings remounts when its authoritative snapshot changes; wait for the
 // connected controls instead of the old component's transient saved message.
 await page.waitForFunction(()=>!document.querySelector('[data-template-id="review-deleted"]')&&
  [...document.querySelectorAll('button')].some(button=>button.textContent==='Salva turni predefiniti'&&!button.disabled));
 assert.equal(await page.getByText('Verifica del salvataggio non riuscita.',{exact:true}).count(),0);
 assert.equal(data.A.settings.presets.custom.some(t=>t.id===removed.id),false);
 assert.deepEqual(data.A.data.shifts[sourceKey],oldShift);
 await page.reload();await select().waitFor();await select().selectOption(a);await page.getByRole('button',{name:'Impostazioni',exact:true}).click();
 assert.equal(await page.locator('[data-template-id="review-deleted"]').count(),0);
 await page.getByRole('button',{name:'Pianificazione',exact:true}).click();
 for(const [width,date] of [[1280,'2026-10-17'],[390,'2026-10-18']]){
  await page.setViewportSize({width,height:900});
  const beforeCollision=structuredClone(data.A.data.shifts),beforeMetadata=structuredClone(deletedTemplates.A),color=width===1280?'#AABBCC':'#DDEEFF';
  await page.getByRole('button',{name:'Impostazioni',exact:true}).click();
  await page.locator('[data-template-id="review-6h"] input[type=color]').fill(color);
  const recolored=page.waitForResponse(r=>r.url().endsWith('/planner_apply_branch_operations')&&r.status()===200);
  await page.getByRole('button',{name:'Salva turni predefiniti'}).click();const colorReply=await recolored;
  assert.deepEqual(colorReply.request().postDataJSON().p_operations.map(op=>op.kind),['template_upsert']);
  await page.waitForFunction(()=>[...document.querySelectorAll('button')].some(button=>button.textContent==='Salva turni predefiniti'&&!button.disabled));
  assert.equal(await page.getByText('Verifica del salvataggio non riuscita.',{exact:true}).count(),0);
  for(const [id,shift] of Object.entries(beforeCollision))assert.deepEqual(data.A.data.shifts[id],{...shift,...(shift.branchId===a&&shift.presetId==='review-6h'?{presetColor:color}:{})});
  assert.deepEqual(data.A.data.shifts[sourceKey],oldShift,'colliding active color must not normalize deleted history');
  assert.deepEqual(deletedTemplates.A,beforeMetadata,'deleted-template color metadata stays authoritative');
  await page.getByRole('button',{name:'Pianificazione',exact:true}).click();
  await page.getByLabel('Vai alla data').fill('2026-10-15');await page.getByRole('button',{name:'Vai',exact:true}).click();
  const deletedSource=page.locator('tr[data-employee-id="employee-A"] td[data-planner-date="2026-10-15"] .shift-cell');
  const destination=page.locator('tr[data-employee-id="employee-A"] td[data-planner-date="'+date+'"] .shift-cell');
  assert.equal(await deletedSource.evaluate(node=>getComputedStyle(node).backgroundColor),'rgb(119, 136, 153)');
  assert.match(await deletedSource.getAttribute('aria-label'),/Nome storico eliminato.*23:15.*07:45/);
  await deletedSource.dispatchEvent('click',{ctrlKey:true});await page.getByText(/^Copia rapida:/).waitFor();
  const reply=page.waitForResponse(r=>r.url().endsWith('/planner_apply_branch_operations')&&r.status()===200);
  await destination.dispatchEvent('click',{ctrlKey:true});const response=await reply;
  assert.equal(response.request().postDataJSON().p_operations[0].presetColor,'#778899');
  await page.waitForFunction(date=>document.querySelector('tr[data-employee-id="employee-A"] td[data-planner-date="'+date+'"] .shift-cell')?.textContent.includes('Nome storico eliminato'),date);
  assert.deepEqual(data.A.data.shifts['employee-A|'+date],{...oldShift,presetColor:'#123456'});
  assert.deepEqual(data.A.data.shifts[sourceKey],oldShift);await page.waitForFunction(date=>getComputedStyle(document.querySelector('tr[data-employee-id="employee-A"] td[data-planner-date="'+date+'"] .shift-cell')).backgroundColor==='rgb(18, 52, 86)',date);assert.equal(await destination.evaluate(node=>getComputedStyle(node).backgroundColor),'rgb(18, 52, 86)');
  assert.equal(await page.getByText('Verifica del salvataggio non riuscita.',{exact:true}).count(),0);
  await page.getByRole('button',{name:'Annulla modalità',exact:true}).click();
 }
 await page.reload();await select().waitFor();await select().selectOption(a);await page.getByLabel('Vai alla data').fill('2026-10-15');await page.getByRole('button',{name:'Vai',exact:true}).click();
 const reloadedCopy=page.locator('tr[data-employee-id="employee-A"] td[data-planner-date="2026-10-17"] .shift-cell');
 assert.match(await reloadedCopy.getAttribute('aria-label'),/Nome storico eliminato/);assert.equal(await reloadedCopy.evaluate(node=>getComputedStyle(node).backgroundColor),'rgb(18, 52, 86)');
 await page.setViewportSize({width:1280,height:900});
 await logout();data.A=original;extraBranches.A=originalExtra;preferences.A=originalPrefs;deletedTemplates.A=originalDeleted;
 console.log('Sede browser OK: legacy collision color edit and deleted template after reload/copy on desktop + mobile, both persistence blockers, 8 sorts, Planner parity/reload, color-only snapshots, independent orders, 102 employees, search/groups, mobile layout.');
}
