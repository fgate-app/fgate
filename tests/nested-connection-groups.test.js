import test from 'node:test';import assert from 'node:assert/strict';import {parse} from 'yaml';
import {Store} from '../server/store.js';import {buildMihomoConfig} from '../server/mihomo.js';import {defaultDnsSettings} from '../server/dns-resolvers.js';import {expandConnectionGroup,connectionGroupContains} from '../shared/connection-groups.js';import {countConnectionRoutes} from '../web/src/lib/route-usage.js';import {buildNetworkArchitecture} from '../web/src/lib/network-architecture.js';
const runtime=store=>parse(buildMihomoConfig(defaultDnsSettings,{}, {profiles:store.profiles(),configs:store.db.prepare('SELECT * FROM profile_configs').all(),groups:store.routeGroups(),devices:[],connectionGroups:store.connectionGroups()}));
test('nested groups preserve references, flatten unique proxies and immediately track child edits',()=>{
 const store=new Store(':memory:');try{
 const a=store.importProfile({name:'EU',value:'socks5://192.0.2.1:1080'}),b=store.importProfile({name:'US',value:'socks5://192.0.2.2:1080'}),c=store.importProfile({name:'Other',value:'socks5://192.0.2.3:1080'});
 const eu=store.saveConnectionGroup(null,{name:'Europa',members:[a.id]}),us=store.saveConnectionGroup(null,{name:'USA',members:[b.id,a.id]}),vpn=store.saveConnectionGroup(null,{name:'VPN',members:[eu.id,us.id,a.id]});
 assert.deepEqual(store.connectionGroups().find(g=>g.id===vpn.id).members,[eu.id,us.id,a.id]);
 assert.deepEqual(expandConnectionGroup(store.connectionGroups(),vpn.id),[a.id,b.id]);
 assert.deepEqual(runtime(store)['proxy-groups'].find(g=>g.name==='cg-'+vpn.id).proxies,[`p-${a.id.slice(0,8)}-grp`,`p-${b.id.slice(0,8)}-grp`]);
 store.saveConnectionGroup(eu.id,{members:[c.id]});assert.deepEqual(expandConnectionGroup(store.connectionGroups(),vpn.id),[c.id,b.id,a.id]);
 store.saveConnectionGroup(us.id,{members:[b.id]});store.saveConnectionGroup(vpn.id,{members:[eu.id,us.id]});assert.deepEqual(runtime(store)['proxy-groups'].find(g=>g.name==='cg-'+vpn.id).proxies,[`p-${c.id.slice(0,8)}-grp`,`p-${b.id.slice(0,8)}-grp`]);
 assert.throws(()=>store.saveConnectionGroup(eu.id,{members:[eu.id]}),/cycles/);assert.throws(()=>store.saveConnectionGroup(eu.id,{members:[vpn.id]}),/cycles/);assert.deepEqual(store.connectionGroups().find(g=>g.id===eu.id).members,[c.id]);assert.throws(()=>store.removeConnectionGroup(eu.id),/another group/);
 const route=store.addRouteGroup({name:'All',entries:['example.org'],routeId:vpn.id});assert.equal(countConnectionRoutes({groups:[route]},c.id,store.connectionGroups()),1);assert.equal(countConnectionRoutes({groups:[route]},eu.id,store.connectionGroups()),1);
 const graph=buildNetworkArchitecture({profiles:store.profiles(),connectionGroups:[vpn,eu,us],rules:{groups:[]},modules:[],clients:[]});assert.ok(graph.edges.some(e=>e.source==='group:'+eu.id&&e.target==='group:'+vpn.id));
 }finally{store.close()}
});
test('DAG expansion handles shared descendants and corrupt cycles without falling back to DIRECT',()=>{
 const groups=[{id:'root',members:['a','b','p']},{id:'a',members:['child']},{id:'b',members:['child']},{id:'child',members:['p','q']}];assert.deepEqual(expandConnectionGroup(groups,'root'),['p','q']);assert.equal(connectionGroupContains(groups,'root','child'),true);groups[3].members.push('root');assert.deepEqual(expandConnectionGroup(groups,'root'),[]);assert.throws(()=>expandConnectionGroup(groups,'root',{rejectCycles:true}),/cycles/);
 const yaml=parse(buildMihomoConfig(defaultDnsSettings,{}, {profiles:[{id:'p',engine:'direct',enabled:true}],configs:[],groups:[],devices:[],connectionGroups:groups}));assert.deepEqual(yaml['proxy-groups'].find(g=>g.name==='cg-root').proxies,['REJECT']);
});
