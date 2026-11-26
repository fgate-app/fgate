import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {diagnosticPath,diagnosticAttempt,diagnoseGateway,requestDiagnostic} from '../server/gateway-diagnostics.js';

const profiles=[{id:'inner',engine:'outline',gatewayId:'outer'},{id:'outer',engine:'xray'},{id:'direct',engine:'direct'}];
test('diagnostic path preserves nested chain and fails closed on disabled, missing or cyclic routes',()=>{
  assert.deepEqual(diagnosticPath(profiles,'inner').chain.map(p=>p.id),['inner','outer']);
  assert.equal(diagnosticPath(profiles,'inner').routeVerified,false);
  assert.equal(diagnosticPath(profiles,'direct').mode,'direct');
  for(const rows of [profiles.map(p=>p.id==='outer'?{...p,enabled:false}:p),profiles.filter(p=>p.id!=='outer'),profiles.map(p=>p.id==='outer'?{...p,gatewayId:'inner'}:p)])assert.throws(()=>diagnosticPath(rows,'inner'));
});
test('reports distinguish certificate errors, timeout after TLS and HTTP failure without claiming tunnel handshake evidence',()=>{
  const cert=diagnosticAttempt({exitCode:60,http_connect:200,time_total:0.2},'https://test','now');
  assert.equal(cert.observation,'certificate-error');assert.equal(cert.stages.find(s=>s.id==='tunnel-protocol').state,'unavailable');
  const timeout=diagnosticAttempt({exitCode:28,http_connect:200,time_appconnect:0.1,time_total:8},'https://test','now');
  assert.equal(timeout.stages.find(s=>s.id==='tls').state,'ok');assert.equal(timeout.stages.find(s=>s.id==='http').state,'failed');
  assert.equal(diagnosticAttempt({exitCode:0,http_connect:200,response_code:503},'test','now').outcome,'failed');
});
test('every attempt stays on selected listener and reports cannot disclose credentials or raw transport fields',async()=>{
  const endpoint={port:28000,secret:'private-credential'},seen=[];
  const report=await diagnoseGateway({profiles,id:'inner',endpoint,request:async current=>{seen.push(current);return {exitCode:0,http_connect:200,time_appconnect:0.1,response_code:204,size_download:0,url:'private-credential',proxy_user:'secret'};}});
  assert.equal(seen.length,3);assert.ok(seen.every(row=>row===endpoint));assert.equal(report.outcome,'ok');
  assert.equal(JSON.stringify(report).includes('private-credential'),false);assert.equal(report.diagnosis.cause,null);
  let calls=0;
  const failed=await diagnoseGateway({profiles,id:'inner',endpoint,request:async current=>{calls++;assert.equal(current,endpoint);throw Error('private-credential');}});
  assert.equal(calls,3);assert.equal(failed.outcome,'unavailable');assert.equal(JSON.stringify(failed).includes('private-credential'),false);
  const controller=new AbortController();controller.abort();
  await assert.rejects(diagnoseGateway({profiles,id:'inner',endpoint,signal:controller.signal}),{code:'ABORTED'});
});
test('real curl uses authenticated CONNECT and never bypasses a rejecting local proxy',async()=>{
  let connects=0,credential;
  const proxy=http.createServer();
  proxy.on('connect',(req,socket)=>{connects++;credential=req.headers['proxy-authorization'];socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');});
  await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));
  try{
    const result=await requestDiagnostic({port:proxy.address().port,secret:'fixture'},'https://www.gstatic.com/generate_204');
    assert.equal(result.http_connect,403);assert.notEqual(result.exitCode,0);assert.equal(connects,1);
    assert.equal(credential,'Basic '+Buffer.from('fg-geo:fixture').toString('base64'));
    const custom=await requestDiagnostic({port:proxy.address().port,secret:'fixture'},'https://example.com/');assert.equal(custom.http_connect,403);assert.equal(connects,2);
    await assert.rejects(requestDiagnostic({},'https://localhost/'));
  }finally{await new Promise(resolve=>proxy.close(resolve));}
});

