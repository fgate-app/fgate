import {isIP} from 'node:net';
import {normalizeRouteEntry} from '../shared/route-preset-entries.js';
import {validRouteEntry} from './route-entries.js';
import {PublicError} from './public-error.js';
export const METACUBE_REPOSITORY='MetaCubeX/meta-rules-dat';
export const METACUBE_BRANCH='meta';
export const PRESET_LIMIT=500000;
export const presetId=/^[a-z0-9][a-z0-9!_@-]*$/;
export function parseMetaList(text,kind){
 const entries=new Set();
 for(const raw of String(text).split(/\r?\n/)){
  const line=raw.trim();if(!line||line.startsWith('#'))continue;
  const comma=line.indexOf(',');let value;
  if(comma<0){value=kind==='geoip'?line:line.startsWith('+.')?line.slice(2):'full:'+line;}
  else{
   const type=line.slice(0,comma),payload=line.slice(comma+1);
   if(type==='DOMAIN')value='full:'+payload;
   else if(type==='DOMAIN-SUFFIX')value=payload;
   else if(type==='DOMAIN-KEYWORD')value='keyword:'+payload;
   else if(type==='DOMAIN-REGEX')value='regexp:'+payload;
   else if(type==='IP-CIDR'||type==='IP-CIDR6')value=payload.replace(/,no-resolve$/,'');
   else throw new PublicError('Unsupported rule in the domain list.');
  }
  value=normalizeRouteEntry(value);
  if(!validRouteEntry(value)||value.startsWith('exclude:')||kind==='geoip'&&!isIP(value.split('/')[0]))throw new PublicError('Unsupported rule in the domain list.');
  entries.add(value);if(entries.size>PRESET_LIMIT)throw new PublicError('The preset contains too many addresses.');
 }
 return [...entries].sort();
}
export function buildMetaCatalog(sources,{ref,labels=new Map(),updatedAt=new Date().toISOString()}={}){
 const lists={},presets=[],domains=new Map(),ips=new Map(),attributes=new Map();
 for(const [path,text] of Object.entries(sources)){
  const match=/^(geosite|geoip)\/([a-z0-9][a-z0-9!_@-]*)$/.exec(path);if(!match)throw new PublicError('Invalid domain list file.');
  const [,kind,id]=match,entries=parseMetaList(text,kind);
  if(kind==='geoip'){ips.set(id,entries);continue;}
  if(id.includes('@')){const [service,attribute,...extra]=id.split('@');if(extra.length||!presetId.test(service)||!['cn','!cn','ads','telemetry'].includes(attribute))throw new PublicError('Invalid domain list file.');attributes.set(id,{service,attribute,entries});}
  else domains.set(id,entries);
 }
 if(!domains.size||!ips.size)throw new PublicError('The domain lists catalog is empty or too large.');
 for(const id of [...new Set([...domains.keys(),...ips.keys()])].sort()){
  const entries=[...new Set([...(domains.get(id)||[]),...(ips.get(id)||[])])].sort();if(entries.length>PRESET_LIMIT)throw new PublicError('The preset contains too many addresses.');
  lists[id]=entries;presets.push({id,label:id==='vk'?'VK':labels.get(id)||id,kind:'service',count:entries.length,domainCount:domains.get(id)?.length||0,ipCount:ips.get(id)?.length||0});
 }
 const allTracking=new Set(lists['category-ads-all']||[]);
 for(const preset of presets)if(preset.id.startsWith('category-ads'))preset.kind='tracking';
 for(const {service,attribute,entries}of attributes.values()){
  if(['ads','telemetry'].includes(attribute)){
   const id=`tracking--${service}--${attribute}`;if(Object.hasOwn(lists,id))throw new PublicError('Tracker preset names conflict.');lists[id]=entries;entries.forEach(e=>allTracking.add(e));presets.push({id,label:labels.get(service)||service,kind:'tracking',attribute,hidden:true,count:entries.length});
  }else{const id=service+'@'+attribute;lists[id]=entries;presets.push({id,label:id,kind:'service',count:entries.length,domainCount:entries.length,ipCount:0});}
 }
 for(const preset of presets.filter(p=>p.kind==='service')){
  const tracking=[...new Set(['ads','telemetry'].flatMap(a=>lists[`tracking--${preset.id}--${a}`]||[]))].sort();if(!tracking.length)continue;
  const excluded=new Set(tracking);lists[preset.id]=lists[preset.id].filter(e=>!excluded.has(e));preset.exclusions=tracking;preset.count=lists[preset.id].length;
  const id='tracking--'+preset.id;if(Object.hasOwn(lists,id))throw new PublicError('Tracker preset names conflict.');lists[id]=tracking;presets.push({id,label:preset.label,kind:'tracking',combined:true,serviceId:preset.id,count:tracking.length});
 }
 if(allTracking.size){lists['tracking--all']=[...allTracking].sort();presets.push({id:'tracking--all',label:'Реклама и трекеры — все',kind:'tracking',count:allTracking.size});}
 return {version:5,repository:METACUBE_REPOSITORY,branch:METACUBE_BRANCH,ref,updatedAt,presets,lists};
}
