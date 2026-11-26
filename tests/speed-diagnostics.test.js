import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import {speedSamples,speedSampleResult,speedMetrics,diagnoseSpeed,requestSpeedSample} from '../server/speed-diagnostics.js';
import {diagnoseProtocols} from '../server/protocol-diagnostics.js';
const profiles=[{id:'private-id',engine:'xray'}],endpoint={id:'private-id',port:28000,secret:'private-secret'};
const raw=sample=>({exitCode:0,http_connect:200,ssl_verify_result:0,time_appconnect:.1,response_code:200,size_download:sample.kind==='upload'?0:sample.bytes,size_upload:sample.kind==='upload'?sample.bytes:0,time_pretransfer:.2,time_starttransfer:.4,time_total:1.4});
test('speed rates exclude connection setup; unverified routes, bad TLS and redirects produce no metrics',()=>{
 const sample=speedSamples.find(row=>row.kind==='download'),row=speedSampleResult(raw(sample),sample);assert.equal(row.mbps,67.11);
 assert.equal(speedMetrics([row]).downloadMbps,null);row.pathObservation={state:'verified'};assert.equal(speedMetrics([row]).downloadMbps,67.11);
 assert.equal(speedSampleResult({...raw(sample),exitCode:60},sample).outcome,'failed');assert.equal(speedSampleResult({...raw(sample),response_code:302},sample).mbps,null);
 const partial=speedSampleResult({...raw(sample),exitCode:28,size_download:1048576},sample);assert.equal(partial.observation,'measured-with-time-limit');assert.equal(partial.mbps,8.39);
});
test('speed probes remain pinned, expose progress, cancel and invalidate configuration changes',async()=>{
 const ports=[],events=[];let next=45000,current=true;
 const options={id:'private-id',profiles,endpoint,allocatePort:async()=>next++,observe:async({localPort})=>{ports.push(localPort);return {finish:async()=>({state:'verified'})};},request:async(e,sample)=>{assert.equal(e,endpoint);return raw(sample);},onProgress:value=>events.push(value)};
 const report=await diagnoseSpeed(options);assert.equal(report.outcome,'ok',JSON.stringify(report));assert.equal(report.attempts.length,5);assert.equal(new Set(ports).size,5);assert.ok(events.some(row=>row.state==='running' && row.attempts.length===2));assert.ok(report.metrics.uploadMbps>0);assert.doesNotMatch(JSON.stringify(report),/private-secret/);
 const changed=await diagnoseSpeed({...options,isCurrent:()=>current,request:async(e,sample)=>{current=false;return raw(sample);}});assert.deepEqual(changed.metrics,{downloadMbps:null,uploadMbps:null,responseMs:null});assert.equal(changed.path.configChanged,true);
 const controller=new AbortController();await assert.rejects(diagnoseSpeed({...options,signal:controller.signal,request:async()=>{controller.abort();throw Object.assign(Error('cancelled'),{code:'ABORTED'});}}),{code:'ABORTED'});
});
test('TCP and UDP require a verified response; DNS negative responses still prove transport',async()=>{
 let transports;
 const request=async options=>{transports=options.transports;return {providers:[{name:'Catalog resolver'}],attempts:[{transport:'udp',state:'ok',rcode:3,pathObservation:{state:'verified'}}]};};
 const confirmed=await diagnoseProtocols({name:'example.com',provider:'catalog',tcpConfirmed:true,request});assert.deepEqual(transports,['udp']);assert.equal(confirmed.outcome,'ok');
 const unknown=await diagnoseProtocols({name:'example.com',provider:'catalog',request:async()=>({attempts:[{transport:'udp',state:'ok',rcode:0,pathObservation:{state:'unavailable'}}]})});assert.equal(unknown.protocols.udp.state,'unconfirmed');assert.equal(unknown.protocols.tcp.state,'unconfirmed');
 const changed=await diagnoseProtocols({name:'example.com',provider:'catalog',tcpConfirmed:true,request:async()=>({path:{configChanged:true},attempts:[]})});assert.equal(changed.protocols.tcp.state,'unconfirmed');
});
test('real authenticated CONNECT speed probes verify TLS, download bytes and POST upload using a private disposable payload',async t=>{
 const folder=mkdtempSync(join(tmpdir(),'fg-speed-'));t.after(()=>rmSync(folder,{recursive:true,force:true}));const key=join(folder,'key.pem'),cert=join(folder,'cert.pem');
 execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=speed.cloudflare.com','-addext','subjectAltName=DNS:speed.cloudflare.com'],{stdio:'ignore'});
 const sockets=new Set(),track=socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));};let uploaded=0,connects=0;const payloads=[];
 const origin=https.createServer({key:readFileSync(key),cert:readFileSync(cert)},(req,res)=>{if(req.url==='/__up'){assert.equal(req.method,'POST');req.on('data',chunk=>uploaded+=chunk.length);req.on('end',()=>res.end());return;}const bytes=Number(new URL(req.url,'https://fixture').searchParams.get('bytes'));res.writeHead(200,{'Content-Length':bytes,'Content-Type':'application/octet-stream'});res.end(Buffer.alloc(bytes));});origin.on('connection',track);origin.on('tlsClientError',()=>{});await new Promise(resolve=>origin.listen(0,'127.0.0.1',resolve));
 const proxy=http.createServer();proxy.on('connection',track);proxy.on('connect',(req,socket,head)=>{connects++;assert.equal(req.headers['proxy-authorization'],'Basic '+Buffer.from('fg-geo:fixture').toString('base64'));assert.equal(req.url,'speed.cloudflare.com:443');const upstream=net.connect(origin.address().port,'127.0.0.1',()=>{socket.write('HTTP/1.1 200 Connection established\r\n\r\n');if(head.length)upstream.write(head);socket.pipe(upstream);upstream.pipe(socket);});track(upstream);socket.on('error',()=>upstream.destroy());upstream.on('error',()=>socket.destroy());socket.once('close',()=>upstream.destroy());});await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{for(const socket of sockets)socket.destroy();await Promise.all([new Promise(resolve=>proxy.close(resolve)),new Promise(resolve=>origin.close(resolve))]);});
 const trusted=(cmd,args,options)=>{const position=args.indexOf('--data-binary');if(position>=0)payloads.push(args[position+1].slice(1));assert.doesNotMatch(args.join(' '),/fixture/);assert.ok(!args.includes('--location') && !args.includes('--insecure'));return spawn(cmd,[args[0],'--cacert',cert,...args.slice(1)],options);};
 const report=await diagnoseSpeed({id:'private-id',profiles,endpoint:{port:proxy.address().port,secret:'fixture'},request:(e,sample,options)=>requestSpeedSample(e,sample,{...options,spawnProcess:trusted}),observe:async()=>({finish:async()=>({state:'verified'})})});assert.equal(report.outcome,'ok',JSON.stringify(report));assert.equal(uploaded,2*1048576);assert.ok(payloads.every(path=>!existsSync(path)));assert.equal(connects,5);assert.ok(report.metrics.downloadMbps>0);assert.ok(report.metrics.uploadMbps>0);
 await assert.rejects(requestSpeedSample(endpoint,{id:'bad'},{localPort:45000}));
});
