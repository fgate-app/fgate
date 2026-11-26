import test from 'node:test';
import assert from 'node:assert/strict';
import {diagnoseEndpoint} from '../server/endpoint-diagnostics.js';
import {dnsMatrixProviders} from '../server/dns-matrix-catalog.js';
import {diagnoseDomains} from '../server/domain-diagnostics.js';
import {exportDiagnosticReport} from '../shared/diagnostic-report.js';
import {diagnosticSummary} from '../shared/diagnostic-summary.js';
const providers=dnsMatrixProviders().map(row=>row.id),peer={host:'proxy.example',port:44127};

test('proxy hostname checks both selected resolvers and probes the union of IPs on the proxy port',async()=>{
 const queried=[],probes=[];
 const report=await diagnoseEndpoint(peer,{dnsSource:'doh',dohProviders:providers,resolve:()=>{throw Error('No system fallback');},
 resolveDoh:async({name,provider})=>{
  queried.push(provider);const selected=dnsMatrixProviders([provider])[0];
  return {ok:true,name,mode:'endpoint-doh',attempts:['A','AAAA'].map(qtype=>({provider,transport:'doh',qtype,address:selected.endpoints.doh.address,port:selected.endpoints.doh.port,state:'ok',rcode:0,routeVerified:true,answers:[{name,type:qtype,value:qtype==='AAAA'?'2001:db8::7':provider===providers[0]?'203.0.113.7':'203.0.113.8'}]}))};
 },probe:async value=>{probes.push(value);return {state:'failed',complete:true,results:[]};}});
 assert.deepEqual(queried,providers);assert.equal(probes.length,1);assert.equal(probes[0].port,44127);
 assert.deepEqual(probes[0].addresses,['203.0.113.7','2001:db8::7','203.0.113.8']);
 assert.equal(report.bootstrap.resolvers.length,2);assert.equal(report.bootstrap.attempts.length,4);assert.equal(report.complete,true);
 assert.equal(diagnosticSummary({endpointControl:report}).find(row=>row.id==='server-resolvers').rows.length,4);
});

test('failure of one resolver preserves the other resolver IPs and cannot establish complete endpoint failure',async()=>{
 const report=await diagnoseEndpoint(peer,{dnsSource:'doh',dohProviders:providers,resolveDoh:async({name,provider})=>{
 if(provider===providers[0])throw Error('Resolver failed');const selected=dnsMatrixProviders([provider])[0];
 return {ok:true,name,mode:'endpoint-doh',attempts:['A','AAAA'].map(qtype=>({provider,transport:'doh',qtype,address:selected.endpoints.doh.address,port:443,state:'ok',rcode:0,routeVerified:true,answers:qtype==='A'?[{name,type:qtype,value:'203.0.113.8'}]:[]}))};
 },probe:async({addresses})=>{assert.deepEqual(addresses,['203.0.113.8']);return {state:'failed',complete:true,results:[]};}});
 assert.equal(report.complete,false);assert.equal(report.bootstrap.state,'partial');assert.equal(report.bootstrap.resolvers[0].reason,'dns-error');
});

async function flow({endpointState='failed',websiteOutcome='failed',complete=true}={}){
 const calls=[],snapshots=[];
 const report=await diagnoseDomains({domains:['one.example','two.example'],profile:{engine:'mihomo'},checks:{endpoint:true,dns:true,protocols:true,speedtest:true},
 services:{prepare:async()=>({}),identity:()=>({}),endpoint:async()=>({state:endpointState,complete,results:[]}),
 endpointDetailed:async()=>{calls.push('detail');return {state:'failed',complete:true,results:[{address:'203.0.113.7',attempts:[{localAddress:'192.168.1.86',route:{gateway:'192.168.1.1'},tcpCapture:{tuple:{localAddress:'192.168.1.86',localPort:55111}}}]}]};},
 gateway:async({targets})=>{calls.push(targets[0]);return {attempts:[{url:targets[0],outcome:websiteOutcome,pathObservation:{state:'verified'},stages:[]}]};},
 dnsDirect:async()=>{calls.push('dns');return {};},dnsGateway:async()=>({}),protocols:async()=>{calls.push('protocols');return {};},speedtest:async()=>{calls.push('speed');return {};}
 },onProgress:event=>snapshots.push(event)});
 return {report,calls,snapshots};
}

test('confirmed endpoint failure stops before any website request and keeps only endpoint evidence',async()=>{
 const {report,calls,snapshots}=await flow();
 assert.deepEqual(calls,['detail']);assert.equal(report.failureInvestigation.trigger,'endpoint-unreachable');
 assert.equal(report.phase,'endpoint-only');assert.equal(report.domains,undefined);assert.equal(report.targetReports,undefined);assert.equal(report.attempts,undefined);
 assert.ok(report.progress.steps.filter(row=>row.id!=='preparing' && row.id!=='server' && row.id!=='server-detail').every(row=>row.state==='skipped'));
 assert.ok(snapshots.some(row=>row.progress.steps.some(step=>step.id==='server-detail' && step.state==='running')));
 assert.doesNotMatch(JSON.stringify(exportDiagnosticReport(report)),/192\.168\.1\.(86|1)|55111/);
});

test('working tunnel, unavailable control, or incomplete endpoint evidence does not suppress website tests',async()=>{
 for(const options of [{endpointState:'ok'},{endpointState:'unavailable'},{complete:false}]){
  const {calls,report}=await flow(options);assert.ok(calls.includes('https://two.example/'));assert.ok(calls.includes('speed'));assert.ok(!report.failureInvestigation);
 }
});
