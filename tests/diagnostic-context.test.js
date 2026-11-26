import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {diagnosticContext} from '../shared/diagnostic-context.js';
import {exportDiagnosticReport} from '../shared/diagnostic-report.js';
import {createServer} from '../server/index.js';
import {Store} from '../server/store.js';

for(const engine of ['direct','zapret'])test(`${engine} reports omit external-proxy stages, duplicate controls and exported local identities`,()=>{
 const path=()=>({chain:[{id:'12345678-private',engine}],externalConnection:{state:'unavailable'},observedRoute:null,routeVerified:false});
 const matrix=()=>({path:path(),attempts:[{localAddress:'127.0.0.1',localPort:45000,pathObservation:{connectionId:'private-flow',sourcePort:45000,inboundPort:28000}}]});
 const report=diagnosticContext({path:path(),attempts:[{stages:['bootstrap-dns','proxy-connect','tunnel-protocol','tls','http','transfer'].map(id=>({id,state:'ok'}))}],endpointControl:{},uplinkControl:{},dnsMatrix:{},dnsPathComparisons:[],sniControl:{},gatewayDnsMatrix:matrix(),gatewaySniControl:matrix(),transfer:{path:path()}},{engine});
 assert.deepEqual(report.attempts[0].stages.map(row=>row.id),['tls','http','transfer']);
 for(const key of ['endpointControl','uplinkControl','dnsMatrix','dnsPathComparisons','sniControl','gatewayDnsMatrix','gatewaySniControl'])assert.equal(key in report,false,key);
 assert.equal(report.gatewayKind,engine==='direct'?'direct':'dpi-bypass');assert.equal(report.path.externalConnection,undefined);assert.equal(report.path.observedRoute,undefined);assert.equal(report.path.routeVerified,undefined);
 const exported=exportDiagnosticReport(report);assert.doesNotMatch(JSON.stringify(exported),/12345678|private-flow|127\.0\.0\.1|45000|28000/);assert.ok(exported.localDns && exported.localSni);
});

test('local gateway API ignores inappropriate flags and runs only one selected-path DNS/SNI matrix',async()=>{
 const store=new Store(':memory:');const calls=[];
 const server=createServer(store,{supervisor:{diagnoseGateway:async()=>({path:{chain:[]},attempts:[]}),diagnoseGatewayDns:async()=>{calls.push('dns');return {ok:true,attempts:[]};},diagnoseGatewaySni:async()=>{calls.push('sni');return {ok:true,attempts:[]};}},diagnosticUplink:()=>{throw Error('Unexpected separate uplink control');},diagnosticEndpoint:()=>{throw Error('Unexpected endpoint control');},diagnosticDns:()=>{calls.push('extra-dns');},diagnosticSni:()=>{calls.push('extra-sni');}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}/api/`;
 try{
  const setup=await fetch(base+'auth/setup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'admin',password:'fixture password 12345'})});const {csrf}=await setup.json(),cookie=setup.headers.get('set-cookie').split(';')[0];
  for(const profile of store.profiles().filter(row=>['direct','zapret'].includes(row.engine))){
   const response=await fetch(base+`profiles/${profile.id}/diagnostics`,{method:'POST',headers:{'Content-Type':'application/json',Cookie:cookie,'X-CSRF-Token':csrf},body:JSON.stringify({uplink:true,endpoint:true,endpointDnsSource:'invalid',endpointDnsProvider:'invalid',dns:true,sni:true,sniName:'example.com'})});assert.equal(response.status,200);
   const report=await response.json();assert.equal(report.measurement.checks.uplink,false);assert.equal(report.measurement.checks.endpoint,false);assert.equal(report.schemaVersion,2);assert.ok(report.localDns && report.localSni);for(const key of ['endpointControl','uplinkControl','dnsMatrix','gatewayDnsMatrix','sniControl','gatewaySniControl','dnsPathComparisons'])assert.equal(key in report,false,key);
  }
  assert.deepEqual(calls,['dns','sni','dns','sni']);
 }finally{await new Promise(resolve=>server.close(resolve));store.close();}
});
