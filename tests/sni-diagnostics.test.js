import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {selectSniAddress,sniTargets,summarizeSni,diagnoseGatewaySni} from '../server/sni-diagnostics.js';
import {exportDiagnosticReport} from '../shared/diagnostic-report.js';
const id='12345678-abcd',profiles=[{id,engine:'xray',enabled:true}],endpoint={id,port:28000,secret:'private-secret'};

test('SNI pairs preserve verified baselines and never infer DPI from a foreign TLS alert',async()=>{
 const calls=[];
 const report=await diagnoseGatewaySni({id,profiles,endpoint,name:'EXAMPLE.COM.',allocatePort:async()=>45000,
 observe:async()=>({finish:async()=>({state:'verified',connectionId:'private-flow',chain:['p-12345678'],sourcePort:45000,inboundPort:28000})}),
 request:async request=>{if(request.transport)return {state:'failed'};calls.push(request);return {state:request.experimental?'failed':'ok',localAddress:'127.0.0.1',localPort:45000,observation:request.experimental?'tls-alert':'http-response',httpStatus:request.experimental?undefined:200};}});
 assert.equal(calls.length,6);assert.ok(calls.every(row=>row.proxy.port===endpoint.port && row.proxy.secret===endpoint.secret));assert.equal(report.attempts.filter(row=>row.experimental).length,4);assert.ok(report.comparisons.every(row=>row.state==='observed' && row.cause===null));assert.equal(report.diagnosis.cause,null);
 const exported=exportDiagnosticReport({profileId:id,path:{chain:[{id}]},gatewaySniControl:report});assert.doesNotMatch(JSON.stringify(exported),/private-flow|private-secret|127\.0\.0\.1|12345678|45000|28000/);
 report.attempts[0].certificateVerification=false;summarizeSni(report);assert.equal(report.comparisons[0].state,'uninformative');
});

test('failed or unobserved baselines make SNI experiments uninformative',()=>{
 const target=sniTargets()[0],base={...target,certificateVerification:true,experimental:false,state:'ok',routeVerified:true};
 const report={ok:true,name:'example.com',attempts:[{...base,kind:'baseline-before'},{...base,kind:'baseline-after'},{...base,kind:'foreign-sni',experimental:true,certificateVerification:false}]};
 assert.equal(summarizeSni(report).comparisons[0].state,'observed');report.attempts[1].state='failed';assert.equal(summarizeSni(report).comparisons[0].state,'uninformative');
 report.attempts[1].state='ok';report.attempts[1].routeVerified=false;assert.equal(summarizeSni(report).comparisons[0].state,'uninformative');
});

test('configuration changes stop further SNI requests and invalidate the pair',async()=>{
 let current=true;
 const report=await diagnoseGatewaySni({id,profiles,endpoint,name:'example.com',isCurrent:()=>current,allocatePort:async()=>45000,request:async()=>{current=false;return {state:'ok'};}});
 assert.equal(report.path.configChanged,true);assert.ok(report.comparisons.every(row=>row.state==='uninformative'));assert.ok(report.attempts.every(row=>row.pathObservation?.state==='unavailable'));
 const controller=new AbortController();controller.abort();await assert.rejects(diagnoseGatewaySni({id,profiles,endpoint,name:'example.com',signal:controller.signal}),{code:'ABORTED'});
});

