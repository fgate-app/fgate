// Local isolated ingress, same DNS/policy chain as cloud. No production keys.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';import {mkdtempSync,writeFileSync,rmSync,readFileSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {managedPoint} from '../../server/access-points/managed.js';import {ingressConfig} from '../../server/access-points/runtime.js';import {unusedPort} from '../../server/xray.js';import {outlineBinary} from '../../server/ss-profile.js';import {execute} from '../../server/access-points/ssh.js';
const dir=mkdtempSync(join(tmpdir(),'fg-cloud-dns-')),children=[];
try{
 const p=managedPoint(),port=await unusedPort(),socks=await unusedPort(),cfg=ingressConfig(p,port);cfg.log={loglevel:'debug',error:join(dir,'xray.log'),access:join(dir,'access.log')};
 writeFileSync(join(dir,'xray.json'),JSON.stringify(cfg),{mode:0o600});writeFileSync(join(dir,'client.json'),JSON.stringify({port:socks,node:{server:'127.0.0.1',port,cipher:'chacha20-ietf-poly1305',password:p.clients[0].password}}),{mode:0o600});
 children.push(spawn('/opt/freedomgate/modules/xray/current/xray',['run','-config',join(dir,'xray.json')],{stdio:'ignore'}));children.push(spawn(outlineBinary(),[join(dir,'client.json')],{stdio:'ignore'}));await new Promise(resolve=>setTimeout(resolve,400));
 const result=await execute('python3',['-c',`import socket,struct
for qt in [1,28]:
 s=socket.create_connection(('127.0.0.1',${socks}));s.settimeout(4);s.sendall(bytes.fromhex('050100'));assert s.recv(2)==bytes.fromhex('0500')
 s.sendall(bytes.fromhex('05030001000000000000'));r=s.recv(32);assert r[1]==0
 p=struct.unpack('!H',r[-2:])[0];u=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);u.settimeout(4)
 q=bytes.fromhex('123401000001000000000000076578616d706c65036f726700')+struct.pack('!HH',qt,1)
 u.sendto(bytes.fromhex('00000001010101010035')+q,('127.0.0.1',p))
 try:
  r=u.recv(4096);assert r[10:12]==bytes.fromhex('1234');assert r[13]&15==0;answers=struct.unpack('!H',r[16:18])[0];assert qt!=1 or answers>0;print('DNS type',qt,'length',len(r),'rcode',r[13]&15,'answers',answers)
 except Exception as e:print('DNS type',qt,type(e).__name__);raise
 s.close();u.close()`],{timeout:12000});console.log(result.output,result.error);assert.equal(result.code,0,'Remote client DNS must resolve through AdGuard');
 console.log(readFileSync(join(dir,'xray.log'),'utf8').split('\n').slice(-25).join('\n'));
}finally{for(const child of children)child.kill();rmSync(dir,{recursive:true,force:true});}
