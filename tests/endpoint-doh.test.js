import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {diagnoseEndpoint} from '../server/endpoint-diagnostics.js';
import {endpointDohResolution} from '../server/endpoint-doh.js';
import {dnsMatrixProviders} from '../server/dns-matrix-catalog.js';
import {exportDiagnosticReport} from '../shared/diagnostic-report.js';
const provider=dnsMatrixProviders()[0],peer={host:'proxy.example',port:44127};
const dns=(patch={})=>({ok:true,name:peer.host,mode:'endpoint-doh',limits:{attempts:2,budgetSeconds:7},attempts:['A','AAAA'].map(qtype=>({provider:provider.id,transport:'doh',qtype,repeat:1,address:provider.endpoints.doh.address,port:443,state:'ok',rcode:0,routeVerified:true,localAddress:'192.168.1.86',localPort:45000,route:{gateway:'192.168.1.1'},answers:[{name:peer.host,type:'CNAME',value:'cdn.example'},{name:'cdn.example',type:qtype,value:qtype==='A'?'203.0.113.7':'2001:db8::7'},{name:'unrelated.example',type:qtype,value:qtype==='A'?'203.0.113.9':'2001:db8::9'}],...patch}))});
const success={state:'ok',complete:true,results:[]};
const options={dnsSource:'doh',dohProvider:provider.id,resolve:()=>{throw Error('No implicit system DNS');},resolveDoh:async()=>dns()};

test('DoH endpoint resolution uses catalog provenance, validated CNAME A/AAAA and only the configured TCP port',async()=>{
 let selected;
 const report=await diagnoseEndpoint(peer,{...options,resolveDoh:async(request,{signal})=>{assert.deepEqual(request,{name:peer.host,provider:provider.id});assert.ok(signal);return dns();},probe:async value=>{selected=value;return success;}});
 assert.deepEqual(selected,{addresses:['203.0.113.7','2001:db8::7'],port:44127});assert.equal(report.complete,true);assert.equal(report.bootstrap.method,'doh');assert.equal(report.bootstrap.pathVerified,true);assert.equal(report.bootstrap.addressSources.length,2);assert.deepEqual(report.bootstrap.addressSources.map(row=>row.qtype),['A','AAAA']);assert.equal(report.bootstrap.resolverAddress,provider.endpoints.doh.address);
 const exported=exportDiagnosticReport({endpointControl:report});assert.doesNotMatch(JSON.stringify(exported),/192\.168\.1\.(86|1)|45000|localAddress|localPort/);assert.equal(exported.endpointControl.bootstrap.addressSources[0].provider,provider.id);
});

test('an incomplete DoH family preserves its original error and cannot make a complete TCP result',async()=>{
 const value=dns();value.attempts[1]={...value.attempts[1],state:'failed',reason:'timeout',failedStage:'tls',answers:[]};
 const result=await diagnoseEndpoint(peer,{...options,resolveDoh:async()=>value,probe:async({addresses})=>{assert.deepEqual(addresses,['203.0.113.7']);return success;}});
 assert.equal(result.complete,false);assert.equal(result.bootstrap.state,'partial');assert.equal(result.bootstrap.reason,'timeout');assert.equal(result.bootstrap.attempts[1].failedStage,'tls');
 for(const patch of [{rcode:3,answers:[]},{state:'failed',reason:'certificate-error',failedStage:'tls'},{state:'failed',reason:'timeout'},{state:'failed',reason:'invalid-response',httpStatus:503}, {truncated:true}]){
  let called=false;const result=await diagnoseEndpoint(peer,{...options,resolveDoh:async()=>dns(patch),probe:()=>{called=true;}});assert.equal(called,false);assert.equal(result.state,'unavailable');assert.equal(result.complete,false);assert.equal(result.bootstrap.attempts[0].rcode,patch.rcode ?? 0);assert.equal(result.bootstrap.attempts[0].httpStatus,patch.httpStatus ?? null);
 }
});

test('unverified, mismatched, non-DoH and old full-matrix responses cannot supply endpoint targets',()=>{
 for(const patch of [{routeVerified:false},{transport:'udp'},{provider:'not-selected'},{address:'127.0.0.1'},{port:53}])assert.deepEqual(endpointDohResolution(peer.host,provider.id,dns(patch)).addresses,[]);
 const old=dns();old.mode='direct';assert.deepEqual(endpointDohResolution(peer.host,provider.id,old).addresses,[]);
 const wrongName=dns();wrongName.name='other.example';assert.deepEqual(endpointDohResolution(peer.host,provider.id,wrongName).addresses,[]);
 const duplicate=dns();duplicate.attempts.push(duplicate.attempts[0]);assert.deepEqual(endpointDohResolution(peer.host,provider.id,duplicate).addresses,['2001:db8::7']);
});

test('fake-IP answers are excluded and bounded address selections remain incomplete',async()=>{
 const mixed=dns();mixed.attempts[0].answers=[{name:peer.host,type:'A',value:'198.18.0.1'},{name:peer.host,type:'A',value:'203.0.113.7'}];mixed.attempts[1].answers=[];
 const result=await diagnoseEndpoint(peer,{...options,fakeIpRanges:['198.18.0.0/15'],resolveDoh:async()=>mixed,probe:async({addresses})=>{assert.deepEqual(addresses,['203.0.113.7']);return success;}});assert.equal(result.complete,false);assert.equal(result.bootstrap.state,'partial');assert.equal(result.excludedAddresses[0].reason,'synthetic-dns-address');
 const many=dns();many.attempts[0].answers=Array.from({length:10},(_,i)=>({name:peer.host,type:'A',value:`203.0.113.${i+1}`}));many.attempts[1].answers=[];
 const limited=await diagnoseEndpoint(peer,{...options,resolveDoh:async()=>many,probe:async({addresses})=>{assert.equal(addresses.length,8);return success;}});assert.equal(limited.complete,false);assert.equal(limited.truncated,true);
});

