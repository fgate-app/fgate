import {validDomainCatalog} from './domain-catalog-validation.js';
import {METACUBE_REPOSITORY,METACUBE_BRANCH,PRESET_LIMIT,presetId,buildMetaCatalog} from './metacube-catalog.js';
import {createPresetSearch} from './domain-preset-search.js';
import {normalizeRouteEntry} from '../shared/route-preset-entries.js';
import {PublicError} from './public-error.js';
import {createGunzip} from 'node:zlib';
import {Readable} from 'node:stream';
import {mkdirSync,readFileSync,writeFileSync,renameSync,rmSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {validRouteEntry} from './route-entries.js';
const REPOSITORY=METACUBE_REPOSITORY;
const ID=presetId;
const bundled=JSON.parse(readFileSync(new URL('../packaging/domain-list-catalog.json',import.meta.url),'utf8'));
export const DOMAIN_PRESETS=bundled.presets;
const TRACKING_PRESETS=[
 {id:'tracking--all',label:'Реклама и трекеры — все',kind:'tracking'},
 {id:'tracking--yandex--telemetry',label:'Яндекс Метрика и AppMetrica',kind:'tracking',hidden:true},
 {id:'tracking--vk--ads',label:'VK — реклама и трекеры',kind:'tracking',hidden:true},
];

export function domainListRef(){
 const lock=JSON.parse(readFileSync(new URL('../packaging/modules.lock.json',import.meta.url),'utf8'));
 const ref=lock.sourceModules?.find(module=>module.id==='metacube-rules')?.commit;
 if(!/^[a-f0-9]{40}$/.test(ref || ''))throw new PublicError("The domain lists version is not pinned.");
 return ref;
}
function records(text){
 const result=[];
 for(const raw of String(text || '').split(/\r?\n/)){
  const line=raw.split('#')[0].trim();if(!line)continue;
  const [token,...attributes]=line.split(/\s+/);
  if(token.startsWith('include:')){
   const category=token.slice(8);if(!ID.test(category))throw new PublicError("Invalid include in the domain list.");
   result.push({category,filters:attributes.filter(value=>value.startsWith('@')).map(value=>value.slice(1))});continue;
  }
  const value=normalizeRouteEntry(token);
  if(value.startsWith('exclude:') || !validRouteEntry(value))throw new PublicError("Unsupported rule in the domain list.");
  result.push({entry:value,attributes:attributes.filter(value=>value.startsWith('@')).map(value=>value.slice(1)),affiliations:attributes.filter(value=>value.startsWith('&')).map(value=>value.slice(1))});
 }
 return result;
}
export function parseDomainList(text){return [...new Set(records(text).filter(row=>row.entry).map(row=>row.entry))].sort();}
function dataDir(){return join(process.env.FREEDOMGATE_STATE_DIR || '/var/lib/freedomgate','domain-lists');}
const cache=new Map();
function splitServicePresets(snapshot){
 const lists={...snapshot.lists},presets=snapshot.presets.map(preset=>({...preset}));
 for(const preset of presets.filter(row=>(row.kind || 'service')==='service')){
  if(preset.id==='vk')preset.label='VK';
  const tracking=[...new Set(['ads','telemetry'].flatMap(attribute=>lists[`tracking--${preset.id}--${attribute}`] || []))].sort();
  if(!tracking.length)continue;
  const id='tracking--'+preset.id;
  if(Object.hasOwn(lists,id))throw new PublicError('Tracker preset names conflict.');
  const excluded=new Set(tracking);lists[preset.id]=lists[preset.id].filter(entry=>!excluded.has(entry));lists[id]=tracking;
  preset.exclusions=tracking;preset.count=lists[preset.id].length;
  presets.push({id,label:preset.label,kind:'tracking',combined:true,serviceId:preset.id,count:tracking.length});
 }
 for(const preset of presets)if(preset.kind==='tracking' && preset.attribute)preset.hidden=true;
 return {...snapshot,version:4,lists,presets};
}
export function normalizeDomainCatalog(value){
 if(!validDomainCatalog(value))return null;
 return value.version===3?splitServicePresets(value):value;
}
function storedCatalog(){
 const path=join(dataDir(),'catalog.json');
 try{
  const info=statSync(path),key=info.mtimeMs+':'+info.size;
  if(cache.get(path)?.key===key)return cache.get(path).value;
  const stored=JSON.parse(readFileSync(path,'utf8'));
  const value=normalizeDomainCatalog(stored);if(!value)return null;
  cache.set(path,{key,value});return value;
 }catch{return null;}
}
export function domainListSnapshot(){try{return readFileSync(join(dataDir(),'catalog.json'));}catch(error){if(error.code==='ENOENT')return null;throw error;}}
export function restoreDomainListSnapshot(snapshot){
 const folder=dataDir(),path=join(folder,'catalog.json');
 if(snapshot===null)rmSync(path,{force:true});
 else{mkdirSync(folder,{recursive:true,mode:0o700});const temporary=join(folder,'restore-'+randomUUID()+'.tmp');try{writeFileSync(temporary,snapshot,{mode:0o600});renameSync(temporary,path);}finally{rmSync(temporary,{force:true});}}
 cache.delete(path);
}
export function domainListsStatus(){
 const stored=storedCatalog();
 const available=stored?.version>=3?stored.presets:DOMAIN_PRESETS;
 const presets=[...available,...TRACKING_PRESETS.filter(preset=>!available.some(item=>item.id===preset.id))];
 return {loaded:!!stored,partial:!!stored?.partial,repository:stored?.repository || REPOSITORY,branch:METACUBE_BRANCH,ref:stored?.ref || domainListRef(),updatedAt:stored?.updatedAt || null,
  presets:presets.map(preset=>({id:preset.id,label:preset.label || DOMAIN_PRESETS.find(item=>item.id===preset.id)?.label || preset.id,kind:preset.kind || 'service',hidden:!!preset.hidden,combined:!!preset.combined,attribute:preset.attribute || null,categories:[preset.id],count:stored?.lists[preset.id]?.length || 0,available:!!stored?.lists[preset.id]?.length}))};
}
const searches=new WeakMap();
export function searchDomainPresets(query){
 const snapshot=storedCatalog();if(!snapshot)return [];
 if(!searches.has(snapshot))searches.set(snapshot,createPresetSearch(snapshot.presets,snapshot.lists));
 return searches.get(snapshot)(query);
}
export function domainListExclusions(id){return storedCatalog()?.presets.find(preset=>preset.id===id)?.exclusions || [];}
export function domainListDomains(id){
 if(!ID.test(id))return null;
 const stored=storedCatalog();
 if(stored?.lists[id])return stored.lists[id];
 return [...DOMAIN_PRESETS,...TRACKING_PRESETS].some(preset=>preset.id===id)?[]:null;
}

// Stream past binary/ASN members; retain only the canonical textual GeoSite/GeoIP files.
export async function readDomainArchive(archive){
 const stream=Readable.from([archive]).pipe(createGunzip()),sources={};let buffer=Buffer.alloc(0),remaining=0,padding=0,id=null,chunks=[],expanded=0,ended=false,metadata=null,pendingPath=null;
 try{for await(const chunk of stream){
  expanded+=chunk.length;if(expanded>512*1024*1024)throw new PublicError('The domain lists archive is too large.');
  buffer=buffer.length?Buffer.concat([buffer,chunk]):chunk;
  while(buffer.length&&!ended){
   if(remaining){const count=Math.min(remaining,buffer.length);if(id||metadata)chunks.push(buffer.subarray(0,count));buffer=buffer.subarray(count);remaining-=count;if(!remaining&&(id||metadata)){const content=Buffer.concat(chunks).toString('utf8');if(metadata)pendingPath=metadata==='long'?content.split('\0')[0]:/(?:^|\n)\d+ path=([^\n]+)\n/.exec(content)?.[1]||pendingPath;else sources[id]=content;chunks=[];id=null;metadata=null;}continue;}
   if(padding){const count=Math.min(padding,buffer.length);buffer=buffer.subarray(count);padding-=count;continue;}
   if(buffer.length<512)break;
   const header=buffer.subarray(0,512);buffer=buffer.subarray(512);if(header.every(byte=>byte===0)){ended=true;break;}
   const text=(a,b)=>header.subarray(a,b).toString().split('\0')[0],name=pendingPath||(text(345,500)?text(345,500)+'/':'')+text(0,100),size=parseInt(text(124,136).trim()||'0',8);
   if(!Number.isSafeInteger(size)||size<0)throw new PublicError('The domain lists archive is corrupt.');
   if(header[156]===120||header[156]===76){if(size>65536)throw new PublicError('Invalid domain list file.');metadata=header[156]===76?'long':'pax';remaining=size;padding=(512-size%512)%512;continue;}
   pendingPath=null;
   const meta=/^[^/]+\/geo\/(geosite|geoip)\/classical\/([^/]+)\.list$/.exec(name),legacy=/^[^/]+\/data\/([^/]+)$/.exec(name);
   if((meta||legacy)&&(header[156]===48||header[156]===0)){
    id=meta?meta[1]+'/'+meta[2]:legacy[1];if(!ID.test(meta?meta[2]:id)||size>16*1024*1024||Object.hasOwn(sources,id))throw new PublicError('Invalid domain list file.');
    if(!size){sources[id]='';id=null;}
   }
   remaining=size;padding=(512-size%512)%512;
  }
 }}finally{stream.destroy();}
 if(remaining||padding||!Object.keys(sources).length||Object.keys(sources).length>10000)throw new PublicError('The domain lists archive is corrupt.');
 return sources;
}
const updates=new Map();
export async function updateDomainLists({fetchImpl=fetch,ref=domainListsStatus().repository===REPOSITORY?domainListsStatus().ref:domainListRef(),sources=null}={}){
 const folder=dataDir();
 if(updates.has(folder))return updates.get(folder);
 const task=performUpdate(folder,fetchImpl,ref,sources);
 updates.set(folder,task);
 try{return await task;}finally{updates.delete(folder);}
}
async function performUpdate(folder,fetchImpl,ref,sources){
 if(!/^[a-zA-Z0-9._-]{1,80}$/.test(ref))throw new PublicError("Invalid domain lists version.");
 if(!sources){
  const response=await fetchImpl(`https://codeload.github.com/${REPOSITORY}/tar.gz/${ref}`,{signal:AbortSignal.timeout(120000),redirect:'error',maxBytes:64*1024*1024,timeoutMs:120000,validate:bytes=>readDomainArchive(bytes)});
  if(!response.ok)throw new PublicError("Failed to download the catalog: HTTP "+response.status);
  const chunks=[];let size=0;
  if(response.body){for await(const chunk of response.body){size+=chunk.length;if(size>64*1024*1024)throw new PublicError("The domain lists archive is too large.");chunks.push(chunk);}}
  else{const bytes=Buffer.from(await response.arrayBuffer());if(bytes.length>64*1024*1024)throw new PublicError("The domain lists archive is too large.");chunks.push(bytes);}
  sources=await readDomainArchive(Buffer.concat(chunks));
 }
 if(Object.keys(sources).some(id=>id.startsWith('geosite/')))return saveCatalog(folder,buildMetaCatalog(sources,{ref,labels:new Map(DOMAIN_PRESETS.map(p=>[p.id,p.label]))}));
 const ids=Object.keys(sources).sort();
 if(!ids.length || ids.length>10000 || ids.some(id=>!ID.test(id)))throw new PublicError("Invalid domain lists catalog.");
 const parsed=new Map(ids.map(id=>[id,records(sources[id])]));
 // Affiliations add a rule to another list as defined by the upstream format.
 for(const id of ids)for(const row of [...parsed.get(id)])if(row.entry)for(const target of row.affiliations || []){
  if(!parsed.has(target))continue;
  parsed.get(target).push({...row,affiliations:[]});
 }
 const loaded=new Map();
 function load(category,ancestors=[]){
  if(ancestors.includes(category) || ancestors.length>100)throw new PublicError("Cyclic include in domain lists.");
  if(loaded.has(category))return loaded.get(category);
  if(!parsed.has(category))throw new PublicError("Included list not found: "+category);
  const result=new Map();
  for(const row of parsed.get(category)){
   const rows=row.entry?[row]:load(row.category,[...ancestors,category]).filter(item=>row.filters.every(filter=>filter.startsWith('-') || filter.startsWith('!')?!item.attributes.includes(filter.slice(1)):item.attributes.includes(filter)));
   for(const item of rows)result.set(item.entry+'@'+[...item.attributes].sort().join(','),item);
   if(result.size>100000)throw new PublicError("The preset contains too many addresses.");
  }
  const rows=[...result.values()];loaded.set(category,rows);return rows;
 }
 const lists=Object.fromEntries(ids.map(id=>[id,[...new Set(load(id).map(row=>row.entry))].sort()]));
 const updatedAt=new Date().toISOString(),labels=new Map(DOMAIN_PRESETS.map(preset=>[preset.id,preset.label]));
 const presets=ids.map(id=>({id,label:labels.get(id) || id,count:lists[id].length}));
 // Keep upstream attributes: a service's tracking subset must not inherit its
 // ordinary domains, even when a parent service includes that same list.
 const allTracking=new Set();
 for(const category of ids)for(const attribute of ['ads','telemetry']){
  const entries=[...new Set(load(category).filter(row=>row.attributes.includes(attribute)).map(row=>row.entry))].sort();
  if(!entries.length)continue;
  const id=`tracking--${category}--${attribute}`;
  if(Object.hasOwn(lists,id))throw new PublicError("Tracker preset names conflict.");
  lists[id]=entries;entries.forEach(entry=>allTracking.add(entry));
  presets.push({id,label:TRACKING_PRESETS.find(preset=>preset.id===id)?.label || labels.get(category) || category,kind:'tracking',attribute,count:entries.length});
 }
 if(allTracking.size){
  if(Object.hasOwn(lists,'tracking--all'))throw new PublicError("Tracker preset names conflict.");
  lists['tracking--all']=[...allTracking].sort();
  presets.push({...TRACKING_PRESETS[0],count:allTracking.size});
 }
 if(presets.length>10000 || Object.values(lists).some(entries=>entries.length>PRESET_LIMIT))throw new PublicError("The preset contains too many addresses.");
 const snapshot=splitServicePresets({version:3,repository:REPOSITORY,ref,updatedAt,presets,lists});
 if(snapshot.presets.length>10000)throw new PublicError("The preset contains too many addresses.");
 return saveCatalog(folder,snapshot);
}
function saveCatalog(folder,snapshot){
 mkdirSync(folder,{recursive:true,mode:0o700});
 const candidate=join(folder,'catalog-'+randomUUID()+'.tmp');
 try{writeFileSync(candidate,JSON.stringify(snapshot),{mode:0o600});renameSync(candidate,join(folder,'catalog.json'));}
 finally{rmSync(candidate,{force:true});}
 cache.delete(join(folder,'catalog.json'));
 return {repository:snapshot.repository,ref:snapshot.ref,updatedAt:snapshot.updatedAt,presets:snapshot.presets};
}
