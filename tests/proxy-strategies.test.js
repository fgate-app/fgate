import test from 'node:test';
import assert from 'node:assert/strict';
import {diagnoseProxyStrategies,probeProxyStrategy,strategyTestPlan} from '../server/proxy-strategies.js';
import {strategyNft,strategyDaemonArgs,strategyMark} from '../server/proxy-strategy-helper.js';
import {diagnoseDomains} from '../server/domain-diagnostics.js';
const snapshot={profile:{id:'fixture',engine:'xray'},config:{engine:'xray',config:'vless://00000000-0000-4000-8000-000000000001@proxy.example:443?security=none'}},endpoint={addresses:['203.0.113.7'],port:443};

test('isolated strategy sweep recommends only repeated improvement between two failed baselines',async()=>{
 const calls=[],progress=[];
 const report=await diagnoseProxyStrategies({snapshot,endpoint,domain:'example.com',onProgress:value=>progress.push(value),probe:async({strategy})=>{calls.push(strategy);return {state:strategy==='split-1'?'ok':'failed',attempts:[]};}});
 assert.deepEqual(calls,['baseline','split-1','disorder-1','disorder-16','fake-md5-split','fake-md5-disorder','baseline']);assert.deepEqual(report.recommendations,[{address:'203.0.113.7',strategy:'split-1'}]);assert.equal(progress[0].results.length,7);assert.ok(progress[0].results.every(row=>row.state==='pending'));assert.equal(report.outcome,'ok');assert.doesNotMatch(JSON.stringify(report),/private fixture/);
 for(const before of ['ok','partial','unavailable']){
  const result=await diagnoseProxyStrategies({snapshot,endpoint,domain:'example.com',probe:async({strategy})=>({state:strategy==='baseline'?before:'ok'})});assert.deepEqual(result.recommendations,[]);
 }
});

test('unsupported clients, cancellation, config changes and budget cannot produce recommendations',async()=>{
 let calls=0;
 assert.equal((await diagnoseProxyStrategies({snapshot:{...snapshot,profile:{gateway_id:'outer'}},endpoint,probe:()=>{calls++;}})).reason,'unsupported-strategy-client');assert.equal(calls,0);
 const controller=new AbortController();await assert.rejects(diagnoseProxyStrategies({snapshot,endpoint,signal:controller.signal,probe:async()=>{controller.abort();throw Object.assign(Error('cancelled'),{code:'ABORTED'});}}),{code:'ABORTED'});
 const changed=await diagnoseProxyStrategies({snapshot,endpoint,isCurrent:()=>++calls<2,probe:async()=>({state:'ok'})});assert.equal(changed.reason,'configuration-changed');assert.deepEqual(changed.recommendations,[]);assert.ok(changed.results.every(row=>row.state==='unavailable'));
 const expired=await diagnoseProxyStrategies({snapshot,endpoint,budgetMs:5,probe:async({signal})=>new Promise(resolve=>{signal.addEventListener('abort',()=>resolve({state:'unavailable'}),{once:true});})});assert.equal(expired.reason,'budget-exhausted');assert.deepEqual(expired.recommendations,[]);
});

