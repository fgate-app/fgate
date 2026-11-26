// Probe each exit explicitly through the engine; never fall back to the host route.
export const httpHealthUrls = Object.freeze([
  'https://www.gstatic.com/generate_204',
  'https://cp.cloudflare.com/generate_204',
  'https://www.apple.com/library/test/success.html',
]);

export function createHttpHealth(request, {now=Date.now, interval=60000, timeout=4000, report=()=>{}, urls=httpHealthUrls, transport=()=>({state:'ready'})}={}) {
  let generation=0, timer=null, controller=null, entries=new Map();
  const failures=new Map();
  function emit(event){try{report(event);}catch{}}
  function event(profile,url,failed,reason) {
    const key=`${profile.id}:${url}`, previous=failures.get(key), time=now();
    if(failed){
      if(!previous || time-previous.loggedAt>=900000){
        failures.set(key,{loggedAt:time});
        emit({profileId:profile.id,endpoint:new URL(url).hostname,failed:true,reason});
      }
    }else if(previous){
      failures.delete(key);
      emit({profileId:profile.id,endpoint:new URL(url).hostname,failed:false,reason:'ok'});
    }
  }
  async function probe(entry,version) {
    const valid=()=>generation===version && entries.get(entry.profile.id)===entry;
    const connection=transport(entry.profile);
    if(connection.state!=='ready'){
      entry.metric={httpStatus:connection.state==='failed'?'error':'checking',ping:null,httpEndpoint:null,httpHistory:entry.history.slice()};
      entry.nextAt=0;
      return;
    }
    if(entry.nextAt>now())return;
    const probeTimeout=connection.timeout || timeout;
    let result={httpStatus:'error',ping:null,httpEndpoint:null};
    for(const url of urls){
      if(!valid())return;
      try{
        const data=await request(`/proxies/${encodeURIComponent(entry.tag)}/delay?timeout=${probeTimeout}&url=${encodeURIComponent(url)}`,{timeout:probeTimeout+1500,signal:controller.signal});
        if(!valid())return;
        if(transport(entry.profile).state!=='ready'){entry.nextAt=0;return;}
        if(!Number.isFinite(data?.delay) || data.delay<=0)throw Error('invalid-delay');
        event(entry.profile,url,false);
        result={httpStatus:'ok',ping:data.delay,httpEndpoint:new URL(url).hostname};
        break;
      }catch(error){
        if(!valid())return;
        if(transport(entry.profile).state!=='ready'){entry.nextAt=0;return;}
        const reason=error?.name==='TimeoutError' || error?.status===504?'timeout':'unreachable';
        event(entry.profile,url,true,reason);
      }
    }
    if(!valid())return;
    const measuredAt=new Date(now()).toISOString();
    entry.history.push({time:measuredAt,delay:result.ping});
    entry.history=entry.history.slice(-24);
    entry.metric={...result,measuredAt,httpHistory:entry.history.slice()};
    entry.nextAt=now()+interval;
  }
  async function round(version) {
    const queue=[...entries.values()];
    await Promise.all(Array.from({length:Math.min(2,queue.length)},async()=>{
      while(queue.length && generation===version)await probe(queue.shift(),version);
    }));
    if(generation===version){timer=setTimeout(()=>round(version),Math.min(interval,1000));timer.unref?.();}
  }
  return {
    start(profiles){
      clearTimeout(timer);controller?.abort();controller=new AbortController();const version=++generation;
      const previous=entries;entries=new Map();
      for(const profile of profiles){
        if(profile.enabled===false || profile.engine==='block')continue;
        const old=previous.get(profile.id);
        entries.set(profile.id,{profile,tag:profile.engine==='direct'?'DIRECT':`p-${profile.id.slice(0,8)}-grp`,history:old?.history || [],metric:old?.metric || {httpStatus:'checking',ping:null,httpHistory:[]}});
      }
      for(const key of failures.keys())if(!entries.has(key.split(':')[0]))failures.delete(key);
      return round(version);
    },
    get(profile){
      if(profile.enabled===false)return {httpStatus:'disabled',ping:null,httpHistory:[],httpEndpoint:null};
      const connection=transport(profile),metric=entries.get(profile.id)?.metric || {httpStatus:'unmeasured',ping:null,httpHistory:[],httpEndpoint:null};
      return connection.state==='ready'?metric:{...metric,httpStatus:connection.state==='failed'?'error':'checking',ping:null,httpEndpoint:null};
    },
    stop(){++generation;controller?.abort();clearTimeout(timer);timer=null;entries.clear();failures.clear();},
  };
}
