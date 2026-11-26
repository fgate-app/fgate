// External Outline SDK client for cloud-relay-smoke.mjs (EXTERNAL_READY mode).
// Usage: node ... /private/client.json [admin@test-gateway gateway-pid]
import {readFileSync,mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {spawn} from 'node:child_process';import assert from 'node:assert/strict';
import {outlineBinary} from '../../server/ss-profile.js';
import {unusedPort} from '../../server/xray.js';
import {execute} from '../../server/access-points/ssh.js';
const config=JSON.parse(readFileSync(process.argv[2])),folder=mkdtempSync(join(tmpdir(),'fg-cloud-client-'));
const port=await unusedPort();config.port=port;config.node.prefix_hex='16030100a80101';
writeFileSync(join(folder,'client.json'),JSON.stringify(config),{mode:0o600});
const child=spawn(outlineBinary(),[join(folder,'client.json')],{stdio:'ignore'});
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const curl=(url,seconds=6)=>execute('curl',['-4','-fsS','--max-time',String(seconds),'--socks5-hostname','127.0.0.1:'+port,url],{timeout:(seconds+2)*1000});
const target='http://'+config.node.server+':28080/';
try{
 await wait(300);const response=await curl(target);assert.equal(response.code,0,response.error);assert.notEqual(response.output.trim(),config.node.server);console.log('PASS TCP external Outline SDK → cloud → home; exit '+response.output.trim());
 assert.notEqual((await curl('https://example.com',3)).code,0);console.log('PASS blocked domain');
 for(const size of [32,1200,1280]){
  const result=await execute('python3',['-c',`import socket,struct,os
s=socket.create_connection(('127.0.0.1',${port}));s.settimeout(5);s.sendall(bytes.fromhex('050100'));assert s.recv(2)==bytes.fromhex('0500')
s.sendall(bytes.fromhex('05030001000000000000'));r=s.recv(32);assert r[1]==0
u=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);u.settimeout(5);p=struct.unpack('!H',r[-2:])[0];q=os.urandom(${size})
u.sendto(bytes.fromhex('00000001')+socket.inet_aton('${config.node.server}')+struct.pack('!H',28080)+q,('127.0.0.1',p));r=u.recv(65535);assert r[10:]==q
u.close();s.close()`],{timeout:8000});assert.equal(result.code,0,result.error);console.log('PASS UDP echo '+size+' bytes');
 }
 if(process.argv[3]){
  const pid=process.argv[4];assert.match(pid,/^[1-9][0-9]*$/);
  const signal=async name=>{const result=await execute('ssh',['-o','BatchMode=yes','-o','UserKnownHostsFile=/tmp/freedomgate-rpi-known-hosts',process.argv[3],'kill -'+name+' '+pid]);assert.equal(result.code,0,result.error);};
  await signal('USR1');assert.notEqual((await curl(target,2)).code,0);console.log('PASS fail closed after tunnel crash');
  let recovered=false;for(let n=0;n<30;n++){await wait(500);if((await curl(target,1)).code===0){recovered=true;break;}}
  assert.ok(recovered,'automatic recovery');console.log('PASS automatic watchdog recovery');
  await signal('USR2');await wait(300);assert.notEqual((await curl(target,2)).code,0);console.log('PASS disabled access stops traffic');
  await signal('USR2');recovered=false;for(let n=0;n<30;n++){await wait(500);if((await curl(target,1)).code===0){recovered=true;break;}}
  assert.ok(recovered);console.log('PASS re-enable with unchanged client key');
 }
}finally{child.kill();rmSync(folder,{recursive:true,force:true});}
