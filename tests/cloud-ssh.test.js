import test from 'node:test';import assert from 'node:assert/strict';
import net from 'node:net';import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createSshBannerRelay,createCloudSshIdentity} from '../server/access-points/cloud-ssh.js';
import {cloudAuthorizedKey,cloudSshdConfig,validEd25519Key,cloudSshUser} from '../server/cloud/ssh-policy.js';
import {CloudRegistry} from '../server/cloud/broker.js';import {managedPoint} from '../server/access-points/managed.js';
import {frpcConfig} from '../server/access-points/runtime.js';
import {AccessPointService} from '../server/access-points/service.js';import {Store} from '../server/store.js';
const key=await createCloudSshIdentity();
test('SSH device keys are Ed25519; authorization permits only own relay and enrollment, no shell',()=>{
 assert.equal(validEd25519Key(key.publicKey),true);assert.equal(validEd25519Key(key.publicKey+' injected'),false);assert.equal(validEd25519Key('ssh-ed25519 AAAA'),false);
 const line=cloudAuthorizedKey({sshPublicKey:key.publicKey,transportPort:20001});assert.match(line,/^restrict,port-forwarding,command="\/usr\/sbin\/nologin"/);assert.match(line,/permitopen="127.0.0.1:20001"/);assert.match(line,/permitopen="127.0.0.1:7443"/);assert.ok(!line.includes('20003'));assert.match(cloudSshdConfig,/MaxSessions 0/);assert.match(cloudSshdConfig,/AllowTcpForwarding local/);assert.match(cloudSshdConfig,/AllowStreamLocalForwarding no/);
});
test('enrollment registers only the authenticated tenant public key and never leaks private identity',()=>{
 const dir=mkdtempSync(join(tmpdir(),'fg-cloud-ssh-registry-'));let row;
 try{const registry=new CloudRegistry({dir,host:'127.0.0.1',start:value=>{row=value;return {ssh:{username:cloudSshUser(value.id),port:22,hostKey:key.publicKey}};}});const point=managedPoint(),body={id:point.secrets.instanceId,credential:point.secrets.credential,sshPublicKey:key.publicKey,accessToken:'test-invitation-'.repeat(3)};registry.invite(body.accessToken);const r=registry.enroll(body);assert.equal(row.sshPublicKey,key.publicKey);assert.ok(r.ssh);assert.equal(r.sshPublicKey,undefined);assert.equal(r.tlsKey,undefined);assert.ok(!JSON.stringify(r).includes(key.privateKey));assert.throws(()=>registry.enroll({...body,credential:'f'.repeat(64)}),/Unauthorized/);assert.throws(()=>registry.enroll({...body,sshPublicKey:key.publicKey+'\ncommand=bad'}),/Invalid identity/);}finally{rmSync(dir,{recursive:true,force:true});}
});
test('banner relay buffers client-first data and preserves a fragmented server greeting and tail',async()=>{
 let accepted;const entered=new Promise(resolve=>accepted=resolve);let upstream,received='';
 const server=net.createServer(s=>{upstream=s;s.on('data',b=>received+=b);accepted();});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const relay=await createSshBannerRelay({host:'127.0.0.1',port:server.address().port});const client=net.connect(relay.port,'127.0.0.1');client.on('error',()=>{});let response='';client.on('data',b=>response+=b);
 try{client.write('SSH-2.0-client\r\nclient-kex');await entered;await new Promise(r=>setTimeout(r,30));assert.equal(received,'');upstream.write('SSH-2.');await new Promise(r=>setTimeout(r,20));assert.equal(received,'');upstream.write('0-server\r\nserver-kex');for(let i=0;i<50&&!received;i++)await new Promise(r=>setTimeout(r,10));assert.equal(received,'SSH-2.0-client\r\nclient-kex');assert.equal(response,'SSH-2.0-server\r\nserver-kex');}finally{client.destroy();await relay.close();await new Promise(r=>server.close(r));}
});
test('banner relay closes an oversized untrusted greeting and releases pending sockets',async()=>{
 const server=net.createServer(s=>{s.on('error',()=>{});s.end(Buffer.alloc(9000,65));});await new Promise(r=>server.listen(0,'127.0.0.1',r));const relay=await createSshBannerRelay({host:'127.0.0.1',port:server.address().port});const client=net.connect(relay.port,'127.0.0.1');client.on('error',()=>{});
 try{await new Promise(r=>client.once('close',r));}finally{client.destroy();await relay.close();await new Promise(r=>server.close(r));}
});
test('FRP over SSH preserves endpoint certificate and transports both TCP and UDP within the tunnel',()=>{
 const point=managedPoint();Object.assign(point,{host:'192.0.2.1',publicPort:20000,transportPort:20001});const config=frpcConfig(point,12345,'/private',{statusPort:12346,statusPassword:'test',sshTransport:{relayPort:23456}});assert.equal(config.serverAddr,'127.0.0.1');assert.equal(config.serverPort,23456);assert.equal(config.transport.proxyURL,undefined);assert.equal(config.transport.tls.serverName,'192.0.2.1');assert.equal(config.transport.tls.trustedCaFile,'/private/tls.crt');assert.deepEqual(config.proxies.map(p=>p.type),['tcp','udp']);
});
async function fixture(run){const dir=mkdtempSync(join(tmpdir(),'fg-cloud-ssh-service-')),store=new Store(':memory:');let service;try{await run(options=>service=new AccessPointService(store,{stateDir:dir,...options}));}finally{await service?.close();store.close();rmSync(dir,{recursive:true,force:true});}}
function cached(service){const p=service.repository.all()[0];Object.assign(p,{cloudAddress:'https://192.0.2.44:7443',host:'192.0.2.1',publicPort:20000,transportPort:20001});Object.assign(p.secrets,{token:'a'.repeat(64),tlsCert:'-----BEGIN CERTIFICATE-----fixture',cloudSshPrivateKey:key.privateKey,cloudSshPublicKey:key.publicKey,cloudSshRegisteredKey:key.publicKey,cloudSsh:{username:cloudSshUser(p.secrets.instanceId),port:22,hostKey:key.publicKey}});service.repository.save(p);return p;}
test('failed direct relay switches to SSH before other gateways and retains SSH for client key edits',()=>fixture(async create=>{
 const starts=[];let last;const service=create({gateways:()=>[{id:'proxy',port:28001,secret:'a'.repeat(64)}],enroll:async()=>{throw Error('must not enroll');},runtime:{supportsCloudSsh:true,start:async(_p,options)=>{last=options;starts.push(options.ssh?'ssh':options.gateway?'gateway':'direct');},waitActive:async()=>last.ssh,status:async()=> 'active',stop:async()=>{},close:async()=>{}}});const p=cached(service);await service.setEnabled(p.id,true);await Promise.all(service.jobs.values());assert.deepEqual(starts,['direct','ssh']);await service.addClient(p.id,{name:'Test'});assert.equal(starts.at(-1),'ssh');assert.equal(last.gateway,undefined);
}));
test('SSH failure falls back to existing gateways without downgrading host pinning',()=>fixture(async create=>{
 let last;const starts=[];const service=create({gateways:()=>[{id:'proxy',port:28001,secret:'a'.repeat(64)}],runtime:{supportsCloudSsh:true,start:async(_p,o)=>{last=o;starts.push(o.ssh?'ssh':o.gateway?'gateway':'direct');if(o.ssh)throw Error('Host key mismatch');},waitActive:async()=>!!last.gateway,status:async()=> 'active',stop:async()=>{},close:async()=>{}}});const p=cached(service);await service.setEnabled(p.id,true);await Promise.all(service.jobs.values());assert.deepEqual(starts,['direct','ssh','gateway']);assert.equal(service.sshTransports.has(p.id),false);
}));
test('legacy cached relay registers an independent key before activating SSH',()=>fixture(async create=>{
 let registered,last;const starts=[];const service=create({sshCapability:p=>({username:cloudSshUser(p.secrets.instanceId),port:2222,hostKey:key.publicKey}),enroll:async p=>{registered=p.secrets.cloudSshPublicKey;return {host:p.host,publicPort:p.publicPort,transportPort:p.transportPort,token:p.secrets.token,tlsCert:p.secrets.tlsCert};},runtime:{supportsCloudSsh:true,start:async(_p,o)=>{last=o;starts.push(o.ssh?'ssh':'direct');},waitActive:async()=>last.ssh,status:async()=> 'active',stop:async()=>{},close:async()=>{}}});const p=cached(service);delete p.secrets.cloudSsh;delete p.secrets.cloudSshPrivateKey;delete p.secrets.cloudSshPublicKey;delete p.secrets.cloudSshRegisteredKey;service.repository.save(p);await service.setEnabled(p.id,true);await Promise.all(service.jobs.values());assert.deepEqual(starts,['direct','ssh']);assert.ok(validEd25519Key(registered));assert.notEqual(registered,key.publicKey);assert.equal(service.repository.get(p.id).secrets.cloudSshRegisteredKey,registered);
}));

