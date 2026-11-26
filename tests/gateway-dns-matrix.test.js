import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import {diagnoseGatewayDns,compareDnsPaths,requestGatewayDns} from '../server/gateway-dns-matrix.js';
import {dnsMatrixProviders} from '../server/dns-matrix-catalog.js';
import {allocateDiagnosticTcpPort} from '../server/diagnostic-port.js';
import {exportDiagnosticReport} from '../shared/diagnostic-report.js';
const id='12345678-abcd',profiles=[{id,engine:'xray',enabled:true}],endpoint={id,port:28000,tag:'p-12345678',secret:'private-listener-secret'};

test('gateway DNS matrix uses only selected listener, preserves all attempts and uses authenticated UDP with explicit network evidence',async()=>{
 let requests=0,active=0,maximum=0;const observations=[];
 const report=await diagnoseGatewayDns({id,profiles,endpoint,name:'EXAMPLE.COM.',providers:['cloudflare'],allocatePort:async()=>45000,
 observe:async context=>{observations.push(context);return {finish:async raw=>{assert.equal(raw.local_port,45000);return {state:'verified',connectionId:'private-flow',chain:['p-12345678'],sourcePort:45000,inboundPort:28000};}};},
 request:async(request,{signal})=>{requests++;active++;maximum=Math.max(maximum,active);assert.equal(request.proxy.port,endpoint.port);assert.equal(request.proxy.secret,endpoint.secret);assert.equal(request.name,'example.com');await new Promise(resolve=>setTimeout(resolve,1));active--;return {state:'ok',localAddress:'127.0.0.1',localPort:45000,rcode:0,answers:[],rawBase64:'packet'};}});
 assert.equal(requests,16);assert.ok(maximum<=4);assert.equal(report.attempts.length,16);assert.equal(report.attempts.filter(row=>row.transport==='udp').length,4);assert.equal(report.state,'ok');assert.ok(observations.some(row=>row.network==='udp'));assert.ok(observations.some(row=>row.url.endsWith(':853/')));
 assert.equal(JSON.stringify(report).includes(endpoint.secret),false);assert.ok(report.attempts.every(row=>row.routeVerified===false));
 const exported=exportDiagnosticReport({profileId:id,path:{chain:[{id}]},gatewayDnsMatrix:report});assert.doesNotMatch(JSON.stringify(exported),/private-flow|127\.0\.0\.1|12345678|45000|28000/);assert.equal(exported.gatewayDnsMatrix.path.chain[0].id,'gateway-1');
});

test('path mismatch overrides valid DNS, missing endpoint fails closed and cancellation starts no probes',async()=>{
 const options={id,profiles,endpoint,name:'example.com',providers:['google'],allocatePort:async()=>45000,observe:async()=>({finish:async()=>({state:'mismatch'})}),request:async()=>({state:'ok',localAddress:'127.0.0.1',localPort:45000,rcode:0,answers:[]})};
 const report=await diagnoseGatewayDns(options);assert.ok(report.attempts.filter(row=>row.transport!=='udp').every(row=>row.state==='failed' && row.reason==='path-mismatch'));
 await assert.rejects(diagnoseGatewayDns({...options,endpoint:null}),/listener/);
 const controller=new AbortController();controller.abort();await assert.rejects(diagnoseGatewayDns({...options,signal:controller.signal,request:()=>assert.fail('must not run')}),{code:'ABORTED'});
});

test('path comparison requires identical domain, provider, type, transport and verified evidence',()=>{
 const row={provider:'google',qtype:'A',transport:'tcp',state:'ok',rcode:0,answers:[{name:'example.com',type:'A',value:'203.0.113.7',ttl:60}]};
 const direct={ok:true,name:'example.com',attempts:[1,2].map(repeat=>({...row,repeat,routeVerified:true}))};
 const gateway={ok:true,name:'example.com',providers:[{id:'google'}],attempts:[1,2].map(repeat=>({...row,repeat,pathObservation:{state:'verified'}}))};
 const tcp=()=>compareDnsPaths(direct,gateway).find(row=>row.qtype==='A' && row.transport==='tcp');
 assert.equal(tcp().state,'matched');gateway.attempts[0].answers=[{name:'example.com',type:'A',value:'203.0.113.8',ttl:60}];assert.equal(tcp().state,'different');assert.equal(tcp().cause,null);
 gateway.attempts[0].pathObservation.state='unavailable';assert.equal(tcp().state,'incomplete');gateway.name='other.example';assert.deepEqual(compareDnsPaths(direct,gateway),[]);
});

