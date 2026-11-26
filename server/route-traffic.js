const key=(type,payload)=>String(type).replace(/[^a-z0-9]/gi,'').toLowerCase()+'\0'+payload;
// Observed bytes since service start. Snapshot sampling cannot account for flows
// that start and finish entirely between samples; this is not a billing counter.
export function createRouteTrafficCollector(request,{now=Date.now,clients=()=>[],storage=null}={}){
 const saved=storage?.load();
 const startedAt=saved?.startedAt || new Date(now()).toISOString();
 let paused=false,observations=[];
 let owners=[],revision=0,indexRevision=-1,index=new Map(),previous=new Map(),pending=null;
 const totals=kind=>Object.fromEntries(Object.entries(saved?.[kind] || {}).filter(([,value])=>Number.isFinite(value?.upload) && value.upload>=0 && Number.isFinite(value?.download) && value.download>=0));
 let result={available:false,startedAt,sampledAt:null,groups:totals('groups'),devices:totals('devices'),clients:totals('clients')};
 let persistedAt=0,persistenceFailed=false;
 function flush(){if(!storage)return;try{storage.save({startedAt,groups:result.groups,devices:result.devices,clients:result.clients});persistenceFailed=false;}catch{if(!persistenceFailed)console.error('FreedomGate: traffic counters could not be saved');persistenceFailed=true;}persistedAt=now();}
 function setOwners(value){
  owners=value;revision++;paused=false;
  for(const kind of ['groups','devices']){
   const ids=new Set(owners.filter(owner=>owner?.kind===kind).map(owner=>owner.id));
   for(const id of ids)result[kind][id] ||= {upload:0,download:0};
  }
 }
 async function sample(){
  if(paused)return;
  if(pending)return pending;
  pending=(async()=>{
   const generation=revision;
   try{
    if(indexRevision!==generation){
     const registry=await request('/rules');
     if(generation!==revision)return;
     const next=new Map();
     for(const [position,rule] of (registry.rules || []).entries()){
      const ruleKey=key(rule.type,rule.payload);
      // First rule wins even if it has no owner.
      if(!next.has(ruleKey))next.set(ruleKey,owners[position] || null);
     }
     index=next;indexRevision=generation;
    }
    const snapshot=await request('/connections');
    if(generation!==revision)return;
    const current=new Map(),paths=new Map();
    const sampled=now(),elapsed=result.available && result.sampledAt?(sampled-Date.parse(result.sampledAt))/1000:0;
    const addresses=new Map(clients().map(client=>[client.ip,client.mac.toLowerCase()]));
    for(const flow of snapshot.connections || []){
     const old=previous.get(flow.id);
     const owner=old?.owner || index.get(key(flow.rule,flow.rulePayload));
     const upload=Math.max(0,Number(flow.upload)||0),download=Math.max(0,Number(flow.download)||0);
     const mac=old?.mac || addresses.get(flow.metadata?.sourceIP);
     current.set(flow.id,{upload,download,owner,mac});
     if(mac){
      const total=result.clients[mac] ||= {upload:0,download:0};
      total.upload+=Math.max(0,upload-(old?.upload || 0));
      total.download+=Math.max(0,download-(old?.download || 0));
     }
     // Retain only attribution evidence, never destinations or proxy credentials.
     const m=flow.metadata || {};
     const chains=(flow.chains || []).filter(tag=>typeof tag==='string' && /^(DIRECT|REJECT|REJECT-DROP|p-[a-z0-9-]+|cg-[a-z0-9-]+|zapret-[a-z0-9-]+)$/i.test(tag));
     const identity=JSON.stringify([owner,m.sourceIP,m.inboundName,m.inboundUser,chains]);
     if(paths.size<5000 || paths.has(identity)){
      const path=paths.get(identity) || {routeKind:owner?.kind || null,routeId:owner?.id || null,rule:flow.rule,sourceIP:m.sourceIP || '',sourceMac:mac || '',inboundName:m.inboundName || '',inboundUser:m.inboundUser || '',chains,upload:0,download:0,uploadRate:elapsed>0?0:null,downloadRate:elapsed>0?0:null};
      path.upload+=upload;path.download+=download;
      if(elapsed>0){path.uploadRate+=Math.max(0,upload-(old?.upload || 0))/elapsed;path.downloadRate+=Math.max(0,download-(old?.download || 0))/elapsed;}
      paths.set(identity,path);
     }
     const target=owner && result[owner.kind]?.[owner.id];
     if(!target)continue;
     target.upload+=Math.max(0,upload-(old?.upload || 0));
     target.download+=Math.max(0,download-(old?.download || 0));
    }
    observations=[...paths.values()];previous=current;result.available=true;result.sampledAt=new Date(now()).toISOString();
    if(now()-persistedAt>=10000)flush();
   }catch{result.available=false;}
  })();
  try{await pending;}finally{pending=null;}
 }
 return {observations:()=>({available:result.available,sampledAt:result.sampledAt,paths:result.available?structuredClone(observations):[]}),flush,pause:()=>{paused=true;revision++;result.available=false;},setOwners,sample,snapshot:()=>structuredClone(result)};
}
