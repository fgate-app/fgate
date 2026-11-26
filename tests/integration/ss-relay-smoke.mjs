import {spawn,execFileSync} from 'node:child_process';
import dgram from 'node:dgram';import http from 'node:http';import net from 'node:net';import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {SsRelaySupervisor} from '../../server/ss-relay.js';import {ssPython} from '../../server/ss-profile.js';
import {buildMihomoConfig} from '../../server/mihomo.js';import {defaultDnsSettings} from '../../server/dns-resolvers.js';
const dir=mkdtempSync(join(tmpdir(),'fg-native-ss-')),relay=new SsRelaySupervisor({stateDir:dir});let fixture,core,udp;let udpPackets=0;
const port=async()=>{const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;};
async function stop(p){if(p && p.exitCode===null && p.signalCode===null){p.kill();await new Promise(r=>p.once('exit',r));}}
try{
 fixture=spawn(ssPython(),['tests/integration/ss-fixture.py'],{stdio:['ignore','pipe','inherit']});
 const peer=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Fixture timeout')),5000);fixture.stdout.once('data',data=>{clearTimeout(timer);resolve(Number(String(data).trim()));});fixture.once('exit',()=>reject(Error('Fixture failed')));});
 const id='fixture1',value='ss://'+Buffer.from('chacha20-ietf-poly1305:test-password').toString('base64url')+`@127.0.0.1:${peer}/?prefix=%16%03%01`;
 const configs=[{profile_id:id,engine:'outline',config:value}],prepared=await relay.prepare(configs);await prepared.commit();
 const mixedPort=await port(),controllerPort=await port();
 const yaml=buildMihomoConfig(defaultDnsSettings,{mixedPort,controllerPort,controllerSecret:'fixture-secret'},{configs,profiles:[{id,engine:'outline'}],groups:[{id:'site',entries:['full:ss-fixture.example'],routeId:id}],devices:[{id:'phone',identifier:'127.0.0.1',routeId:id}],bridges:prepared.bridges}).replace('tun:\n  enable: true','tun:\n  enable: false').replace('dns:\n  enable: true','dns:\n  enable: false');
 assert.match(yaml,/udp: true/);
 const path=join(dir,'config.yaml');writeFileSync(path,yaml,{mode:0o600});const binary=process.env.FREEDOMGATE_MIHOMO || '/opt/freedomgate/modules/mihomo/v1.19.33/mihomo';execFileSync(binary,['-t','-d',dir,'-f',path],{stdio:'ignore'});core=spawn(binary,['-d',dir,'-f',path],{stdio:'ignore'});
 let body;
 for(let n=0;n<15;n++){
  try{body=await new Promise((resolve,reject)=>{const req=http.get({host:'127.0.0.1',port:mixedPort,path:'http://ss-fixture.example/',headers:{Host:'ss-fixture.example'}},res=>{let data='';res.on('data',chunk=>data+=chunk);res.on('end',()=>res.statusCode===200?resolve(data):reject(Error('HTTP '+res.statusCode)));});req.setTimeout(2000,()=>req.destroy(Error('Timeout')));req.on('error',reject);});break;}catch(error){if(n===14)throw error;await new Promise(r=>setTimeout(r,100));}
 }
 udp=dgram.createSocket('udp4');udp.on('message',()=>udpPackets++);await new Promise(resolve=>udp.bind(0,'127.0.0.1',resolve));
 execFileSync(ssPython(),['-c',`import socket,struct,time
s=socket.create_connection(('127.0.0.1',${mixedPort}))
s.sendall(bytes.fromhex('050100'));assert s.recv(2)==bytes.fromhex('0500')
s.sendall(bytes.fromhex('05030001000000000000'));r=s.recv(32);assert r[1]==0
p=struct.unpack('!H',r[-2:])[0]
u=socket.socket(socket.AF_INET,socket.SOCK_DGRAM)
u.sendto(bytes.fromhex('000000017f000001')+struct.pack('!H',${udp.address().port})+b'no-direct-leak',('127.0.0.1',p))
u.settimeout(3)
reply=u.recv(4096)
assert reply.endswith(b'freedomgate-udp-ok'), 'encrypted UDP reply missing'
s.close();u.close()`]);
 await new Promise(resolve=>setTimeout(resolve,300));assert.equal(udpPackets,0,'SS UDP must never reach the destination directly');
 const rules=await (await fetch(`http://127.0.0.1:${controllerPort}/rules`,{headers:{Authorization:'Bearer fixture-secret'}})).json();
 assert.ok(!rules.rules.some(rule=>rule.type==='AND' && rule.proxy==='REJECT'),'UDP-capable bridge must not be rejected');
 assert.equal(body,'freedomgate-ss-prefix-ok');console.log('Native mihomo → SS Relay → AEAD fixture passed; prefix verified on wire; encrypted UDP response received with no direct leak.');
}finally{udp?.close();await stop(core);await relay.stop();await stop(fixture);rmSync(dir,{recursive:true,force:true});}
