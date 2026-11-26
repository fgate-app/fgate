import {spawn,execFileSync} from 'node:child_process';
import dgram from 'node:dgram';import http from 'node:http';import net from 'node:net';import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {SsRelaySupervisor} from '../../server/ss-relay.js';import {ssPython} from '../../server/ss-profile.js';
import {buildMihomoConfig} from '../../server/mihomo.js';import {defaultDnsSettings} from '../../server/dns-resolvers.js';
const dir=mkdtempSync(join(tmpdir(),'fg-native-ss-')),relay=new SsRelaySupervisor({stateDir:dir});let fixture,core,udp;let udpPackets=0;
const port=async()=>{const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;};
async function stop(p){if(p && p.exitCode===null && p.signalCode===null){p.kill();await new Promise(r=>p.once('exit',r));}}
try{
 const db=new DatabaseSync('/var/lib/freedomgate/freedomgate.sqlite',{readOnly:true});
 const value=db.prepare("SELECT config FROM profile_configs WHERE profile_id=?").get(process.env.FREEDOMGATE_TEST_PROFILE || '2b669c25-3364-4aab-9b22-2b3cbebd1819')?.config;db.close();assert.ok(value,'Test profile missing');
 const id='fixture1';
 const configs=[{profile_id:id,engine:'outline',config:value}],prepared=await relay.prepare(configs);await prepared.commit();
 const mixedPort=await port(),controllerPort=await port();
 const yaml=buildMihomoConfig(defaultDnsSettings,{mixedPort,controllerPort,controllerSecret:'fixture-secret'},{configs,profiles:[{id,engine:'outline'}],groups:[{id:'site',entries:['full:ss-fixture.example'],routeId:id}],devices:[{id:'phone',identifier:'127.0.0.1',routeId:id}],bridges:prepared.bridges}).replace('tun:\n  enable: true','tun:\n  enable: false').replace('dns:\n  enable: true','dns:\n  enable: false');
 assert.match(yaml,/udp: true/);
 const path=join(dir,'config.yaml');writeFileSync(path,yaml,{mode:0o600});const binary=process.env.FREEDOMGATE_MIHOMO || '/opt/freedomgate/modules/mihomo/v1.19.33/mihomo';execFileSync(binary,['-t','-d',dir,'-f',path],{stdio:'ignore'});core=spawn(binary,['-d',dir,'-f',path],{stdio:'ignore'});
 for(let n=0;n<40;n++){try{const response=await fetch(`http://127.0.0.1:${controllerPort}/version`,{headers:{Authorization:'Bearer fixture-secret'}});assert.equal(response.status,200);break;}catch(error){if(n===39)throw error;await new Promise(r=>setTimeout(r,100));}}
 udp=dgram.createSocket('udp4');udp.on('message',()=>udpPackets++);await new Promise(resolve=>udp.bind(0,'127.0.0.1',resolve));
 execFileSync(ssPython(),['-c',`import socket,struct,time
s=socket.create_connection(('127.0.0.1',${mixedPort}))
s.sendall(bytes.fromhex('050100'));assert s.recv(2)==bytes.fromhex('0500')
s.sendall(bytes.fromhex('05030001000000000000'));r=s.recv(32);assert r[1]==0
p=struct.unpack('!H',r[-2:])[0]
u=socket.socket(socket.AF_INET,socket.SOCK_DGRAM)
query=bytes.fromhex('123401000001000000000000076578616d706c6503636f6d0000010001')
u.sendto(bytes.fromhex('00000001010101010035')+query,('127.0.0.1',p))
u.settimeout(3)
reply=u.recv(4096)
assert reply[:3]==bytes(3) and reply[10:12]==bytes.fromhex('1234'), 'DNS reply transaction mismatch'
assert reply[13]&15==0, 'DNS response error'
s.close();u.close()`]);
 await new Promise(resolve=>setTimeout(resolve,300));assert.equal(udpPackets,0,'SS UDP must never reach the destination directly');
 const rules=await (await fetch(`http://127.0.0.1:${controllerPort}/rules`,{headers:{Authorization:'Bearer fixture-secret'}})).json();
 assert.ok(!rules.rules.some(rule=>rule.type==='AND' && rule.proxy==='REJECT'),'UDP-capable bridge must not be rejected');
 console.log('Live profile: native mihomo → SS Relay → encrypted SS UDP → DNS reply passed.');
}finally{udp?.close();await stop(core);await relay.stop();await stop(fixture);rmSync(dir,{recursive:true,force:true});}