test('Python SNI worker fixes destination, verifies controls, bounds HTTP and distinguishes refusals',()=>{
 const result=spawnSync('python3',['-c',String.raw`
import importlib.util,socket,ssl,time
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('sni','server/sni-probe.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class Sock:
 def __init__(self):self.closed=False;self.header=b'HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n';self.sent=b''
 def settimeout(self,value):pass
 def getsockname(self):return ('127.0.0.1',45000)
 def sendall(self,data):self.sent=data
 def recv(self,n):data=self.header[:n];self.header=self.header[n:];return data
 def version(self):return 'TLSv1.3'
 def close(self):self.closed=True
s=Sock();target={'provider':'fixture','address':'1.1.1.1','servername':'cloudflare-dns.com'};proxy={'port':28000,'secret':'private-secret','localPort':45000}
with patch.object(m.transport,'proxy_socket',return_value=s) as connector,patch.object(m.ssl,'create_default_context') as context,patch.object(m.time,'sleep'):
 context.return_value.wrap_socket.return_value=s
 r=m.attempt(None,target,'example.com',True,proxy);assert r['state']=='ok' and r['observation']=='http-rejection' and r['httpStatus']==403 and not r['certificateVerification'],r
 assert context.return_value.check_hostname is False and context.return_value.verify_mode==ssl.CERT_NONE
 assert s.sent==b'HEAD / HTTP/1.1\r\nHost: example.com\r\nConnection: close\r\n\r\n';connector.assert_called_once();assert connector.call_args.args[1:3]==('1.1.1.1',443)
 assert 'private-secret' not in str(r) and s.closed
 context.reset_mock();context.return_value=__import__('unittest.mock',fromlist=['MagicMock']).MagicMock();context.return_value.wrap_socket.return_value=s;context.return_value.wrap_socket.side_effect=ssl.SSLCertVerificationError('invalid cert')
 r=m.attempt(None,target,target['servername'],False,proxy);assert r['observation']=='certificate-error' and r['failedStage']=='tls' and r['certificateVerification'],r
 assert context.return_value.check_hostname is not False and context.return_value.verify_mode != ssl.CERT_NONE
 for error,observation in [(ConnectionResetError('reset'),'connection-reset'),(TimeoutError('timeout'),'timeout'),(ssl.SSLEOFError('EOF'),'unexpected-eof')]:
  context.return_value.wrap_socket.side_effect=error;r=m.attempt(None,target,'example.com',True,proxy);assert r['observation']==observation,r
 alert=ssl.SSLError('alert');alert.reason='TLSV1_ALERT_UNRECOGNIZED_NAME';context.return_value.wrap_socket.side_effect=alert
 r=m.attempt(None,target,'example.com',True,proxy);assert r['observation']=='tls-alert',r
 context.return_value.wrap_socket.side_effect=None;s.header=b'x'*9000
 r=m.attempt(None,target,'example.com',True,proxy);assert r['observation']=='invalid-response' and r['failedStage']=='http',r
`],{encoding:'utf8',timeout:5000});assert.equal(result.status,0,result.stderr);
});

test('foreign SNI is not sent after a failed initial control, while the final control is retained',async()=>{
 let calls=0;
 const report=await diagnoseGatewaySni({id,profiles,endpoint,name:'example.com',allocatePort:async()=>45000,request:async request=>{if(request.transport)return {state:'failed'};calls++;assert.equal(request.experimental,false);return {state:'failed',observation:'timeout'};}});
 assert.equal(calls,4);assert.equal(report.attempts.length,10);assert.equal(report.attempts.filter(row=>row.kind==='foreign-sni' && row.observation==='baseline-unavailable').length,2);assert.ok(report.comparisons.every(row=>row.state==='uninformative'));
});

test('cross SNI pins one verified public DoH answer per provider and exports its source',async()=>{
 const calls=[];
 const report=await diagnoseGatewaySni({id,profiles,endpoint,name:'example.com',allocatePort:async()=>45000,
 observe:async()=>({finish:async()=>({state:'verified'})}),
 request:async (request,options)=>{calls.push({request,options});return request.transport?{state:'ok',rcode:0,answers:[{type:'A',value:'192.168.1.1'},{type:'A',value:'93.184.215.14'},{type:'A',value:'8.8.8.8'}]}:{state:'ok',httpStatus:200};}});
 assert.equal(calls.length,12);assert.equal(report.attempts.length,10);
 for(const target of sniTargets()){
  const own=report.attempts.find(row=>row.provider===target.provider && row.kind==='target-own-ip');
  assert.equal(own.address,'93.184.215.14');assert.equal(own.servername,'example.com');assert.equal(own.certificateVerification,true);
  assert.deepEqual(own.resolution,{method:'doh',provider:target.provider,address:target.address,name:'example.com',state:'ok',reason:null,rcode:0,pathVerified:true,selectedAddress:'93.184.215.14'});
  const foreign=report.attempts.find(row=>row.provider===target.provider && row.kind==='control-on-target-ip');
  assert.equal(foreign.address,own.address);assert.equal(foreign.servername,target.servername);assert.equal(foreign.experimental,true);
 }
 const exported=exportDiagnosticReport({gatewaySniControl:report});assert.equal(exported.gatewaySniControl.attempts[3].resolution.method,'doh');
 assert.ok(calls.filter(row=>row.options.worker==='sni').every(row=>row.request.target.address && !row.request.target.dnsProvider));
});

