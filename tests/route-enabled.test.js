import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {Store} from '../server/store.js';
import {FilterPolicy} from '../server/filter-policy.js';
import {buildMihomoConfig} from '../server/mihomo.js';
import {defaultDnsSettings} from '../server/dns-resolvers.js';
import {createServer} from '../server/index.js';
test('legacy route tables migrate to enabled; disabled rules persist through edits and reopening',()=>{
 const folder=mkdtempSync(join(tmpdir(),'fg-route-enabled-')),path=join(folder,'db');let store;
 try{
  const db=new DatabaseSync(path);db.exec(`CREATE TABLE route_groups (id TEXT PRIMARY KEY,name TEXT NOT NULL,entries TEXT NOT NULL,route_id TEXT,created_at TEXT NOT NULL); INSERT INTO route_groups VALUES ('legacy','Legacy','["example.org"]','block','2026-01-01'); CREATE TABLE device_routes (id TEXT PRIMARY KEY,name TEXT NOT NULL,identifier TEXT NOT NULL,route_id TEXT,created_at TEXT NOT NULL); CREATE TABLE local_routes (id TEXT PRIMARY KEY,alias TEXT NOT NULL UNIQUE,target TEXT NOT NULL,created_at TEXT NOT NULL); INSERT INTO local_routes VALUES ('local','router.home','10.20.0.1','2026-01-01');`);db.close();
  store=new Store(path);assert.equal(store.routeGroup('legacy').enabled,true);assert.equal(store.localRoutes()[0].enabled,true);
  store.setRouteEnabled('groups','legacy',false);store.updateRouteGroup('legacy',{name:'Changed'});store.setRouteEnabled('locals','local',false);store.updateLocalRoute('local',{target:'10.20.0.2'});
  const direct=store.profiles().find(p=>p.engine==='direct');const device=store.addDeviceRoute({name:'Phone',identifier:'10.20.0.10',routeId:direct.id});store.setRouteEnabled('devices',device.id,false);store.updateDeviceRoute(device.id,{name:'Renamed'});
  store.close();store=new Store(path);assert.equal(store.routeGroup('legacy').enabled,false);assert.equal(store.localRoutes()[0].enabled,false);assert.equal(store.deviceRoutes()[0].enabled,false);assert.throws(()=>store.setRouteEnabled('groups','legacy','false'));
 }finally{store?.close();rmSync(folder,{recursive:true,force:true});}
});
test('disabled rules leave no mihomo rules or DNS rewrites; disabled exceptions do not suppress active blocks',async()=>{
 const store=new Store(':memory:');let rules=[];const policy=new FilterPolicy(store,{userRules:async()=>rules,reconcileUserRules:async(_,next)=>{rules=next;}});
 try{
  const direct=store.profiles().find(p=>p.engine==='direct');
  const exception=store.addRouteGroup({name:'Exception',entries:['allowed.example'],routeId:direct.id}),block=store.addRouteGroup({name:'Block',entries:['blocked.example'],routeId:'block'}),device=store.addDeviceRoute({name:'Phone',identifier:'10.20.0.12',routeId:direct.id}),local=store.addLocalRoute({alias:'router.home',target:'10.20.0.1'});
  await policy.change(()=>store.setRouteEnabled('groups',exception.id,false));assert.ok(rules.includes('||blocked.example^'));
  await policy.change(()=>store.setRouteEnabled('groups',block.id,false));await policy.change(()=>store.setRouteEnabled('devices',device.id,false));await policy.change(()=>store.setRouteEnabled('locals',local.id,false));assert.deepEqual(rules,[]);
  const yaml=buildMihomoConfig(defaultDnsSettings,{}, {profiles:store.profiles(),configs:[],groups:store.routeGroups(),devices:store.deviceRoutes()});assert.ok(!yaml.includes('blocked.example'));assert.ok(!yaml.includes('allowed.example'));assert.ok(!yaml.includes('10.20.0.12'));
  await policy.change(()=>store.setRouteEnabled('groups',block.id,true));assert.ok(rules.includes('||blocked.example^'));
 }finally{store.close();}
});
test('route toggle API enforces permissions, validates state and defers runtime apply and reports failures without losing saved edits',async()=>{
 const store=new Store(':memory:');let fail=false;const supervisor={status:()=>({state:'running'}),setRoutes:()=>{},reapply:async()=>({ok:!fail,error:'Fixture apply failed'})};
 const server=createServer(store,{supervisor,inlineDelay:30});await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}/api/`;
 const call=(path,method='GET',body,auth)=>fetch(base+path,{method,headers:{'Content-Type':'application/json',...(auth?{Cookie:auth.cookie,'X-CSRF-Token':auth.csrf}:{})},...(body?{body:JSON.stringify(body)}:{})});
 try{
  const setup=await call('auth/setup','POST',{username:'admin',password:'test password 12345'}),data=await setup.json(),admin={cookie:setup.headers.get('set-cookie').split(';')[0],csrf:data.csrf};
  const row=store.addRouteGroup({name:'Rule',entries:['example.com'],routeId:'block'}),path='routes/groups/'+row.id+'/enabled';
  assert.equal((await call(path,'PUT',{enabled:false})).status,401);assert.equal((await call(path,'PUT',{enabled:false},{...admin,csrf:'wrong'})).status,403);
  await call('users','POST',{username:'viewer',password:'test password 12345',role:'viewer'},admin);const login=await call('auth/login','POST',{username:'viewer',password:'test password 12345'}),v=await login.json(),viewer={cookie:login.headers.get('set-cookie').split(';')[0],csrf:v.csrf};assert.equal((await call(path,'PUT',{enabled:false},viewer)).status,403);
  assert.equal((await call(path,'PUT',{enabled:'false'},admin)).status,400);assert.equal(store.routeGroup(row.id).enabled,true);
  fail=true;const queued=await call(path,'PUT',{enabled:false},admin);assert.equal(queued.status,200);assert.equal((await queued.json()).apply.state,'pending');assert.equal(store.routeGroup(row.id).enabled,false);
  async function applied(state){for(let i=0;i<100;i++){const response=await call('changes/status','GET',undefined,admin),data=await response.json();if(data.state===state)return data;await new Promise(r=>setTimeout(r,10));}throw Error('Timed out waiting for '+state);}
  assert.equal((await applied('error')).error,'Fixture apply failed');
  fail=false;assert.equal((await call(path,'PUT',{enabled:true},admin)).status,200);await applied('applied');assert.equal(store.routeGroup(row.id).enabled,true);
 }finally{await new Promise(r=>server.close(r));store.close();}
});