test('a failed ingress launch closes the already authenticated SSH transport and removes private runtime files',async()=>{
 const {AccessPointRuntime}=await import('../server/access-points/runtime.js');const {readdirSync}=await import('node:fs');const dir=mkdtempSync(join(tmpdir(),'fg-ssh-cleanup-'));let closed=0;
 const point=managedPoint();Object.assign(point,{host:'192.0.2.1',publicPort:20000,transportPort:20001});Object.assign(point.secrets,{token:'a'.repeat(64),tlsCert:'fixture',cloudSshPrivateKey:key.privateKey,cloudSshPublicKey:key.publicKey,cloudSsh:{username:cloudSshUser(point.secrets.instanceId),port:22,hostKey:key.publicKey}});
 const runtime=new AccessPointRuntime({stateDir:dir,xray:'/usr/bin/true',frpc:'/usr/bin/true',sshStart:async()=>({relayPort:12345,child:{exitCode:null,signalCode:null},close:async()=>closed++})});
 try{await assert.rejects(runtime.start(point,{ssh:true}));assert.equal(closed,1);assert.deepEqual(readdirSync(join(dir,'access-runtime')),[]);assert.equal(runtime.entries.size,0);}finally{await runtime.close();rmSync(dir,{recursive:true,force:true});}
});

