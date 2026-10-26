// A phone-sized short edge keeps the same mode through portrait/landscape rotation.
export const MOBILE_PLANNER_QUERY='(max-width: 760px), (max-height: 500px) and (max-width: 1000px)';
export const MIN_OVERVIEW_DAY_WIDTH=14;
export const MIN_SHEET_SCALE=MIN_OVERVIEW_DAY_WIDTH/36;
export const MAX_SHEET_SCALE=5;
export const PAN_THRESHOLD=7;
export function clampSheetScale(value){return Math.max(MIN_SHEET_SCALE,Math.min(MAX_SHEET_SCALE,Number(value)||1));}
export function fitSheetScale(width,days){return clampSheetScale((width-40-36)/(36*days));}
export function sheetMetrics(scale){
 const dayWidth=36*scale;
 return {dayWidth,employeeWidth:40,totalWidth:36,rowHeight:Math.max(18,Math.min(60,dayWidth)),fontSize:Math.max(9,Math.min(14,dayWidth*.35)),headerFontSize:Math.max(9,Math.min(14,dayWidth*.5))};
}
export function employeeInitials(name){
 const words=(typeof name==='string'?name.normalize('NFC').trim():'').split(/\s+/u).filter(Boolean);
 if(!words.length)return '—';
 const first=Array.from(words[0]),last=Array.from(words.at(-1));
 return `${first[0]}${words.length>1?last[0]:first.at(-1)}`.toLocaleUpperCase('it-IT');
}
export function touchPair(points){
 const [a,b]=points;
 return {x:(a.x+b.x)/2,y:(a.y+b.y)/2,distance:Math.max(1,Math.hypot(a.x-b.x,a.y-b.y))};
}
export function anchoredScroll(scroll,anchor,oldSize,newSize){return Math.max(0,(scroll+anchor)*newSize/oldSize-anchor);}
