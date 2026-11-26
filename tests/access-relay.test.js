import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import net from 'node:net';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {newServer} from '../server/access-points/model.js';
import {frpsConfig,tlsIdentity} from '../server/access-points/provision.js';
import {frpcConfig} from '../server/access-points/runtime.js';
import {unusedPort} from '../server/xray.js';
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
test('unchanged frp forwards a real TCP stream through the authenticated TLS reverse connection',async()=>{
 const folder=mkdtempSync(join(tmpdir(),'fg-relay-stream-')),children=[],echo=net.createServer(socket=>socket.pipe(socket));await new Promise(resolve=>echo.listen(0,'127.0.0.1',resolve));
 const point=newServer({name:'Relay',host:'127.0.0.1',username:'root',sshPort:22,transportPort:await unusedPort(),publicPort:await unusedPort(),fingerprint:'SHA256:'+'a'.repeat(43)});Object.assign(point.secrets,await tlsIdentity(point.host));
 try{
  writeFileSync(join(folder,'tls.crt'),point.secrets.tlsCert);writeFileSync(join(folder,'tls.key'),point.secrets.tlsKey);
  const config=frpsConfig(point);config.bindAddr='127.0.0.1';config.proxyBindAddr='127.0.0.1';config.transport.tls.certFile=join(folder,'tls.crt');config.transport.tls.keyFile=join(folder,'tls.key');
  writeFileSync(join(folder,'server.json'),JSON.stringify(config));writeFileSync(join(folder,'client.json'),JSON.stringify(frpcConfig(point,echo.address().port,folder,{statusPort:await unusedPort(),statusPassword:'test'})));
  const base=new URL('../server/access-points/bin/'+process.platform+'-'+(process.arch==='x64'?'amd64':process.arch)+'/',import.meta.url).pathname;
  children.push(spawn(base+'frps',['-c',join(folder,'server.json')],{stdio:'ignore'}));await wait(250);children.push(spawn(base+'frpc',['-c',join(folder,'client.json')],{stdio:'ignore'}));
  let socket;
  for(let n=0;n<60;n++){socket=await new Promise(resolve=>{const socket=net.connect(point.publicPort,'127.0.0.1');socket.once('connect',()=>resolve(socket));socket.once('error',()=>{socket.destroy();resolve(null);});});if(socket)break;await wait(100);}
  assert.ok(socket,'reverse listener becomes reachable');
  const output=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{socket.destroy();reject(Error('echo timeout'));},3000);socket.once('data',data=>{clearTimeout(timer);socket.destroy();resolve(data.toString());});socket.once('error',reject);socket.write('freedomgate-through-vps');});
  assert.equal(output,'freedomgate-through-vps');
 }finally{for(const child of children)child.kill('SIGTERM');await new Promise(resolve=>echo.close(resolve));rmSync(folder,{recursive:true,force:true});}
});
