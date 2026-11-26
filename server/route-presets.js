import {routeEntrySelection} from '../shared/route-preset-entries.js';
import {domainListExclusions,domainListDomains,domainListsStatus} from './domain-lists.js';
import {normalizeRouteEntries} from './route-entries.js';

export function readRoutePresets(value){
 try{const rows=JSON.parse(value || '[]');return Array.isArray(rows)?rows.filter(row=>row && typeof row.id==='string' && /^[a-z0-9][a-z0-9!_@-]*$/.test(row.id) && (row.entries===undefined || Array.isArray(row.entries))):[];}catch{return [];}
}
export function bindRoutePresets(ids,previous=[]){
 if(!Array.isArray(ids) || ids.length>64 || ids.some(id=>typeof id!=='string' || !/^[a-z0-9][a-z0-9!_@-]*$/.test(id)))throw Error('Select valid domain presets.');
 if(!ids.length)return [];
 const catalog=domainListsStatus();
 return [...new Set(ids)].map(id=>{
  const preset=catalog.updatedAt && catalog.presets.find(row=>row.id===id),entries=preset?domainListDomains(id):null;
  if(entries){return {id,label:preset.label,entries:entries.length?normalizeRouteEntries(entries,{max:500000}):[],combined:!!preset.combined,exclusions:domainListExclusions(id),ref:catalog.ref};}
  const saved=previous.find(row=>row.id===id);
  if(saved)return {...saved,label:saved.label || id,entries:saved.entries || []};
  throw Error('The selected domain preset is unavailable.');
 });
}
export function expandRoutePresets(manual,refs){
 const {entries}=routeEntrySelection(manual,refs);
 if(entries.length>500000)throw Error('Specify no more than 500000 addresses.');
 return entries;
}
export function presentRoutePresets(row){
 const refs=readRoutePresets(row.domainPresets).map(ref=>({...ref,label:ref.label || ref.id,entries:ref.entries || []})),manualEntries=JSON.parse(row.entries),catalog=refs.length?domainListsStatus():null;
 const {domainPresets,...rest}=row;
 return {...rest,exclusions:routeEntrySelection(manualEntries,refs).exclusions,manualEntries,presetIds:refs.map(ref=>ref.id),presets:refs.map(ref=>({id:ref.id,label:ref.label,combined:!!ref.combined,exclusions:ref.exclusions || [],entries:ref.entries,count:ref.entries.length,available:!!catalog.updatedAt && catalog.ref===ref.ref && catalog.presets.some(preset=>preset.id===ref.id)})),entries:expandRoutePresets(manualEntries,refs)};
}