test('pinned enrollment sends the device public key and rejects an unrelated TLS certificate',async()=>{
 const https=await import('node:https');const {tlsIdentity}=await import('../server/access-points/provision.js');const {enrollManaged}=await import('../server/access-points/managed.js');const identity=await tlsIdentity('127.0.0.1'),other=await tlsIdentity('127.0.0.1');const point=managedPoint();point.secrets.cloudSshPublicKey=key.publicKey;point.secrets.cloudAccessToken="test-invitation-".repeat(3);let bodies=[];
 const server=https.createServer({key:identity.tlsKey,cert:identity.tlsCert},async(req,res)=>{let data='';for await(const b of req)data+=b;bodies.push(JSON.parse(data));res.end(JSON.stringify({id:point.secrets.instanceId,host:'127.0.0.1',publicPort:20000,transportPort:20001,token:'a'.repeat(64),tlsCert:identity.tlsCert,ssh:{username:cloudSshUser(point.secrets.instanceId),port:22,hostKey:key.publicKey}}));});await new Promise(r=>server.listen(0,'127.0.0.1',r));const config={endpoint:'https://127.0.0.1:'+server.address().port,certificate:identity.tlsCert};
 try{const row=await enrollManaged(point,{config});assert.ok(row.ssh);assert.equal(bodies[0].sshPublicKey,key.publicKey);assert.ok(!JSON.stringify(bodies).includes(key.privateKey));await assert.rejects(enrollManaged(point,{config:{...config,certificate:other.tlsCert}}),/temporarily unavailable/);assert.equal(bodies.length,1);}finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});
test('legacy enrollment retries through a local authenticated gateway while retaining TLS IP verification',async()=>{
 const https=await import('node:https');const {tlsIdentity}=await import('../server/access-points/provision.js');const {enrollManaged}=await import('../server/access-points/managed.js');const {readGatewayBytes}=await import('../server/gateway-tunnel.js');const identity=await tlsIdentity('127.0.0.2'),point=managedPoint();point.secrets.cloudAccessToken='test-invitation-'.repeat(3);let authenticated=false;const sockets=new Set();
 const server=https.createServer({key:identity.tlsKey,cert:identity.tlsCert},(_q,r)=>r.end(JSON.stringify({id:point.secrets.instanceId,host:'127.0.0.2',publicPort:20000,transportPort:20001,token:'a'.repeat(64),tlsCert:identity.tlsCert})));await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const proxy=net.createServer(s=>{sockets.add(s);s.on('error',()=>{});s.on('close',()=>sockets.delete(s));(async()=>{assert.deepEqual([...await readGatewayBytes(s,3)],[5,1,2]);s.write(Buffer.from([5,2]));assert.equal((await readGatewayBytes(s,1))[0],1);const user=(await readGatewayBytes(s,(await readGatewayBytes(s,1))[0])).toString();const password=(await readGatewayBytes(s,(await readGatewayBytes(s,1))[0])).toString();assert.equal(user,'fg-geo');assert.equal(password,'a'.repeat(64));authenticated=true;s.write(Buffer.from([1,0]));const h=await readGatewayBytes(s,4);if(h[3]===1)await readGatewayBytes(s,4);else await readGatewayBytes(s,(await readGatewayBytes(s,1))[0]);await readGatewayBytes(s,2);const up=net.connect(server.address().port,'127.0.0.1');sockets.add(up);up.on('error',()=>s.destroy());up.on('close',()=>{sockets.delete(up);s.destroy();});s.on('close',()=>up.destroy());await new Promise((r,j)=>{up.once('connect',r);up.once('error',j);});s.write(Buffer.from([5,0,0,1,127,0,0,1,0,0]));s.pipe(up);up.pipe(s);})().catch(()=>s.destroy());});
 let port;for(let i=0;i<20;i++){port=29000+Math.floor(Math.random()*8000);try{await new Promise((r,j)=>{proxy.once('error',j);proxy.listen(port,'127.0.0.1',r);});break;}catch{if(i===19)throw Error('No fixture port');}}
 try{const row=await enrollManaged(point,{config:{endpoint:'https://127.0.0.2:'+server.address().port,certificate:identity.tlsCert},gateways:[{id:'fixture',port,secret:'a'.repeat(64)}]});assert.equal(authenticated,true);assert.equal(row.host,'127.0.0.2');}finally{for(const s of sockets)s.destroy();server.closeAllConnections();await Promise.all([new Promise(r=>proxy.close(r)),new Promise(r=>server.close(r))]);}
});