test('real Python DNS worker authenticates CONNECT and never falls back when it is rejected',async t=>{
 let connections=0,reject=true;
 const proxy=net.createServer(socket=>{
  connections++;let data=Buffer.alloc(0),connected=false;
  socket.on('data',chunk=>{
   data=Buffer.concat([data,chunk]);
   if(!connected){const end=data.indexOf('\r\n\r\n');if(end<0)return;
    const header=data.subarray(0,end).toString();assert.match(header,/CONNECT 8\.8\.8\.8:53/);assert.ok(header.includes(Buffer.from('fg-geo:'+endpoint.secret).toString('base64')));
    if(reject){socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');return;}
    connected=true;data=data.subarray(end+4);socket.write('HTTP/1.1 200 Connection established\r\n\r\n');
   }
   if(data.length<2 || data.length<data.readUInt16BE(0)+2)return;
   const length=data.readUInt16BE(0),answer=Buffer.from(data.subarray(2,length+2));answer.writeUInt16BE(0x8183,2);
   const prefix=Buffer.alloc(2);prefix.writeUInt16BE(answer.length);socket.write(Buffer.concat([prefix,answer]));data=Buffer.alloc(0);
  });
  socket.on('error',()=>{});
 });
 await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>proxy.close(resolve)));
 const request={provider:dnsMatrixProviders(['google'])[0],transport:'tcp',name:'example.com',qtype:1,repeat:1,proxy:{port:proxy.address().port,secret:endpoint.secret,localPort:await allocateDiagnosticTcpPort()}};
 const denied=await requestGatewayDns(request);assert.equal(denied.state,'failed');assert.equal(denied.routeVerified,false);assert.equal(connections,1);assert.doesNotMatch(JSON.stringify(denied),/private-listener-secret/);
 reject=false;request.proxy.localPort=await allocateDiagnosticTcpPort();const accepted=await requestGatewayDns(request);assert.equal(accepted.state,'ok');assert.equal(accepted.rcode,3);assert.equal(accepted.routeVerified,false);assert.equal(accepted.localPort,request.proxy.localPort);assert.equal(connections,2);
});

test('cancelling an active Python gateway worker closes its CONNECT socket',async t=>{
 let connected,closed;const ready=new Promise(resolve=>connected=resolve),ended=new Promise(resolve=>closed=resolve);
 const proxy=net.createServer(socket=>{socket.on('data',()=>connected());socket.on('end',()=>socket.end());socket.on('close',closed);socket.on('error',()=>{});});
 await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>proxy.close(resolve)));
 const controller=new AbortController();
 const pending=requestGatewayDns({provider:dnsMatrixProviders(['google'])[0],transport:'tcp',name:'example.com',qtype:1,repeat:1,proxy:{port:proxy.address().port,secret:endpoint.secret,localPort:await allocateDiagnosticTcpPort()}},{signal:controller.signal});
 const rejected=assert.rejects(pending,{code:'ABORTED'});await ready;controller.abort();await rejected;await ended;
});

test('real UDP worker authenticates SOCKS, validates relay and source, and rejects fragments without fallback',async t=>{
 const {default:dgram}=await import('node:dgram');
 let reject=false,nonloop=false,fragment=false,wrongTarget=false,wrongId=false,datagrams=0;
 const udp=dgram.createSocket('udp4');await new Promise(resolve=>udp.bind(0,'127.0.0.1',resolve));
 t.after(()=>new Promise(resolve=>udp.close(resolve)));
 udp.on('message',(message,peer)=>{
  datagrams++;assert.equal(message.subarray(0,10).toString('hex'),'00000001080808080035');
  const answer=Buffer.from(message);answer.writeUInt16BE(0x8180,12);
  if(fragment)answer[2]=1;if(wrongTarget)answer[4]=1;if(wrongId)answer[10]^=1;
  udp.send(answer,peer.port,peer.address);
 });
 const socks=net.createServer(socket=>{
  let buffer=Buffer.alloc(0),stage=0;
  socket.on('error',()=>{});
  socket.on('data',chunk=>{
   buffer=Buffer.concat([buffer,chunk]);
   while(true){
    if(stage===0){if(buffer.length<3)return;assert.equal(buffer.subarray(0,3).toString('hex'),'050102');buffer=buffer.subarray(3);socket.write(Buffer.from([5,2]));stage=1;}
    if(stage===1){if(buffer.length<2)return;const userLength=buffer[1];if(buffer.length<3+userLength)return;const passwordLength=buffer[2+userLength];if(buffer.length<3+userLength+passwordLength)return;
     assert.equal(buffer.subarray(2,2+userLength).toString(),'fg-geo');assert.equal(buffer.subarray(3+userLength,3+userLength+passwordLength).toString(),endpoint.secret);
     buffer=buffer.subarray(3+userLength+passwordLength);socket.write(Buffer.from([1,0]));stage=2;
    }
    if(stage===2){if(buffer.length<10)return;assert.equal(buffer.subarray(0,10).toString('hex'),'05030001000000000000');buffer=buffer.subarray(10);
     const reply=Buffer.from([5,reject?7:0,0,1,...(nonloop?[203,0,113,1]:[127,0,0,1]),0,0]);reply.writeUInt16BE(udp.address().port,8);socket.write(reply);stage=3;
    }
    return;
   }
  });
 });
 await new Promise(resolve=>socks.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>socks.close(resolve)));
 const request={provider:dnsMatrixProviders(['google'])[0],transport:'udp',name:'example.com',qtype:1,repeat:1,proxy:{port:socks.address().port,secret:endpoint.secret,localPort:0}};
 const run=async()=>{const allocation=dgram.createSocket('udp4');await new Promise(resolve=>allocation.bind(0,'127.0.0.1',resolve));request.proxy.localPort=allocation.address().port;await new Promise(resolve=>allocation.close(resolve));return requestGatewayDns(request);};
 const good=await run();assert.equal(good.state,'ok');assert.equal(good.rcode,0);assert.equal(good.localAddress,'127.0.0.1');assert.equal(good.localPort,request.proxy.localPort);assert.equal(good.routeVerified,false);assert.equal(datagrams,1);
 reject=true;const denied=await run();assert.equal(denied.state,'unavailable');assert.equal(denied.reason,'gateway-udp-unavailable');assert.equal(datagrams,1);reject=false;
 nonloop=true;assert.equal((await run()).reason,'gateway-udp-unavailable');assert.equal(datagrams,1);nonloop=false;
 fragment=true;assert.equal((await run()).reason,'invalid-response');fragment=false;
 wrongTarget=true;assert.equal((await run()).reason,'invalid-response');wrongTarget=false;
 wrongId=true;assert.equal((await run()).reason,'invalid-response');
});