test('DoH timeout and cancellation abort its helper and never start TCP or system fallback',async()=>{
 let helperAborted=false,probed=false;
 const resolveDoh=async(request,{signal})=>new Promise((resolve,reject)=>{signal.addEventListener('abort',()=>{helperAborted=true;reject(Object.assign(Error('cancelled'),{code:'ABORTED'}));},{once:true});});
 const result=await diagnoseEndpoint(peer,{...options,resolveDoh,dohTimeout:5,probe:()=>{probed=true;}});assert.equal(helperAborted,true);assert.equal(probed,false);assert.equal(result.bootstrap.reason,'timeout');assert.equal(result.bootstrap.method,'doh');
 helperAborted=false;const controller=new AbortController();const pending=diagnoseEndpoint(peer,{...options,resolveDoh,signal:controller.signal,probe:()=>{probed=true;}});await new Promise(resolve=>setImmediate(resolve));controller.abort();await assert.rejects(pending,{code:'ABORTED'});assert.equal(helperAborted,true);assert.equal(probed,false);
 const failed=await diagnoseEndpoint(peer,{...options,resolveDoh:async()=>{throw Error('private-credential');}});assert.doesNotMatch(JSON.stringify(failed),/private-credential/);assert.equal(failed.bootstrap.reason,'dns-error');
});

test('literal endpoint IP skips the requested DoH source entirely',async()=>{
 const report=await diagnoseEndpoint({host:'203.0.113.7',port:443},{...options,resolveDoh:()=>{throw Error('must not run');},probe:async()=>success});assert.equal(report.bootstrap.method,'literal-address');assert.equal(report.complete,true);
});

test('existing DNS worker endpoint mode performs only two bounded DoH queries and no DNS matrix',()=>{
 const result=spawnSync('python3',['-c',String.raw`
import importlib.util
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('dns','server/dns-matrix.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
calls=[]
def probe(*args):calls.append(args);return {'state':'ok'}
with patch.object(m,'attempt',side_effect=probe):
 result=m.endpoint_resolution('eth0','proxy.example',[{'id':'fixture'}])
 assert len(calls)==2 and all(call[2]=='doh' for call in calls)
 assert sorted(call[4] for call in calls)==[1,28] and all(call[3]=='proxy.example' and call[5]==1 for call in calls)
 assert result['limits']['attempts']==2 and result['limits']['budgetSeconds']==7 and result['mode']=='endpoint-doh'
 try:m.endpoint_resolution('eth0','proxy.example',[{'id':'first'},{'id':'second'}]);raise AssertionError('Multiple providers accepted')
 except ValueError:pass
`],{encoding:'utf8',timeout:5000});assert.equal(result.status,0,result.stderr);
});

test('endpoint API validates explicit source/provider, preserves fixed peer/port and records the normalized choice',async()=>{
 const {Store}=await import('../server/store.js'),{createServer}=await import('../server/index.js');
 const store=new Store(':memory:'),profile=store.importProfile({name:'Fixture',value:'socks5://fixture-user:fixture-secret@proxy.example:44127'});let dnsCalls=0,probes=0;
 const server=createServer(store,{supervisor:{diagnoseGateway:async()=>({path:{chain:[]},attempts:[]})},diagnosticEndpointDns:async(request,{signal})=>{dnsCalls++;assert.deepEqual(request,{name:peer.host,provider:provider.id});assert.ok(signal);return dns();},diagnosticEndpoint:async value=>{probes++;assert.deepEqual(value,{addresses:['203.0.113.7','2001:db8::7'],port:44127});return success;}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}/api/`;
 try{
  const setup=await fetch(base+'auth/setup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'admin',password:'fixture password 12345'})}),{csrf}=await setup.json(),cookie=setup.headers.get('set-cookie').split(';')[0];
  const request=body=>fetch(base+`profiles/${profile.id}/diagnostics`,{method:'POST',headers:{'Content-Type':'application/json',Cookie:cookie,'X-CSRF-Token':csrf},body:JSON.stringify(body)});
  assert.equal((await request({endpoint:true,endpointDnsSource:'other'})).status,400);assert.equal((await request({endpoint:true,endpointDnsProvider:'other'})).status,400);assert.equal(dnsCalls,0);assert.equal(probes,0);
  const response=await request({endpoint:true,endpointDnsProvider:provider.id});assert.equal(response.status,200);const value=await response.json();assert.equal(value.endpointControl.bootstrap.method,'doh');assert.equal(value.endpointControl.complete,true);assert.deepEqual(value.measurement.parameters.endpoint,{source:'doh',provider:provider.id});assert.equal(dnsCalls,1);assert.equal(probes,1);assert.doesNotMatch(JSON.stringify(value),/fixture-user|fixture-secret/);
 }finally{await new Promise(resolve=>server.close(resolve));store.close();}
});
