// Run as root on an isolated Linux preflight tree. Uses only loopback fixtures;
// the helper owns a separate mark/queue/table and always removes them.
import assert from 'node:assert/strict';
import {execFile,execFileSync,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,writeFile,readFile,chmod,rm} from 'node:fs/promises';
import {join} from 'node:path';
import https from 'node:https';
import {createServer} from 'node:net';
import {randomBytes} from 'node:crypto';
import {ProxyStrategyHelper,proxyStrategies,strategyDaemonArgs,strategyTable} from '../server/proxy-strategy-helper.js';
import {serveHelperConnection} from '../server/helper-protocol.js';
import {unusedPort} from '../server/xray.js';
const pairsOnly=process.argv.includes('--pairs-only');
const execute=promisify(execFile),run=async(command,args,options={})=>(await execute(command,args,{timeout:5000,...options})).stdout.trim();
const directory=await mkdtemp('/tmp/fg-strategy-native-');await chmod(directory,0o755);
const node=process.execPath,xray='/opt/freedomgate/modules/xray/current/xray';
const paths=async()=>({binary:'/opt/freedomgate/modules/zapret/current/nfqws2',lua:'/opt/freedomgate/modules/zapret/current/lua'});
const stopDaemon=async path=>{try{const pid=Number((await readFile(path,'utf8')).trim()),cmd=await readFile('/proc/'+pid+'/cmdline','utf8');if(cmd.includes(directory)){process.kill(pid,'SIGTERM');for(let i=0;i<50;i++){try{process.kill(pid,0);}catch{return;}await new Promise(r=>setTimeout(r,20));}process.kill(pid,'SIGKILL');}}catch{}};
const controller=new ProxyStrategyHelper({run,paths,stopDaemon,runDir:directory});
let origin,helper,server,mihomo;const sockets=new Set();
const sharedBefore=await run('nft',['-s','list','table','inet','freedomgate_zapret']).catch(()=>null);
try{
 const key=join(directory,'key.pem'),cert=join(directory,'cert.pem');
 execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=example.com','-addext','subjectAltName=DNS:example.com'],{stdio:'ignore'});
 await chmod(cert,0o644);
 origin=https.createServer({key:await readFile(key),cert:await readFile(cert)},(req,res)=>{setTimeout(()=>res.end('verified strategy fixture'),100);});origin.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
 await new Promise(resolve=>origin.listen(0,'127.0.0.1',resolve));
 const vlessPort=await unusedPort(),ssPort=await unusedPort(),password=randomBytes(16).toString('hex'),uuid='00000000-0000-4000-8000-000000000001';
 const config={log:{loglevel:'error'},inbounds:[{listen:'::1',port:vlessPort,protocol:'vless',settings:{clients:[{id:uuid}],decryption:'none'}},{listen:'127.0.0.1',port:vlessPort,protocol:'vless',settings:{clients:[{id:uuid}],decryption:'none'}},{listen:'127.0.0.1',port:ssPort,protocol:'shadowsocks',settings:{method:'aes-128-gcm',password,network:'tcp'}}],outbounds:[{protocol:'freedom',settings:{redirect:'127.0.0.1:'+origin.address().port,finalRules:[{action:'allow',network:'tcp',ip:['127.0.0.1/32'],port:String(origin.address().port)}]}}]};
 const controlSocksPort=await unusedPort(),controlPort=await unusedPort(),controllerPort=await unusedPort(),controlSecret=randomBytes(16).toString('hex');
 config.inbounds.push({tag:'control-socks',listen:'127.0.0.1',port:controlSocksPort,protocol:'socks',settings:{auth:'noauth',udp:false}});
 config.outbounds[0].tag='origin';config.outbounds.push({tag:'control-peer',protocol:'freedom',settings:{finalRules:[{action:'allow',network:'tcp',ip:['127.0.0.1/32','::1/128'],port:vlessPort+','+ssPort}]}});
 config.routing={rules:[{type:'field',inboundTag:['control-socks'],port:'443',outboundTag:'origin'},{type:'field',inboundTag:['control-socks'],outboundTag:'control-peer'}]};
 const controlEndpoint={id:'fixture-control',tag:'p-00000001',port:controlPort,secret:controlSecret};
 const mihomoPath=join(directory,'mihomo.json');
 await writeFile(mihomoPath,JSON.stringify({'external-controller':'127.0.0.1:'+controllerPort,secret:controlSecret,'log-level':'error',mode:'rule',rules:['MATCH,REJECT'],proxies:[{name:controlEndpoint.tag,type:'socks5',server:'127.0.0.1',port:controlSocksPort}],listeners:[{name:'fg-geo-'+controlEndpoint.id,type:'mixed',listen:'127.0.0.1',port:controlPort,proxy:controlEndpoint.tag,users:[{username:'fg-geo',password:controlSecret}]}]}),{mode:0o600});
 mihomo=spawn('/opt/freedomgate/modules/mihomo/current/mihomo',['-d',directory,'-f',mihomoPath],{stdio:'ignore'});
 await new Promise(resolve=>setTimeout(resolve,500));assert.equal(mihomo.exitCode,null);
 const configPath=join(directory,'server.json');await writeFile(configPath,JSON.stringify(config),{mode:0o600});
 await run(xray,['run','-test','-config',configPath]);
 server=spawn(xray,['run','-config',configPath],{stdio:'ignore'});
 await new Promise(resolve=>setTimeout(resolve,300));assert.equal(server.exitCode,null);
 const socketPath=join(directory,'network.sock');helper=createServer({allowHalfOpen:true},socket=>serveHelperConnection(socket,(request,{signal})=>controller.handle(request,{signal,interface:'lo'})));
 await new Promise(resolve=>helper.listen(socketPath,resolve));await chmod(socketPath,0o666);
 const worker=join(directory,'client.mjs');
 const moduleUrl=new URL('../server/proxy-strategies.js',import.meta.url).href;
 await writeFile(worker,`
import {probeProxyStrategy} from ${JSON.stringify(moduleUrl)};
import {compareProxyPaths} from ${JSON.stringify(new URL('../server/proxy-path-comparison.js',import.meta.url).href)};
import {observeDiagnostic} from ${JSON.stringify(new URL('../server/diagnostic-observer.js',import.meta.url).href)};
import {diagnoseGateway} from ${JSON.stringify(new URL('../server/gateway-diagnostics.js',import.meta.url).href)};
let raw='';for await(const chunk of process.stdin)raw+=chunk;
const input=JSON.parse(raw),cancelTest=input.cancelTest;delete input.cancelTest;
const controller=new AbortController();let result;
try{
 if(input.controlFixture){
  const endpoint=input.controlFixture.endpoint;
  const request=async(path,{signal})=>{const response=await fetch('http://127.0.0.1:'+input.controlFixture.controllerPort+path,{signal,headers:{Authorization:'Bearer '+endpoint.secret}});if(!response.ok)throw Error('Fixture controller unavailable.');return response.json();};
  const observe=context=>observeDiagnostic(request,context);
  const control={upstream:{...endpoint,username:'fg-geo',password:endpoint.secret},observe,isCurrent:()=>true};
  result=await compareProxyPaths({snapshot:input.snapshot,endpoint:{addresses:[input.address],port:input.peerPort},candidates:[{id:endpoint.id}],
   getControl:async()=>control,...(cancelTest?{probe:options=>probeProxyStrategy({...options,...(options.helper?{request:async()=>{controller.abort();throw Object.assign(Error('cancelled'),{code:'ABORTED'});}}:{})})}:{}),verifyControl:async()=>diagnoseGateway({profiles:[{id:endpoint.id,engine:'socks5'}],id:endpoint.id,endpoint,targets:['https://example.com/'],observe,signal:controller.signal}).then(report=>{if(report.outcome!=='ok')process.stderr.write(JSON.stringify({controlCheck:report})+'\\n');return report;}),signal:controller.signal});
 }else result=await probeProxyStrategy({...input,signal:controller.signal,...(cancelTest?{request:async()=>{controller.abort();throw Object.assign(Error('cancelled'),{code:'ABORTED'});}}:{})});
}catch(error){if(error.code!=='ABORTED')throw error;result={cancelled:true};}
process.stdout.write(JSON.stringify(result));`,{mode:0o644});
 const snapshots=[{profile:{id:'fixture-vless'},config:{engine:'xray',config:'vless://'+uuid+'@127.0.0.1:'+vlessPort+'?security=none'}},{profile:{id:'fixture-outline'},config:{engine:'outline',config:'ss://'+Buffer.from('aes-128-gcm:'+password).toString('base64url')+'@127.0.0.1:'+ssPort}}];
 snapshots.push({profile:{id:'fixture-vless-ipv6'},fixtureIPv6:true,config:{engine:'xray',config:'vless://'+uuid+'@[::1]:'+vlessPort+'?security=none'}});
 for(const snapshot of snapshots)for(const strategy of pairsOnly?[]:[...proxyStrategies.map(row=>row.id),...(snapshot.config.engine==='xray'?['cancel']:[])]){
  const cancelTest=strategy==='cancel';
  const child=spawn('runuser',['-u','freedomgate','--','env','FREEDOMGATE_NETWORK_SOCKET='+socketPath,'FREEDOMGATE_OUTLINE=/opt/freedomgate/current/server/outline/bin/linux-arm64/outline-bridge','CURL_CA_BUNDLE='+cert,node,worker],{stdio:['pipe','pipe','pipe']});
  let raw='',errors='';child.stdout.on('data',chunk=>raw+=chunk);child.stderr.on('data',chunk=>errors+=chunk);
  child.stdin.end(JSON.stringify({snapshot,address:snapshot.fixtureIPv6?'::1':'127.0.0.1',strategy:cancelTest?'split-1':strategy,domain:'example.com',cancelTest}));
  const code=await new Promise(resolve=>child.on('exit',resolve));assert.equal(code,0,errors);
  const result=JSON.parse(raw);if(cancelTest){assert.equal(result.cancelled,true);assert.equal(controller.session,null);await assert.rejects(run('nft',['list','table','inet',strategyTable]));console.log('cancel: native client, relay, queue and rules cleaned');continue;}assert.equal(result.state,'ok',JSON.stringify(result));assert.equal(result.attempts.length,2);assert.ok(result.attempts.every(row=>row.pathObservation.state==='verified' && row.bytes>0));
  if(strategy==='baseline')assert.ok(result.attempts.every(row=>row.flows?.some(flow=>flow.tcpCapture?.probeCorrelated && flow.evidence?.code==='peer-data-received')),JSON.stringify(result));
  assert.equal(controller.session,null);await assert.rejects(run('nft',['list','table','inet',strategyTable]));
  console.log(snapshot.config.engine+' '+strategy+': two verified HTTPS responses; rules and processes cleaned');
 }
 for(const snapshot of [...snapshots,{...snapshots[0],cancelComparison:true}]){
  const child=spawn('runuser',['-u','freedomgate','--','env','FREEDOMGATE_NETWORK_SOCKET='+socketPath,'FREEDOMGATE_OUTLINE=/opt/freedomgate/current/server/outline/bin/linux-arm64/outline-bridge','CURL_CA_BUNDLE='+cert,node,worker],{stdio:['pipe','pipe','pipe']});
  let raw='',errors='';child.stdout.on('data',chunk=>raw+=chunk);child.stderr.on('data',chunk=>errors+=chunk);
  child.stdin.end(JSON.stringify({snapshot,address:snapshot.fixtureIPv6?'0:0:0:0:0:0:0:1':'127.0.0.1',peerPort:snapshot.config.engine==='outline'?ssPort:vlessPort,controlFixture:{endpoint:controlEndpoint,controllerPort},cancelTest:snapshot.cancelComparison===true}));
  assert.equal(await new Promise(resolve=>child.once('exit',resolve)),0,errors);
  const result=JSON.parse(raw);if(snapshot.cancelComparison){assert.equal(result.cancelled,true);assert.equal(controller.session,null);console.log('wrapped comparison: cancellation cleaned client, relay and observer');continue;}assert.equal(result.outcome,'same-success',JSON.stringify(result));
  assert.equal(result.results.length,3);assert.ok(result.results.every(row=>row.attempts.length===2 && row.attempts.every(attempt=>attempt.pathObservation.state==='verified')));
  console.log(snapshot.profile.id+': direct/control/direct passed with real mihomo pinned listener, default REJECT and engine tuple proof');
 }
 // Installed nfqws2 validates every allowlisted strategy, rather than relying on a mock.
 for(const strategy of pairsOnly?[]:proxyStrategies.filter(row=>row.desync)){
  const [binary,...args]=strategyDaemonArgs({...await paths(),pidfile:join(directory,'dry.pid'),strategy:strategy.id});await run(binary,args.filter(arg=>arg!=='--daemon' && !arg.startsWith('--pidfile=')).concat('--dry-run'));
 }
 assert.equal(await run('nft',['-s','list','table','inet','freedomgate_zapret']).catch(()=>null),sharedBefore);
 console.log(pairsOnly?'Native paired-path preflight passed: actual Outline/Xray, IPv4/expanded IPv6, pinned mihomo with default REJECT, cancellation and shared rules verified.':'Native strategy preflight passed: Outline SDK and Xray, 18 successful IPv4/IPv6 sessions, 36 strategy HTTPS responses plus 18 paired-path HTTPS responses, actual-client capture, direct and wrapped cancellation cleanup, 5 nfqws2 dry-runs; shared rules unchanged.');
}finally{
 await controller.stop().catch(()=>{});server?.kill('SIGTERM');mihomo?.kill('SIGTERM');for(const socket of sockets)socket.destroy();await new Promise(resolve=>origin?origin.close(resolve):resolve());await new Promise(resolve=>helper?helper.close(resolve):resolve());await rm(directory,{recursive:true,force:true});
}
