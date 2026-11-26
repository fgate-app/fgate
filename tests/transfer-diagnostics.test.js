import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import {transferTargets,requestTransfer,transferAttempt,diagnoseTransfer} from '../server/transfer-diagnostics.js';
import {allocateDiagnosticTcpPort} from '../server/diagnostic-port.js';
import {exportDiagnosticReport} from '../shared/diagnostic-report.js';
const id='12345678-fixture',profiles=[{id,engine:'xray'}],endpoint={id,port:28000,secret:'private-secret'};
const raw=bytes=>({exitCode:0,http_connect:200,response_code:200,ssl_verify_result:0,time_appconnect:.1,time_starttransfer:.2,time_total:1,receivedBytes:bytes,content_type:'application/octet-stream',local_ip:'127.0.0.1',local_port:45000});

test('transfer reports require complete bytes, verified TLS, status and binary content; raw secrets never escape',()=>{
 const target=transferTargets[0],result=transferAttempt({...raw(target.bytes),proxy_user:'private-secret'},target);
 assert.equal(result.complete,true);assert.equal(result.ttfbMs,200);assert.equal(result.durationMs,1000);assert.equal(result.bytesPerSecond,65536);assert.doesNotMatch(JSON.stringify(result),/private-secret|127\.0\.0\.1/);
 for(const [patch,observation] of [[{exitCode:28},'timeout'],[{exitCode:60},'certificate-error'],[{exitCode:63},'response-too-large'],[{http_connect:403},'connect-error'],[{ssl_verify_result:1},'tls-error'],[{response_code:302},'http-rejection'],[{receivedBytes:100},'size-mismatch'],[{content_type:'text/html'},'unexpected-content-type'],[{exitCode:18},'transport-error']]){
  const row=transferAttempt({...raw(target.bytes),...patch},target);assert.equal(row.complete,false);assert.equal(row.bytesPerSecond,null);assert.equal(row.observation,observation);
 }
});

test('transfer follows selected listener, enforces budgets and invalidates changes without disclosing observer identity',async()=>{
 const calls=[];let current=true;
 const options={id,profiles,endpoint,allocatePort:async()=>45000,observe:async()=>({finish:async()=>({state:'verified',connectionId:'private-flow',chain:['p-12345678'],sourcePort:45000,inboundPort:28000})}),request:async(e,target,options)=>{calls.push({e,target,options});return raw(target.bytes);}};
 const report=await diagnoseTransfer(options);assert.equal(calls.length,2);assert.equal(report.outcome,'ok');assert.ok(report.path.engineVerified);assert.deepEqual(calls.map(row=>row.target.bytes),[65536,1048576]);assert.ok(calls.every(row=>row.e===endpoint && row.options.timeoutMs<=12000));assert.equal(report.limits.expectedBodyBytes,1114112);
 const exported=exportDiagnosticReport({profileId:id,path:{chain:[{id}]},transfer:report});assert.doesNotMatch(JSON.stringify(exported),/private-flow|private-secret|12345678|45000|28000/);assert.equal(exported.transfer.attempts[0].bytes,65536);
 const changed=await diagnoseTransfer({...options,isCurrent:()=>current,request:async()=>{current=false;return raw(65536);}});assert.equal(changed.path.configChanged,true);assert.ok(changed.attempts.every(row=>!row.complete && row.observation==='configuration-changed'));
 const unavailable=await diagnoseTransfer({...options,observe:async()=>({finish:async()=>{throw Error('observer failed');}})});assert.ok(unavailable.attempts.every(row=>!row.complete && row.outcome==='unavailable'));
 const mismatch=await diagnoseTransfer({...options,observe:async()=>({finish:async()=>({state:'mismatch'})})});assert.ok(mismatch.attempts.every(row=>!row.complete && row.observation==='path-mismatch'));
 let time=0,count=0;const limited=await diagnoseTransfer({...options,now:()=>time,request:async()=>{count++;time=27000;return raw(65536);}});assert.equal(count,1);assert.equal(limited.attempts[1].observation,'budget-exhausted');
 const controller=new AbortController();controller.abort();await assert.rejects(diagnoseTransfer({...options,signal:controller.signal}),{code:'ABORTED'});
});

