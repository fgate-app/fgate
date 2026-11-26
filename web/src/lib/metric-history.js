const windowMs=5*60*1000;
const key=id=>'fg.metric-history.v1:'+id;
export function mergeMetricSamples(lists,now=Date.now()){
 const samples=new Map();
 for(const list of lists)for(const sample of Array.isArray(list)?list:[]){
  if(!sample || !Number.isFinite(sample.time) || sample.time<now-windowMs || sample.time>now)continue;
  const normalized={time:sample.time};
  for(const field of ['cpu','memory','upload','download']){
   const value=sample[field];
   normalized[field]=Number.isFinite(value) && value>=0 && (!['cpu','memory'].includes(field) || value<=100)?value:null;
  }
  samples.set(sample.time,normalized);
 }
 return [...samples.values()].sort((a,b)=>a.time-b.time).slice(-61);
}
export function loadMetricHistory(id,now=Date.now()){
 try{return id?mergeMetricSamples([JSON.parse(localStorage.getItem(key(id)))],now):[];}catch{return [];}
}
export function saveMetricHistory(id,samples){
 try{if(id)localStorage.setItem(key(id),JSON.stringify(samples));}catch{/* Keep collecting when browser storage is unavailable. */}
}