test('random OpenSSH identity is interoperable and authorization never derives keys from transport tokens',async()=>{
 const {generateCloudSshIdentity,cloudAuthorizedKeys}=await import('../server/cloud/ssh-policy.js');const {writeFileSync}=await import('node:fs');const {execute}=await import('../server/access-points/ssh.js');const a=generateCloudSshIdentity(),b=generateCloudSshIdentity();assert.notEqual(a.publicKey,b.publicKey);assert.equal(validEd25519Key(a.publicKey),true);
 const dir=mkdtempSync(join(tmpdir(),'fg-random-ssh-'));try{const path=join(dir,'identity');writeFileSync(path,a.privateKey,{mode:0o600});const result=await execute('ssh-keygen',['-y','-P','','-f',path]);assert.equal(result.code,0);assert.equal(result.output.trim().split(/\s+/).slice(0,2).join(' '),a.publicKey);assert.equal(cloudAuthorizedKeys({token:'a'.repeat(64),transportPort:20001}),'');const line=cloudAuthorizedKeys({token:'a'.repeat(64),transportPort:20001,sshPublicKey:a.publicKey});assert.ok(line.endsWith(a.publicKey+'\n'));assert.ok(!line.includes(b.publicKey));}finally{rmSync(dir,{recursive:true,force:true});}
});

