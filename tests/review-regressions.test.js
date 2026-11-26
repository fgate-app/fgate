import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../server/store.js';
import {AccessPointService} from '../server/access-points/service.js';
import {createServer} from '../server/index.js';
import {nativeFixtures} from './fixtures/mihomo-proxies.js';

const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
test('access point mutations cannot overwrite a concurrent key revocation or deletion',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'fg-review-clients-')),store=new Store(':memory:');
 let gate=null,live;
 const runtime={start:async row=>{live=structuredClone(row);},stop:async()=>{},close:async()=>{},status:async()=> 'active'};
 const service=new AccessPointService(store,{stateDir:dir,runtime,prepare:async()=>{if(gate)await gate.promise;}});
 try{
  const row=service.repository.all()[0];row.enabled=true;row.host='192.0.2.1';service.repository.save(row);const id=row.id,clientId=row.clients[0].id;
  gate=deferred();const adding=service.addClient(id,{name:'New client'});
  for(const action of [()=>service.changeClient(id,clientId,{enabled:false}),()=>service.changeClient(id,clientId,{}, {remove:true}),()=>service.setEnabled(id,false),()=>service.remove(id),()=>service.saveClients(id,{clients:[]})])await assert.rejects(action,e=>e.status===409);
  gate.resolve();await adding;gate=null;
  await service.changeClient(id,clientId,{enabled:false});
  assert.equal(service.repository.get(id).clients.find(c=>c.id===clientId).enabled,false);
  assert.equal(live.clients.find(c=>c.id===clientId).enabled,false);
  await service.changeClient(id,clientId,{}, {remove:true});
  await service.addClient(id,{name:'Another client'});
  assert.ok(!service.repository.get(id).clients.some(c=>c.id===clientId));
  assert.ok(!live.clients.some(c=>c.id===clientId));
  
  await service.setEnabled(id,false);assert.equal(service.repository.get(id).enabled,false);
 }finally{gate?.resolve();await service.close();store.close();rmSync(dir,{recursive:true,force:true});}
});

for(const outer of ['tor','lantern'])test(`dependent UDP and OpenVPN chains reject a new ${outer} ancestor`,()=>{
 const store=new Store(':memory:');
 try{
  for(const type of ['hysteria2','openvpn']){
   const inner=store.importProfile({name:type,value:JSON.stringify({type,server:'192.0.2.5',port:443,...(type==='hysteria2'?{password:'fixture'}:nativeFixtures[type])})});
   const middle=store.importProfile({value:'socks5://192.0.2.6:1080'}),target=store.profiles().find(p=>p.engine===outer);
   store.updateProfile(inner.id,{gatewayId:middle.id});
   assert.throws(()=>store.updateProfile(middle.id,{gatewayId:target.id}),/UDP-only/);
   assert.equal(store.profiles().find(p=>p.id===middle.id).gatewayId,null);
   if(type==='openvpn'){
    store.updateProfile(inner.id,{value:JSON.stringify({type,server:'192.0.2.5',port:443,...(type==='hysteria2'?{password:'fixture'}:nativeFixtures[type]),proto:'tcp'})});
    store.updateProfile(middle.id,{gatewayId:target.id});
    assert.throws(()=>store.updateProfile(inner.id,{value:JSON.stringify({type,server:'192.0.2.5',port:443,...(type==='hysteria2'?{password:'fixture'}:nativeFixtures[type])})}),/UDP-only/);
   }else{
    store.updateProfile(inner.id,{value:'socks5://192.0.2.7:1080'});store.updateProfile(middle.id,{gatewayId:target.id});
    assert.throws(()=>store.updateProfile(inner.id,{value:JSON.stringify({type,server:'192.0.2.5',port:443,...(type==='hysteria2'?{password:'fixture'}:nativeFixtures[type])})}),/UDP-only/);
   }
  }
 }finally{store.close();}
});

test('route API rolls back failed create, update and delete and preserves a queued successful request',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'fg-review-routes-')),store=new Store(':memory:');
 let failure=false,gate=null,entered=null;const applied=[];
 const supervisor={status:()=>({state:'running'}),setRoutes:()=>{},reapply:async()=>{
  if(gate){const pending=gate;gate=null;entered.resolve();await pending.promise;return {ok:false,error:'Fixture apply failed'};}
  if(failure){failure=false;return {ok:false,error:'Fixture apply failed'};}
  applied.push(JSON.stringify({devices:store.deviceRoutes(),groups:store.routeGroups(),locals:store.localRoutes()}));return {ok:true};
 }};
 const accessPoints=new AccessPointService(store,{stateDir:dir});const server=createServer(store,{supervisor,accessPoints});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{
  const base='http://127.0.0.1:'+server.address().port;const setup=await fetch(base+'/api/auth/setup',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'reviewadmin',password:'FixturePassword123!'})});const cookie=setup.headers.get('set-cookie').split(';')[0],session=await setup.json();
  const request=async(path,method,body)=>{const response=await fetch(base+'/api/routes/'+path,{method,headers:{'content-type':'application/json',cookie,'x-csrf-token':session.csrf},...(body?{body:JSON.stringify(body)}:{})});return {status:response.status,body:await response.json()};};
  const routeId=store.profiles().find(p=>p.engine==='direct').id;
  for(const [kind,input,update,rows] of [
   ['devices',{name:'Device',identifier:'192.0.2.44',routeId},{name:'Changed'},()=>store.deviceRoutes()],
   ['groups',{name:'Group',entries:['example.com'],routeId},{name:'Changed'},()=>store.routeGroups()],
   ['locals',{alias:'fixture.home',target:'192.0.2.45'},{target:'192.0.2.46'},()=>store.localRoutes()]
  ]){
   const before=rows();failure=true;assert.equal((await request(kind,'POST',input)).status,400);assert.deepEqual(rows(),before);
   const created=await request(kind,'POST',input);assert.equal(created.status,201);const saved=rows();
   failure=true;assert.equal((await request(kind+'/'+created.body.id,'PUT',update)).status,400);assert.deepEqual(rows(),saved);
   failure=true;assert.equal((await request(kind+'/'+created.body.id,'DELETE')).status,400);assert.deepEqual(rows(),saved);
  }
  gate=deferred();const paused=gate;entered=deferred();const rejected=request('devices','POST',{name:'Rejected',identifier:'192.0.2.90',routeId});await entered.promise;
  const accepted=request('devices','POST',{name:'Accepted',identifier:'192.0.2.91',routeId});paused.resolve();assert.equal((await rejected).status,400);assert.equal((await accepted).status,201);
  assert.ok(!store.deviceRoutes().some(r=>r.name==='Rejected'));assert.ok(store.deviceRoutes().some(r=>r.name==='Accepted'));assert.ok(applied.at(-1).includes('Accepted'));
 }finally{gate?.resolve();await new Promise(r=>server.close(r));await server.cleanup;store.close();rmSync(dir,{recursive:true,force:true});}
});
