import test from 'node:test';
import assert from 'node:assert/strict';
import {compareProxyPaths} from '../server/proxy-path-comparison.js';
import {exportDiagnosticReport} from '../shared/diagnostic-report.js';
import {diagnoseDomains} from '../server/domain-diagnostics.js';
const snapshot={profile:{id:'subject'},config:{engine:'xray'}},endpoint={addresses:['203.0.113.7'],port:443};
const works={attempts:[{outcome:'ok',pathObservation:{state:'verified'}}]},control={isCurrent:()=>true,upstream:{},observe:()=>{}};

test('comparison automatically selects a verified working gateway and repeats one endpoint on both paths',async()=>{
 const verified=[],tried=[],events=[];
 const report=await compareProxyPaths({snapshot,endpoint,candidates:[{id:'dead'},{id:'working',name:'Private control name'},{id:'unused'}],verifyControl:async id=>{verified.push(id);return id==='working'?works:{};},getControl:async()=>control,onProgress:event=>events.push(event),probe:async options=>{tried.push(options);return {state:options.helper?'ok':'failed',attempts:[]};}});
 assert.deepEqual(verified,['dead','working']);assert.equal(report.controlGatewayId,'working');assert.equal(report.outcome,'path-dependent');
 assert.equal(tried.length,3);assert.ok(tried.every(row=>row.address==='203.0.113.7' && row.domain==='example.com' && row.snapshot===snapshot && row.strategy==='baseline'));
 assert.ok(events.some(row=>row.results.some(result=>result.state==='pending')));assert.ok(events.some(row=>row.results.some(result=>result.state==='running')));
 const exported=exportDiagnosticReport({pathComparison:report});assert.doesNotMatch(JSON.stringify(exported),/Private control name|"working"|"dead"/);assert.equal(exported.pathComparison.controlGatewayId,'gateway-2');
});

test('no other gateway or no verified working gateway skips the comparison without probing the subject',async()=>{
 let probes=0;
 for(const candidates of [[],[{id:'dead'}],[{id:'unverified'}]]){
  const report=await compareProxyPaths({snapshot,endpoint,candidates,verifyControl:async()=>({attempts:[{outcome:'ok'}]}),getControl:async()=>control,probe:async()=>{probes++;}});
  assert.equal(report.outcome,'unavailable');assert.equal(report.results.length,0);assert.equal(report.reason,candidates.length?'no-verified-control':'no-control-gateway');
 }
 assert.equal(probes,0);
});

test('budget, cancellation and configuration changes cannot produce a path-dependent conclusion',async()=>{
 const options={snapshot,endpoint,candidates:[{id:'working'}],verifyControl:async()=>works,getControl:async()=>control};
 let current=true;const changed=await compareProxyPaths({...options,isCurrent:()=>current,probe:async()=>{current=false;return {state:'ok'};}});assert.equal(changed.reason,'configuration-changed');assert.equal(changed.outcome,'unavailable');
 const abort=new AbortController();await assert.rejects(compareProxyPaths({...options,signal:abort.signal,probe:async()=>{abort.abort();throw Error('private');}}),{code:'ABORTED'});
 const expired=await compareProxyPaths({...options,budgetMs:5,verifyControl:async(id,{signal})=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('cancelled')),{once:true}))});assert.equal(expired.outcome,'unavailable');assert.equal(expired.reason,'budget-exhausted');
});

test('dead endpoint still compares paths without exporting untested website domains or invoking website checks',async()=>{
 let sites=0,comparisons=0;
 const report=await diagnoseDomains({domains:['untested-private.example'],checks:{endpoint:true},services:{prepare:async()=>({}),identity:()=>({}),endpoint:async()=>({state:'failed',complete:true,...endpoint}),pathComparison:async({onProgress})=>{comparisons++;const value={state:'completed',outcome:'unavailable',reason:'no-control-gateway',results:[]};onProgress(value);return value;},gateway:()=>{sites++;}}});
 assert.equal(comparisons,1);assert.equal(sites,0);assert.doesNotMatch(JSON.stringify(report),/untested-private/);assert.equal(report.pathComparison.reason,'no-control-gateway');
});