test('cloud admission is mandatory, single-instance and stored only as a digest',()=>{
 const dir=mkdtempSync(join(tmpdir(),'fg-cloud-invite-'));const point=managedPoint(),token='invitation-fixture-'.repeat(3);let starts=0;
 try{const registry=new CloudRegistry({dir,host:'127.0.0.1',start:()=>starts++});const body={id:point.secrets.instanceId,credential:point.secrets.credential,accessToken:token,sshPublicKey:key.publicKey};
  assert.throws(()=>registry.enroll(body),/Invalid cloud access token/);assert.equal(starts,0);
  registry.invite(token);const first=registry.enroll(body);assert.equal(registry.enroll(body).token,first.token);
  assert.throws(()=>registry.enroll({...body,accessToken:undefined}),/Invalid cloud access token/);
  assert.throws(()=>registry.enroll({...body,id:managedPoint().secrets.instanceId}),/already assigned/);
  const {readdirSync,readFileSync}=process.getBuiltinModule('node:fs');for(const file of readdirSync(dir).filter(f=>f.endsWith('.json')))assert.ok(!readFileSync(join(dir,file),'utf8').includes(token));
  const inviteDir=join(dir,'invitations');assert.ok(!JSON.stringify(readdirSync(inviteDir)).includes(token));assert.ok(!readFileSync(join(inviteDir,readdirSync(inviteDir)[0]),'utf8').includes(token));
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('cloud settings keep secrets out of API, retain a blank token and preserve client keys and ports',()=>fixture(async create=>{
 const service=create({runtime:{start:async()=>{},status:async()=> 'stopped',stop:async()=>{},close:async()=>{}}});const p=cached(service);p.cloudAddress='https://cloud.example:7443';p.secrets.cloudAccessToken='existing-invitation-'.repeat(3);service.repository.save(p);
 const before=structuredClone(p.clients);const visible=await service.configureCloud(p.id,{address:p.cloudAddress,token:'',enabled:false});assert.equal(visible.hasCloudToken,true);assert.ok(!JSON.stringify(visible).includes(p.secrets.cloudAccessToken));assert.deepEqual(service.repository.get(p.id).clients,before);assert.equal(service.repository.get(p.id).publicPort,20000);
 await assert.rejects(service.configureCloud(p.id,{address:'http://cloud.example',token:''}),/HTTPS/);
 await assert.rejects(service.configureCloud(p.id,{address:'https://other.example',token:''}),/access token/);
 await service.configureCloud(p.id,{address:p.cloudAddress,token:'new-invitation-'.repeat(3),enabled:false});assert.equal(service.repository.get(p.id).secrets.cloudSshRegisteredKey,undefined);assert.equal(service.repository.get(p.id).secrets.cloudSshPrivateKey,key.privateKey);
 await service.configureCloud(p.id,{address:'https://other.example',token:'other-invitation-'.repeat(3),enabled:false});assert.equal(service.repository.get(p.id).host,undefined);assert.equal(service.repository.get(p.id).secrets.token,undefined);assert.equal(service.repository.get(p.id).secrets.cloudSsh,undefined);assert.deepEqual(service.repository.get(p.id).clients,before);
}));

test('saving unchanged cloud settings preserves the live SSH transport and client sessions',()=>fixture(async create=>{
 let stops=0,starts=0;const runtime={entries:new Map(),supportsCloudSsh:true,start:async()=>starts++,stop:async()=>stops++,status:async()=> 'active',close:async()=>{}};const service=create({runtime}),p=cached(service);p.enabled=true;p.secrets.cloudAccessToken='unchanged-invitation-'.repeat(3);service.repository.save(p);runtime.entries.set(p.id,{transport:'ssh'});service.sshTransports.add(p.id);
 const result=await service.configureCloud(p.id,{address:'https://192.0.2.44:7443',token:'',enabled:true});assert.equal(result.enabled,true);assert.equal(stops,0);assert.equal(starts,0);assert.equal(service.sshTransports.has(p.id),true);assert.equal((await service.list())[0].connectionTransport,'ssh');assert.deepEqual(service.repository.get(p.id).clients,p.clients);
}));
test('cloud settings lock the whole disable-save-enable operation against competing changes',()=>fixture(async create=>{
 let release,entered;const gate=new Promise(r=>release=r),stopping=new Promise(r=>entered=r);const service=create({runtime:{start:async()=>{},stop:async()=>{entered();await gate;},status:async()=> 'active',close:async()=>{}},enroll:async()=>{throw Error('Unexpected registration');}});const p=cached(service);p.enabled=true;p.secrets.cloudAccessToken='previous-invitation-'.repeat(3);service.repository.save(p);
 const saving=service.configureCloud(p.id,{address:'https://192.0.2.44:7443',token:'replacement-invitation-'.repeat(3),enabled:true});await stopping;
 try{await assert.rejects(service.configureCloud(p.id,{address:'https://192.0.2.44:7443',token:'competing-invitation-'.repeat(3),enabled:false}),/busy/);await assert.rejects(service.setEnabled(p.id,false),/busy/);await assert.rejects(service.addClient(p.id,{name:'Concurrent'}),/busy/);}finally{release();}
 await saving;await Promise.all(service.jobs.values());const after=service.repository.get(p.id);assert.equal(after.enabled,true);assert.equal(after.secrets.cloudAccessToken,'replacement-invitation-'.repeat(3));assert.deepEqual(after.clients,p.clients);
}));
test('legacy cloud data without an invitation can still be disabled from its settings',()=>fixture(async create=>{
 let stopped=0;const service=create({runtime:{status:async()=> 'active',stop:async()=>stopped++,close:async()=>{}}});const p=cached(service);p.enabled=true;delete p.secrets.cloudAccessToken;service.repository.save(p);
 const result=await service.configureCloud(p.id,{address:'https://192.0.2.44:7443',token:'',enabled:false});assert.equal(result.enabled,false);assert.equal(stopped,1);
}));
test('cloud bootstrap with a DNS endpoint never writes a hostname into TUN CIDR exclusions',()=>fixture(async create=>{
 let hosts;const service=create({prepare:async value=>hosts=value,runtime:{close:async()=>{}}});const p=cached(service);p.enabled=true;p.cloudAddress='https://cloud.example:7443';delete p.host;service.repository.save(p);await service.syncPolicy();assert.deepEqual(hosts,[]);p.host='192.0.2.44';service.repository.save(p);await service.syncPolicy();assert.deepEqual(hosts,['192.0.2.44/32']);
}));