test('DNS failure, truncated/private/fake answers and unverified DoH never start target-IP probes',async()=>{
 for(const result of [{state:'failed',reason:'timeout'},{state:'ok',rcode:3,answers:[]},{state:'ok',rcode:0,truncated:true,answers:[{type:'A',value:'8.8.8.8'}]},{state:'ok',rcode:0,answers:[{type:'A',value:'10.0.0.1'},{type:'A',value:'198.18.0.1'},{type:'A',value:'93.184.215.14'}]}]){
  const requests=[];const report=await diagnoseGatewaySni({id,profiles,endpoint,name:'example.com',fakeIpRanges:['93.184.215.0/24'],allocatePort:async()=>45000,observe:async()=>({finish:async()=>({state:'verified'})}),request:async request=>{requests.push(request);return request.transport?result:{state:'ok'};}});
  assert.equal(requests.filter(row=>row.target).length,6);assert.equal(report.attempts.filter(row=>row.observation==='dns-address-unavailable').length,4);
 }
 const report=await diagnoseGatewaySni({id,profiles,endpoint,name:'example.com',allocatePort:async()=>45000,request:async request=>request.transport?{state:'ok',rcode:0,answers:[{type:'A',value:'8.8.8.8'}]}:{state:'ok'}});
 assert.ok(report.attempts.filter(row=>row.resolution).every(row=>row.address===null));
 for(const ip of ['0.1.2.3','127.0.0.1','169.254.1.2','100.64.0.1','172.16.1.2','192.0.2.1','198.51.100.1','203.0.113.1','224.0.0.1','255.255.255.255','::1'])assert.equal(selectSniAddress({state:'ok',rcode:0,answers:[{type:'A',value:ip}]}),null,ip);
});

test('direct matrix uses explicit DoH and pins both crossed names without implicit DNS',()=>{
 const result=spawnSync('python3',['-c',String.raw`
import importlib.util
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('sni','server/sni-probe.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
target={'provider':'fixture','address':'1.1.1.1','servername':'cloudflare-dns.com','dnsProvider':{'id':'fixture'}}
queries=[];calls=[]
def resolve(*args):
 queries.append(args);return {'state':'ok','routeVerified':True,'rcode':0,'answers':[{'type':'A','value':'10.0.0.1'},{'type':'A','value':'93.184.215.14'}]}
def probe(interface,target,name,experimental):
 calls.append((target['address'],name,experimental));return {'state':'ok','routeVerified':True}
with patch.object(m.transport,'attempt',side_effect=resolve),patch.object(m,'attempt',side_effect=probe):
 r=m.matrix('eth0',[target],'example.com');assert len(r['attempts'])==5
 assert queries[0][2:6]==('doh','example.com',1,1)
 assert calls[-2:]==[('93.184.215.14','example.com',False),('93.184.215.14','cloudflare-dns.com',True)],calls
 assert r['attempts'][-1]['resolution']['method']=='doh'
 calls.clear();r=m.matrix('eth0',[target],'example.com',['93.184.215.0/24']);assert len(calls)==3
 assert all(row['observation']=='dns-address-unavailable' for row in r['attempts'][-2:])
`],{encoding:'utf8',timeout:5000});assert.equal(result.status,0,result.stderr);
});
