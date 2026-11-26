import test from 'node:test';
import assert from 'node:assert/strict';
import {compareTransfer} from '../server/paired-transfer.js';
import {diagnosticOverview,diagnosticSummary} from '../shared/diagnostic-summary.js';
import {exportDiagnosticReport} from '../shared/diagnostic-report.js';

const sample=(id='private-gateway',verified=true)=>({path:{chain:[{id}]},attempts:[{url:'https://speed.cloudflare.com/__down?bytes=65536',complete:true,expectedBytes:65536,bytes:65536,durationMs:100,outcome:'ok',pathObservation:{state:verified?'verified':'unavailable',sourcePort:45000,connectionId:'private-flow'}}]});
test('paired download uses the same fixed resource and preserves independent verified results',async()=>{
 const calls=[],events=[];
 const report=await compareTransfer({onProgress:value=>events.push(value),request:async(mode,options)=>{calls.push({mode,targets:options.targets});return sample(mode);}});
 assert.deepEqual(calls.map(row=>row.mode),['direct','gateway']);assert.deepEqual(calls[0].targets,calls[1].targets);assert.equal(calls[0].targets[0].bytes,65536);assert.equal(report.outcome,'ok');
 assert.ok(events.some(row=>row.results.some(result=>result.id==='gateway' && result.state==='running')));
 assert.equal(diagnosticSummary({pairedTransfer:report}).find(row=>row.id==='paired-transfer').rows.length,2);
 const safe=exportDiagnosticReport({pairedTransfer:report});assert.doesNotMatch(JSON.stringify(safe),/private-flow|45000/);
});
test('an unverified route, partial body or configuration change cannot count as paired success',async()=>{
 const report=await compareTransfer({request:async mode=>sample(mode,mode==='gateway')});assert.equal(report.outcome,'partial');assert.equal(report.results[0].state,'unavailable');
 const partial=await compareTransfer({request:async()=>{const result=sample();result.attempts[0].bytes=100;return result;}});assert.notEqual(partial.outcome,'ok');
 const rejected=await compareTransfer({request:async()=>{const result=sample();result.attempts[0].outcome='failed';return result;}});assert.equal(rejected.outcome,'failed');
 let calls=0;const changed=await compareTransfer({isCurrent:()=>calls===0,request:async()=>{calls++;return sample();}});assert.equal(changed.reason,'configuration-changed');assert.equal(changed.results.length,1);assert.equal(changed.results[0].state,'unavailable');
 const controller=new AbortController();await assert.rejects(compareTransfer({signal:controller.signal,request:async()=>{controller.abort();return sample();}}),{name:'AbortError'});
});
test('a failed direct sample never changes the verdict of working websites through the gateway',()=>{
 const report={progress:{state:'completed'},attempts:[{url:'https://example.com/',outcome:'ok',pathObservation:{state:'verified'}}],pairedTransfer:{outcome:'partial',results:[{id:'direct',state:'failed'},{id:'gateway',state:'ok',...sample()}]}};
 assert.equal(diagnosticOverview(report).state,'ok');assert.equal(diagnosticSummary(report).find(row=>row.id==='paired-transfer').state,'partial');
});
