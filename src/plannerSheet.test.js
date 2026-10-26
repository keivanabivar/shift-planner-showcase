// Synthetic showcase fixtures only; never derived from real accounts or exports.
import test from 'node:test';
import assert from 'node:assert/strict';
import {MAX_SHEET_SCALE,MIN_OVERVIEW_DAY_WIDTH,MIN_SHEET_SCALE,anchoredScroll,clampSheetScale,employeeInitials,fitSheetScale,sheetMetrics,touchPair} from './plannerSheet.js';

test('fit prioritizes readable dates and compact frozen initials across mobile ranges',()=>{
 for(const width of [320,360,390,430,844,915])for(const days of [7,18,31]){
  const metrics=sheetMetrics(fitSheetScale(width,days));
  assert.equal(metrics.employeeWidth,40);assert.equal(metrics.totalWidth,36);
  assert.ok(Math.abs(metrics.employeeWidth+metrics.totalWidth+metrics.dayWidth*days-Math.max(width,76+MIN_OVERVIEW_DAY_WIDTH*days))<1);
  assert.ok(metrics.fontSize>=9);assert.ok(metrics.headerFontSize>=9);assert.ok(metrics.dayWidth>=MIN_OVERVIEW_DAY_WIDTH);
  assert.ok(metrics.rowHeight>=18&&metrics.rowHeight<=60);
 }
});
test('7-day portrait fit has square cells; 31-day landscape fits all readable dates',()=>{
 const week=sheetMetrics(fitSheetScale(390,7)),month=sheetMetrics(fitSheetScale(844,31));
 assert.equal(week.dayWidth,week.rowHeight);
 assert.equal(month.dayWidth,month.rowHeight);
 assert.ok(month.dayWidth>24);assert.ok(month.headerFontSize>12);
});
test('31-day portrait fit keeps most dates visible without making numbers illegible',()=>{
 const metrics=sheetMetrics(fitSheetScale(390,31));
 assert.equal(metrics.dayWidth,14);assert.equal(metrics.headerFontSize,9);
 assert.equal(Math.floor((390-metrics.employeeWidth-metrics.totalWidth)/metrics.dayWidth),22);
});
test('employee initials use the first and last word and normalize whitespace/case',()=>{
 for(const [name,initials] of [
  ['Demo Fixture Alpha','DA'],['Demo Fixture Beta','DB'],
  ['  demo\t fixture alpha \n','DA'],['Demo Middle Fixture Gamma','DG'],
  ['Éxample Fixturé','ÉF'],['E\u0301xample Fixturé','ÉF']
 ])assert.equal(employeeInitials(name),initials);
});
test('one-word employee initials use the first and last character',()=>{
 for(const [name,initials] of [['DemoX','DX'],[' demox ','DX'],['DemoZ','DZ'],['DëmoZ','DZ'],['Q','QQ']])assert.equal(employeeInitials(name),initials);
});
test('initials have a safe empty fallback and never alter the employee name',()=>{
 for(const name of ['', '  ',null,undefined])assert.equal(employeeInitials(name),'—');
 const employee={name:'  Demo Fixture Alpha  '};assert.equal(employeeInitials(employee.name),'DA');assert.equal(employee.name,'  Demo Fixture Alpha  ');
});
test('zoom limits remain finite and a sheet cannot collapse',()=>{
 assert.equal(clampSheetScale(-4),MIN_SHEET_SCALE);
 assert.equal(clampSheetScale(100),MAX_SHEET_SCALE);
 assert.equal(clampSheetScale(NaN),1);
 assert.equal(clampSheetScale(0),1);
});
test('pinch anchoring preserves the content point under the fingers',()=>{
 const left=180,anchor=80,oldWidth=36,newWidth=72;
 const next=anchoredScroll(left,anchor,oldWidth,newWidth);
 assert.equal((next+anchor)/newWidth,(left+anchor)/oldWidth);
 assert.equal(anchoredScroll(0,0,72,36),0);
 assert.deepEqual(touchPair([{x:10,y:20},{x:70,y:100}]),{x:40,y:60,distance:100});
 assert.equal(touchPair([{x:10,y:10},{x:10,y:10}]).distance,1);
});
