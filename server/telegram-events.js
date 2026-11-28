import {expandConnectionGroup} from '../shared/connection-groups.js';
const updateActive=new Set(['downloading','building','verifying','installing','restarting','extracting','preparing','stopping','starting']);
const componentId=id=>String(id).replace(/[^a-zA-Z0-9-]/g,'').slice(0,12);
export async function observeTelegramRuntime(notifier,{store,supervisor,filter,accessPoints,modulesHelper,networkStatus}){
 const generation=notifier.generation;const current=()=>!notifier.closed && notifier.generation===generation;
 const health=(key,state,component,category='services')=>{if(!['running','ready','active','failed','error','stopped'].includes(state))return;notifier.observe(key,['running','ready','active'].includes(state)?'ready':'failed',{category,component,kind:'health',failed:!['running','ready','active'].includes(state)});};
 const runtime=supervisor?.status?.();
 if(runtime?.state==='running')health('service-app','ready','FreedomGate');
 if(runtime){health('service-mihomo',runtime.state,'mihomo');if(runtime.xray?.state!=='stopped' || notifier.state.observations['service-xray'])health('service-xray',runtime.xray?.state,'Xray');}
 const dns=filter?.status?.();if(dns?.state!=='stopped' || notifier.state.observations['service-adguard'])health('service-adguard',dns?.state,'AdGuard Home');
 const profiles=store.profiles(),groups=store.connectionGroups();
 const used=new Set([...store.routeGroups(),...store.deviceRoutes()].filter(r=>r.enabled!==false).map(r=>r.routeId));
 for(const group of groups)if(used.has(group.id))for(const id of expandConnectionGroup(groups,group.id))used.add(id);
 for(const profile of profiles.filter(p=>used.has(p.id)&&p.enabled!==false)){
  const metric=supervisor?.httpHealth?.get?.(profile);if(['ok','error'].includes(metric?.httpStatus))health('gateway-'+profile.id,metric.httpStatus==='ok'?'ready':'failed','Gateway '+componentId(profile.id),'gateways');
 }
 if(runtime?.state==='running' && groups.some(g=>used.has(g.id))){
  let registry;try{registry=(await supervisor.controller('/proxies')).proxies;}catch{}if(!current())return;
  for(const group of groups.filter(g=>used.has(g.id))){const proxy=registry?.['cg-'+group.id];if(!proxy)continue;
   const ids=expandConnectionGroup(groups,group.id),states=ids.map(id=>profiles.find(p=>p.id===id)).filter(Boolean).filter(p=>p.enabled!==false).map(p=>supervisor.httpHealth?.get?.(p)?.httpStatus);
   if(states.length && states.every(x=>['ok','error'].includes(x)))health('group-health-'+group.id,states.every(x=>x==='error')?'failed':'ready','Gateway group '+componentId(group.id),'gateways');
   let selected=proxy.now;const seen=new Set();while(registry[selected]?.now && !selected.startsWith('p-') && !seen.has(selected)){seen.add(selected);selected=registry[selected].now;}
   if(selected && selected!=='REJECT')notifier.observe('group-selection-'+group.id,selected,{category:'gateways',component:'Gateway group '+componentId(group.id)+' → '+(selected==='DIRECT'?'Direct':componentId(selected)),kind:'switched'});
  }
 }
 for(const point of accessPoints?.repository?.all?.().filter(p=>p.managed) || []){
  notifier.observe('cloud-enabled-'+point.id,!!point.enabled,{category:'cloud',component:'Cloud access',kind:'changed'});if(!point.enabled)continue;
  let state;try{state=await accessPoints.runtime.status(point.id);}catch{continue;}if(!current())return;
  health('cloud-health-'+point.id,state,'Cloud access','cloud');
  const transport=accessPoints.runtime.entries?.get(point.id)?.transport;
  if(transport)notifier.observe('cloud-transport-'+point.id,transport,{category:'cloud',component:'Cloud access ('+(['ssh','frp'].includes(transport)?transport:'tunnel')+')',kind:'changed'});
 }
 if(networkStatus){let state;try{state=await networkStatus();}catch{state={ok:false};}if(!current())return;health('service-network',state.ok?'ready':'failed','Network helper');}
 let updates;try{updates=await modulesHelper('status');}catch{}if(!current())return;
 for(const row of updates?.modules || []){
  if(!['system','mihomo','xray','adguard','zapret','frp','domain-lists','diagnostic-blocklist'].includes(row.id))continue;
  const key='update-'+row.id,previous=notifier.state.observations[key]?.value;
  if(previous!==row.state && previous && (row.state==='updated' || row.state==='error' && updateActive.has(previous)))notifier.enqueue('updates',row.state==='updated'?'updated':'updateFailed',row.id,key);
  notifier.state.observations[key]={value:row.state,pending:row.state,since:notifier.now()};
 }
}
