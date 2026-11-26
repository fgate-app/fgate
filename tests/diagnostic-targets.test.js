import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultDiagnosticDomains,normalizeDiagnosticDomains,diagnosticDomainUrl,diagnosticSampleTargets,validDiagnosticUrl} from '../shared/diagnostic-targets.js';
import {diagnoseDomains} from '../server/domain-diagnostics.js';
import {diagnosticOverview} from '../shared/diagnostic-summary.js';
import {exportDiagnosticReport} from '../shared/diagnostic-report.js';
import {transferAttempt} from '../server/transfer-diagnostics.js';

test('common domain list has bounded canonical targets, no URLs, ports or empty fallback',()=>{
 assert.equal(defaultDiagnosticDomains.length,3);assert.deepEqual(normalizeDiagnosticDomains([' Example.COM. ','example.com']),['example.com']);
 for(const input of [[],['https://example.com'],['example.com/path'],['example.com:443'],['127.0.0.1'],['-bad.example'],Array(9).fill('example.com'),null])assert.throws(()=>normalizeDiagnosticDomains(input));
 assert.equal(diagnosticDomainUrl('example.com'),'https://example.com/');assert.equal(validDiagnosticUrl('https://example.com/'),true);assert.equal(validDiagnosticUrl('https://example.com/secret'),false);assert.equal(validDiagnosticUrl('https://user:pass@example.com/'),false);
});

test('every selected domain reaches every enabled website check; proxy endpoint remains independent',async()=>{
 const domains=['example.com','test.example'],calls=[],events=[];
 const id='private-profile',profile={id,engine:'xray'};
 const good=url=>({path:{chain:[profile]},limits:{attempts:1},attempts:[{url,outcome:'ok',pathObservation:{state:'verified',sourcePort:45000,connectionId:'private-flow'}}]});
 const matrix=name=>({name,path:{chain:[profile]},attempts:[{state:'ok',rcode:0,pathObservation:{state:'verified',sourcePort:45000,connectionId:'private-flow'}}]});
 const services={prepare:async()=>({}),identity:()=>({state:'unavailable'}),endpoint:async()=>{calls.push(['endpoint']);return {state:'ok'};},gateway:async({targets})=>{calls.push(['https',new URL(targets[0]).hostname]);return good(targets[0]);},direct:async({targets})=>{calls.push(['direct',new URL(targets[0]).hostname]);return good(targets[0]);},dnsDirect:async({name})=>{calls.push(['dns-direct',name]);return matrix(name);},dnsGateway:async({name})=>{calls.push(['dns-gateway',name]);return matrix(name);},sniDirect:async({name})=>{calls.push(['sni-direct',name]);return matrix(name);},sniGateway:async({name})=>{calls.push(['sni-gateway',name]);return matrix(name);},transfer:async({targets})=>{calls.push(['transfer',targets[0].domain]);return {attempts:targets.map(target=>({...target,complete:true,pathObservation:{state:'verified'}}))};}};
 const checks={endpoint:true,uplink:true,dns:true,sni:true,transfer:true};
 const report=await diagnoseDomains({domains,profile,checks,services,onProgress:event=>events.push(event)});
 assert.equal(calls.filter(row=>row[0]==='endpoint').length,1);
 for(const kind of ['https','direct','dns-direct','dns-gateway','sni-direct','sni-gateway','transfer'])assert.deepEqual(calls.filter(row=>row[0]===kind).map(row=>row[1]),domains);
 assert.equal(report.progress.steps.length,16);assert.ok(report.progress.steps.every(step=>step.state==='finished'));assert.equal(report.attempts.length,2);assert.equal(report.outcome,'ok');assert.ok(events.some(event=>event.progress.steps.some(step=>step.domain==='test.example' && step.state==='running')));
 const safe=exportDiagnosticReport(report);assert.doesNotMatch(JSON.stringify(safe),/private-profile|private-flow|sourcePort|45000/);assert.deepEqual(safe.domains,domains);
 const local=await diagnoseDomains({domains,profile:{id,engine:'direct'},local:true,checks:{dns:true,sni:true},services});assert.equal(local.gatewayKind,'direct');assert.ok(local.targetReports.every(target=>target.localDns && target.localSni));assert.ok(local.progress.steps.every(step=>!['internet','server','dns-direct','sni-direct'].includes(step.kind)));
});

test('overall budget keeps completed data, skips remaining domains and does not report a complete assessment',async()=>{
 const report=await diagnoseDomains({domains:['example.com','test.example'],profile:{engine:'direct'},local:true,checks:{},budgetMs:20,services:{prepare:async()=>{},identity:()=>({state:'unavailable'}),gateway:({signal})=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('budget')),{once:true}))}});
 assert.equal(report.progress.state,'budget-exhausted');assert.ok(report.progress.steps.some(step=>step.reason==='budget-exhausted'));assert.equal(diagnosticOverview(report).state,'unavailable');assert.equal(report.targetReports.length,2);
});

test('bounded site samples do not claim fixed-size downloads, speed or a successful oversized response',()=>{
 const [target]=diagnosticSampleTargets(['example.com']);
 const raw={exitCode:0,http_connect:200,response_code:200,ssl_verify_result:0,time_appconnect:.1,time_total:1,receivedBytes:1234,content_type:'text/html'};
 const value=transferAttempt(raw,target);assert.equal(value.complete,true);assert.equal(value.bytesPerSecond,null);assert.equal(value.expectedBytes,undefined);assert.equal(value.domain,'example.com');
 assert.equal(transferAttempt({...raw,response_code:204,receivedBytes:0},target).complete,true);
 assert.equal(transferAttempt({...raw,exitCode:63},target).outcome,'unavailable');assert.equal(transferAttempt({...raw,response_code:302},target).outcome,'unavailable');
});

test('partial success confirms Internet access and never recommends checking the router',()=>{
 for(const gatewayKind of ['direct','dpi-bypass','proxy']){
  const report={gatewayKind,attempts:[{url:'https://example.com',outcome:'ok',pathObservation:{state:'verified'}},{url:'https://test.example',outcome:'failed',observation:'timeout',stages:[]}]};
  const successWithBadDirect=diagnosticOverview({...report,attempts:[report.attempts[0]],uplinkControl:{attempts:[{outcome:'failed'}]}});assert.doesNotMatch(successWithBadDirect.next || '',/router|Raspberry Pi/);
  const value=diagnosticOverview(report);assert.equal(value.state,'partial');assert.match(value.message,/confirming Internet access/);assert.doesNotMatch(value.next,/router|Raspberry|Internet connection/);assert.match(value.next,/failed websites/);
 }
});
