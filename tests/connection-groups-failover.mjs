// Native, loopback-only failure acceptance. Run inside an empty network namespace.
// Uses generated groups and the original MATCH,DIRECT default; only the test
// health URL, optional health timing and isolated listeners are adapted. Never reads production configuration or controller secrets.
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import {spawn,execFileSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {parse} from 'yaml';
import {buildMihomoConfig} from '../server/mihomo.js';
import {defaultDnsSettings} from '../server/dns-resolvers.js';
const binary=process.env.FREEDOMGATE_TEST_MIHOMO;
assert.ok(binary,'Set FREEDOMGATE_TEST_MIHOMO to an installed native mihomo binary.');
assert.equal(process.platform,'linux','Run this acceptance test on Linux in a network namespace.');
const interfaces=JSON.parse(execFileSync('ip',['-j','link','show'],{encoding:'utf8'}));
assert.ok(interfaces.length===1&&interfaces[0].ifname==='lo','Run in a loopback-only network namespace; production networking is not allowed.');
const interval=Number(process.env.FG_GROUP_INTERVAL || 2),timeout=Number(process.env.FG_GROUP_TIMEOUT || 800);
assert.ok(Number.isInteger(interval)&&interval>=1&&interval<=60);
assert.ok(Number.isInteger(timeout)&&timeout>=200&&timeout<=5000);
const folder=mkdtempSync(join(tmpdir(),'fg-group-failover-')),servers=[],children=[],sockets=new Set(),streams=[],sourcePaths=new Map(),allowedPorts=new Set(),evidence=[];
const now=()=>performance.now(),wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const elapsed=t=>Math.round(now()-t),budget=interval*1000+timeout*3+8000;
let targetHits=0,directHits=0,forbiddenDials=0,stage='setup',coreLog='';
const mark=value=>{stage=value;console.error('Stage: '+stage);};
const track=socket=>{sockets.add(socket);socket.on('error',()=>{});socket.once('close',()=>sockets.delete(socket));return socket;};
async function listen(server,host='127.0.0.1'){servers.push(server);await new Promise(resolve=>server.listen(0,host,resolve));allowedPorts.add(server.address().port);return server.address().port;}
async function freePort(){const s=net.createServer();await new Promise(resolve=>s.listen(0,'127.0.0.1',resolve));const port=s.address().port;await new Promise(resolve=>s.close(resolve));return port;}
function proxy(label,latency){
 const active=new Set();let up=true,connections=0;
 const server=net.createServer(client=>{
  track(client);active.add(client);client.once('close',()=>active.delete(client));if(!up){client.destroy();return;}
  let buffer=Buffer.alloc(0),state=0;
  function data(chunk){
   buffer=Buffer.concat([buffer,chunk]);
   if(state===0){if(buffer.length<2+buffer[1])return;assert.equal(buffer[0],5);buffer=buffer.subarray(2+buffer[1]);client.write(Buffer.from([5,0]));state=1;}
   if(state!==1||buffer.length<5)return;
   const length=buffer[3]===1?10:buffer[3]===4?22:7+buffer[4];if(buffer.length<length)return;
   assert.equal(buffer[1],1,'Only CONNECT is expected');const port=buffer.readUInt16BE(length-2);
   if(!allowedPorts.has(port)){forbiddenDials++;client.destroy();return;}
   state=2;client.off('data',data);client.pause();const extra=buffer.subarray(length);buffer=Buffer.alloc(0);
   setTimeout(()=>{
    if(!up||client.destroyed){client.destroy();return;}
    const remote=track(net.connect(port,'127.0.0.1'));active.add(remote);remote.once('close',()=>{active.delete(remote);sourcePaths.delete(remote.localPort);client.destroy();});client.once('close',()=>remote.destroy());
    remote.once('connect',()=>{connections++;sourcePaths.set(remote.localPort,label);client.write(Buffer.from([5,0,0,1,127,0,0,1,0,0]));if(extra.length)remote.write(extra);client.pipe(remote);remote.pipe(client);client.resume();});
    remote.once('error',()=>client.destroy());
   },latency).unref();
  }
  client.on('data',data);
 });
 return {server,label,get connections(){return connections;},setUp(value){up=value;if(!up)for(const socket of active)socket.destroy();}};
}
async function until(check,label,milliseconds=budget){const started=now();let last;while(elapsed(started)<milliseconds){try{const value=await check();if(value)return {value,ms:elapsed(started)};}catch(error){last=error.message;}await wait(200);}throw Error('Timed out: '+label+(last?' ('+last+')':''));}
function request(port,path='/data',domain='127.0.0.2'){
 return new Promise((resolve,reject)=>{
  const req=http.get({hostname:'127.0.0.1',port,path:`http://${domain}:${targetPort}${path}`,headers:{Host:domain+':'+targetPort},agent:false,timeout:1800},res=>{let text='';res.setEncoding('utf8');res.on('data',data=>text+=data);res.on('end',()=>{try{assert.equal(res.statusCode,200);const body=JSON.parse(text);assert.equal(body.payload,'x'.repeat(4096));resolve(body);}catch(error){reject(error);}});res.on('error',reject);});req.on('error',reject);req.on('timeout',()=>req.destroy(Error('Request timeout')));
 });
}
async function stream(port){
 const row={lines:0,path:null,ended:false};streams.push(row);
 row.request=http.get({hostname:'127.0.0.1',port,path:`http://127.0.0.2:${targetPort}/stream`,headers:{Host:'127.0.0.2:'+targetPort},agent:false},res=>{row.response=res;let text='';res.setEncoding('utf8');res.on('data',chunk=>{text+=chunk;let end;while((end=text.indexOf('\n'))>=0){const line=JSON.parse(text.slice(0,end));row.path ||= line.via;assert.equal(line.via,row.path);row.lines++;text=text.slice(end+1);}});res.on('end',()=>row.ended=true);res.on('close',()=>row.ended=true);res.on('error',()=>row.ended=true);});row.request.on('error',()=>row.ended=true);
 await until(()=>row.lines>=2,'stream starts');return row;
}
const a=proxy('primary',5),b=proxy('reserve',150),outer=proxy('outer',0);
let targetPort;
try{
 targetPort=await listen(http.createServer((req,res)=>{
  const via=sourcePaths.get(req.socket.remotePort)||'direct';if(req.url!=='/health'){targetHits++;if(via==='direct')directHits++;}
  if(req.url==='/stream'){res.writeHead(200,{'Content-Type':'application/x-ndjson'});let n=0;const send=()=>res.write(JSON.stringify({via,seq:n++})+'\n');send();const timer=setInterval(send,100);res.on('close',()=>clearInterval(timer));}
  else if(req.url==='/health'){res.writeHead(204);res.end();}
  else res.end(JSON.stringify({via,payload:'x'.repeat(4096)}));
 }),'0.0.0.0');
 const directControl=await(await fetch(`http://127.0.0.2:${targetPort}/data`)).json();assert.equal(directControl.via,'direct');
 const aPort=await listen(a.server),bPort=await listen(b.server),outerPort=await listen(outer.server);
 const profiles=[{id:'aaaaaaaa-primary',engine:'socks5',gatewayId:'oooooooo-outer'},{id:'bbbbbbbb-reserve',engine:'socks5'},{id:'oooooooo-outer',engine:'socks5'},{id:'direct-local',engine:'direct'}];
 const routes={profiles,configs:profiles.slice(0,3).map((p,i)=>({profile_id:p.id,engine:'socks5',config:`socks5://127.0.0.1:${[aPort,bPort,outerPort][i]}`})),groups:[{entries:['127.0.0.2'],routeId:'auto'},{entries:['127.0.0.3'],routeId:profiles[0].id}],devices:[],connectionGroups:[{id:'auto',members:profiles.slice(0,2).map(p=>p.id)},{id:'explicit-direct',members:[profiles[0].id,'direct-local']}]};
 const controllerPort=await freePort(),port=await freePort();
 const yaml=buildMihomoConfig(defaultDnsSettings,{mixedPort:port,controllerPort,controllerSecret:'isolated-fixture'},routes);
 const config=parse(yaml);assert.equal(config['proxy-groups'].find(g=>g.name==='cg-auto').type,'url-test');assert.equal(config['proxy-groups'].find(g=>g.name==='cg-explicit-direct').type,'fallback');assert.equal(config.proxies.find(p=>p.name==='p-aaaaaaaa')['dialer-proxy'],'p-oooooooo');
 config.tun.enable=false;config.dns.enable=false;config['log-level']='info';assert.equal(config.rules.at(-1),'MATCH,DIRECT');config.rules.splice(-1,0,'IP-CIDR,127.0.0.1/32,cg-explicit-direct,no-resolve');
 const productionHealth=config['proxy-groups'].filter(g=>g.url).map(({interval,timeout})=>({interval,timeout}));
 for(const g of config['proxy-groups'])if(g.url){g.url=`http://127.0.0.1:${targetPort}/health`;g.interval=interval;g.timeout=timeout;g.lazy=false;}
 const file=join(folder,'config.json');writeFileSync(file,JSON.stringify(config),{mode:0o600});execFileSync(binary,['-t','-d',folder,'-f',file],{timeout:10000,stdio:'pipe'});
 const core=spawn(binary,['-d',folder,'-f',file],{stdio:['ignore','pipe','pipe']});children.push(core);for(const output of [core.stdout,core.stderr])output.on('data',chunk=>{coreLog=(coreLog+chunk.toString()).slice(-12000);});let launchError;core.on('error',error=>launchError=error);
 const api=async path=>{if(launchError)throw launchError;const response=await fetch(`http://127.0.0.1:${controllerPort}${path}`,{headers:{Authorization:'Bearer isolated-fixture'},signal:AbortSignal.timeout(2000)});assert.equal(response.status,200);return response.json();};
 mark('initial readiness');await until(()=>api('/version'),'core ready',10000);const version=await api('/version');
 await api('/group/cg-auto/delay?url='+encodeURIComponent(`http://127.0.0.1:${targetPort}/health`)+`&timeout=${timeout}`);
 const selected=async()=>((await api('/proxies/cg-auto')).now);
 await until(async()=>await selected()==='p-aaaaaaaa-grp','initial primary');assert.equal((await request(port)).via,'primary');assert.ok(outer.connections>0);const firstStream=await stream(port);assert.equal(firstStream.path,'primary');
 evidence.push({stage:'baseline',selected:await selected(),dataVia:'primary',stream:firstStream.path});
 mark('short failure');const shortStart=now();a.setUp(false);const shortDuration=Number(process.env.FG_GROUP_SHORT_MS||1200);let shortSuccess=null;
 while(elapsed(shortStart)<shortDuration){try{const result=await request(port);if(!shortSuccess)shortSuccess={atMs:elapsed(shortStart),via:result.via};}catch{}await wait(100);}
 a.setUp(true);const recoveredShort=await until(async()=>await selected()==='p-aaaaaaaa-grp'&&(await request(port)).via==='primary','short failure recovery');
 evidence.push({stage:'shortFailure',requestedDurationMs:shortDuration,actualDurationMs:elapsed(shortStart)-recoveredShort.ms,firstSuccessfulRequest:shortSuccess,recoveryMs:recoveredShort.ms,originalStreamEnded:firstStream.ended});assert.ok(firstStream.ended,'A lost stream is closed, not silently migrated');
 mark('long failure');const longStart=now();a.setUp(false);const switched=await until(async()=>await selected()==='p-bbbbbbbb-grp'&&(await request(port)).via==='reserve','long failure switches to reserve');
 const reserveStream=await stream(port);assert.equal(reserveStream.path,'reserve');const hold=interval*1000+timeout+1000;await wait(hold);assert.equal((await request(port)).via,'reserve');
 a.setUp(true);const recoveryStart=now();const returned=await until(async()=>await selected()==='p-aaaaaaaa-grp'&&(await request(port)).via==='primary','primary returns');const lines=reserveStream.lines;await wait(650);assert.ok(reserveStream.lines>lines&&!reserveStream.ended);assert.equal(reserveStream.path,'reserve');
 evidence.push({stage:'longFailure',durationMs:Math.round(recoveryStart-longStart),switchMs:switched.ms,recoveryMs:returned.ms,newRequestsVia:'primary',existingStreamRemained:'reserve',streamLinesAfterRecovery:reserveStream.lines-lines});
 mark('outer wrapper failure');outer.setUp(false);const wrapperStart=now();const wrapperSwitch=await until(async()=>await selected()==='p-bbbbbbbb-grp'&&(await request(port)).via==='reserve','outer failure switches group');
 await assert.rejects(request(port,'/data','127.0.0.3'));evidence.push({stage:'wrapperFailure',switchMs:wrapperSwitch.ms,rejectionCheckMs:elapsed(wrapperStart)-wrapperSwitch.ms,groupVia:'reserve',wrappedProxyRequest:'rejected'});
 mark('all proxy paths failed');b.setUp(false);await wait(300);const before=targetHits,leaks=directHits;for(let i=0;i<3;i++)await assert.rejects(request(port));assert.equal(targetHits,before,'Failed group must not fall back to reachable direct target');assert.equal(directHits,leaks);evidence.push({stage:'allProxiesFailed',requests:3,targetRequests:targetHits-before,directRequests:directHits-leaks});
 mark('explicit DIRECT reserve');const explicitStart=now();const explicit=await until(async()=>{try{const row=await request(port,'/data','127.0.0.1');return row.via==='direct'&&row;}catch{return false;}},'explicit direct reserve');
 evidence.push({stage:'explicitDirectFallback',switchMs:elapsed(explicitStart),via:explicit.value.via,allowedBecause:'DIRECT explicitly belongs to this group'});
 outer.setUp(true);a.setUp(true);b.setUp(true);const finalRecovery=await until(async()=>await selected()==='p-aaaaaaaa-grp'&&(await request(port)).via==='primary','final recovery');assert.equal(forbiddenDials,0);
 const result={task:'FG-11.1',testedAt:new Date().toISOString(),version,architecture:process.arch,productionHealth:[...new Set(productionHealth.map(row=>JSON.stringify(row)))].map(row=>JSON.parse(row)),testHealth:{intervalSeconds:interval,timeoutMs:timeout},defaultRule:config.rules.at(-1),directTargetControl:directControl.via,initialForcedHealthChecks:1,subsequentSelection:'automatic health checks plus client requests; no forced delay calls or selection changes',evidence,finalRecoveryMs:finalRecovery.ms,forbiddenDials,limitations:['Loopback TCP fixture, no external provider or VPN cryptography measured.','TUN and DNS capture disabled; original MATCH,DIRECT retained and direct target reachability confirmed.','Only configured health-check target controls availability; per-site blocking may differ.'],passed:true};
 console.log(JSON.stringify(result,null,2));if(process.env.FG_GROUP_REPORT)writeFileSync(process.env.FG_GROUP_REPORT,JSON.stringify(result,null,2)+'\n',{mode:0o600});
}catch(error){console.error(JSON.stringify({stage,targetHits,directHits,forbiddenDials,proxyConnections:{a:a.connections,b:b.connections,outer:outer.connections},coreLog},null,2));throw error;}finally{
 for(const stream of streams){stream.request.destroy();stream.response?.destroy();}
 for(const child of children){if(child.exitCode===null&&child.signalCode===null){const exited=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGTERM');await exited;}}
 for(const socket of sockets)socket.destroy();for(const server of servers)server.closeAllConnections?.();
 await Promise.all(servers.map(server=>new Promise(resolve=>server.close(resolve))));rmSync(folder,{recursive:true,force:true});
}
