import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {Store} from '../server/store.js';
import {createServer} from '../server/index.js';
import {newServer,normalizeServer,publicServer,clientConfig} from '../server/access-points/model.js';
import {AccessPointRepository} from '../server/access-points/repository.js';
import {AccessPointService} from '../server/access-points/service.js';
import {fingerprint,execute} from '../server/access-points/ssh.js';
import {frpsConfig,installScript,tlsIdentity} from '../server/access-points/provision.js';
import {frpcConfig,ingressConfig,privateNetworks} from '../server/access-points/runtime.js';
const hostKey='ssh-ed25519 '+randomBytes(32).toString('base64');
const input={name:'Test VPS',host:'203.0.113.10',sshPort:22,username:'root',transportPort:7443,publicPort:443,serverName:'www.microsoft.com',hostKey,fingerprint:fingerprint(hostKey),sshKey:'-----BEGIN OPENSSH PRIVATE KEY-----\nsecret\n-----END OPENSSH PRIVATE KEY-----'};
test('access point validation rejects shell syntax, invalid addresses and conflicting listener ports',()=>{
 for(const change of [{host:'-oProxyCommand=bad'},{username:'root; id'},{serverName:'example.com; id'},{publicPort:22},{sshPort:-1},{fingerprint:'bad'}])assert.throws(()=>normalizeServer({...input,...change}));
 assert.equal(normalizeServer(input).protocol,'vless');
});
test('access point secrets are encrypted on disk and excluded from public API; client export only includes its credential',()=>{
 const dir=mkdtempSync(join(tmpdir(),'fg-access-')),store=new Store(join(dir,'db.sqlite'));
 try{
  const repo=new AccessPointRepository(store.db,{stateDir:dir}),server=newServer(input);repo.save(server);
  const raw=store.db.prepare('SELECT value FROM access_points').get().value;assert.ok(!raw.includes(input.sshKey));assert.ok(!raw.includes(server.secrets.token));assert.equal(statSync(join(dir,'access-points.key')).mode&0o777,0o600);
  assert.deepEqual(repo.get(server.id),server);const visible=JSON.stringify(repo.list());assert.ok(!visible.includes('secret'));assert.ok(!visible.includes(server.secrets.realityPrivate));
  const config=clientConfig(server,{id:'client-id',name:'Phone'});assert.ok(config.link.startsWith('vless://client-id@203.0.113.10:443?'));assert.ok(!JSON.stringify(config).includes(server.secrets.realityPrivate));assert.ok(config.mihomo.tun.enable);
  assert.deepEqual(publicServer(server).clients,[]);
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
test('ingress stays loopback-only and routes DNS to AdGuard and traffic into policy with private-network rejection',()=>{
 const server=newServer(input);server.clients=[{id:'client-id',name:'Phone',enabled:true},{id:'disabled-id',enabled:false}];const config=ingressConfig(server,20000);
 assert.equal(config.inbounds[0].listen,'127.0.0.1');assert.equal(config.inbounds[0].settings.clients.length,1);assert.equal(config.outbounds[0].settings.servers[0].port,17990);assert.equal(config.outbounds.find(out=>out.tag==='dns').settings.rewritePort,53053);assert.ok(!config.outbounds.some(out=>out.protocol==='freedom'));assert.deepEqual(config.routing.rules[1].ip,privateNetworks);assert.equal(config.inbounds[0].sniffing.routeOnly,false,'Recover sniffed domains from synthetic DNS addresses');assert.equal(config.routing.domainStrategy,'AsIs','Domain targets must reach policy routing without resolving to private fake IPs');
 const relay=frpsConfig(server);assert.deepEqual(relay.allowPorts,[{single:443}]);assert.ok(relay.transport.tls.force);assert.ok(!relay.webServer);
});
test('upstream frp accepts generated configurations and installer is valid POSIX shell without running it',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'fg-frp-')),server=newServer(input);
 try{
  Object.assign(server.secrets,await tlsIdentity(server.host));
  const {writeFileSync}=await import('node:fs');writeFileSync(join(dir,'tls.crt'),server.secrets.tlsCert);writeFileSync(join(dir,'tls.key'),server.secrets.tlsKey);
  const remote=frpsConfig(server);remote.transport.tls.certFile=join(dir,'tls.crt');remote.transport.tls.keyFile=join(dir,'tls.key');
  writeFileSync(join(dir,'server.json'),JSON.stringify(remote));writeFileSync(join(dir,'client.json'),JSON.stringify(frpcConfig(server,20000,dir,{statusPort:21000,statusPassword:'test'})));
  const platform=process.platform+'-'+(process.arch==='x64'?'amd64':process.arch),binary=new URL('../server/access-points/bin/'+platform+'/frps',import.meta.url).pathname;
  assert.equal((await execute(binary,['verify','-c',join(dir,'server.json')])).code,0);
  assert.equal((await execute(binary.replace(/frps$/,'frpc'),['verify','-c',join(dir,'client.json')])).code,0);
  const script=installScript(server,Buffer.from('test binary'));assert.equal((await execute('/bin/sh',['-n'],{input:script})).code,0);assert.ok(script.includes('sha256sum -c'));assert.ok(script.includes('trap \'result=$?;'));assert.ok(!script.includes('curl'));
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('provisioning is asynchronous, restart marks interrupted jobs and disabled clients cannot export',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'fg-access-')),store=new Store(':memory:');let complete;
 const runtime={start:async()=>{},stop:async()=>{},status:async()=> 'active',close:async()=>{}};
 const service=new AccessPointService(store,{stateDir:dir,runtime,install:server=>new Promise(resolve=>{complete=()=>{server.secrets.tlsCert='cert';resolve({platform:'linux-amd64'});};})});
 try{
  const point=service.create(input);assert.equal(service.installServer(point.id).state,'installing');assert.throws(()=>service.installServer(point.id));
  complete();await Promise.all(service.jobs.values());assert.equal((await service.list()).find(row=>!row.managed).state,'active');
  const client=await service.addClient(point.id,{name:'Phone'});assert.ok(service.exportClient(point.id,client.id).link);
  await service.changeClient(point.id,client.id,{name:'Renamed phone'});assert.equal(service.repository.get(point.id).clients[0].enabled,true);assert.equal(service.repository.get(point.id).clients[0].name,'Renamed phone');
  await assert.rejects(service.changeClient(point.id,client.id,{name:' '}));
  await service.changeClient(point.id,client.id,{enabled:false});assert.throws(()=>service.exportClient(point.id,client.id));
  await service.changeClient(point.id,client.id,{}, {remove:true});assert.equal(service.repository.get(point.id).clients.length,0);
 }finally{await service.close();store.close();rmSync(dir,{recursive:true,force:true});}
});
test('access point API enforces admin role, CSRF and redacts SSH credentials',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'fg-api-access-')),store=new Store(':memory:');
 const service=new AccessPointService(store,{stateDir:dir,runtime:{close:async()=>{}}}),server=createServer(store,{accessPoints:service});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port;
 try{
  const response=await fetch(base+'/api/auth/setup',{method:'POST',body:JSON.stringify({username:'admin',password:'test password 12345'}),headers:{'Content-Type':'application/json'}}),session=await response.json(),cookie=response.headers.get('set-cookie').split(';')[0],headers={'Content-Type':'application/json',Cookie:cookie,'X-CSRF-Token':session.csrf};
  assert.equal((await fetch(base+'/api/access-points')).status,401);
  assert.equal((await fetch(base+'/api/access-points',{method:'POST',body:JSON.stringify(input),headers:{...headers,'X-CSRF-Token':'wrong'}})).status,403);
  const created=await fetch(base+'/api/access-points',{method:'POST',body:JSON.stringify(input),headers});assert.equal(created.status,201);assert.ok(!(await created.text()).includes('secret'));
  const list=await(await fetch(base+'/api/access-points',{headers})).json();assert.equal(list.length,2);assert.ok(!list[0].secrets);
  await fetch(base+'/api/users',{method:'POST',headers,body:JSON.stringify({username:'viewer',password:'viewer password 12345',role:'viewer'})});
  const login=await fetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'viewer',password:'viewer password 12345'})});const viewer=login.headers.get('set-cookie').split(';')[0];
  assert.equal((await fetch(base+'/api/access-points',{headers:{Cookie:viewer}})).status,403);
 }finally{await new Promise(resolve=>server.close(resolve));await service.close();store.close();rmSync(dir,{recursive:true,force:true});}
});
test('remote listener guard precedes user rules and never changes LAN policy when disabled',async()=>{
 const {buildMihomoConfig}=await import('../server/mihomo.js'),{defaultDnsSettings}=await import('../server/dns-resolvers.js');
 const routes={profiles:[{id:'direct',engine:'direct'}],configs:[],devices:[],groups:[{id:'com',routeId:'direct',entries:['com']}]};
 const plain=buildMihomoConfig(defaultDnsSettings,{},routes);assert.ok(!plain.includes('fg-remote'));
 const guarded=buildMihomoConfig(defaultDnsSettings,{remoteAccessEnabled:true},routes);assert.match(guarded,/listen: 127\.0\.0\.1\n    port: 17990/);assert.ok(guarded.indexOf('IN-NAME,fg-remote')<guarded.indexOf('DOMAIN-SUFFIX,com,DIRECT'));
});
test('encrypted SSH keys are unlocked through askpass without placing their passphrase in SSH arguments',async()=>{
 const folder=mkdtempSync(join(tmpdir(),'fg-ssh-key-'));
 try{
  const key=join(folder,'identity');assert.equal((await execute('ssh-keygen',['-q','-t','ed25519','-N','fixture passphrase','-f',key])).code,0);
  const server=newServer({...input,sshKey:readFileSync(key,'utf8'),sshPassphrase:'fixture passphrase'}),{withSsh}=await import('../server/access-points/ssh.js');
  assert.equal(await withSsh(server,async()=> 'unlocked'),'unlocked');
  server.secrets.sshPassphrase='wrong';await assert.rejects(withSsh(server,async()=> 'never'),/key or passphrase is invalid/);
 }finally{rmSync(folder,{recursive:true,force:true});}
});
test('access-point watchdog detects signal exits and cleanup never waits for an exit event already delivered',async()=>{
 const {AccessPointRuntime}=await import('../server/access-points/runtime.js'),folder=mkdtempSync(join(tmpdir(),'fg-runtime-'));
 const runtime=new AccessPointRuntime({stateDir:folder});runtime.entries.set('dead',{folder,processes:[{exitCode:null,signalCode:'SIGTERM',pid:123,kill(){throw Error('must not signal exited child');}}]});
 assert.equal(await runtime.status('dead'),'error');await runtime.stop('dead');assert.equal(runtime.entries.size,0);rmSync(folder,{recursive:true,force:true});
});
test('SSH credentials can be replaced only with a matching confirmed host fingerprint, without exposing the key',()=>{
 const folder=mkdtempSync(join(tmpdir(),'fg-credentials-')),store=new Store(':memory:'),service=new AccessPointService(store,{stateDir:folder,runtime:{close:async()=>{}}});
 try{
  const point=service.create(input);assert.throws(()=>service.updateCredentials(point.id,{...input,fingerprint:'SHA256:'+'a'.repeat(43)}));
  const result=service.updateCredentials(point.id,{...input,username:'ubuntu',sshKey:'new private key'});assert.equal(result.username,'ubuntu');assert.ok(!JSON.stringify(result).includes('new private key'));assert.equal(service.repository.get(point.id).secrets.sshKey,'new private key');assert.throws(()=>service.create(input));
 }finally{store.close();rmSync(folder,{recursive:true,force:true});}
});

