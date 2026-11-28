import {runJsonWorker,gatewayCurlConfig} from './json-worker.js';
import {spawn} from 'node:child_process';
import {createHash,createHmac} from 'node:crypto';
import {isIP} from 'node:net';

export function gatewayFingerprint(profiles,configs,id) {
 const seen=new Set(),chain=[];let p=profiles.find(p=>p.id===id);
 while(p && !seen.has(p.id)){seen.add(p.id);chain.push([p.id,p.engine,p.enabled!==false,p.gatewayId || null,configs.find(c=>c.profile_id===p.id)?.config || '']);p=profiles.find(row=>row.id===p.gatewayId);}
 return createHash('sha256').update(JSON.stringify(chain)).digest('hex');
}

export function locationListeners(profiles,configs,supportedTags,secret,{basePort=28000,ports=new Map()}={}) {
 return profiles.filter(profile=>profile.id && profile.enabled!==false && (profile.engine==='direct' || supportedTags.has(`p-${profile.id.slice(0,8)}-grp`))).sort((a,b)=>a.id.localeCompare(b.id)).map(profile=>{
  if(!ports.has(profile.id)){
   const used=new Set(ports.values());let port=basePort;
   while(used.has(port) && port<=37999)port++;
   if(port>37999)throw Error('Too many gateway probes');
   ports.set(profile.id,port);
  }
  const tag=profile.engine==='direct'?'DIRECT':`p-${profile.id.slice(0,8)}-grp`;
  const fingerprint=gatewayFingerprint(profiles,configs,profile.id);
  return {id:profile.id,tag,port:ports.get(profile.id),key:fingerprint,secret:createHmac('sha256',secret).update(profile.id+fingerprint).digest('hex')};
 });
}

