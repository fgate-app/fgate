import test from 'node:test';
import assert from 'node:assert/strict';
import {followDiagnosticRedirects,validRedirectUrl} from '../server/diagnostic-redirects.js';
import {diagnoseGateway} from '../server/gateway-diagnostics.js';
import {diagnosticSummary} from '../shared/diagnostic-summary.js';
const start='https://example.com/';
const response=(status,next,state='verified')=>({raw:{exitCode:0,response_code:status,redirect_url:next},row:{outcome:status===200?'ok':'failed',pathObservation:{state},stages:[{id:'http',status}]}});
test('relative and cross-domain redirects keep original target, sanitized chain and per-hop evidence',async()=>{
 const calls=[];const result=await followDiagnosticRedirects(start,async(url,options)=>{calls.push({url,options});return calls.length===1?response(301,'https://www.example.com/path?secret=private#x'):calls.length===2?response(307,'/final'):response(200);});
 assert.equal(result.outcome,'ok');assert.equal(result.url,start);assert.equal(result.finalUrl,'https://www.example.com/final');assert.equal(calls.length,3);assert.equal(calls[1].options.redirectHop,true);assert.equal(calls[1].url,'https://www.example.com/path?secret=private');assert.equal(result.redirects.length,2);assert.doesNotMatch(JSON.stringify(result),/secret|private/);
 assert.equal(diagnosticSummary({attempts:[result]})[0].rows[0].redirects,'example.com → www.example.com/path → www.example.com/final');
});
test('redirect loop, hop bound, unsupported target, route mismatch and unknown intermediate evidence never pass',async()=>{
 assert.equal((await followDiagnosticRedirects(start,async()=>response(302,start))).observation,'redirect-loop');
 let n=0;assert.equal((await followDiagnosticRedirects(start,async()=>response(308,'https://example.com/'+(++n)))).observation,'redirect-limit');assert.equal(n,6);
 for(const url of ['http://example.com/','https://user:pass@example.com/','https://127.0.0.1/','https://localhost/','https://example.com:8443/','file:///tmp/test']){assert.equal(validRedirectUrl(url),false);assert.equal((await followDiagnosticRedirects(start,async()=>response(302,url))).observation,'redirect-target-unsupported');}
 assert.equal((await followDiagnosticRedirects(start,async()=>response(302,'/next','mismatch'))).outcome,'failed');
 let first=true;const unknown=await followDiagnosticRedirects(start,async()=>{if(first){first=false;return response(302,'/next','unavailable');}return response(200);});assert.equal(unknown.pathObservation.state,'unavailable');
 const controller=new AbortController();let abortedCalls=0;await assert.rejects(followDiagnosticRedirects(start,async()=>{abortedCalls++;controller.abort();return response(302,'/next');},{signal:controller.signal}),{code:'ABORTED'});assert.equal(abortedCalls,1);
 let clock=0;const budget=await followDiagnosticRedirects(start,async()=>{clock=100;return response(302,'/next');},{now:()=>clock,budgetMs:50});assert.equal(budget.observation,'redirect-budget-exhausted');
 let count=0;const interrupted=await followDiagnosticRedirects(start,async()=>{if(count++)throw Error('private transport error');return response(302,'/next');});assert.equal(interrupted.redirects.length,1);assert.equal(interrupted.outcome,'unavailable');
});
test('redirects allocate and observe a fresh socket through the same gateway, without curl auto-follow',async()=>{
 const endpoint={port:28000,secret:'private'},urls=[],ports=[];let port=45000;
 const report=await diagnoseGateway({profiles:[{id:'gateway',engine:'direct'}],id:'gateway',endpoint,targets:[start],allocatePort:async()=>port++,observe:async({url,localPort})=>{urls.push(url);ports.push(localPort);return {finish:async()=>({state:'verified'})};},request:async(e,url)=>{assert.equal(e,endpoint);return {...response(url===start?301:200,'https://www.example.com/final').raw,http_connect:200,time_appconnect:.1};}});
 assert.equal(report.outcome,'ok');assert.equal(report.attempts[0].redirects.length,1);assert.deepEqual(ports,[45000,45001]);assert.deepEqual(urls,[start,'https://www.example.com/final']);
});
