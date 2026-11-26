// A read-only projection. Keep raw proxy configs, Wi-Fi passwords, inbound
// usernames, targets and controller responses out of this endpoint.
const list=value=>Array.isArray(value)?value:[];
const pick=(value,keys)=>Object.fromEntries(keys.filter(key=>value?.[key]!==undefined).map(key=>[key,value[key]]));
export async function collectNetworkArchitecture({store,supervisor,filter,interfaces,networkTraffic,clients,remoteClients,zapret,versions,frp=async()=>null,describePaths=rows=>rows}){
 const requests={
  network:async()=>({interfaces:interfaces(),setup:store.networkSettings()}),
  telemetry:()=>supervisor?.telemetry?.(store.profiles(),store.connectionGroups()) || {available:false},
  clients,remoteClients,interfaceTraffic:networkTraffic,zapret,frp,
 };
 const entries=await Promise.all(Object.entries(requests).map(async([key,request])=>{try{return [key,await request()];}catch{return [key,null];}}));
 const data=Object.fromEntries(entries),engine=supervisor?.status?.() || {state:'unavailable'};
 const paths=supervisor?.architecturePaths?.() || {available:false,paths:[]};
 const local=list(data.clients),remote=list(data.remoteClients);
 const allClients=[...local,...remote].map(client=>pick(client,['id','accessPointId','accessPointName','hostname','ip','mac','online','remote','traffic']));
 const observations=paths.available?describePaths(paths.paths || []).map(path=>({
  ...pick(path,['routeKind','routeId','rule','sourceIP','sourceMac','chains','upload','download','uploadRate','downloadRate']),
  ...(path.accessClientId?{accessClientId:path.accessClientId,accessPointId:path.accessPointId}:{})
 })):[];
 const runtimeState=value=>value?.state || 'unknown';
 const aggregate=states=>states.some(state=>['error','failed','unavailable'].includes(state))?'error':states.some(state=>['running','ready','active'].includes(state))?'running':states.some(state=>['connecting','waiting'].includes(state))?'connecting':states.length?'stopped':'unknown';
 const modules=[
  ['mihomo','mihomo',runtimeState(engine)],['adguard','AdGuard Home',runtimeState(filter?.status?.())],
  ['xray','Xray',runtimeState(engine.xray)],['outline','Shadowsocks Outline SDK',runtimeState(engine.ssRelay)],
  ['zapret','zapret2',data.zapret?.ok?(data.zapret.running?(data.zapret.nftables?'running':'error'):'stopped'):'unknown'],
  ['tor','Tor',engine.torInstalled===false?'unavailable':aggregate(Object.values(engine.tor || {}).map(runtimeState))],
  ['lantern','Lantern',engine.lanternInstalled===false?'unavailable':aggregate(Object.values(engine.lantern || {}).map(runtimeState))],
  ['frp','frp',data.frp || 'unknown'],
 ].map(([id,name,state])=>({id,name,state,version:versions?.[id] || null}));
 const telemetry=data.telemetry && {available:data.telemetry.available===true,profiles:Object.fromEntries(Object.entries(data.telemetry.profiles || {}).map(([id,metric])=>[id,{...pick(metric,['available','httpStatus','upload','download']),location:pick(metric.location,['country','countryCode'])}])),groups:Object.fromEntries(Object.entries(data.telemetry.groups || {}).map(([id,metric])=>[id,pick(metric,['selectedId','httpStatus'])]))};
 const setup=data.network?.setup;
 return {timestamp:new Date().toISOString(),sources:Object.fromEntries(entries.map(([key,value])=>[key,value!=null])),
  network:data.network?{interfaces:list(data.network.interfaces).map(row=>pick(row,['name','type','state','carrier','addresses'])),setup:{uplink:pick(setup?.uplink,['interface']),client:pick(setup?.client,['interface','type','vlanId']),wired:pick(setup?.wired,['interface','enabled','vlanId'])}}:null,
  profiles:store.profiles().map(row=>pick(row,['id','name','engine','protocol','enabled','gatewayId'])),connectionGroups:store.connectionGroups().map(row=>pick(row,['id','name','members'])),
  rules:{groups:store.routeGroups().map(row=>({...pick(row,['id','name','routeId','enabled']),entriesCount:list(row.entries).length})),devices:store.deviceRoutes().map(row=>pick(row,['id','name','identifier','routeId','enabled']))},
  clients:allClients,modules,telemetry,interfaceTraffic:data.interfaceTraffic,
  observations:{available:paths.available===true,sampledAt:paths.sampledAt || null,paths:observations},
 };
}