// Credentials go to curl over stdin, never command-line arguments. The proxy
// and empty NO_PROXY override guarantee that every lookup uses this outbound.
export function requestLocationJson(endpoint,url,{signal,spawnProcess=spawn}={}) {
 return (async()=>{
  if(!/^https:\/\/(ipwho\.is|api\.ipapi\.is)\/$/.test(url))throw Error('Unsupported location service');
  const timeoutMs=Math.max(1000,Math.min(60000,endpoint.timeoutMs || 8000));
  try{const {value,exitCode}=await runJsonWorker('curl',['--disable','--config','-','--fail','--silent','--show-error','--noproxy','','--proto','=https','--connect-timeout',String(Math.min(10,timeoutMs/1000)),'--max-time',String(timeoutMs/1000),'--max-filesize','65536'],{input:gatewayCurlConfig(endpoint,url),signal,spawnProcess,timeoutMs:timeoutMs+2000});if(exitCode!==0)throw Object.assign(Error(),{code:'LOOKUP_FAILED'});return value;}
  catch(error){throw Error(error.code==='ABORTED' || error.code==='TIMEOUT' || error.limitExceeded?'Location request cancelled':error.code==='INVALID_RESPONSE'?'Invalid location response':error.code==='LOOKUP_FAILED'?'Location lookup failed':'Location transport unavailable');}
 })();
}
const text=value=>typeof value==='string'?value.replace(/[\x00-\x1f\x7f]/g,'').trim().slice(0,160):null;
export function normalizeGatewayLocation(raw,source) {
 if(!raw || raw.success===false || raw.is_bogon===true || raw.error || !isIP(String(raw.ip || '')))throw Error('Location unavailable');
 const countryCode=text(raw.country_code || raw.location?.country_code)?.toUpperCase();
 const asn=raw.connection?.asn || raw.asn?.asn || (typeof raw.asn==='string'?/^AS(\d+)/i.exec(raw.asn)?.[1]:null);
 return {ip:raw.ip,countryCode:/^[A-Z]{2}$/.test(countryCode || '')?countryCode:null,
  country:text(raw.country || raw.location?.country),region:text(raw.region || raw.location?.state),city:text(raw.city || raw.location?.city),
  provider:text(raw.connection?.isp) || text(raw.connection?.org) || text(raw.company?.name) || text(raw.company) || text(raw.asn?.org),
  asn:/^\d+$/.test(String(asn || ''))?`AS${asn}`:null,source};
}
export async function probeGatewayLocation(endpoint,{request=requestLocationJson,signal}={}) {
 for(const url of ['https://ipwho.is/','https://api.ipapi.is/']) {
  if(signal?.aborted)throw Error('Location request cancelled');
  try{return normalizeGatewayLocation(await request(endpoint,url,{signal}),new URL(url).hostname);}catch{}
 }
 throw Error('Location unavailable');
}
export function createGatewayLocations(endpointFor,{probe=probeGatewayLocation,now=Date.now,ttl=24*60*60*1000,retry=5*60*1000,transportPollMs=1000}={}) {
 const cache=new Map(),identities=new Map(),queue=[];let active=0;
 const drain=()=>{while(active<2 && queue.length){const job=queue.shift();active++;Promise.resolve().then(job).finally(()=>{active--;drain();});}};
 const invalidate=id=>{const item=cache.get(id);clearTimeout(item?.retryTimer);item?.controller?.abort();item?.complete?.();cache.delete(id);};
 const api={
  async refresh(profile,{signal}={}) {
   invalidate(profile.id);this.get(profile);let item=cache.get(profile.id);
   if(!item)return {status:'unsupported'};
   const abort=()=>invalidate(profile.id);signal?.addEventListener('abort',abort,{once:true});
   try{if(signal?.aborted)abort();while(item?.waiting){await item.done;item=cache.get(profile.id);}if(!item)return {status:'unavailable'};await item.done;return item.value;}finally{signal?.removeEventListener('abort',abort);}
  },
  get(profile) {
   if(profile.enabled===false){invalidate(profile.id);return {status:'disabled'};}
   const endpoint=endpointFor(profile);if(!endpoint){invalidate(profile.id);return {status:'unsupported'};}
   const key=endpoint.key+':'+endpoint.port+':'+endpoint.secret,old=cache.get(profile.id);
   if(endpoint.transportState && endpoint.transportState!=='ready'){
    invalidate(profile.id);
    const item={key,waiting:true,value:{status:endpoint.transportState==='failed'?'unavailable':'checking'}};
    item.done=new Promise(resolve=>{item.complete=resolve;});
    cache.set(profile.id,item);
    item.retryTimer=setTimeout(()=>{if(cache.get(profile.id)===item)api.get(profile);},transportPollMs);
    item.retryTimer.unref?.();return item.value;
   }

   if(!old?.waiting && old?.key===key && (old.pending || now()-old.time<(old.value.status==='ok'?(endpoint.ttl || ttl):old.retryAfter || retry)))return old.value;
   invalidate(profile.id);
   const item={key,pending:true,time:now(),value:{status:'checking'},failures:old?.failures || 0,controller:new AbortController()};let complete;item.done=new Promise(resolve=>{complete=resolve;});item.complete=complete;cache.set(profile.id,item);
   queue.push(async()=>{
    if(cache.get(profile.id)!==item){complete();return;}
    try{
     const result=await probe(endpoint,{signal:item.controller.signal});
     const known=identities.get(result.ip);
     // Prefer the primary provider when available, and use one identity per IP.
     const identity=known && now()-known.time<ttl && (known.value.source==='ipwho.is' || result.source!=='ipwho.is')?known.value:result;
     identities.set(result.ip,{time:now(),value:identity});
     item.failures=0;
     item.value={...identity,status:'ok',checkedAt:new Date(now()).toISOString()};
     for(const other of cache.values())if(!other.pending && other.value.status==='ok' && other.value.ip===result.ip)other.value={...identity,status:'ok',checkedAt:other.value.checkedAt};
    }
    catch{item.value={status:'unavailable'};item.failures++;}
    finally{
     item.pending=false;item.time=now();complete();
     if(cache.get(profile.id)===item && item.value.status==='unavailable'){
      item.retryAfter=Math.min(retry*2**Math.min(item.failures-1,6),60*60*1000);
      item.retryTimer=setTimeout(()=>{if(cache.get(profile.id)===item)api.get(profile);},item.retryAfter+1);
      item.retryTimer.unref?.();
     }
    }
   });drain();return item.value;
  },
  start(profiles){this.prune(profiles.map(profile=>profile.id));for(const profile of profiles)this.get(profile);},
  invalidate,
  prune(ids){const keep=new Set(ids);for(const id of cache.keys())if(!keep.has(id))invalidate(id);},
  stop(){for(const id of cache.keys())invalidate(id);queue.length=0;identities.clear();}
 };
 return api;
}