test('temporary real-client adapter uses fixed IP and original credentials, verifies relay traffic, and always cleans up',async()=>{
 let stopped=0,rolled=0,sequence=0;const calls=[];
 const helper=async request=>{calls.push(request);return request.op==='start'?{ok:true,port:12345,username:'private-user',password:'private-password'}:request.op==='stats'?{records:sequence++%2===0?[]:[{routeVerified:true,sentBytes:100,receivedBytes:100}]}:{ok:true};};
 const makeClient=({resolve})=>({prepare:async rows=>{assert.equal((await resolve())[0].address,'203.0.113.7');assert.equal(rows[0].dpiBypass,false);assert.equal(rows[0].config,snapshot.config.config);assert.equal(rows[0].wrapEndpoint.password,'private-password');return {bridges:{[rows[0].profile_id]:{port:12346}},rollback:async()=>{rolled++;}};},stop:async()=>{stopped++;}});
 const result=await probeProxyStrategy({snapshot,address:'203.0.113.7',strategy:'split-1',domain:'example.com',helper,makeClient,tcpProbe:async()=>({state:'ok'}),request:async(port,url)=>{assert.equal(port,12346);assert.equal(url,'https://example.com/');return {state:'ok'};}});
 assert.equal(result.state,'ok');assert.equal(result.attempts.length,2);assert.equal(stopped,1);assert.equal(rolled,2);assert.equal(calls.at(-1).op,'stop');assert.doesNotMatch(JSON.stringify(result),/private-/);
 const missingProof=await probeProxyStrategy({snapshot,address:'203.0.113.7',strategy:'split-1',domain:'example.com',helper:async req=>req.op==='stats'?{records:[]}:helper(req),makeClient,tcpProbe:async()=>({state:'ok'}),request:async()=>({state:'ok'})});assert.equal(missingProof.state,'unavailable');
 const broken=await probeProxyStrategy({snapshot,address:'203.0.113.7',strategy:'split-1',domain:'example.com',helper,tcpProbe:async()=>({state:'ok'}),makeClient:()=>({prepare:async()=>{throw Error('private-credentials');},stop:async()=>{stopped++;}})});assert.equal(broken.state,'unavailable');assert.equal(calls.at(-1).op,'stop');assert.doesNotMatch(JSON.stringify(broken),/private-/);
});

test('strategy rules match only diagnostic mark and exact IP:port, never the shared or Outline mark',()=>{
 const nft=strategyNft('203.0.113.7',44127);assert.match(nft,/0x20000008 ip daddr 203.0.113.7 tcp dport 44127/);assert.doesNotMatch(nft,/freedomgate_zapret|10000007|10000000/);assert.equal(strategyMark & 0x50000000,0);
 assert.match(strategyNft('2001:db8::7',443),/ip6 daddr/);assert.throws(()=>strategyNft('x;bad',443));assert.throws(()=>strategyNft('203.0.113.7',0));assert.throws(()=>strategyDaemonArgs({strategy:'injected'}));
 for(const strategy of strategyTestPlan.filter(row=>row.strategy!=='baseline'))assert.ok(strategyDaemonArgs({binary:'nfqws2',lua:'/opt/lua',pidfile:'/run/freedomgate/test.pid',strategy:strategy.strategy}).includes('--filter-mark=0x20000008/0xffffffff'));
});

test('strategies run only after confirmed proxy failure and each appears in progress',async()=>{
 for(const works of [true,false]){
  let strategyCalls=0;const events=[];
  const report=await diagnoseDomains({domains:['example.com','second.example'],checks:{endpoint:true},services:{prepare:async()=>({}),identity:()=>({}),endpoint:async()=>({state:'ok',complete:true,addresses:['203.0.113.7']}),gateway:async({targets})=>({attempts:[{url:targets[0],outcome:works?'ok':'failed',pathObservation:{state:'verified'}}]}),strategies:async({onProgress})=>{strategyCalls++;return diagnoseProxyStrategies({snapshot,endpoint,domain:'example.com',onProgress,probe:async()=>({state:'failed'})});}},onProgress:event=>events.push(event)});
  assert.equal(strategyCalls,works?0:1);
  if(!works){assert.equal(report.proxyStrategies.results.length,7);assert.equal(report.progress.steps.filter(row=>row.kind==='strategy').length,7);assert.ok(events.some(event=>event.progress.steps.some(row=>row.kind==='strategy' && row.state==='running')));assert.ok(events.some(event=>event.progress.steps.some(row=>row.kind==='strategy' && row.state==='pending')));}
 }
});

test('a working baseline never runs bypass candidates',async()=>{
 const tried=[];const report=await diagnoseProxyStrategies({snapshot,endpoint,domain:'example.com',probe:async({strategy})=>{tried.push(strategy);return {state:'ok'};}});
 assert.deepEqual(tried,['baseline','baseline']);assert.ok(report.results.filter(row=>row.strategy!=='baseline').every(row=>row.reason==='baseline-working'));assert.deepEqual(report.recommendations,[]);
});