test('diagnostic API requires auth and CSRF, limits concurrency, and releases slot on failure',async()=>{
  const {Store}=await import('../server/store.js'),{createServer}=await import('../server/index.js');
  const store=new Store(':memory:');let finish,fail=false,dnsCalls=0,sniCalls=0,transferCalls=0;
  const server=createServer(store,{supervisor:{diagnoseGateway:async()=>{if(fail)throw Error('secret');return new Promise(resolve=>finish=resolve);},diagnoseTransfer:async(id,{signal})=>{assert.ok(signal);transferCalls++;return {ok:true,outcome:'partial'};}},diagnosticDns:async(request,{signal})=>{dnsCalls++;assert.deepEqual(request,{name:'example.com',providers:['quad9','google']});assert.ok(signal);return {ok:true,mode:'direct'};},diagnosticSni:async(request,{signal})=>{sniCalls++;assert.deepEqual(request,{name:'example.com',fakeIpRanges:[]});assert.ok(signal);return {ok:false,state:'unavailable'};}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+server.address().port;
  const request=async(path,body={},session)=>{
    const response=await fetch(base+'/api/'+path,{method:'POST',headers:{'Content-Type':'application/json',...(session?{Cookie:session.cookie,'X-CSRF-Token':session.csrf}:{})},body:JSON.stringify(body)});
    return {status:response.status,data:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]};
  };
  try{
    const id=store.importProfile({name:'Proxy fixture',value:'vless://00000000-0000-4000-8000-000000000001@203.0.113.7:443?security=none#Fixture'}).id,path=`profiles/${id}/diagnostics`;
    assert.equal((await request(path)).status,401);
    const auth=await request('auth/setup',{username:'admin',password:'fixture password 12345'}),session={cookie:auth.cookie,csrf:auth.data.csrf};
    assert.equal((await request(path,{}, {...session,csrf:'bad'})).status,403);
    assert.equal((await request(path,{dns:true,dnsName:'bad\r\nHost: injected'},session)).status,400);
    assert.equal((await request(path,{dns:true,dnsProviders:['not-in-catalog']},session)).status,400);assert.equal(dnsCalls,0);
    assert.equal((await request(path,{sni:true,sniName:'bad\r\nHost: injected'},session)).status,400);assert.equal(sniCalls,0);
    const pending=request(path,{transfer:true,sni:true,sniName:'EXAMPLE.COM.',dns:true,dnsName:'ExAmPle.CoM.',dnsProviders:['quad9','google']},session);
    while(!finish)await new Promise(resolve=>setImmediate(resolve));
    assert.equal((await request(path,{},session)).status,409);
    finish({version:1,outcome:'ok'});const completed=await pending;assert.equal(completed.status,200);assert.equal(completed.data.dnsMatrix.mode,'direct');assert.equal(dnsCalls,1);assert.equal(sniCalls,1);assert.equal(completed.data.sniControl.state,'unavailable');assert.equal(transferCalls,1);assert.equal(completed.data.transfer.outcome,'partial');assert.equal(completed.data.schemaVersion,2);assert.ok(Date.parse(completed.data.finishedAt)>=Date.parse(completed.data.startedAt));assert.equal(completed.data.measurement.parameters.sni.name,'example.com');assert.equal(completed.data.measurement.checks.transfer,true);
    fail=true;const failed=await request(path,{},session);assert.equal(failed.status,503);assert.equal(JSON.stringify(failed).includes('secret'),false);
    assert.equal((await request('profiles/missing/diagnostics',{},session)).status,404);
    assert.equal((await request(path,{},session)).status,503);
    await request('users',{username:'viewer',password:'fixture password 12345',role:'viewer'},session);
    const login=await request('auth/login',{username:'viewer',password:'fixture password 12345'});
    assert.equal((await request(path,{}, {cookie:login.cookie,csrf:login.data.csrf})).status,403);
  }finally{await new Promise(resolve=>server.close(resolve));store.close();}
});

test('export removes local addresses and stored profile identities without changing the live report',async()=>{
  const {exportDiagnosticReport}=await import('../shared/diagnostic-report.js');
  const input={profileId:'private-id',path:{chain:[{id:'private-id',engine:'outline'},{id:'outer-id',engine:'xray'}]},uplinkControl:{attempts:[{localAddress:'192.168.1.86',peerAddress:'1.1.1.1',route:{dev:'eth0',prefsrc:'192.168.1.86',gateway:'192.168.1.1'}}]}};
  input.attempts=[{pathObservation:{connectionId:'private-flow',sourcePort:45000,inboundPort:28000,chain:['p-private-','p-outer-id-grp','p-11111111','DIRECT']}}];
  input.path.externalConnection={sockets:[{localAddress:'192.168.1.86',localPort:45000,peerAddress:'203.0.113.7',route:{dev:'eth0',gateway:'192.168.1.1'}}]};
  const report=exportDiagnosticReport(input),encoded=JSON.stringify(report);
  assert.deepEqual(report.attempts[0].pathObservation.chain,['gateway-1','gateway-2','other-gateway','DIRECT']);
  assert.equal(encoded.includes('private-flow'),false);assert.equal(encoded.includes('45000'),false);
  assert.equal(report.path.chain[0].id,report.profileId);assert.equal(report.path.chain[1].id,'gateway-2');
  assert.equal(encoded.includes('192.168.'),false);assert.equal(encoded.includes('private-id'),false);
  assert.equal(report.uplinkControl.attempts[0].peerAddress,'1.1.1.1');assert.equal(input.profileId,'private-id');
});

test('an observed different outbound overrides an otherwise successful HTTPS probe',async()=>{
 const report=await diagnoseGateway({profiles,id:'inner',endpoint:{id:'inner',port:28000},
  request:async(endpoint,url,{localPort})=>({exitCode:0,http_connect:200,response_code:204,local_port:localPort,local_ip:'127.0.0.1'}),
  observe:async()=>({finish:async()=>({state:'mismatch',chain:['DIRECT']})})});
 assert.equal(report.outcome,'failed');assert.equal(report.path.engineVerified,false);
 assert.ok(report.attempts.every(attempt=>attempt.observation==='path-mismatch'));
});
