import {readRoutePresets} from './route-presets.js';
import {domainListRef,normalizeDomainCatalog} from './domain-lists.js';
import {HttpError} from './http.js';

export const CATALOG_FILE='domain-lists/catalog.json';
const invalid=()=>new HttpError(400,'Invalid configuration file.');

export function configurationCatalog(value){
 let catalog;
 try{catalog=normalizeDomainCatalog(value);}catch{throw invalid();}
 if(!catalog)throw invalid();
 return catalog;
}

// A list is stored once; rules keep stable IDs instead of duplicating its rows.
export function compactConfigurationCatalog(groups,catalog,createdAt){
 const refs=new Map();
 const rows=groups.map(row=>{
  const selected=readRoutePresets(row.domain_presets);
  for(const ref of selected)if(!refs.has(ref.id))refs.set(ref.id,ref);
  return {...row,domain_presets:JSON.stringify(selected.map(ref=>({id:ref.id})))};
 });
 const presets=[],lists={};
 for(const [id,ref]of refs){
  const preset=catalog?.presets.find(p=>p.id===id),entries=catalog?.lists[id] ?? ref.entries;
  if(entries===undefined)continue;
  lists[id]=entries;
  presets.push(preset || {id,label:ref.label || id,combined:!!ref.combined,exclusions:ref.exclusions || []});
 }
 const selected=presets.length?configurationCatalog({version:5,repository:catalog?.repository || 'MetaCubeX/meta-rules-dat',ref:catalog?.ref || [...refs.values()].find(ref=>ref.ref)?.ref || domainListRef(),updatedAt:catalog?.updatedAt || createdAt,partial:true,presets,lists}):null;
 return {groups:rows,catalog:selected};
}

// Preserve installed lists and add only the lists missing on the target device.
export function mergeConfigurationCatalog(saved,local){
 try{local=normalizeDomainCatalog(local);}catch{local=null;}
 if(!local || local.repository!==saved.repository)return saved;
 const installed=new Set(local.presets.map(p=>p.id));
 const missing=saved.presets.filter(p=>!installed.has(p.id));
 if(!missing.length)return local;
 const added=Object.fromEntries(missing.map(p=>[p.id,saved.lists[p.id]]));
 return {...local,partial:true,presets:[...local.presets,...missing],lists:{...local.lists,...added}};
}
