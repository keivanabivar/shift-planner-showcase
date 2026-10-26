// Predict 029's two color triggers without changing the submitted operations.
// Untouched history only changes on a template color edit; inserted/updated
// shifts resolve their template's current color, preserving their name/hours.
export function applyTemplateColorChanges(previous,next,deletedTemplateColors=[]){
 // Deleted-template metadata comes from the authenticated load envelope, not
 // historical shift colors or the submitted snapshot. It survives a reload.
 const old=new Map([...deletedTemplateColors,...(previous.settings.presets?.custom||[])].map(t=>[t.id,t]));
 const current=next.settings.presets?.custom||[];
 // A deleted template remains in the DB and still resolves copied snapshots.
 const templates=[...current,...[...old.values()].filter(t=>!current.some(n=>n.id===t.id))];
 const shifts=Object.fromEntries(Object.entries(next.data.shifts).map(([key,shift])=>{
  if(!shift.presetId)return [key,shift];
  const scoped=templates.filter(t=>t.branchId===shift.branchId);
  // SQL prefers an exact UUID over a legacy alias. Only use aliases previously
  // read from the DB, never a newly supplied client linkage.
  const template=scoped.find(t=>t.id===shift.presetId)||scoped.find(t=>old.get(t.id)?.legacyPresetId===shift.presetId);
  const prior=template&&old.get(template.id);
  const propagated=template&&current.includes(template)&&prior?.branchId===template.branchId&&prior.color!==template.color;
  const written=JSON.stringify(previous.data.shifts[key])!==JSON.stringify(shift);
  return [key,template&&(propagated||written)?{...shift,presetColor:template.color}:shift];
 }));
 return {...next,data:{...next.data,shifts}};
}

export function deletedTemplateColorsAfter(previous,next,known=[]){
 const current=new Set((next.settings.presets?.custom||[]).map(t=>t.id));
 const deleted=(previous.settings.presets?.custom||[]).filter(t=>!current.has(t.id)).map(t=>({
  id:t.id,branchId:t.branchId,color:t.color,...(t.legacyPresetId?{legacyPresetId:t.legacyPresetId}:{})
 }));
 return [...known,...deleted].sort((a,b)=>a.id.localeCompare(b.id));
}

export function validDeletedTemplateColors(colors,snapshot,selectedBranchIds){
 if(!Array.isArray(colors))return false;
 const ids=new Set((snapshot.settings.presets?.custom||[]).map(t=>t.id));
 const aliases=new Set((snapshot.settings.presets?.custom||[]).filter(t=>t.legacyPresetId).map(t=>JSON.stringify([t.branchId,t.legacyPresetId])));
 return colors.every(t=>{
  if(!t||typeof t!=='object'||Array.isArray(t)||Object.keys(t).some(k=>!['id','branchId','color','legacyPresetId'].includes(k))||
   typeof t.id!=='string'||!t.id||ids.has(t.id)||typeof t.branchId!=='string'||!selectedBranchIds.includes(t.branchId)||
   typeof t.color!=='string'||!/^#[0-9a-f]{6}$/i.test(t.color)||
   (Object.hasOwn(t,'legacyPresetId')&&(typeof t.legacyPresetId!=='string'||!t.legacyPresetId)))return false;
  const alias=JSON.stringify([t.branchId,t.legacyPresetId]);
  if(t.legacyPresetId&&aliases.has(alias))return false;
  ids.add(t.id);if(t.legacyPresetId)aliases.add(alias);return true;
 });
}
