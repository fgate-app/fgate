import {checkManagedCloud,managedEndpoint,managedPoint} from './access-points/managed.js';

// Status checks never enroll or overwrite the cloud's public SSH authorization.
export async function inspectRestoreCloud(snapshot,{accessPoints,gateways=[],check=checkManagedCloud}={}){
 const point=snapshot.repositories.access_points.find(row=>row.managed);
 if(!point?.host || !point.secrets?.token)return {state:'not-configured',reset:false};
 try{
  const remote=await check(point,{gateways,signal:AbortSignal.timeout(20000)});
  if(!remote.occupied)return {state:'available',reset:false};
  const current=accessPoints?.repository.all().find(row=>row.managed);
  const same=current?.enabled && current.secrets.instanceId===point.secrets.instanceId && current.secrets.credential===point.secrets.credential && managedEndpoint(current)===managedEndpoint(point);
  if(same && await accessPoints.runtime.status(current.id)==='active')return {state:'current',reset:false};
  return {state:'occupied',reset:true};
 }catch{return {state:'unavailable',reset:true};}
}
export function detachRestoreCloud(snapshot,inspection){
 if(!inspection.reset)return snapshot;
 const result=structuredClone(snapshot);
 result.repositories.access_points=result.repositories.access_points.map(point=>{
  if(!point.managed)return point;
  const detached={...point,secrets:managedPoint().secrets,clients:[],enabled:false,state:'stopped',stage:null,error:null};
  for(const key of ['host','publicPort','transportPort','vlessPort','platform','connectionTransport'])delete detached[key];
  return detached;
 });
 return result;
}
