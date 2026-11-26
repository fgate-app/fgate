// Isolated native-core acceptance test. Does not touch the gateway's configuration or TUN.
import {createServer} from 'node:net';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import assert from 'node:assert/strict';
import {buildMihomoConfig} from '../server/mihomo.js';
import {createTelemetryCollector} from '../server/proxy-telemetry.js';
import {defaultDnsSettings} from '../server/dns-resolvers.js';
const binary=process.env.FREEDOMGATE_TEST_MIHOMO;
if(!binary)throw new Error('Set FREEDOMGATE_TEST_MIHOMO to a native mihomo binary.');
const folder=mkdtempSync(join(tmpdir(),'fg-group-core-')),sockets=new Set();
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve(server.address().port)));
async function freePort(){const server=createServer();const port=await listen(server);await new Promise(resolve=>server.close(resolve));return port;}
function socks(label,latency){
 const server=createServer(socket=>{
  sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.on('error',()=>{});
  let buffer=Buffer.alloc(0),state=0;
  socket.on('data',chunk=>{
   buffer=Buffer.concat([buffer,chunk]);
   if(state===0 && buffer.length>=2+buffer[1]){buffer=buffer.subarray(2+buffer[1]);socket.write(Buffer.from([5,0]));state=1;}
   if(state===1 && buffer.length>=5){const size=buffer[3]===1?10:buffer[3]===4?22:7+buffer[4];if(buffer.length<size)return;buffer=buffer.subarray(size);socket.write(Buffer.from([5,0,0,1,127,0,0,1,0,0]));state=2;}
   if(state===2 && buffer.includes('\r\n\r\n')){state=3;setTimeout(()=>{if(!socket.destroyed)socket.end(`HTTP/1.1 204 No Content\r\nX-Fixture: ${label}\r\nConnection: close\r\n\r\n`);},latency());}
  });
 });return server;
}
let aDelay=30,bDelay=200;
const a=socks('a',()=>aDelay),b=socks('b',()=>bDelay);
let core;
try {
 const aPort=await listen(a),bPort=await listen(b),controllerPort=await freePort(),mixedPort=await freePort();
 const profiles=[{id:'aaaaaaaa-test',engine:'socks5'},{id:'bbbbbbbb-test',engine:'socks5'}];
 const routes={profiles,configs:profiles.map((profile,i)=>({profile_id:profile.id,engine:'socks5',config:`socks5://127.0.0.1:${i?bPort:aPort}`})),groups:[{entries:['192.0.2.10'],routeId:'auto'}],devices:[],connectionGroups:[{id:'auto',members:profiles.map(p=>p.id)}]};
 let yaml=buildMihomoConfig(defaultDnsSettings,{mixedPort,controllerPort,controllerSecret:'test-secret'},routes)
   .replace('tun:\n  enable: true','tun:\n  enable: false').replace('dns:\n  enable: true','dns:\n  enable: false')
   .replaceAll('https://www.gstatic.com/generate_204','http://127.0.0.1:18081/probe');
 const config=join(folder,'config.yaml');writeFileSync(config,yaml,{mode:0o600});
 core=spawn(binary,['-d',folder,'-f',config],{stdio:'ignore'});
 core.on('error',()=>{});
 const api=async path=>{const response=await fetch(`http://127.0.0.1:${controllerPort}${path}`,{headers:{Authorization:'Bearer test-secret'},signal:AbortSignal.timeout(4000)});assert.equal(response.status,200);return response.json();};
 for(let n=0;n<50;n++){try{await api('/version');break;}catch{if(n===49)throw Error('Core not ready');await wait(100);}}
 const check=()=>api('/group/cg-auto/delay?url='+encodeURIComponent('http://127.0.0.1:18081/probe')+'&timeout=1000');
 await check();assert.equal((await api('/proxies/cg-auto')).now,'p-aaaaaaaa-grp');
 const routed=()=>new Promise((resolve,reject)=>{const request=http.get({hostname:'127.0.0.1',port:mixedPort,path:'http://192.0.2.10/probe',headers:{Host:'192.0.2.10'},timeout:3000},response=>{response.resume();resolve({status:response.statusCode,node:response.headers['x-fixture']});});request.on('error',reject);request.on('timeout',()=>request.destroy(Error('Timeout')));});
 assert.deepEqual(await routed(),{status:204,node:'a'});
 aDelay=250;bDelay=30;await check();assert.equal((await api('/proxies/cg-auto')).now,'p-bbbbbbbb-grp');
 assert.equal((await routed()).node,'b');
 const telemetry=await createTelemetryCollector(api)(profiles,[{id:'auto'}]);
 assert.equal(telemetry.groups.auto.selectedId,profiles[1].id);
 assert.ok(telemetry.profiles[profiles[1].id].ping>0);
 console.log('Native mihomo: generated groups validate, choose lower HTTP latency, switch A → B and route actual requests through the selected member.');
} finally {
 if(core){core.kill('SIGTERM');await new Promise(resolve=>core.once('exit',resolve));}
 for(const socket of sockets)socket.destroy();
 await Promise.all([a,b].map(server=>new Promise(resolve=>server.close(resolve))));rmSync(folder,{recursive:true,force:true});
}
