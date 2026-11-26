import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../server/store.js';
import {AccessPointService} from '../server/access-points/service.js';
import {clientLink} from '../server/access-points/model.js';
import {canonicalGatewayHost,assertNoResolvedAccessPointGateway,recursionError} from '../server/gateway-recursion.js';
import {createServer} from '../server/index.js';
const uuid='00000000-0000-4000-8000-000000000001';
const link=(host,port=443)=>`vless://${uuid}@${host}:${port}?security=none`;
const snapshot=host=>({profile:{builtin:0},config:{engine:'socks5',config:`socks5://${host}:1080`}});
function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'fg-recursion-')),store=new Store(':memory:'),service=new AccessPointService(store,{stateDir:dir,runtime:{close:async()=>{}}});
 service.repository.save({id:'test-point',name:'Fixture',host:'203.0.113.10',enabled:false,protocol:'shadowsocks',publicPort:20000,clients:[{id:uuid,password:'synthetic-test-password',enabled:false}],secrets:{}});
 return {store,service,close:async()=>{await service.close();store.close();rmSync(dir,{recursive:true,force:true});}};
}
test('canonical host catches alternate IPv4, mapped IPv6, compressed IPv6 and domain spelling',()=>{
 for(const host of ['203.0.113.10','0xcb00710a','3405803786','[::ffff:203.0.113.10]'])assert.equal(canonicalGatewayHost(host),'203.0.113.10');
 assert.equal(canonicalGatewayHost('[2001:0db8:0:0::1]'),'2001:db8::1');assert.equal(canonicalGatewayHost('EXAMPLE.COM.'),'example.com');
});
test('all import paths reject access-point servers regardless of protocol, key, port or enabled state',async()=>{
 const f=fixture();try{
  const point=f.service.repository.get('test-point');
  const inputs=[clientLink(point,point.clients[0]),link('203.0.113.10',8443),'socks5://203.0.113.10:1081','socks5://[::ffff:203.0.113.10]:1080',JSON.stringify({outbounds:[{protocol:'vless',settings:{vnext:[{address:'203.0.113.10',port:9443,users:[{id:uuid,encryption:'none'}]}]}}]}),JSON.stringify({type:'hysteria2',server:'203.0.113.10',port:443,password:'fixture'})];
  for(const value of inputs){assert.throws(()=>f.store.importProfile({name:'loop',value}),{message:recursionError});assert.equal(f.store.profiles().filter(p=>!p.builtin).length,0);}
  const cloud=f.service.repository.all().find(p=>p.managed);cloud.cloudAddress='https://192.0.2.44:7443';f.service.repository.save(cloud);
  assert.throws(()=>f.store.importProfile({value:link('192.0.2.44')}),{message:recursionError},'configured cloud endpoint is protected before enrollment');
 }finally{await f.close();}
});
test('mixed batch rolls back and editing or enabling an old recursive profile cannot bypass validation',async()=>{
 const f=fixture();try{
  assert.throws(()=>f.store.importProfiles({value:link('198.51.100.8')+'\n'+link('203.0.113.10')}),{message:recursionError});assert.equal(f.store.profiles().filter(p=>!p.builtin).length,0);
  const good=f.store.importProfile({name:'good',value:link('198.51.100.8')}),before=f.store.profileSnapshot(good.id);
  assert.throws(()=>f.store.updateProfile(good.id,{editor:{type:'vless',fields:{server:'203.0.113.10'}}}),{message:recursionError});assert.deepEqual(f.store.profileSnapshot(good.id),before);
  assert.throws(()=>f.store.updateProfile(good.id,{value:link('203.0.113.10')}),{message:recursionError});assert.deepEqual(f.store.profileSnapshot(good.id),before);
  f.store.db.prepare('UPDATE profile_configs SET config=? WHERE profile_id=?').run(JSON.stringify({outbounds:[{protocol:'vless',settings:{vnext:[{address:'203.0.113.10',port:443,users:[{id:uuid,encryption:'none'}]}]}}]}),good.id);
  assert.throws(()=>f.store.updateProfile(good.id,{enabled:true}),{message:recursionError});assert.equal(f.store.updateProfile(good.id,{enabled:false}).enabled,false,'An old recursive gateway can always be disabled');
 }finally{await f.close();}
});
test('DNS aliases are compared by all returned addresses; unavailable DNS stays bounded',async()=>{
 await assert.rejects(assertNoResolvedAccessPointGateway([snapshot('alias.example')],()=>[{host:'203.0.113.10'}],{resolve:async()=>[{address:'198.51.100.1'},{address:'203.0.113.10'}]}),{message:recursionError});
 await assert.rejects(assertNoResolvedAccessPointGateway([snapshot('[2001:db8::1]')],()=>[{host:'ap.example'}],{resolve:async()=>[{address:'2001:db8::1'}]}),{message:recursionError});
 await assertNoResolvedAccessPointGateway([snapshot('offline.example')],()=>[],{resolve:()=>new Promise(()=>{}),timeoutMs:10});
 await assertNoResolvedAccessPointGateway([snapshot('external.example')],()=>[{host:'203.0.113.10'}],{resolve:async()=>[{address:'198.51.100.1'}]});
});
test('API rejects a mixed batch and replacement before applying routes or changing stored profiles',async()=>{
 const f=fixture();let applies=0;const server=createServer(f.store,{accessPoints:f.service,supervisor:{applyRoutes:async()=>{applies++;}}});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{
  const base='http://127.0.0.1:'+server.address().port,response=await fetch(base+'/api/auth/setup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'admin',password:'fixture password 12345'})}),session=await response.json(),headers={'Content-Type':'application/json',Cookie:response.headers.get('set-cookie').split(';')[0],'X-CSRF-Token':session.csrf};
  const rejected=await fetch(base+'/api/profiles/import',{method:'POST',headers,body:JSON.stringify({value:link('198.51.100.8')+'\n'+link('203.0.113.10')})});assert.equal(rejected.status,400);assert.equal((await rejected.json()).error,recursionError);assert.equal(f.store.profiles().filter(p=>!p.builtin).length,0);assert.equal(applies,0);
  const good=f.store.importProfile({name:'good',value:link('198.51.100.8')}),before=f.store.profileSnapshot(good.id);
  const edited=await fetch(base+'/api/profiles/'+good.id,{method:'PUT',headers,body:JSON.stringify({editor:{type:'vless',fields:{server:'203.0.113.10'}}})});assert.equal(edited.status,400);assert.deepEqual(f.store.profileSnapshot(good.id),before);
 }finally{await new Promise(r=>server.close(r));await f.close();}
});


test('native WireGuard peers and overlay endpoints cannot recurse through access points',async()=>{
 const f=fixture(),key=Buffer.alloc(32,1).toString('base64');
 const wg={type:'wireguard','private-key':key,ip:'10.0.0.2',peers:[{server:'198.51.100.1',port:443,'public-key':key},{server:'203.0.113.10',port:8443,'public-key':key}]};
 try{
  for(const node of [wg,{type:'easytier',peers:['tcp://203.0.113.10:11010']},{type:'tailscale','control-url':'https://203.0.113.10'}])assert.throws(()=>f.store.importProfiles({value:JSON.stringify({proxies:[node]})}),{message:recursionError});
  wg.peers[1].server='alias.example';const snapshot={profile:{builtin:0},config:{engine:'mihomo',config:JSON.stringify({mihomo:wg})}};
  await assert.rejects(assertNoResolvedAccessPointGateway([snapshot],()=>[{host:'203.0.113.10'}],{resolve:async()=>[{address:'203.0.113.10'}]}),{message:recursionError});
 }finally{await f.close();}
});
