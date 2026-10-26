// Synthetic showcase fixtures only; never derived from real accounts or exports.
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';

export async function checkPlannerReview({page,data,extraBranches,preferences,login,logout}){
 const original=structuredClone(data.A),extra=extraBranches.A,prefs=structuredClone(preferences.A||{}),a='branch-A',b='branch-review030-B';
 const template={id:'review030-template',branchId:a,name:'Mattina review',start:'08:00',end:'15:00',color:'#112233'};
 extraBranches.A=[{id:b,name:'Demo Branch Beta',active:true,readable:true,operable:true,admin:true}];
 data.A.data.employees=[{id:'review030-a',name:'Demo Sample 016',homeBranchId:a,branchIds:[a,b]},{id:'review030-z',name:'Demo Sample 017',homeBranchId:a,branchIds:[a,b]}];
 data.A.settings.presets.custom=[template];data.A.settings.statusStyles={};
 const assigned={type:template.name,presetId:template.id,presetName:template.name,presetColor:template.color,start:'07:30',end:'15:45',off:false,branchId:a};
 data.A.data.shifts={'review030-z|2026-09-27':{...assigned},'review030-z|2026-10-15':{...assigned},'review030-z|2026-10-16':{type:'Notte esterna',start:'22:00',end:'06:00',off:false,branchId:b}};
 preferences.A={employee_column_width:190,employee_order:[],hidden_employee_ids:[],branch_preferences:{[a]:{employee_order:['review030-z','review030-a']}}};
 await login('A');await page.getByText('Demo Sample 017',{exact:true}).first().waitFor();
 await page.locator('.workspace-header .branch-selector select').selectOption(a);
 await page.getByLabel('Vai alla data').fill('2026-10-15');await page.getByRole('button',{name:'Vai',exact:true}).click();
 assert.deepEqual(await page.locator('.timeline-scroll tbody tr').evaluateAll(rows=>rows.map(r=>r.dataset.employeeId)),['review030-z','review030-a']);
 await page.getByRole('button',{name:'Stampa / Esporta PDF',exact:true}).click();await page.getByRole('dialog',{name:'Stampa ed esporta'}).waitFor();
 await page.getByLabel('Dipendenti da includere').selectOption('one');assert.deepEqual(await page.getByLabel('Dipendente',{exact:true}).locator('option').allTextContents(),['Demo Sample 017','Demo Sample 016']);
 await page.getByLabel('Dipendenti da includere').selectOption('all');
 await page.getByRole('button',{name:'Stampa',exact:true}).click();await page.locator('iframe[data-turni-print]').waitFor({state:'attached'});
 const frame=page.frameLocator('iframe[data-turni-print]');await frame.getByText('Non assegnato',{exact:true}).first().waitFor({state:'attached'});
 assert.equal((await frame.locator('tbody tr').first().locator('td').first().textContent()).trim(),'Demo Sample 017');assert.equal(await frame.getByText('Demo Branch Beta',{exact:true}).count(),0);
 await page.getByLabel('Mostra anche i turni nelle altre sedi').check();await page.getByRole('button',{name:'Stampa',exact:true}).click();
 await frame.getByText('Demo Branch Beta',{exact:true}).waitFor({state:'attached'});assert.match(await frame.locator('tbody tr').first().innerText(),/8 h · Demo Branch Beta/);assert.match(await frame.locator('tbody tr').first().innerText(),/16 h 15 min · Totale/);
 await page.getByText('Stampa mensile compatta',{exact:true}).click();const download=page.waitForEvent('download');await page.getByRole('button',{name:'Esporta PDF',exact:true}).click();const file=await download;assert.equal(file.suggestedFilename(),'turni_mensile_ottobre_2026.pdf');
 await mkdir('work/review030',{recursive:true});await file.saveAs('work/review030/mensile.pdf');await page.locator('dialog .dialog-actions').getByRole('button',{name:'Chiudi',exact:true}).click();
 // Names/time decisions and the permanent semantic identity of status styles.
 await page.getByRole('button',{name:'Impostazioni',exact:true}).click();assert.equal(await page.getByLabel('Nome utente',{exact:true}).count(),0);assert.equal(await page.getByText('Backup dei dati',{exact:true}).count(),1);
 const row=page.locator('[data-template-id="review030-template"]');await row.getByLabel('Nome',{exact:true}).fill('Mattina nuova');await row.getByLabel('Ora di inizio').fill('09:00');await row.getByLabel('Ora di fine').fill('16:00');
 page.once('dialog',d=>{assert.match(d.message(),/da domani.*personalizzati/);d.dismiss();});const noReply=page.waitForResponse(r=>r.url().endsWith('/planner_apply_branch_operations')&&r.status()===200);await page.getByRole('button',{name:'Salva turni predefiniti'}).click();await noReply;
 await page.waitForFunction(()=>document.querySelector('[data-template-id="review030-template"] input')?.value==='Mattina nuova');
 for(const date of ['2026-09-27','2026-10-15']){assert.equal(data.A.data.shifts['review030-z|'+date].presetName,'Mattina nuova');assert.equal(data.A.data.shifts['review030-z|'+date].start,'07:30');}
 await row.getByLabel('Ora di inizio').fill('10:00');page.once('dialog',d=>d.accept());const yesReply=page.waitForResponse(r=>r.url().endsWith('/planner_apply_branch_operations')&&r.status()===200);await page.getByRole('button',{name:'Salva turni predefiniti'}).click();await yesReply;assert.equal(data.A.data.shifts['review030-z|2026-10-15'].start,'10:00');assert.equal(data.A.data.shifts['review030-z|2026-09-27'].start,'07:30');
 await page.getByLabel('Nome visualizzato Riposo').fill('Giorno libero');await page.getByLabel('Colore Riposo',{exact:true}).fill('#abcdef');const stylesReply=page.waitForResponse(r=>r.url().endsWith('/planner_apply_branch_operations')&&r.status()===200);await page.getByRole('button',{name:'Salva turni predefiniti'}).click();await stylesReply;
 await page.getByRole('button',{name:'Pianificazione',exact:true}).click();const target=()=>page.locator('tr[data-employee-id="review030-a"] td[data-planner-date="2026-10-15"] .shift-cell');
 await target().click();await page.getByRole('button',{name:'Giorno libero',exact:true}).click();await page.waitForFunction(()=>document.querySelector('tr[data-employee-id="review030-a"] td[data-planner-date="2026-10-15"] .shift-cell')?.textContent.includes('Giorno libero'));
 assert.equal(data.A.data.shifts['review030-a|2026-10-15'].type,'Riposo');await page.waitForFunction(()=>getComputedStyle(document.querySelector('tr[data-employee-id="review030-a"] td[data-planner-date="2026-10-15"] .shift-cell')).backgroundColor==='rgb(171, 205, 239)');
 const undo=()=>page.locator('.page-heading').getByRole('button',{name:'Annulla',exact:true});assert.equal(await undo().isEnabled(),true);
 await undo().click();await page.waitForFunction(()=>!document.querySelector('tr[data-employee-id="review030-a"] td[data-planner-date="2026-10-15"] .shift-cell')?.textContent.includes('Giorno libero'));assert.equal(data.A.data.shifts['review030-a|2026-10-15'],undefined);
 // Interleaved order + shift Undo and text-input Cmd/Ctrl+Z isolation.
 await target().click();await page.getByRole('button',{name:'Giorno libero',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('dialog'));
 const orderReply=page.waitForResponse(r=>r.url().endsWith('/user_branch_employee_order_save')&&r.status()===200);await page.getByRole('button',{name:'Riordina Demo Sample 016'}).focus();await page.keyboard.press('ArrowUp');await orderReply;
 await page.waitForFunction(()=>document.querySelector('.timeline-scroll tbody tr')?.dataset.employeeId==='review030-a');
 await page.locator('.page-heading h1').click();await page.keyboard.press('Control+z');await page.waitForFunction(()=>document.querySelector('.timeline-scroll tbody tr')?.dataset.employeeId==='review030-z');
 await page.keyboard.press('Meta+z');await page.waitForFunction(()=>!document.querySelector('tr[data-employee-id="review030-a"] td[data-planner-date="2026-10-15"] .shift-cell')?.textContent.includes('Giorno libero'));
 assert.equal(data.A.data.shifts['review030-a|2026-10-15'],undefined);
 await page.getByRole('button',{name:'Account',exact:true}).click();await page.getByLabel('Nome utente',{exact:true}).waitFor();assert.equal(await page.getByRole('heading',{name:'Turni predefiniti'}).count(),0);
 await page.getByRole('button',{name:'Backup dei dati',exact:true}).click();assert.equal(await page.getByRole('heading',{name:'Turni predefiniti'}).count(),0);
 await page.getByRole('button',{name:'Utenti e accessi',exact:true}).click();assert.equal(await page.locator('.invite-form').count(),0);
 await page.getByRole('button',{name:'Invita utente',exact:true}).click();await page.locator('.invite-form').waitFor();assert.equal(await page.getByRole('heading',{name:'Utenti',exact:true}).count(),0);
 // Mobile and reload persist styles/order; history deliberately expires on reload.
 await page.reload();await page.getByText('Demo Sample 017',{exact:true}).first().waitFor();await page.locator('.workspace-header .branch-selector select').selectOption(a);assert.equal(await undo().isDisabled(),true);
 await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:'Impostazioni',exact:true}).click();await page.getByLabel('Nome visualizzato Riposo').waitFor();assert.equal(await page.getByLabel('Nome visualizzato Riposo').inputValue(),'Giorno libero');assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);await page.screenshot({path:'work/review030/settings-mobile.png',fullPage:true});
 await page.getByRole('button',{name:'Pianificazione',exact:true}).click();assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);await page.screenshot({path:'work/review030/planner-mobile.png',fullPage:true});
 await page.setViewportSize({width:1280,height:900});await logout();data.A=original;extraBranches.A=extra;preferences.A=prefs;
 console.log('030 browser OK: Planner/PDF order, other Sedi toggle + totals, monthly filename, rename + No/Yes time choice, semantic statuses, button/Ctrl/Meta Undo interleaved with order, isolated navigation, reload + mobile.');
}
