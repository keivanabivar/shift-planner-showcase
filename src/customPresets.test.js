// Synthetic showcase fixtures only; never derived from real accounts or exports.
import {LEGACY_SETTINGS as DEFAULT_SETTINGS} from './legacySettings.js';
import {makeLegacyShift as makeShift} from './testFixtures.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {validSettings} from './preferences.js';
import {applyPresetSettings,customPresets,minutes,reportPeriod,scheduleTypes,shiftOptions,shiftType,validData} from './schedule.js';
import {copyShiftValue} from './copyShifts.js';
import {backupText,parseBackup} from './persistence.js';
import {emptySnapshot,sameSnapshot} from './plannerStore.js';
import {buildHoursReport} from './hoursReport.js';
import {printDocument} from './export.js';
import {filterSchedule,EMPTY_SCHEDULE_FILTERS} from './filters.js';

const settings=()=>{const value=structuredClone(DEFAULT_SETTINGS);value.presets.custom=[{id:'night-id',name:'Notte',start:'23:00',end:'07:00',color:'#7C3AED'}];return value;};
test('preset personalizzato usa ID stabile, turno notturno e colore',()=>{
 const s=settings(),shift=makeShift('custom:night-id','','',s);
 assert.deepEqual(shift,{type:'Notte',presetId:'night-id',presetName:'Notte',presetColor:'#7C3AED',start:'23:00',end:'07:00',off:false});
 assert.equal(minutes(shift),480);assert.equal(shiftType(shift),'Notte');assert.ok(validSettings(s));assert.ok(validData({version:1,employees:[{id:'a',name:'Demo Sample 016'}],shifts:{'a|2026-09-26':shift}}));
});
test('modifica preset conserva usi esistenti, report, stampa, filtri e copia',()=>{
 const first=settings(),data={version:1,employees:[{id:'a',name:'Demo Sample 016'}],shifts:{'a|2026-09-26':makeShift('custom:night-id','','',first)}};
 const changed=settings();changed.presets.custom[0]={...changed.presets.custom[0],name:'Notte lunga',start:'22:00',end:'07:00',color:'#0EA5E9'};
 const updated=applyPresetSettings(data,changed),shift=updated.shifts['a|2026-09-26'];assert.equal(shift.type,'Notte');assert.equal(minutes(shift),480);assert.equal(shift.presetId,'night-id');
 assert.equal(reportPeriod(updated,'a','2026-09-26','2026-09-26').rows[0].total,'8 h');assert.equal(buildHoursReport(updated,{},['a'],'2026-09-26','2026-09-26')[0].planned,480);
 assert.match(printDocument([reportPeriod(updated,'a','2026-09-26','2026-09-26')]),/Notte/);
 assert.deepEqual([...filterSchedule(updated,{}, {...EMPTY_SCHEDULE_FILTERS,shiftTypes:['Notte']},['2026-09-26']).visibleKeys],['a|2026-09-26']);
 assert.deepEqual(copyShiftValue(shift,changed),shift);assert.ok(scheduleTypes(changed,updated).includes('Notte lunga'));
});
test('eliminare il preset conserva turni storici e backup completo',()=>{
 const s=settings(),snapshot={...emptySnapshot(),settings:s,data:{version:1,employees:[{id:'a',name:'Demo Sample 016'}],shifts:{'a|2026-09-26':makeShift('custom:night-id','','',s)}}};
 const restored=parseBackup(backupText(snapshot));assert.ok(sameSnapshot(restored,snapshot));assert.equal(restored.settings.presets.custom[0].id,'night-id');
 const removed={...s,presets:{...s.presets,custom:[]}},historical=applyPresetSettings(snapshot.data,removed).shifts['a|2026-09-26'];assert.equal(historical.presetId,'night-id');assert.equal(historical.type,'Notte');assert.equal(minutes(historical),480);
});
test('nomi personalizzati sono obbligatori, univoci e non riservati',()=>{
 for(const name of ['', 'Riposo', 'Malattia']){const s=settings();s.presets.custom.push({id:'other',name,start:'10:00',end:'18:00',color:'#123456'});assert.equal(validSettings(s),false,name);}
});

test('organizzazioni precedenti senza presets.custom usano un elenco vuoto',()=>{
 const legacy=structuredClone(DEFAULT_SETTINGS);delete legacy.presets.custom;
 assert.equal(validSettings(legacy),true);
 assert.deepEqual(customPresets(legacy),[]);
 assert.deepEqual(shiftOptions(legacy),['Riposo','Malattia','Ferie']);
});