test('client list save validates all drafts, preserves credentials and rolls back failed apply',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'fg-key-batch-')),store=new Store(join(dir,'db.sqlite'));let starts=0,fail=false;
 const service=new AccessPointService(store,{stateDir:dir,runtime:{start:async()=>{starts++;if(fail)throw Error('apply failed');},stop:async()=>{},status:async()=> 'active',close:async()=>{}}});
 try{
  const point=service.repository.get('freedomgate-cloud');point.enabled=false;service.repository.save(point);
  const first=await service.addClient(point.id,{name:'First'}),second=await service.addClient(point.id,{name:'Second'});
  const before=service.repository.get(point.id),credential=before.clients.find(c=>c.id===first.id).password;
  await assert.rejects(service.saveClients(point.id,{clients:[{id:first.id,name:'Changed'},{id:second.id,name:''}]}));assert.deepEqual(service.repository.get(point.id),before);
  await service.saveClients(point.id,{clients:[{id:first.id,name:'Changed',enabled:false},{name:'New',enabled:true}]});
  const saved=service.repository.get(point.id);assert.equal(saved.clients.length,2);assert.equal(saved.clients[0].password,credential);assert.equal(saved.clients[0].enabled,false);assert.ok(saved.clients[1].password);assert.notEqual(saved.clients[1].id,first.id);
  await assert.rejects(service.saveClients(point.id,{clients:[{id:first.id,name:'One'},{id:first.id,name:'Duplicate'}]}));assert.deepEqual(service.repository.get(point.id),saved);
  saved.enabled=true;service.repository.save(saved);fail=true;
  await assert.rejects(service.saveClients(point.id,{clients:[]}),/apply failed/);assert.deepEqual(service.repository.get(point.id),saved);assert.ok(starts>=1);
 }finally{await service.close();store.close();rmSync(dir,{recursive:true,force:true});}
});

test('frp module state reflects local tunnel health without exposing access point details',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'fg-frp-module-')),store=new Store(':memory:');let states={};
 const runtime={frpc:process.execPath,entries:new Map(),status:async id=>states[id],sample:async()=>{},close:async()=>{}};
 const service=new AccessPointService(store,{stateDir:dir,runtime});
 try{
  assert.equal(await service.moduleState(),'stopped');runtime.entries.set('a',{});states.a='active';assert.equal(await service.moduleState(),'active');
  runtime.entries.set('b',{});states.b='connecting';assert.equal(await service.moduleState(),'connecting');
  states.b='error';assert.equal(await service.moduleState(),'error');states.b='unknown';assert.equal(await service.moduleState(),'unknown');
  runtime.frpc=join(dir,'missing');assert.equal(await service.moduleState(),'unavailable');runtime.frpc=null;assert.equal(await service.moduleState(),'unknown');
 }finally{await service.close();store.close();rmSync(dir,{recursive:true,force:true});}
});