test('real curl validates TLS through authenticated CONNECT, rejects redirects/stubs/stalls and cancels children',async t=>{
 const folder=mkdtempSync(join(tmpdir(),'fg-transfer-'));t.after(()=>rmSync(folder,{recursive:true,force:true}));
 const key=join(folder,'key.pem'),cert=join(folder,'cert.pem');
 execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=speed.cloudflare.com','-addext','subjectAltName=DNS:speed.cloudflare.com'],{stdio:'ignore'});
 let scenario='full',connects=0,headers,arrived,closedChild;
 const sockets=new Set();const track=socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));};
 const origin=https.createServer({key:readFileSync(key),cert:readFileSync(cert)},(req,res)=>{
  if(scenario==='site-redirect' && req.url==='/'){res.writeHead(307,{Location:'/final'});res.end();return;}
  if(req.url==='/final'){res.end('redirect destination');return;}
  if(req.url==='/'){assert.equal(req.headers.range,'bytes=0-1048575');res.writeHead(200,{'Content-Type':'text/html'});res.end('<html>fixture</html>');return;}
  const bytes=Number(new URL(req.url,'https://fixture').searchParams.get('bytes'));
  if(scenario==='redirect'){res.writeHead(302,{Location:'https://unapproved.invalid/'});res.end();return;}
  if(scenario==='stub'){res.writeHead(200,{'Content-Type':'application/octet-stream'});res.end('blocked');return;}
  if(scenario==='html'){res.writeHead(200,{'Content-Type':'text/html'});res.end(Buffer.alloc(bytes));return;}
  if(scenario==='oversized'){res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Length':bytes+1});res.end(Buffer.alloc(bytes+1));return;}
  res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Length':bytes});
  if(scenario==='stall'){res.write(Buffer.alloc(16));arrived?.();return;}
  res.end(Buffer.alloc(bytes));
 });origin.on('connection',track);origin.on('tlsClientError',()=>{});
 await new Promise(resolve=>origin.listen(0,'127.0.0.1',resolve));
 const proxy=http.createServer();proxy.on('connection',track);proxy.on('connect',(req,socket,head)=>{
  connects++;headers=req.headers;assert.equal(req.url,'speed.cloudflare.com:443');
  if(scenario==='reject'){socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');return;}
  const upstream=net.connect(origin.address().port,'127.0.0.1',()=>{socket.write('HTTP/1.1 200 Connection established\r\n\r\n');if(head.length)upstream.write(head);socket.pipe(upstream);upstream.pipe(socket);});track(upstream);
  socket.on('error',()=>upstream.destroy());upstream.on('error',()=>socket.destroy());socket.once('close',()=>upstream.destroy());
 });
 await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{for(const socket of sockets)socket.destroy();await Promise.all([new Promise(resolve=>proxy.close(resolve)),new Promise(resolve=>origin.close(resolve))]);});
 const e={port:proxy.address().port,secret:'fixture-secret'};
 const spawnTrusted=(cmd,args,options)=>{assert.equal(cmd,'curl');assert.ok(!args.includes('--location') && !args.includes('--insecure'));assert.doesNotMatch(args.join(' '),/fixture-secret/);const child=spawn(cmd,[args[0],'--cacert',cert,...args.slice(1)],options);closedChild=new Promise(resolve=>child.once('close',resolve));return child;};
 const request=async(target=transferTargets[0],extra={})=>requestTransfer(e,target,{localPort:await allocateDiagnosticTcpPort(),timeoutMs:1000,spawnProcess:spawnTrusted,...extra});
 for(const target of transferTargets){const result=await request(target);assert.equal(transferAttempt(result,target).complete,true,JSON.stringify(result));assert.equal(result.receivedBytes,target.bytes);}
 const sample={domain:'speed.cloudflare.com',url:'https://speed.cloudflare.com/',bytes:1048576,mode:'site-response'};const sampled=transferAttempt(await request(sample),sample);assert.equal(sampled.complete,true,JSON.stringify(sampled));assert.equal(sampled.bytes,20);assert.equal(sampled.bytesPerSecond,null);
 scenario='site-redirect';const redirected=await diagnoseTransfer({id,profiles,endpoint:e,targets:[sample],request:(endpoint,target,options)=>requestTransfer(endpoint,target,{...options,spawnProcess:spawnTrusted}),observe:async()=>({finish:async()=>({state:'verified'})})});assert.equal(redirected.attempts[0].complete,true,JSON.stringify(redirected));assert.equal(redirected.attempts[0].redirects.length,1);assert.equal(redirected.attempts[0].finalUrl,'https://speed.cloudflare.com/final');scenario='full';
 assert.equal(headers['proxy-authorization'],'Basic '+Buffer.from('fg-geo:fixture-secret').toString('base64'));
 for(const [value,observation] of [['redirect','http-rejection'],['stub','size-mismatch'],['html','unexpected-content-type'],['oversized','response-too-large'],['stall','timeout']]){
  scenario=value;const result=await request();assert.equal(transferAttempt(result,transferTargets[0]).observation,observation,value+JSON.stringify({exitCode:result.exitCode,http_connect:result.http_connect,receivedBytes:result.receivedBytes,oversized:result.oversized}));assert.equal(transferAttempt(result,transferTargets[0]).complete,false);
 }
 scenario='reject';const rejectedAt=connects;const rejected=await request();assert.equal(rejected.http_connect,403);assert.equal(connects,rejectedAt+1);assert.equal(rejected.receivedBytes,0);
 scenario='full';const badCert=await requestTransfer(e,transferTargets[0],{localPort:await allocateDiagnosticTcpPort(),timeoutMs:2000});assert.equal(transferAttempt(badCert,transferTargets[0]).observation,'certificate-error');
 const before=connects;await assert.rejects(requestTransfer(e,{url:'https://unapproved.invalid/',bytes:65536},{localPort:45000}));assert.equal(connects,before);
 scenario='stall';const controller=new AbortController();const started=new Promise(resolve=>arrived=resolve);const pending=request(transferTargets[0],{signal:controller.signal});await started;controller.abort();await assert.rejects(pending,{code:'ABORTED'});await closedChild;
});
