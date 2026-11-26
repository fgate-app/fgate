import {expandConnectionGroup,connectionGroupContains} from '../../../shared/connection-groups.js';
import {resolveCountryCode} from './countries.js';
import {gatewayChainAvailable} from '../../../shared/gateway-wrap.js';
const list=value=>Array.isArray(value)?value:[];
const number=value=>Number.isFinite(value)&&value>=0?value:null;
const moduleState=state=>['running','ready','active'].includes(state)?'healthy':['error','failed'].includes(state)?'error':['stopped','unavailable'].includes(state)?'disabled':'unknown';
const engineModule=engine=>({direct:'mihomo',mihomo:'mihomo',socks5:'mihomo',xray:'xray',outline:'outline',zapret:'zapret',tor:'tor',lantern:'lantern'}[engine]);
export const architectureClientId=client=>client.remote?'client:remote:'+client.accessPointId+':'+client.id:'client:'+(client.mac || client.ip || client.id);
export function buildNetworkArchitecture(snapshot,{unavailable=false,loading=false}={}){
 const nodes=[],edges=[],byId=new Map(),edgeMap=new Map();
 const columns=[32,292,552,812,1072],counts=[0,0,0,0,0];
 const addNode=(node,col)=>{if(byId.has(node.id))return byId.get(node.id);const value={state:'unknown',...node,x:columns[col],y:126+counts[col]++*136};nodes.push(value);byId.set(value.id,value);return value;};
 const addEdge=(source,target,{state,downloadRate=null,uploadRate=null,scope='architecture.observedTraffic'}={})=>{
  if(!byId.has(source)||!byId.has(target)||source===target)return null;
  const id=source+'→'+target;
  let edge=edgeMap.get(id);
  if(!edge){const a=byId.get(source),b=byId.get(target);edge={id,source,target,state:state || (['disabled','offline','error','blocked'].includes(a.state)?a.state:['disabled','offline','error','blocked'].includes(b.state)?b.state:'unknown'),download:null,upload:null,downloadRate:null,uploadRate:null,scope};edgeMap.set(id,edge);edges.push(edge);}
  for(const [key,value] of Object.entries({downloadRate,uploadRate}))if(number(value)!==null)edge[key]=(edge[key]??0)+value;
  if(number(downloadRate)!==null||number(uploadRate)!==null){if((downloadRate || 0)+(uploadRate || 0)>0||!['error','blocked','disabled'].includes(edge.state))edge.state='healthy';edge.scope=scope;}
  return edge;
 };
 if(!snapshot)return {nodes,edges,loading,unavailable,width:1284,height:810};
 const profiles=list(snapshot.profiles),groups=list(snapshot.connectionGroups),clients=list(snapshot.clients).filter(client=>client.online===true),modules=list(snapshot.modules);
 const telemetry=snapshot.telemetry?.available===true&&!unavailable?snapshot.telemetry:null;
 const observations=snapshot.observations?.available===true&&!unavailable?list(snapshot.observations.paths):[];
 for(const port of list(snapshot.network?.interfaces)){
  const setup=snapshot.network?.setup;
  const role=setup?.uplink?.interface===port.name?'WAN':setup?.client?.interface===port.name||setup?.wired?.enabled&&setup.wired.interface===port.name?'LAN':'';
  const counter=!unavailable?snapshot.interfaceTraffic?.interfaces?.[port.name]:null;
  addNode({traffic:counter?{download:role==='WAN'?number(counter.receiveRate):number(counter.transmitRate),upload:role==='WAN'?number(counter.transmitRate):number(counter.receiveRate)}:null,id:'port:'+port.name,kind:'port',icon:port.type==='wifi'?'wifi':'ethernet',name:port.name,detail:[role,...list(port.addresses)].filter(Boolean).join(' · '),state:unavailable?'unknown':port.carrier===true?'healthy':port.carrier===false?'offline':'unknown'},0);
 }
 for(const module of modules)addNode({id:'module:'+module.id,kind:'module',statusKey:module.state==='unavailable'?'architecture.notInstalled':null,icon:module.id==='mihomo'?'brand':module.id==='adguard'?'dns':'modules',name:module.name,detail:module.version && module.version!=='—'?module.version:'',state:unavailable?'unknown':moduleState(module.state)},1);
 for(const profile of profiles){
  const metric=telemetry?.profiles?.[profile.id];
  let state=profile.enabled===false?'disabled':!gatewayChainAvailable(profiles,profile.id)?'blocked':unavailable?'unknown':metric?.httpStatus==='ok'?'healthy':metric?.httpStatus==='error'||metric?.available===false?'error':'unknown';
  addNode({id:'gateway:'+profile.id,kind:'gateway',icon:'public',name:profile.name,detail:[profile.engine,profile.protocol].filter(Boolean).join(' · '),country:resolveCountryCode(metric?.location),enabled:profile.enabled!==false,state},2);
 }
 for(const group of groups){
  const memberIds=expandConnectionGroup(groups,group.id),selected=telemetry?.groups?.[group.id]?.selectedId;
  const state=selected?byId.get('gateway:'+selected)?.state || 'unknown':memberIds.length&&memberIds.every(id=>['error','disabled','blocked'].includes(byId.get('gateway:'+id)?.state))?'blocked':'unknown';
  addNode({id:'group:'+group.id,kind:'gatewayGroup',icon:'connections',name:group.name,detailKey:'architecture.connectionGroup',state},2);
 }
 for(const group of groups)for(const id of list(group.members)){const selected=telemetry?.groups?.[group.id]?.selectedId;addEdge((groups.some(row=>row.id===id)?'group:':'gateway:')+id,'group:'+group.id,{state:connectionGroupContains(groups,id,selected)?byId.get('gateway:'+selected)?.state:'unknown'});}
 const target=routeId=>byId.has('gateway:'+routeId)?'gateway:'+routeId:byId.has('group:'+routeId)?'group:'+routeId:null;
 const ruleRows=[...list(snapshot.rules?.groups).map(row=>({...row,routeKind:'groups'})),...list(snapshot.rules?.devices).map(row=>({...row,routeKind:'devices'}))];
 for(const row of ruleRows){
  const parent=target(row.routeId),parentState=byId.get(parent)?.state;
  addNode({id:'rule:'+row.routeKind+':'+row.id,kind:'rule',icon:row.routeId==='block'?'shield':'routes',name:row.name || row.identifier || row.id,detail:row.identifier || '',detailKey:row.routeId==='block'?'architecture.blockAction':!row.identifier?'architecture.domainCount':null,detailParameters:{count:row.entriesCount || 0},state:row.enabled===false?'disabled':row.routeId==='block'?'policy':parent?['error','disabled','blocked'].includes(parentState)?'blocked':parentState:'unknown'},3);
  if(parent)addEdge(parent,'rule:'+row.routeKind+':'+row.id,{state:byId.get('rule:'+row.routeKind+':'+row.id).state});
 }
 const direct=profiles.find(row=>row.engine==='direct');
 if(direct){addNode({id:'rule:default',kind:'rule',icon:'routes',nameKey:'architecture.ruleDefault',detailKey:'architecture.allOther',state:byId.get('gateway:'+direct.id)?.state || 'unknown'},3);addEdge('gateway:'+direct.id,'rule:default');}
 const clientId=architectureClientId;
 for(const client of clients)addNode({id:clientId(client),kind:'device',icon:client.remote?'public':'laptop',name:client.hostname || client.ip || client.mac || client.id,detail:client.remote?client.accessPointName:client.ip,state:unavailable?'unknown':client.online===true?'healthy':client.online===false?'offline':'unknown'},4);
 for(const profile of profiles){
  const module=engineModule(profile.engine),metric=telemetry?.profiles?.[profile.id];
  if(module&&module!=='mihomo')addEdge('module:mihomo','module:'+module);
  addEdge('module:'+module,'gateway:'+profile.id,{downloadRate:number(metric?.download),uploadRate:number(metric?.upload),scope:'architecture.gatewayTraffic'});
  // A configured outer gateway is part of this gateway's path, even when disabled.
  if(profile.gatewayId)addEdge('gateway:'+profile.gatewayId,'gateway:'+profile.id);
 }
 for(const port of list(snapshot.network?.interfaces)){
  const setup=snapshot.network?.setup;
  if(![setup?.uplink?.interface,setup?.client?.interface,...(setup?.wired?.enabled?[setup.wired.interface]:[])].includes(port.name))continue;
  // Kernel interface counters include bypass traffic, so do not attribute them to
  // mihomo. Keep the configured attachment without invented per-module rates.
  addEdge('port:'+port.name,'module:mihomo');
 }
 if(modules.some(row=>row.id==='adguard'))addEdge('module:adguard','module:mihomo');
 if(clients.some(client=>client.remote))addEdge('module:frp','module:mihomo');
 for(const path of observations){
  const client=clients.find(row=>path.accessClientId?row.remote&&row.id===path.accessClientId&&row.accessPointId===path.accessPointId:!row.remote&&(path.sourceMac?row.mac?.toLowerCase()===path.sourceMac.toLowerCase():row.ip===path.sourceIP));
  let rule=path.routeId?'rule:'+path.routeKind+':'+path.routeId:path.rule?.toLowerCase()==='match'?'rule:default':null;
  if(!rule||!byId.has(rule))continue;
  const rates={downloadRate:number(path.downloadRate),uploadRate:number(path.uploadRate)};
  if(client)addEdge(rule,clientId(client),rates);
  // Rates belong to this exact route/client observation, not to every gateway
  // sharing the same route. Configuration alone never implies client usage.
  const row=ruleRows.find(row=>'rule:'+row.routeKind+':'+row.id===rule),parent=rule==='rule:default'&&direct?'gateway:'+direct.id:target(row?.routeId);
  if(parent){
   addEdge(parent,rule,rates);
   const group=groups.find(group=>'group:'+group.id===parent);
   if(group){const member=expandConnectionGroup(groups,group.id).map(id=>profiles.find(row=>row.id===id)).filter(Boolean).find(profile=>profile.engine!=='direct'&&list(path.chains).some(tag=>tag===`p-${profile.id.slice(0,8)}`||tag===`p-${profile.id.slice(0,8)}-grp`)) || (list(path.chains).includes('DIRECT')?profiles.find(profile=>profile.engine==='direct'&&expandConnectionGroup(groups,group.id).includes(profile.id)):null);if(member)addEdge('gateway:'+member.id,parent,rates);}
  }
 }
 // Explicit device assignments are configuration evidence even without a flow.
 for(const row of list(snapshot.rules?.devices))for(const client of clients.filter(client=>!client.remote&&[client.ip,client.mac?.toLowerCase()].includes(row.identifier?.toLowerCase())))addEdge('rule:devices:'+row.id,clientId(client));
 if(unavailable){for(const node of nodes)if(!['disabled','policy'].includes(node.state))node.state='unknown';for(const edge of edges){edge.state='unknown';edge.downloadRate=null;edge.uploadRate=null;}}
 return {nodes,edges,partial:Object.values(snapshot.sources || {}).some(value=>value===false),width:1284,height:Math.max(810,Math.max(...counts,0)*136+176),loading,unavailable};
}
