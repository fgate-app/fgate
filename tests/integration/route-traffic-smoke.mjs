// Isolated native mihomo rule attribution; no gateway routes or DNS are changed.
import http from 'node:http';import net from 'node:net';import {spawn,execFileSync} from 'node:child_process';import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';import assert from 'node:assert/strict';
import {buildMihomoConfig} from '../../server/mihomo.js';import {defaultDnsSettings} from '../../server/dns-resolvers.js';import {createRouteTrafficCollector} from '../../server/route-traffic.js';
const folder=mkdtempSync(join(tmpdir(),'fg-route-traffic-')),requests=[];let core;
const fixture=http.createServer((_req,res)=>{res.writeHead(200,{'Content-Type':'application/octet-stream'});res.write(Buffer.alloc(65536));});
const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve(server.address().port)));
async function port(){const server=net.createServer(),value=await listen(server);await new Promise(resolve=>server.close(resolve));return value;}
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
try{
 const fixturePort=await listen(fixture),mixedPort=await port(),controllerPort=await port();let owners;
 const yaml=buildMihomoConfig(defaultDnsSettings,{mixedPort,controllerPort,controllerSecret:'test-secret',onRuleOwners:value=>owners=value},{profiles:[{id:'direct',engine:'direct'}],configs:[],devices:[{id:'phone',identifier:'127.0.0.2',routeId:'direct'}],groups:[{id:'site',entries:['127.0.0.1'],routeId:'direct'}]}).replace('tun:\n  enable: true','tun:\n  enable: false').replace('dns:\n  enable: true','dns:\n  enable: false');
 const file=join(folder,'config.yaml');writeFileSync(file,yaml,{mode:0o600});const binary=process.env.FREEDOMGATE_MIHOMO || '/opt/freedomgate/modules/mihomo/v1.19.33/mihomo';
 execFileSync(binary,['-t','-d',folder,'-f',file],{stdio:'ignore',timeout:15000});core=spawn(binary,['-d',folder,'-f',file],{stdio:'ignore'});
 const api=async path=>{const response=await fetch(`http://127.0.0.1:${controllerPort}${path}`,{headers:{Authorization:'Bearer test-secret'},signal:AbortSignal.timeout(1500)});assert.equal(response.status,200);return response.json();};
 for(let n=0;n<100;n++){try{await api('/version');break;}catch{if(n===99)throw Error('Core not ready');await wait(100);}}
 const collector=createRouteTrafficCollector(api);collector.setOwners(owners);
 const stream=localAddress=>new Promise((resolve,reject)=>{const request=http.get({hostname:'127.0.0.1',port:mixedPort,localAddress,path:`http://127.0.0.1:${fixturePort}/stream`,headers:{Host:'127.0.0.1:'+fixturePort}},response=>{response.once('data',resolve);response.resume();});requests.push(request);request.on('error',reject);});
 await stream('127.0.0.1');await wait(100);await collector.sample();let result=collector.snapshot();assert.ok(result.groups.site.download>=65536);assert.equal(result.devices.phone.download,0);const groupTotal=result.groups.site.download;
 await stream('127.0.0.2');await wait(100);await collector.sample();result=collector.snapshot();assert.ok(result.devices.phone.download>=65536);assert.equal(result.groups.site.download,groupTotal);
 await collector.sample();assert.equal(collector.snapshot().groups.site.download,groupTotal);
 console.log('Native route traffic: domain/IP group and higher-priority device attributed separately; byte totals are stable and not duplicated.');
}finally{
 for(const request of requests)request.destroy();fixture.closeAllConnections();await new Promise(resolve=>fixture.close(resolve));
 if(core && core.exitCode===null && core.signalCode===null){core.kill('SIGTERM');await new Promise(resolve=>core.once('exit',resolve));}rmSync(folder,{recursive:true,force:true});
}