test('changing a chain cancels active workers, skips queued probes and invalidates earlier evidence',async()=>{
 const outer='87654321-abcd',chain=[{...profiles[0],gatewayId:outer},{id:outer,engine:'outline',enabled:true}];
 let current=true,started=0,aborted=0,finishedObservers=0;
 const anchor=setTimeout(()=>{},1000);
 try{
  const report=await diagnoseGatewayDns({id,profiles:chain,endpoint,name:'example.com',providers:['google'],isCurrent:()=>current,allocatePort:async()=>45000,
   observe:async()=>({finish:async()=>{finishedObservers++;return {state:'verified'};}}),
   request:(_request,{signal})=>{started++;return new Promise((resolve,reject)=>{signal.addEventListener('abort',()=>{aborted++;reject(Object.assign(Error('cancelled'),{code:'ABORTED'}));},{once:true});setTimeout(()=>current=false,5);});}});
  assert.equal(report.mode,'chain');assert.deepEqual(report.path.chain.map(row=>row.id),[id,outer]);assert.equal(report.path.configChanged,true);
  assert.equal(started,4);assert.equal(aborted,4);assert.equal(finishedObservers,4);assert.equal(report.state,'unavailable');assert.equal(report.attempts.length,16);
  assert.ok(report.comparisons.every(row=>row.state==='incomplete' && row.validResponses===0));assert.ok(report.attempts.every(row=>row.pathObservation.state==='unavailable'));
 }finally{clearTimeout(anchor);}
});

test('budget exhaustion preserves skipped attempts and a disabled outer gateway starts no probe',async()=>{
 let time=0;
 const report=await diagnoseGatewayDns({id,profiles,endpoint,name:'example.com',providers:['google'],now:()=>{const value=time;time=40000;return value;},request:()=>assert.fail('must not run')});
 assert.equal(report.attempts.length,16);assert.ok(report.attempts.every(row=>row.reason==='budget-exhausted'));assert.equal(report.state,'unavailable');
 const outer='87654321-abcd';await assert.rejects(diagnoseGatewayDns({id,profiles:[{...profiles[0],gatewayId:outer},{id:outer,engine:'xray',enabled:false}],endpoint,name:'example.com',providers:['google'],request:()=>assert.fail('must not run')}),/unavailable/);
});

test('supervisor invalidates a changed outer profile even when the listener object is unchanged',async()=>{
 const {MihomoSupervisor}=await import('../server/mihomo.js');
 const outer='87654321-abcd',fake={state:'running',locationEndpoints:new Map([[id,endpoint]]),_routes:{profiles:[{...profiles[0],gatewayId:outer},{id:outer,engine:'xray',enabled:true}],configs:[]},controller:async()=>({connections:null})};
 let cancelled=0,started=0;
 const report=await MihomoSupervisor.prototype.diagnoseGatewayDns.call(fake,id,{name:'example.com',providers:['google'],allocatePort:async()=>45000,
  request:(_request,{signal})=>{started++;fake._routes.profiles[1].enabled=false;return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>{cancelled++;reject(Object.assign(Error('cancelled'),{code:'ABORTED'}));},{once:true}));}});
 assert.equal(fake.locationEndpoints.get(id),endpoint);assert.equal(report.path.configChanged,true);assert.equal(report.state,'unavailable');assert.ok(started>=1 && started<=4);assert.equal(cancelled,started);assert.ok(report.comparisons.every(row=>row.state==='incomplete'));
});
