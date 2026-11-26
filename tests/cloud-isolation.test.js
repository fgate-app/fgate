import {test} from 'node:test';import assert from 'node:assert/strict';
import net from 'node:net';import {spawn} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {managedPoint} from '../server/access-points/managed.js';
import {frpcConfig} from '../server/access-points/runtime.js';
import {relayConfig} from '../server/cloud/broker.js';import {tlsIdentity} from '../server/access-points/provision.js';
import {unusedPort} from '../server/xray.js';
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
test('two real tenant relays keep streams isolated and reject cross-tenant port allocation',async()=>{
 const folder=mkdtempSync(join(tmpdir(),'fg-cloud-isolation-')),children=[],echoes=[],sockets=new Set();
 const binary=new URL('../server/access-points/bin/'+process.platform+'-'+(process.arch==='x64'?'amd64':process.arch)+'/',import.meta.url).pathname;
 const launch=(name,file)=>{const child=spawn(binary+name,['-c',file],{stdio:'ignore'});children.push(child);return child;};
 const connect=port=>new Promise(resolve=>{const s=net.connect(port,'127.0.0.1');sockets.add(s);s.on('close',()=>sockets.delete(s));s.once('connect',()=>resolve(s));s.once('error',()=>{s.destroy();resolve(null);});});
 const echo=async(port)=>{const s=await connect(port);assert.ok(s);return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{s.destroy();reject(Error('relay timeout'));},2000);s.once('data',data=>{clearTimeout(timer);s.destroy();resolve(data.toString());});s.write('payload');});};
 try{
  const points=[];
  for(const label of ['A','B']){
   const point=managedPoint();Object.assign(point,{id:label,host:'127.0.0.1',transportPort:await unusedPort(),publicPort:await unusedPort()});point.secrets.token=point.secrets.credential;Object.assign(point.secrets,await tlsIdentity(point.host));
   const dir=join(folder,label);mkdirSync(dir);writeFileSync(join(dir,'tls.crt'),point.secrets.tlsCert);writeFileSync(join(dir,'tls.key'),point.secrets.tlsKey);
   const server=relayConfig({...point,token:point.secrets.token});server.bindAddr='127.0.0.1';server.proxyBindAddr='127.0.0.1';server.transport.tls.certFile=join(dir,'tls.crt');server.transport.tls.keyFile=join(dir,'tls.key');
   const target=net.createServer(s=>{sockets.add(s);s.on('close',()=>sockets.delete(s));s.on('data',data=>s.end(label+':'+data));});echoes.push(target);await new Promise(resolve=>target.listen(0,'127.0.0.1',resolve));
   writeFileSync(join(dir,'server.json'),JSON.stringify(server));writeFileSync(join(dir,'client.json'),JSON.stringify(frpcConfig(point,target.address().port,dir,{statusPort:await unusedPort(),statusPassword:'test'})));
   launch('frps',join(dir,'server.json'));await wait(150);launch('frpc',join(dir,'client.json'));
   for(let n=0;n<60;n++){const s=await connect(point.publicPort);if(s){s.destroy();break;}if(n===59)throw Error('relay not ready');await wait(100);}
   points.push(point);
  }
  assert.equal(await echo(points[0].publicPort),'A:payload');assert.equal(await echo(points[1].publicPort),'B:payload');
  const statusPort=await unusedPort(),wrong=frpcConfig(points[0],echoes[0].address().port,join(folder,'A'),{statusPort,statusPassword:'test'});
  wrong.proxies=wrong.proxies.map(proxy=>({...proxy,name:'cross-'+proxy.type,remotePort:points[1].publicPort}));writeFileSync(join(folder,'wrong.json'),JSON.stringify(wrong));launch('frpc',join(folder,'wrong.json'));
  let denied=false;
  for(let n=0;n<60;n++){try{const response=await fetch('http://127.0.0.1:'+statusPort+'/api/status',{headers:{Authorization:'Basic '+Buffer.from('freedomgate:test').toString('base64')},signal:AbortSignal.timeout(300)});const state=await response.json();if(state.tcp?.some(proxy=>/error/i.test(proxy.status))){denied=true;break;}}catch{}await wait(100);}
  assert.ok(denied,'tenant A cannot register a port owned by B');assert.equal(await echo(points[1].publicPort),'B:payload');assert.equal(await echo(points[0].publicPort),'A:payload');
 }finally{for(const s of sockets)s.destroy();for(const child of children)child.kill();await Promise.all(echoes.map(server=>new Promise(resolve=>server.close(resolve))));await wait(100);rmSync(folder,{recursive:true,force:true});}
});
