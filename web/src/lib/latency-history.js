export const latencyHistoryLimit=24;
const empty=()=>({http:[],udp:[]});
const storageKey=id=>'fg.latency-history.v1:'+id;
export function mergeLatencySamples(...lists){
 const samples=new Map();
 for(const list of lists){
  if(!Array.isArray(list))continue;
  for(const sample of list){
   if(!sample || typeof sample.time!=='string' || !Number.isFinite(Date.parse(sample.time)))continue;
   if(sample.delay!==null && (!Number.isFinite(sample.delay) || sample.delay<=0))continue;
   const time=new Date(sample.time).toISOString();
   samples.set(time,{time,delay:sample.delay});
  }
 }
 return [...samples.values()].sort((a,b)=>a.time.localeCompare(b.time)).slice(-latencyHistoryLimit);
}
export function loadLatencyHistory(id){
 if(!id)return empty();
 try{
  const saved=JSON.parse(localStorage.getItem(storageKey(id)));
  return {http:mergeLatencySamples(saved?.http),udp:mergeLatencySamples(saved?.udp)};
 }catch{return empty();}
}
export function saveLatencyHistory(id,history){
 if(!id)return;
 try{localStorage.setItem(storageKey(id),JSON.stringify(history));}catch{/* Charts still work when browser storage is unavailable. */}
}
