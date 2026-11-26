import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../server/store.js';
import {buildMihomoConfig} from '../server/mihomo.js';
import {defaultDnsSettings} from '../server/dns-resolvers.js';
import {createTelemetryCollector} from '../server/proxy-telemetry.js';
import {createServer} from '../server/index.js';

test('connection groups accept only existing profiles and protect referenced groups and members',()=>{
 const store=new Store(':memory:');
 try {
  assert.deepEqual(store.connectionGroups(),[]);
  const a=store.importProfile({name:'A',value:'socks5://192.0.2.1:1080'});
  const b=store.importProfile({name:'B',value:'socks5://192.0.2.2:1080'});
  assert.throws(()=>store.saveConnectionGroup(null,{name:'test',members:[]}));
  assert.throws(()=>store.saveConnectionGroup(null,{name:'test',members:['missing']}));
  const group=store.saveConnectionGroup(null,{name:' Auto ',members:[a.id,a.id,b.id]});
  assert.deepEqual(group.members,[a.id,b.id]);
  assert.equal(group.name,'Auto');
  assert.throws(()=>store.removeProfile(a.id),/used by a group/);
  const parent=store.saveConnectionGroup(null,{name:'nested',members:[group.id]});
  assert.throws(()=>store.removeConnectionGroup(group.id),/used by another group/);
  store.removeConnectionGroup(parent.id);
  const route=store.addRouteGroup({name:'Site',entries:['example.org'],routeId:group.id});
  const device=store.addDeviceRoute({name:'Phone',identifier:'10.20.0.10',routeId:group.id});
  assert.throws(()=>store.removeConnectionGroup(group.id),/used by routes/);
  store.updateRouteGroup(route.id,{routeId:a.id});store.removeDeviceRoute(device.id);
  assert.equal(store.removeConnectionGroup(group.id),true);
  assert.equal(store.removeConnectionGroup(group.id),false);
  store.removeRouteGroup(route.id);assert.equal(store.removeProfile(a.id),true);
 } finally {store.close();}
});

test('generated url-test groups route domains and devices without silently using DIRECT for unsupported members',()=>{
 const store=new Store(':memory:');
 try {
  const profile=store.importProfile({name:'A',value:'socks5://192.0.2.1:1080'});
  const unsupported=store.addProfile({name:'Unconfigured',protocol:'sstp'});
  const group=store.saveConnectionGroup(null,{name:'Auto',members:[profile.id,unsupported.id]});
  store.addRouteGroup({name:'Site',entries:['example.org'],routeId:group.id});
  store.addDeviceRoute({name:'Phone',identifier:'10.20.0.10',routeId:group.id});
  const yaml=buildMihomoConfig(defaultDnsSettings,{}, {profiles:store.profiles(),configs:store.db.prepare('SELECT * FROM profile_configs').all(),groups:store.routeGroups(),devices:store.deviceRoutes(),connectionGroups:store.connectionGroups()});
  assert.match(yaml,new RegExp(`name: cg-${group.id}\\n    type: url-test`));
  assert.ok(yaml.includes(`DOMAIN-SUFFIX,example.org,cg-${group.id}`));
  assert.ok(yaml.includes(`SRC-IP-CIDR,10.20.0.10/32,cg-${group.id}`));
  assert.ok(yaml.includes(`name: p-${unsupported.id.slice(0,8)}-grp\n    type: select\n    proxies:\n      - REJECT`));
  assert.match(yaml,/interval: 60/);assert.match(yaml,/lazy: false/);
  assert.match(yaml,/external-controller: 127\.0\.0\.1:19090/);
 } finally {store.close();}
});

test('telemetry attributes chains once, calculates rates, handles closed/reset flows and never exposes destinations',async()=>{
 let time=1000, flows=[{id:'one',chains:['p-12345678','p-12345678-grp','cg-group'],upload:100,download:300,metadata:{host:'private.example'}}];
 const registry={proxies:{'p-12345678-grp':{alive:true,history:[{delay:0,time:'2026-11-12T10:00:00Z',private:'not-public'},{delay:42,time:'2026-11-12T10:01:00Z'}]},'cg-group':{now:'p-12345678-grp'}}};
 const collect=createTelemetryCollector(async path=>path==='/connections'?{connections:flows}:registry,{now:()=>time});
 const profiles=[{id:'12345678-long',engine:'socks5'}],groups=[{id:'group'}];
 let data=await collect(profiles,groups);assert.equal(data.profiles[profiles[0].id].download,null);
 time+=2000;flows[0].upload+=200;flows[0].download+=600;
 data=await collect(profiles,groups);assert.equal(data.profiles[profiles[0].id].upload,100);assert.equal(data.profiles[profiles[0].id].download,300);
 assert.equal(data.groups.group.selectedId,profiles[0].id);assert.equal(data.profiles[profiles[0].id].ping,42);
 assert.ok(!JSON.stringify(data).includes('private.example'));assert.ok(!JSON.stringify(data).includes('not-public'));assert.deepEqual(data.profiles[profiles[0].id].httpHistory,[{time:'2026-11-12T10:00:00Z',delay:null},{time:'2026-11-12T10:01:00Z',delay:42}]);assert.deepEqual(data.groups.group.httpHistory,data.profiles[profiles[0].id].httpHistory);
 time+=2000;flows=[];data=await collect(profiles,groups);assert.equal(data.profiles[profiles[0].id].download,0);
 registry.proxies['p-12345678-grp'].alive=false;time+=2000;
 data=await collect(profiles,groups);assert.equal(data.profiles[profiles[0].id].ping,null);assert.equal(data.groups.group.selectedId,profiles[0].id);assert.equal(data.profiles[profiles[0].id].httpStatus,'error');
});

