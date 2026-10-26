// Synthetic showcase fixtures only; never derived from real accounts or exports.
// Runs inside the existing mocked Auth/UI harness. All data is synthetic.
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';

export async function checkMobilePlanner({page,cdp,getWrites,screenshotDir='/private/tmp/shift-planner-mobile'}){
 await mkdir(screenshotDir,{recursive:true});
 await cdp.send('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:5});
 await page.getByRole('button',{name:'Oggi',exact:true}).click();
 const snapshot=()=>page.evaluate(()=>({range:document.querySelector('.schedule')?.getAttribute('aria-label'),dates:[...document.querySelectorAll('[data-range-date]:not([aria-hidden="true"])')].map(node=>node.dataset.rangeDate)}));
 const scale=async()=>Number(await page.locator('.mobile-sheet').getAttribute('data-sheet-scale'));
 const touch=async(type,points)=>{await cdp.send('Input.dispatchTouchEvent',{type,touchPoints:points.map((point,index)=>({id:index+1,x:point.x,y:point.y,radiusX:2,radiusY:2}))});await page.waitForTimeout(35);};
 const tap=async locator=>{const box=await locator.boundingBox();assert.ok(box);await touch('touchStart',[{x:box.x+box.width/2,y:box.y+box.height/2}]);await touch('touchEnd',[]);};
 const reveal=async()=>{const box=await page.locator('.mobile-reveal-zone').boundingBox(),x=box.x+box.width/2,y=box.y+14;await touch('touchStart',[{x,y}]);await touch('touchMove',[{x,y:y+25}]);await touch('touchEnd',[]);await page.locator('.mobile-planner-controls').waitFor();};
 const hide=async()=>{await page.getByRole('button',{name:'Nascondi controlli pianificazione'}).click();await page.locator('.mobile-planner-controls').waitFor({state:'detached'});};
 const noOverflow=async()=>assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1),true,'page shell must not overflow');
 const dialogFits=async()=>{const box=await page.getByRole('dialog').boundingBox(),size=page.viewportSize();assert.ok(box.x>=0&&box.y>=0&&box.x+box.width<=size.width+1&&box.y+box.height<=size.height+1,'dialog fits the viewport');};
 const writesBefore=getWrites();
 for(const [device,portrait,landscape] of [
  ['compact',{width:390,height:844},{width:844,height:390}],
  ['wide',{width:412,height:915},{width:915,height:412}]
 ]){
  await page.setViewportSize(portrait);await page.waitForTimeout(150);await noOverflow();
  assert.ok(await page.locator('.sidebar').isVisible());
  await page.screenshot({path:join(screenshotDir,`${device}-portrait-normal.png`),fullPage:true});
  const before=await snapshot();await page.getByRole('button',{name:'Apri tabella a schermo intero'}).click();
  await page.locator('.mobile-sheet').waitFor();await page.waitForTimeout(100);
  assert.equal(await page.locator('.sidebar').isVisible(),false);assert.deepEqual(await snapshot(),before);
  const sheetBox=await page.locator('.timeline-scroll').boundingBox();assert.ok(sheetBox.height>portrait.height*.9);assert.ok(sheetBox.width>=portrait.width-1);
  const bar=await page.locator('.mobile-planner-controls').boundingBox();assert.ok(bar.height<=78&&bar.height<portrait.height*.15,'controls occupy at most two small rows');
  assert.equal(await page.locator('.mobile-sheet table').evaluate(node=>getComputedStyle(node).opacity),'1');
  assert.equal(await page.locator('.mobile-planner-controls p').count(),0);
  assert.equal(await page.locator('tr[data-employee-id="employee-A"] .employee-name').textContent(),'DA');
  assert.equal(await page.locator('tr[data-employee-id="employee-A"] .employee-name').getAttribute('title'),'Dipendente A');
  assert.equal(await page.locator('.mobile-sheet thead').evaluate(node=>node.getBoundingClientRect().height)<=26,true);
  await page.screenshot({path:join(screenshotDir,`${device}-controls.png`)});await hide();
  await page.screenshot({path:join(screenshotDir,`${device}-7-days-fit.png`)});
  await page.screenshot({path:join(screenshotDir,`${device}-portrait-immersive.png`)});
  const assigned=page.locator('tr[data-employee-id="mobile-0"] td[data-planner-date="2026-09-25"] button:not(.unassigned)');
  if(await assigned.count()){
   assert.equal(await assigned.locator('strong').textContent(),'M2');assert.equal(await assigned.locator('small:not(.shift-branch-label)').count(),0);
   await tap(assigned);await page.getByRole('heading',{name:'Organizza il turno'}).waitFor();
   assert.ok((await page.getByRole('dialog').innerText()).includes('Persona mobile 1'));
   assert.ok(await page.getByRole('dialog').getByRole('button',{name:'Magazzino 2',exact:true}).isVisible());
   await page.getByRole('button',{name:'Chiudi',exact:true}).click();
  }
  await reveal();
  const navigationState=await snapshot();await page.getByRole('button',{name:'Intervallo successivo'}).click();assert.notDeepEqual((await snapshot()).dates,navigationState.dates);await page.getByRole('button',{name:'Intervallo precedente'}).click();assert.deepEqual(await snapshot(),navigationState);
  const sede=page.locator('.mobile-planner-controls').getByLabel('Sede',{exact:true});
  if(await sede.count()){await sede.selectOption('all');assert.equal(await sede.inputValue(),'all');await sede.selectOption('branch-A');assert.equal(await sede.inputValue(),'branch-A');}
  if(device==='compact'){
   // Inactivity uses real timers; focus within a control keeps it available.
   await page.locator('.mobile-reveal-zone').focus();
   await page.waitForTimeout(6200);assert.equal(await page.locator('.mobile-planner-controls').count(),0);await reveal();
   await page.getByLabel('Giorni nella tabella mobile').focus();await page.waitForTimeout(6200);assert.equal(await page.locator('.mobile-planner-controls').count(),1);
  }
  for(const days of [7,18,31]){
   await page.getByLabel('Giorni nella tabella mobile').selectOption(String(days));await page.waitForTimeout(80);
   assert.equal((await snapshot()).dates.length,days);assert.equal((await snapshot()).range,`Pianificazione su ${days} giorni`);
   assert.equal(await page.locator('[data-range-date][aria-hidden="true"]').count(),0);
   await page.getByRole('button',{name:'Adatta',exact:true}).click();
   const fitMetrics=await page.locator('.timeline-scroll').evaluate(node=>({scroll:node.scrollWidth,client:node.clientWidth,table:node.querySelector('table').getBoundingClientRect().width,employee:node.querySelector('thead th').getBoundingClientRect().width,total:node.querySelector('thead th:last-child').getBoundingClientRect().width,day:node.querySelector('thead th:nth-child(2)').getBoundingClientRect().width}));
   assert.ok(fitMetrics.day>=13.9,JSON.stringify({days,...fitMetrics}));
   if(days<=18)assert.ok(fitMetrics.scroll<=fitMetrics.client+2,JSON.stringify({days,...fitMetrics}));
   else assert.ok(Math.floor((fitMetrics.client-fitMetrics.employee-fitMetrics.total)/fitMetrics.day)>=22);
   assert.ok(await page.locator('[data-range-date] strong').evaluateAll(nodes=>nodes.every(node=>parseFloat(getComputedStyle(node).fontSize)>=9)));
   const compactRow=await page.locator('.mobile-sheet tbody tr').first().boundingBox();const hasBranchMarker=await page.locator('.mobile-sheet tbody tr').first().locator('.shift-branch-label').count()>0;assert.ok(compactRow.height<=Math.max(hasBranchMarker?23:19,fitMetrics.day)+1);
  }
  await hide();await page.screenshot({path:join(screenshotDir,`${device}-31-days-fit.png`)});
  // Real browser touch events, including contacts starting on actual shift cells.
  const box=await page.locator('.timeline-scroll').boundingBox(),cx=box.x+box.width*.63,cy=box.y+120,initialScale=await scale();
  await touch('touchStart',[{x:cx-25,y:cy},{x:cx+25,y:cy}]);
  for(const distance of [40,55,75,95])await touch('touchMove',[{x:cx-distance,y:cy},{x:cx+distance,y:cy}]);
  await touch('touchEnd',[]);assert.ok(await scale()>initialScale*2);assert.equal(await page.locator('dialog[open]').count(),0);
  assert.equal(await page.evaluate(()=>window.visualViewport.scale),1,'browser page must not pinch zoom');
  await page.screenshot({path:join(screenshotDir,`${device}-zoomed-in.png`)});
  const beforePan=await page.locator('.timeline-scroll').evaluate(node=>({x:node.scrollLeft,y:node.scrollTop}));
  await touch('touchStart',[{x:cx,y:cy+80}]);
  for(const amount of [20,45,70,100])await touch('touchMove',[{x:cx-amount,y:cy+80-amount}]);
  await touch('touchEnd',[]);
  const afterPan=await page.locator('.timeline-scroll').evaluate(node=>({x:node.scrollLeft,y:node.scrollTop}));
  assert.ok(afterPan.x>beforePan.x);assert.ok(afterPan.y>beforePan.y);assert.equal(await page.locator('dialog[open]').count(),0);
  // Both frozen axes still hold their positions after pan.
  const sticky=await page.locator('.timeline-scroll').evaluate(node=>({left:node.getBoundingClientRect().left,name:node.querySelector('tbody th').getBoundingClientRect().left,top:node.getBoundingClientRect().top,header:node.querySelector('thead').getBoundingClientRect().top}));
  assert.ok(Math.abs(sticky.name-sticky.left)<2);assert.ok(Math.abs(sticky.header-sticky.top)<2);
  const zoomedScale=await scale();
  await touch('touchStart',[{x:cx-70,y:cy},{x:cx+70,y:cy}]);await touch('touchMove',[{x:cx-40,y:cy},{x:cx+40,y:cy}]);await touch('touchEnd',[]);
  assert.ok(await scale()<zoomedScale);assert.equal(await page.locator('dialog[open]').count(),0);
  // Orientation changes keep date/range/zoom and an open editor, without reload.
  await page.locator('.timeline-scroll').evaluate(node=>{node.scrollLeft=0;node.scrollTop=0});
  await page.waitForTimeout(400);
  const target=page.locator('.mobile-sheet tbody tr').first().locator('td[data-planner-date]').first().locator('button');
  const targetLabel=await target.getAttribute('aria-label');await tap(target);
  await page.getByRole('heading',{name:'Organizza il turno'}).waitFor();assert.ok((await page.getByRole('dialog').innerText()).includes(targetLabel.split(',')[0]));await dialogFits();
  const rotationState=await snapshot(),rotationScale=await scale(),navigation=await page.evaluate(()=>performance.timeOrigin);
  await page.setViewportSize(landscape);await page.waitForTimeout(150);await dialogFits();
  assert.deepEqual(await snapshot(),rotationState);assert.equal(await scale(),rotationScale);assert.equal(await page.evaluate(()=>performance.timeOrigin),navigation);
  await page.getByRole('button',{name:'Chiudi',exact:true}).click();await noOverflow();
  const landscapeBox=await page.locator('.timeline-scroll').boundingBox();assert.ok(landscapeBox.width>=landscape.width-1);assert.ok(landscapeBox.height>landscape.height*.9);
  await reveal();await page.getByRole('button',{name:'Adatta',exact:true}).click();await hide();
  assert.ok(await page.locator('.timeline-scroll').evaluate(node=>node.scrollLeft===0&&node.scrollTop===0));
  await page.screenshot({path:join(screenshotDir,`${device}-landscape-immersive.png`)});
  await reveal();const landscapeBar=await page.locator('.mobile-planner-controls').boundingBox();assert.ok(landscapeBar.height<=42&&landscapeBar.height<landscape.height*.15,'landscape controls occupy one row');
  await page.screenshot({path:join(screenshotDir,`${device}-landscape-controls.png`)});await hide();
  // Tap after reset is reliable; browser cancellation cannot leave a gesture stuck.
  await reveal();await page.getByLabel('Giorni nella tabella mobile').selectOption('7');await hide();
  await tap(page.locator('.mobile-sheet tbody tr').first().locator('td[data-planner-date] button').first());await page.getByRole('heading',{name:'Organizza il turno'}).waitFor();await page.getByRole('button',{name:'Chiudi',exact:true}).click();
  const cancelBox=await page.locator('.timeline-scroll').boundingBox();await touch('touchStart',[{x:cancelBox.x+200,y:cancelBox.y+100}]);await touch('touchCancel',[]);await page.waitForTimeout(400);
  await tap(page.locator('.mobile-sheet tbody tr').first().locator('td[data-planner-date] button').first());await page.getByRole('heading',{name:'Organizza il turno'}).waitFor();await page.getByRole('button',{name:'Chiudi',exact:true}).click();
  await page.getByRole('button',{name:'Esci dalla tabella a schermo intero'}).click();
  assert.equal(await page.locator('.mobile-sheet').count(),0);assert.ok(await page.locator('.sidebar').isVisible());await noOverflow();
 }
 assert.equal(getWrites(),writesBefore,'navigation gestures and opening/cancelling editors never save data');
 await page.setViewportSize({width:1280,height:900});await cdp.send('Emulation.setTouchEmulationEnabled',{enabled:false});
 assert.ok(await page.locator('.sidebar').isVisible());assert.ok(await page.getByRole('button',{name:'Settimana',exact:true}).isVisible());assert.equal(await page.locator('.mobile-planner-entry').count(),0);
 console.log('Mobile browser OK: compact/wide browser portrait + landscape, 7/18/31 days, real touch pinch/pan, frozen axes, editors, rotation, compact initials/grid/top-bar and zero gesture writes.');
}
