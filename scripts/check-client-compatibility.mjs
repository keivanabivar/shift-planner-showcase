// Synthetic showcase fixtures only; never derived from real accounts or exports.
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';

export async function checkClientCompatibility({page,login,logout,setCompatibility,getWrites,getAccount,legacyUrl}){
 await page.setViewportSize({width:1280,height:900});
 await mkdir('work/blocker-fix/browser',{recursive:true});
 for(const mode of ['schema029','closed030']){
  setCompatibility(mode==='schema029'?29:30,false);await login('A');
  await page.getByText('Dipendente A',{exact:true}).first().waitFor();
  await page.locator('.compatibility-notice').waitFor();
  assert.match(await page.locator('.compatibility-notice').innerText(),/Ricarica la pagina/);
  assert.equal(await page.locator('.compatibility-notice p').evaluate(node=>getComputedStyle(node).color),'rgb(92, 67, 12)');
  assert.equal(await page.getByRole('button',{name:'Aggiungi dipendente',exact:true}).isDisabled(),true);
  const before=getWrites(),accountBefore=structuredClone(getAccount());
  await page.getByRole('button',{name:'Stampa / Esporta PDF',exact:true}).click();await page.getByRole('dialog',{name:'Stampa ed esporta'}).waitFor();
  await page.locator('dialog .dialog-actions').getByRole('button',{name:'Chiudi',exact:true}).click();
  await page.getByRole('button',{name:'Account',exact:true}).click();await page.getByLabel('Nome utente',{exact:true}).fill('Must not save');
  await page.getByRole('button',{name:'Salva',exact:true}).click();
  await page.locator('.account-settings [role="alert"]').waitFor();
  assert.match(await page.locator('.account-settings [role="alert"]').innerText(),/Modifiche bloccate.*Ricarica/);
  assert.equal(getWrites(),before);assert.deepEqual(getAccount(),accountBefore);
  await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:'Pianificazione',exact:true}).click();
  assert.equal(await page.locator('.compatibility-notice').isVisible(),true);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
  await page.screenshot({path:`work/blocker-fix/browser/${mode}-mobile.png`,fullPage:true});
  await page.setViewportSize({width:1280,height:900});await logout();
 }
 setCompatibility(30,true);await page.goto(legacyUrl);await login('A');await page.getByText('Dipendente A',{exact:true}).first().waitFor();
 await page.getByRole('button',{name:'Impostazioni',exact:true}).click();
 const before=getWrites();await page.locator('[data-template-id]').first().getByLabel('Nome',{exact:true}).fill('Old browser rename');
 await page.getByRole('button',{name:'Salva turni predefiniti'}).click();
 await page.getByText('Impossibile completare l’operazione nel database.',{exact:true}).last().waitFor();assert.equal(getWrites(),before);
 await page.screenshot({path:'work/blocker-fix/browser/old029-closed-write.png',fullPage:true});
 await logout();await page.goto('http://127.0.0.1:5189');await page.getByRole('heading',{name:'Accedi',exact:true}).waitFor();
 console.log('Compatibility browser OK: new+029 readonly/export/account gate, closed030 desktop/mobile notice, frozen legacy frontend + current protocol cannot commit rename.');
}
