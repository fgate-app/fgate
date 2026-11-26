import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID,randomBytes} from 'node:crypto';
import {CloudRegistry,relayConfig} from '../server/cloud/broker.js';
import {AccessPointService} from '../server/access-points/service.js';
import {clientConfig,publicServer} from '../server/access-points/model.js';
import {managedPoint,managedEndpoint,managedHost,managedSshCapability,enrollManaged} from '../server/access-points/managed.js';
import {ingressConfig,frpcConfig} from '../server/access-points/runtime.js';
import {Store} from '../server/store.js';
const identity=()=>({accessToken:randomBytes(32).toString('base64url'),id:randomUUID(),credential:randomBytes(32).toString('hex')});
test('cloud enrollment is idempotent, isolates ports/tokens/TLS and never returns another tenant or private key',()=>{
 const dir=mkdtempSync(join(tmpdir(),'fg-cloud-'));let starts=0;
 try{
  const registry=new CloudRegistry({dir,host:'127.0.0.1',start:()=>starts++,capacity:2}),a=identity(),b=identity();
  registry.invite(a.accessToken);registry.invite(b.accessToken);
  const first=registry.enroll(a),again=registry.enroll(a),second=registry.enroll(b);
  assert.deepEqual(first,again);assert.notEqual(first.publicPort,second.publicPort);assert.notEqual(first.transportPort,second.transportPort);assert.notEqual(first.token,second.token);assert.notEqual(first.tlsCert,second.tlsCert);
  assert.ok(!first.tlsKey);assert.ok(!first.credentialHash);assert.deepEqual(relayConfig(first).allowPorts,[{single:first.publicPort}]);
  assert.throws(()=>registry.enroll({...a,credential:b.credential}),/Unauthorized/);const c=identity();registry.invite(c.accessToken);assert.throws(()=>registry.enroll(c),/Capacity/);assert.throws(()=>registry.enroll({id:'../../bad',credential:a.credential}));assert.equal(starts,3);
  const restored=new CloudRegistry({dir,host:'127.0.0.1',start:()=>{}});assert.deepEqual(restored.enroll(a),first);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('Outline export and TCP/UDP ingress contain only the instance client key and always use policy',()=>{
 const point=managedPoint();Object.assign(point,{host:'127.0.0.1',publicPort:20000,transportPort:20001});
 const visible=publicServer(point);assert.ok(visible.instanceId);assert.equal(visible.host,undefined);assert.ok(!JSON.stringify(visible).includes(point.clients[0].password));
 const link=clientConfig(point,point.clients[0]).link;assert.ok(link.startsWith('ss://'));assert.equal(new URL(link).searchParams.get('prefix'),'\x16\x03\x01\x00\u00a8\x01\x01');assert.equal(Buffer.from(link.slice(5,link.indexOf('@')),'base64url').toString(),'chacha20-ietf-poly1305:'+point.clients[0].password);
 const ingress=ingressConfig(point,12345);assert.equal(ingress.inbounds[0].protocol,'shadowsocks');assert.equal(ingress.inbounds[0].settings.network,'tcp,udp');assert.ok(!ingress.outbounds.some(out=>out.protocol==='freedom'));
 const tunnel=frpcConfig(point,12345,'/tmp/private',{statusPort:12346,statusPassword:'private'});assert.deepEqual(tunnel.proxies.map(proxy=>proxy.type),['tcp','udp']);assert.ok(tunnel.proxies.every(proxy=>proxy.remotePort===20000));
});
test('old database gets one disabled managed point; enrollment failure retries and disable preserves credentials',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'fg-managed-')),store=new Store(':memory:');let fail=true,stops=0,starts=0;
 const runtime={start:async()=>{starts++;},status:async()=>starts?'active':'stopped',stop:async()=>{stops++;},close:async()=>{}};
 const enroll=async server=>{if(fail)throw Error('unavailable');return {id:server.secrets.instanceId,host:'127.0.0.1',publicPort:20000,transportPort:20001,token:'a'.repeat(64),tlsCert:'test cert'};};
 const service=new AccessPointService(store,{stateDir:dir,runtime,enroll});
 try{
  const first=(await service.list())[0];assert.ok(first.managed);assert.equal(first.enabled,false);
  await service.restore();assert.equal(starts,0);await service.setEnabled(first.id,true);await Promise.all(service.jobs.values());assert.equal((await service.list())[0].state,'error');
  fail=false;await service.reconcile();await Promise.all(service.jobs.values());assert.equal((await service.list())[0].state,'active');
  const link=service.exportClient(first.id,first.clients[0].id).link;await service.setEnabled(first.id,false);assert.equal(stops,1);assert.equal(service.exportClient(first.id,first.clients[0].id).link,link);
  await assert.rejects(service.remove(first.id),/only be disabled/);assert.equal((await service.list())[0].instanceId,first.instanceId);
  const second=new AccessPointService(store,{stateDir:dir,runtime,enroll});assert.equal((await second.list()).length,1);assert.equal((await second.list())[0].instanceId,first.instanceId);await second.close();
 }finally{await service.close();store.close();rmSync(dir,{recursive:true,force:true});}
});