test('groups API enforces roles and CSRF and passes groups into runtime routes',async()=>{
 const store=new Store(':memory:');let routes;
 const supervisor={status:()=>({state:'running'}),setRoutes:(...args)=>routes=args,reapply:async()=>({ok:true}),telemetry:async()=>({available:true,profiles:{},groups:{}})};
 const server=createServer(store,{supervisor});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const base=`http://127.0.0.1:${server.address().port}`;
 try {
  const setup=await fetch(base+'/api/auth/setup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'admin',password:'test password 12345'})});
  const auth=await setup.json(),cookie=setup.headers.get('set-cookie').split(';')[0];
  const headers={'Content-Type':'application/json',Cookie:cookie,'X-CSRF-Token':auth.csrf};
  const member=store.profiles()[0].id;
  assert.equal((await fetch(base+'/api/connection-groups',{method:'POST',headers:{...headers,'X-CSRF-Token':''},body:'{}'})).status,403);
  const response=await fetch(base+'/api/connection-groups',{method:'POST',headers,body:JSON.stringify({name:'Auto',members:[member]})});assert.equal(response.status,201);
  const group=await response.json();assert.equal(routes[4][0].id,group.id);
  const parentResponse=await fetch(base+'/api/connection-groups',{method:'POST',headers,body:JSON.stringify({name:'Parent',members:[group.id]})});assert.equal(parentResponse.status,201);const parent=await parentResponse.json();
  assert.equal((await fetch(base+'/api/connection-groups/'+group.id,{method:'PUT',headers,body:JSON.stringify({members:[parent.id]})})).status,400);
  assert.deepEqual(store.connectionGroups().find(row=>row.id===group.id).members,[member]);
  assert.equal((await fetch(base+'/api/connection-groups/'+group.id,{method:'DELETE',headers})).status,400);
  assert.equal((await fetch(base+'/api/connection-groups/'+parent.id,{method:'DELETE',headers})).status,200);
  const userResponse=await fetch(base+'/api/users',{method:'POST',headers,body:JSON.stringify({username:'reader',password:'reader password 12345',role:'viewer'})});assert.equal(userResponse.status,201);
  const login=await fetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'reader',password:'reader password 12345'})});
  const reader=await login.json(),readerCookie=login.headers.get('set-cookie').split(';')[0];
  const forbidden=await fetch(base+'/api/connection-groups/'+group.id,{method:'DELETE',headers:{Cookie:readerCookie,'X-CSRF-Token':reader.csrf}});assert.equal(forbidden.status,403);
  assert.equal((await fetch(base+'/api/profiles/telemetry',{headers:{Cookie:readerCookie}})).status,200);
  assert.equal((await fetch(base+'/api/connection-groups/'+group.id,{method:'DELETE',headers})).status,200);
 } finally {await new Promise(resolve=>server.close(resolve));store.close();}
});
test('group telemetry resolves the selected gateway through a priority tier',async()=>{
 const request=async path=>path==='/connections'?{connections:[]}:{proxies:{'cg-pool':{now:'cg-pool-proxies'},'cg-pool-proxies':{now:'p-12345678-grp'},'p-12345678-grp':{alive:true,history:[{delay:20,time:'2026-11-16T10:00:00Z'}]}}};
 const result=await createTelemetryCollector(request)([{id:'12345678',engine:'mihomo'}],[{id:'pool'}]);assert.equal(result.groups.pool.selectedId,'12345678');assert.equal(result.groups.pool.ping,20);
});

test('gateway latency is managed independently instead of a duplicate fixed-endpoint health group',()=>{
 const yaml=buildMihomoConfig(defaultDnsSettings,{}, {profiles:[{id:'direct',engine:'direct'}],configs:[],groups:[],devices:[]});
 assert.doesNotMatch(yaml,/name: fg-health/);
});
