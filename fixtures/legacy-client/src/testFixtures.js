// Explicit legacy fixtures for regression tests. Never imported by the application.
import {makeShift,normalizeTime} from './schedule.js';
import {LEGACY_SETTINGS} from './legacySettings.js';
export function makeLegacyShift(type,start='',end='',settings=LEGACY_SETTINGS){
 if(type==='Mattina'||type==='Pomeriggio'){
  const p=settings?.presets?.[type]||LEGACY_SETTINGS.presets[type];return {type,off:false,start:p.start,end:p.end};
 }
 return makeShift(type,start,end,settings);
}
