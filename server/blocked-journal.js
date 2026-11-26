import {createHash} from 'node:crypto';
import {isIP} from 'node:net';
const ruleKey=(type,payload)=>String(type).replace(/[^a-z0-9]/gi,'').toLowerCase()+'\0'+payload;
const endpoint=value=>{
 const match=/^(?:\[([^\]]+)\]|([^:()\s]+)):(\d+)(?:\((.*)\))?$/.exec(value);
 return match?{host:match[1] || match[2],port:match[3],process:match[4] || ''}:null;
};
export function parseRejectedLog(event){
 const text=event?.payload;if(typeof text!=='string' || text.length>16384)return null;
 let network,source,destination,type,payload,chain;
 const info=/^\[(TCP|UDP)\] (.*?) --> (\S+) match (.+) using (.+)$/.exec(text);
 const warning=/^\[(TCP|UDP)\] dial (\S+) \(match ([^/]+)\/(.*?)\) (.*?) --> (\S+) error:/.exec(text);
 if(info){[,network,source,destination]=info;chain=info[5];const rule=/^([^()]+)(?:\((.*)\))?$/.exec(info[4]);if(!rule)return null;[,type,payload='']=rule;}
 else if(warning){[,network,chain,type,payload,source,destination]=warning;}
 else return null;
 if(!/(?:^|[\[\], ])REJECT(?:-DROP)?(?:$|[\[\], ])/.test(chain))return null;
 const from=endpoint(source),to=endpoint(destination);if(!from || !to || !isIP(from.host))return null;
 return {network:network.toLowerCase(),sourceIP:from.host,sourcePort:from.port,host:to.host,destinationPort:to.port,process:from.process,rule:type.trim(),rulePayload:payload};
}

export function createBlockedJournal({watchLogs,rules=async()=>[],dns=async()=>({data:[]}),now=Date.now,retention=5*60*1000,maxRows=1000}={}){
 const rows=new Map(),seen=new Map();let registry=new Map(),stream=null,pending=null,stopped=false;
 let status={route:null,dns:null};
 function prune(){const time=now();for(const [id,row] of rows)if(time-row.lastSeen>retention)rows.delete(id);for(const [id,timeSeen] of seen)if(time-timeSeen>retention)seen.delete(id);while(rows.size>maxRows)rows.delete(rows.keys().next().value);while(seen.size>20000)seen.delete(seen.keys().next().value);}
 function record(value,time=now()){
  if(time<now()-retention || time>now()+60000)return;
  const id='blocked-'+createHash('sha256').update(JSON.stringify([value.blockSource,value.sourceIP,value.host,value.destinationPort,value.network,value.routeId || value.rulePayload,value.dnsType])).digest('hex').slice(0,24);
  const old=rows.get(id);rows.delete(id);
  rows.set(id,{id,active:false,blocked:true,startedAt:old?.startedAt || new Date(time).toISOString(),closedAt:new Date(Math.max(time,old?.lastSeen || 0)).toISOString(),lastSeen:Math.max(time,old?.lastSeen || 0),attempts:(old?.attempts || 0)+1,chains:['REJECT'],upload:0,download:0,uploadSpeed:0,downloadSpeed:0,sourcePort:'',destinationIP:'',process:'',type:'',...value});prune();
 }
 function ingestLog(event){
  const value=parseRejectedLog(event);if(!value)return;
  const rule=registry.get(ruleKey(value.rule,value.rulePayload));if(!rule)return;
  record({...value,blockSource:'route',routeId:rule.id,ruleName:rule.name,type:'Route'});
 }
 function ingestDns(data){
  for(const item of [...(data?.data || [])].reverse()){
   if(!['FilteredBlackList','FilteredSafeBrowsing','FilteredParental','FilteredInvalid','FilteredBlockedService'].includes(item.reason))continue;
   const time=Date.parse(item.time),host=item.question?.name;if(!Number.isFinite(time) || !host || host==='blocked.example')continue;
   const identity=JSON.stringify([item.time,item.client,host,item.question?.type,item.rules,item.reason]);if(seen.has(identity))continue;seen.set(identity,now());
   const applied=item.rules || [],owned=applied.find(rule=>Number(rule.filter_list_id)===0 && data.routeRules?.[rule.text]);
   const owner=owned && data.routeRules[owned.text];
   const labels=applied.map(rule=>data.filters?.[String(rule.filter_list_id)] || (Number(rule.filter_list_id)===0?'Custom rules':String(rule.filter_list_id))).filter(Boolean);
   record({blockSource:owner?'route':'dns',routeId:owner?.id || '',sourceIP:item.client || '',host,network:'dns',dnsType:item.question?.type || '',type:'DNS',rule:item.reason,rulePayload:applied.map(rule=>rule.text).join(' · ') || item.reason,ruleName:owner?.name || labels.join(' · ') || item.service_name || item.reason},time);
  }
  prune();
 }
 function connect(){
  if(!watchLogs || stream || stopped)return;
  const controller=new AbortController();stream=controller;status.route=null;
  Promise.resolve().then(()=>watchLogs(event=>{status.route=true;ingestLog(event);},{signal:controller.signal})).catch(()=>{if(!stopped)status.route=false;}).finally(()=>{if(stream===controller){stream=null;if(!stopped)status.route=false;}});
 }
 const api={
  ingestLog,ingestDns,
  snapshot(){prune();return {connections:[...rows.values()].sort((a,b)=>b.lastSeen-a.lastSeen),sources:{...status}};},
  poll(){if(stopped)return Promise.resolve(api.snapshot());if(pending)return pending;
   pending=(async()=>{
    try{const entries=await rules();registry=new Map(entries.map(rule=>[ruleKey(rule.type,rule.payload),rule]));}catch{status.route=false;}
    connect();
    try{ingestDns(await dns());status.dns=true;}catch{status.dns=false;}
    return api.snapshot();
   })().finally(()=>pending=null);return pending;
  },
  stop(){stopped=true;stream?.abort();}
 };
 return api;
}
