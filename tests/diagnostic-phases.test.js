import test from 'node:test';
import assert from 'node:assert/strict';
import {diagnoseDomains} from '../server/domain-diagnostics.js';
import {diagnosticMetadata} from '../server/diagnostic-metadata.js';
import {exportDiagnosticReport} from '../shared/diagnostic-report.js';
import {parseEndpointRoute,traceArguments,traceEndpointRoute} from '../server/endpoint-route.js';
import {probeProxyStrategy} from '../server/proxy-strategies.js';
const endpoint={state:'failed',complete:true,addresses:['203.0.113.7'],port:44127};

test('unreachable endpoint never opens a website and exports no untouched domain configuration',async()=>{
 let sites=0,strategies=0;const domain='never-requested.example',events=[];
 const report=await diagnoseDomains({domains:[domain],checks:{endpoint:true,dns:true,sni:true,transfer:true,protocols:true,speedtest:true,tlsVersions:true,http3:true,pairedTransfer:true,mtu:true},services:{prepare:async()=>({}),identity:()=>({}),mtu:async()=>({state:'completed',outcome:'ok',lowerBound:1280}),tlsVersions:()=>assert.fail('TLS must not run'),http3:()=>assert.fail('HTTP3 must not run'),pairedTransfer:()=>assert.fail('Paired download must not run'),endpoint:async()=>endpoint,endpointRoute:async()=>({state:'completed',results:[]}),gateway:()=>{sites++;throw Error('Must not run');},strategies:()=>{strategies++;throw Error('Must not run');}},onProgress:event=>events.push(event)});
 assert.equal(sites,0);assert.equal(strategies,0);assert.equal(report.mtu.lowerBound,1280);assert.equal(report.phase,'endpoint-only');assert.equal(report.outcome,'failed');
 const exported=exportDiagnosticReport(diagnosticMetadata(report,{checks:{https:true,dns:true},parameters:{domains:[domain],dns:{providers:['cloudflare']},endpoint:{port:44127}}}));
 assert.doesNotMatch(JSON.stringify(exported),/never-requested|targetReports|maxSampleBytes|"https"|"dns"/);assert.equal(exported.measurement.parameters.endpoint.port,44127);
 assert.ok(events.every(event=>!JSON.stringify(event.report).includes(domain)));
});

test('a recovered or wrapped endpoint can proceed to actual website measurements',async()=>{
 for(const wrapped of [false,true]){
  let sites=0;const report=await diagnoseDomains({domains:['example.com'],checks:{endpoint:true},profile:{gatewayId:wrapped?'outer':null},services:{prepare:async()=>({}),identity:()=>({}),endpoint:async()=>endpoint,endpointDetailed:async()=>({...endpoint,state:'ok'}),gateway:async({targets})=>{sites++;return {attempts:[{url:targets[0],outcome:'ok',routeVerified:true}]};}}});
  assert.equal(sites,1);assert.equal(report.phase,undefined);assert.equal(report.outcome,'ok');
 }
});

test('TCP route evidence distinguishes reached target, partial hops, refusal annotations and no replies',async()=>{
 const full=parseEndpointRoute('traceroute to target\n 1  192.168.1.1  1.25 ms\n 2 *\n 3 203.0.113.7 4.00 ms','203.0.113.7');assert.equal(full.hopCount,3);assert.equal(full.targetReached,true);assert.equal(full.hops.length,3);
 const partial=parseEndpointRoute('1 192.168.1.1 0.4 ms\n2 *\n3 *','203.0.113.7');assert.equal(partial.hopCount,null);assert.equal(partial.lastReplyTtl,1);
 assert.equal(parseEndpointRoute('1 203.0.113.7 0.1 ms !H','203.0.113.7').targetReached,false);
 assert.equal(parseEndpointRoute('1 2001:db8::7 0.1 ms','2001:db8:0:0:0:0:0:7').hopCount,1);
 const noReplies=parseEndpointRoute('1 *\n2 *','203.0.113.7');assert.equal(noReplies.lastReplyTtl,null);assert.equal(noReplies.hopCount,null);
 const exported=exportDiagnosticReport({endpointRoute:{results:[full]}});assert.equal(exported.endpointRoute.results[0].hops[0].address,undefined);assert.equal(exported.endpointRoute.results[0].hops[2].address,'203.0.113.7');
 assert.ok(traceArguments('203.0.113.7',44127,'eth0').includes('--fwmark=0x40000000'));assert.ok(traceArguments('2001:db8::7',443,'eth0').includes('-6'));assert.throws(()=>traceArguments('x;bad',443,'eth0'));assert.throws(()=>traceArguments('203.0.113.7',0,'eth0'));
 const missing=await traceEndpointRoute({addresses:['203.0.113.7'],port:443,interfaceName:'eth0',run:async()=>{throw Object.assign(Error('missing'),{code:'ENOENT'});}});assert.equal(missing.results[0].reason,'traceroute-unavailable');
 const interrupted=await traceEndpointRoute({addresses:['203.0.113.7'],port:443,interfaceName:'eth0',run:async()=>{throw Object.assign(Error('timeout'),{stdout:'1 192.168.1.1 0.1 ms\n2 *'});}});assert.equal(interrupted.results[0].lastReplyTtl,1);assert.equal(interrupted.results[0].incomplete,true);assert.equal(interrupted.results[0].targetReached,false);
});

test('failed per-IP TCP gate sends no proxy credentials or website request and still stops its lease',async()=>{
 let clients=0,requests=0;const commands=[];
 const result=await probeProxyStrategy({snapshot:{profile:{},config:{engine:'xray',config:'vless://00000000-0000-4000-8000-000000000001@proxy.example:44127?security=none'}},address:'203.0.113.7',strategy:'baseline',domain:'never-requested.example',helper:async command=>{commands.push(command.op);return command.op==='stats'?{records:[{state:'failed',routeVerified:true}]}:{ok:true,port:12345,password:'private'};},tcpProbe:async()=>({state:'failed'}),makeClient:()=>{clients++;},request:()=>{requests++;}});
 assert.equal(result.reason,'endpoint-tcp-unreachable');assert.equal(clients,0);assert.equal(requests,0);assert.deepEqual(commands,['start','stats','stop']);assert.doesNotMatch(JSON.stringify(result),/never-requested/);
});
