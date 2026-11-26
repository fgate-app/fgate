import test from 'node:test';
import assert from 'node:assert/strict';
import {diagnosticStepOutcome} from '../server/domain-diagnostics.js';
test('stage indicators use verified evidence rather than completion',()=>{
 assert.equal(diagnosticStepOutcome('preparing',undefined),'ok');
 assert.equal(diagnosticStepOutcome('websites',{attempts:[{outcome:'ok'}]}),'unavailable');
 assert.equal(diagnosticStepOutcome('websites',{attempts:[{outcome:'ok',routeVerified:true}]}),'ok');
 assert.equal(diagnosticStepOutcome('websites',{attempts:[{outcome:'failed',observation:'timeout'}]}),'failed');
 assert.equal(diagnosticStepOutcome('server',{ok:true,results:[{state:'failed',attempts:[{reason:'refused'}]}]}),'failed');
 assert.equal(diagnosticStepOutcome('dns-gateway',{attempts:[{state:'ok',rcode:0}]}),'unavailable');
 assert.equal(diagnosticStepOutcome('dns-gateway',{attempts:[{state:'ok',rcode:0,routeVerified:true}]}),'ok');
 assert.equal(diagnosticStepOutcome('downloads',{ok:false,state:'unavailable',attempts:[]}),'unavailable');
});

import {diagnosticOverview,websiteFinding} from '../shared/diagnostic-summary.js';
test('redirects are inconclusive and never listed as failed websites',()=>{
 const redirect={url:'https://youtube.com/',outcome:'failed',stages:[{id:'http',status:302}]};
 const result=diagnosticOverview({attempts:[{url:'https://example.com',outcome:'ok',routeVerified:true},redirect]});
 assert.equal(websiteFinding(redirect).state,'unavailable');
 assert.equal(result.title,'Some websites need another check');
 assert.equal(result.failedTargets,undefined);
 assert.deepEqual(result.uncheckedTargets,['youtube.com']);
 assert.match(result.next,/final destination/);
 const mixed=diagnosticOverview({attempts:[{url:'https://example.com',outcome:'ok',routeVerified:true},redirect,{url:'https://failed.example',outcome:'failed',observation:'timeout'}]});
 assert.deepEqual(mixed.failedTargets,['failed.example']);
 assert.deepEqual(mixed.uncheckedTargets,['youtube.com']);
});
