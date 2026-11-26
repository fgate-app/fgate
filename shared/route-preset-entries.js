// WHATWG URL supplies the same IDNA conversion in the browser and Node.
function normalizeDomain(value){
 const lowered=value.toLowerCase();
 if(!/[^\x00-\x7f]/.test(value) || /[\s/\\?#@:\[\]]/.test(value))return lowered;
 const wildcard=value.startsWith('*.')?'*.':'';
 try{return wildcard+new URL('http://'+value.slice(wildcard.length)).hostname.toLowerCase();}catch{return lowered;}
}
// Normalize domain prefixes without changing a regex payload.
export function normalizeRouteEntry(value){
 const raw=String(value).trim();
 if(/^regexp:/i.test(raw))return 'regexp:'+raw.slice(7);
 if(/^exclude:/i.test(raw)){
  const inner=raw.slice(8).trim();
  if(/^full:/i.test(inner))return 'exclude:full:'+normalizeDomain(inner.slice(5));
  return 'exclude:'+normalizeDomain(/^domain:/i.test(inner)?inner.slice(7):inner);
 }
 if(/^full:/i.test(raw))return 'full:'+normalizeDomain(raw.slice(5));
 if(/^domain:/i.test(raw))return normalizeDomain(raw.slice(7));
 return normalizeDomain(raw);
}
export function uniqueRouteEntries(entries){return [...new Set(entries.map(normalizeRouteEntry).filter(Boolean))];}

export function routeEntrySelection(manual,presets=[]){
 const normalized=uniqueRouteEntries(manual),exclusions=normalized.filter(entry=>entry.startsWith('exclude:')).map(entry=>entry.slice(8));
 const included=uniqueRouteEntries([...normalized.filter(entry=>!entry.startsWith('exclude:')),...presets.flatMap(preset=>preset.entries || [])]);
 const entries=included.filter(entry=>{
  const exact=entry.startsWith('full:'),name=(exact?entry.slice(5):entry).replace(/^\*\./,'');
  if(name.includes(':') || name.includes('/') || /^\d+(?:\.\d+){3}$/.test(name))return true;
  return !exclusions.some(excluded=>excluded.startsWith('full:')?exact && name===excluded.slice(5):name===excluded || name.endsWith('.'+excluded));
 });
 return {entries,exclusions};
}
