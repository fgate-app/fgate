// Run on the Linux FreedomGate test host. Uses a fresh isolated identity,
// Outline SDK client and production config generators; no LAN/TUN changes.
import {mkdtempSync,writeFileSync,rmSync,readFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {spawn,execFileSync} from 'node:child_process';import assert from 'node:assert/strict';
import {AccessPointService} from '../../server/access-points/service.js';
import {AccessPointRuntime} from '../../server/access-points/runtime.js';
import {managedPoint,enrollManaged} from '../../server/access-points/managed.js';
import {Store} from '../../server/store.js';
import {buildMihomoConfig} from '../../server/mihomo.js';
import {defaultDnsSettings} from '../../server/dns-resolvers.js';
import {unusedPort} from '../../server/xray.js';
import {outlineBinary} from '../../server/ss-profile.js';
import {execute} from '../../server/access-points/ssh.js';
const folder=mkdtempSync(join(tmpdir(),'fg-cloud-smoke-')),store=new Store(':memory:'),children=[];
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));let service,runtime;
async function until(fn,label){for(let n=0;n<180;n++){if(await fn())return;await wait(250);}throw Error('Timeout: '+label);}
try{
 const identityPath=join(tmpdir(),'fg-cloud-smoke-identity.json');const p=existsSync(identityPath)?JSON.parse(readFileSync(identityPath)):managedPoint();writeFileSync(identityPath,JSON.stringify(p),{mode:0o600});const r=await enrollManaged(p);console.log('Enrolled test instance '+p.secrets.instanceId+' on public port '+r.publicPort);
 const mixedPort=await unusedPort(),remotePort=await unusedPort(),controllerPort=await unusedPort();
 const yaml=buildMihomoConfig(defaultDnsSettings,{mixedPort,remotePort,remoteAccessEnabled:true,controllerPort,controllerSecret:'smoke'},{profiles:[],configs:[],devices:[],groups:[{id:'blocked',routeId:'block',entries:['example.com']}]}).replace('tun:\n  enable: true','tun:\n  enable: false').replace('dns:\n  enable: true','dns:\n  enable: false');
 const path=join(folder,'mihomo.yaml');writeFileSync(path,yaml,{mode:0o600});
 const binary=process.env.FREEDOMGATE_MIHOMO || '/opt/freedomgate/modules/mihomo/v1.19.33/mihomo';execFileSync(binary,['-t','-d',folder,'-f',path],{stdio:'ignore'});children.push(spawn(binary,['-d',folder,'-f',path],{stdio:'ignore'}));
 await until(async()=>{try{return (await fetch('http://127.0.0.1:'+controllerPort+'/version',{headers:{Authorization:'Bearer smoke'}})).ok;}catch{return false;}},'mihomo');
 runtime=new AccessPointRuntime({diagnostics:true,stateDir:folder,mixedPort:remotePort,...(process.env.FREEDOMGATE_TEST_FRPC?{frpc:process.env.FREEDOMGATE_TEST_FRPC}:{})});
 service=new AccessPointService(store,{stateDir:folder,runtime,enroll:async()=>r});service.repository.save({...p,enabled:true});await service.restore();await Promise.all(service.jobs.values());
 await until(async()=>await runtime.status(p.id)==='active','reverse tunnel');
 if(process.env.FG_CLOUD_EXTERNAL_CLIENT==='1'){
  const cfg={port:44880,node:{id:'smoke',name:'Smoke',server:r.host,port:r.publicPort,cipher:'chacha20-ietf-poly1305',password:p.clients[0].password,prefix_hex:'16030100a80101',enabled:true}};
  const file=join(tmpdir(),'fg-cloud-smoke-client.json');writeFileSync(file,JSON.stringify(cfg),{mode:0o600});
  console.log('EXTERNAL_READY PID='+process.pid);
  process.on('SIGUSR1',()=>{runtime.entries.get(p.id)?.frpc?.kill('SIGKILL');console.log('TUNNEL_KILLED');});
  process.on('SIGUSR2',async()=>{const row=service.repository.get(p.id);await service.setEnabled(p.id,!row.enabled);await Promise.all(service.jobs.values());console.log(row.enabled?'DISABLED':'ENABLED');});
  await new Promise(resolve=>{const timer=setTimeout(resolve,600000);for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{clearTimeout(timer);resolve();});});
  rmSync(file,{force:true});
 }else{
 const socksPort=await unusedPort(),cfg=join(folder,'outline.json');
 writeFileSync(cfg,JSON.stringify({port:socksPort,node:{id:'smoke',name:'Smoke',server:r.host,port:r.publicPort,cipher:'chacha20-ietf-poly1305',password:p.clients[0].password,prefix_hex:'16030100a80101',enabled:true}}),{mode:0o600});
 children.push(spawn(outlineBinary(),[cfg],{stdio:'ignore'}));await wait(400);
 const curl=async(url,timeout=12)=>execute('curl',['-4','-f','-sS','--max-time',String(timeout),'--socks5-hostname','127.0.0.1:'+socksPort,url],{timeout:(timeout+2)*1000});
 const target='http://'+r.host+':28080/';const ip=await curl(target);assert.equal(ip.code,0);assert.ok(ip.output.trim() && ip.output.trim()!==r.host);console.log('PASS TCP: external exit='+ip.output.trim()+' (not cloud)');
 assert.notEqual((await curl('https://example.com',4)).code,0);assert.equal((await curl(target)).code,0);console.log('PASS domain rules: example.com blocked; controlled target reachable');
 console.log('UDP probe starts; Xray ingress='+JSON.parse(readFileSync(join(runtime.entries.get(p.id).folder,'xray.json'))).inbounds[0].port);
 const udp=await execute('python3',['-c',`import socket,struct
s=socket.create_connection(('127.0.0.1',${socksPort}));s.settimeout(8)
s.sendall(bytes.fromhex('050100'));assert s.recv(2)==bytes.fromhex('0500')
s.sendall(bytes.fromhex('05030001000000000000'));r=s.recv(32);assert r[1]==0
p=struct.unpack('!H',r[-2:])[0];u=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);u.settimeout(8)
q=b'freedomgate-udp-smoke'
u.sendto(bytes.fromhex('00000001')+socket.inet_aton('${r.host}')+struct.pack('!H',28080)+q,('127.0.0.1',p));r=u.recv(4096)
assert r[10:]==q, 'UDP echo mismatch'
u.close();s.close();print('UDP echo passed')`],{timeout:12000});assert.equal(udp.code,0,udp.error);console.log('PASS UDP: Outline SDK → cloud → home policy → UDP echo');
 runtime.entries.get(p.id).frpc.kill('SIGKILL');
 assert.notEqual((await curl(target,3)).code,0);console.log('PASS fail closed after tunnel process crash');
 await until(async()=>await runtime.status(p.id)==='active','watchdog recovery');assert.equal((await curl(target)).code,0);console.log('PASS automatic reconnect after crash');
 const link=service.exportClient(p.id,p.clients[0].id).link;await service.setEnabled(p.id,false);assert.notEqual((await curl(target,3)).code,0);
 await service.setEnabled(p.id,true);await Promise.all(service.jobs.values());await until(async()=>await runtime.status(p.id)==='active','re-enable');assert.equal(service.exportClient(p.id,p.clients[0].id).link,link);assert.equal((await curl(target)).code,0);console.log('PASS disable/re-enable retains access key');
 console.log('ALL CLOUD SMOKE CHECKS PASSED');
 }
}catch(error){if(runtime)for(const entry of runtime.entries.values()){const file=join(entry.folder,'transport.log');if(existsSync(file))console.error(readFileSync(file,'utf8'));}throw error;}finally{
 await service?.close();for(const child of children)child.kill();store.close();rmSync(folder,{recursive:true,force:true});
}
