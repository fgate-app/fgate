import {normalizeRouteEntry} from '../shared/route-preset-entries.js';

// Index unique rules once, rather than re-scanning overlapping presets per keystroke.
export function createPresetSearch(presets,lists){
 const rows=[],ipRows=[],byEntry=new Map(),grams=new Map();
 const visible=presets.filter(p=>!p.hidden && lists[p.id]?.length);
 for(const preset of visible)for(const entry of lists[preset.id]){
  let row=byEntry.get(entry);
  if(!row){row={entry,text:entry.toLowerCase(),ids:[]};byEntry.set(entry,row);if(/^(?:[0-9.]+|[0-9a-f:]+)\/\d+$/i.test(entry))ipRows.push(row);else rows.push(row);}
  if(!row.ids.includes(preset.id))row.ids.push(preset.id);
 }
 for(let i=0;i<rows.length;i++)for(const gram of new Set(trigrams(rows[i].text))){if(!grams.has(gram))grams.set(gram,[]);grams.get(gram).push(i);}
 return query=>{
  const raw=String(query || '').trim().toLowerCase();if(!raw || raw.length>1024)return [];
  const q=normalizeRouteEntry(raw).toLowerCase(),hits=new Map();
  let candidates=rows;
  if(q.length>=3){const postings=trigrams(q).map(g=>grams.get(g) || []);const smallest=postings.reduce((a,b)=>a.length<=b.length?a:b);candidates=smallest.map(i=>rows[i]);}
  const numeric=/^[0-9a-f:./]+$/i.test(q) && /[0-9:./]/.test(q);
  for(const collection of [candidates,numeric?ipRows:[]])for(const row of collection)if(row.text.includes(q))for(const id of row.ids)if(!hits.has(id))hits.set(id,row.entry);
  return visible.map(p=>{
   const names=[p.id,String(p.label || '').toLowerCase()],rank=names.some(n=>n===raw)?0:names.some(n=>n.startsWith(raw))?1:names.some(n=>n.includes(raw))?2:hits.has(p.id)?3:4;
   return {id:p.id,label:p.label || p.id,combined:!!p.combined,kind:p.kind || 'service',count:lists[p.id].length,match:hits.get(p.id) || null,rank};
  }).filter(p=>p.rank<4).sort((a,b)=>a.rank-b.rank || a.id.localeCompare(b.id)).map(({rank,...p})=>p);
 };
}
function trigrams(text){const out=[];for(let i=0;i<text.length-2;i++)out.push(text.slice(i,i+3));return out;}