test('remote DNS resolves through local-mode AdGuard instead of the policy SOCKS listener',()=>{
 const config=ingressConfig(managedPoint(),20000,{adguardPort:53054});
 assert.deepEqual(config.dns.servers,['tcp+local://127.0.0.1:53054']);
 assert.equal(config.routing.rules[0].outboundTag,'dns');
 assert.ok(!config.outbounds.some(out=>out.protocol==='freedom'));
});

test('cloud transport gateway is a validated local listener and retains pinned TLS and TCP/UDP relays',()=>{
 const point=managedPoint();Object.assign(point,{host:'192.0.2.1',publicPort:20000,transportPort:20001});
 const config=frpcConfig(point,12345,'/private/relay',{statusPort:12346,statusPassword:'fixture',gateway:{id:'one',port:28001,secret:'a'.repeat(64)}});
 assert.equal(config.transport.proxyURL,'http://fg-geo:'+ 'a'.repeat(64)+'@127.0.0.1:28001');assert.equal(config.transport.tls.trustedCaFile,'/private/relay/tls.crt');assert.equal(config.transport.tls.serverName,'192.0.2.1');assert.deepEqual(config.proxies.map(p=>p.type),['tcp','udp']);
 assert.throws(()=>frpcConfig(point,12345,'/private/relay',{gateway:{id:'bad',port:80,secret:'a'.repeat(64)}}),/unavailable/);
});

test('cloud is optional: fresh and old databases have no endpoint and stay offline until configured',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'fg-optional-cloud-')),store=new Store(':memory:');let enrollments=0,starts=0;
 const service=new AccessPointService(store,{stateDir:dir,enroll:async()=>{enrollments++;throw Error('Unexpected enrollment');},runtime:{start:async()=>starts++,stop:async()=>{},close:async()=>{}}});
 try{
  const point=(await service.list())[0];assert.equal(point.cloudAddress,'');assert.equal(point.hasCloudToken,false);assert.equal(point.enabled,false);
  await service.restore();await service.reconcile();assert.equal(enrollments,0);assert.equal(starts,0);
  await service.configureCloud(point.id,{enabled:false,address:'',token:''});assert.equal(enrollments,0);
  await assert.rejects(service.configureCloud(point.id,{enabled:true,address:'',token:''}),/HTTPS cloud address/);
  await assert.rejects(service.configureCloud(point.id,{enabled:true,address:'https:\/\/cloud.example',token:''}),/access token/);
 }finally{await service.close();store.close();rmSync(dir,{recursive:true,force:true});}
});
test('enrollment validates explicit endpoint and invitation before attempting any connection',async()=>{
 const p=managedPoint();let attempts=0;const options={onAttempt:()=>attempts++};
 assert.equal(managedEndpoint(p),'');assert.equal(managedHost(p),'');assert.equal(managedSshCapability(p),null);
 await assert.rejects(enrollManaged(p,options),/HTTPS cloud address/);
 p.cloudAddress='https://cloud.example';await assert.rejects(enrollManaged(p,options),/access token/);assert.equal(attempts,0);
});
