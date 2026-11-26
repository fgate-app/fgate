import test from 'node:test';
import assert from 'node:assert/strict';
import {createHttpHealth,httpHealthUrls} from '../server/http-health.js';
import {Store} from '../server/store.js';
import {createServer} from '../server/index.js';

const direct={id:'direct-id',engine:'direct',enabled:true};
test('HTTP checks try gstatic first, then alternate endpoints through the same exit',async()=>{
 const calls=[],events=[];
 const health=createHttpHealth(async(path,options)=>{
  const url=new URL(path,'http://engine');calls.push({tag:url.pathname,url:url.searchParams.get('url'),options});
  if(calls.length<3)throw Object.assign(Error('secret engine payload'),{status:504});
  return {delay:27};
 },{report:event=>events.push(event)});
 try{
  await health.start([direct,{id:'abcdefgh-more',engine:'outline',enabled:false}]);
  assert.deepEqual(calls.map(call=>call.url),httpHealthUrls);
  assert.ok(calls.every(call=>call.tag==='/proxies/DIRECT/delay' && call.options.timeout>4000));
  assert.equal(health.get(direct).ping,27);assert.equal(health.get(direct).httpEndpoint,'www.apple.com');
  assert.equal(health.get(direct).httpHistory.length,1);
  assert.equal(events.length,2);assert.equal(events[0].reason,'timeout');assert.ok(!JSON.stringify(events).includes('secret'));
 }finally{health.stop();}
});
test('repeated failures are deduplicated, recovery is logged, total failure clears the old ping',async()=>{
 let failed=true,time=1000;const events=[];
 const health=createHttpHealth(async()=>{if(failed)throw Error('failed');return {delay:12};},{now:()=>time,report:event=>events.push(event)});
 try{
  await health.start([direct]);assert.equal(health.get(direct).httpStatus,'error');assert.equal(events.length,3);
  await health.start([direct]);assert.equal(events.length,3);
  time+=900000;await health.start([direct]);assert.equal(events.length,6);
  failed=false;await health.start([direct]);assert.equal(events.length,7);assert.equal(events.at(-1).failed,false);assert.equal(health.get(direct).ping,12);
  failed=true;await health.start([direct]);assert.equal(health.get(direct).ping,null);assert.equal(health.get(direct).httpEndpoint,null);assert.equal(health.get(direct).httpHistory.at(-1).delay,null);
 }finally{health.stop();}
});
test('disabled exits make no requests; stopping discards in-flight results and logs',async()=>{
 let finish;const events=[],calls=[];
 const health=createHttpHealth(path=>{calls.push(path);return new Promise(resolve=>finish=resolve);},{report:event=>events.push(event)});
 await health.start([{...direct,enabled:false}]);assert.equal(calls.length,0);assert.equal(health.get({...direct,enabled:false}).httpStatus,'disabled');
 const pending=health.start([{id:'abcdefgh-more',engine:'outline'}]);assert.ok(calls[0].startsWith('/proxies/p-abcdefgh-grp/delay?'));
 health.stop();finish({delay:5});await pending;assert.equal(health.get(direct).httpStatus,'unmeasured');assert.deepEqual(events,[]);
});
test('gateway probe events are persisted in the user-visible journal without controller payloads',()=>{
 const store=new Store(':memory:');let report;
 const server=createServer(store,{supervisor:{setHttpHealthReporter:callback=>report=callback}});
 try{
  report({profileId:'gateway-id',endpoint:'www.gstatic.com',failed:true,reason:'timeout'});
  report({profileId:'gateway-id',endpoint:'www.gstatic.com',failed:false,reason:'ok'});
  const events=store.events();assert.equal(events.length,2);
  assert.ok(events.some(event=>event.action==='SYSTEM gateway-http-failed' && event.detail.includes('www.gstatic.com') && event.status===503));
  assert.ok(events.some(event=>event.action==='SYSTEM gateway-http-restored' && event.status===200));
 }finally{server.close();store.close();}
});
test('checks continue in the background without telemetry polling',async()=>{
 let count=0,resolve;const repeated=new Promise(done=>resolve=done);
 const health=createHttpHealth(async()=>{if(++count===2)resolve();return {delay:19};},{interval:10});
 let timer;
 try{
  await health.start([direct]);
  await Promise.race([repeated,new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('No automatic retry')),1000))]);
  assert.ok(count>=2);
 }finally{clearTimeout(timer);health.stop();}
});

test('Tor HTTP checks wait for bootstrap, use the Tor timeout and recover without false failures',async()=>{
 let state='connecting',calls=0;const events=[];
 const health=createHttpHealth(async(path,options)=>{calls++;assert.equal(new URL(path,'http://engine').searchParams.get('timeout'),'20000');assert.equal(options.timeout,21500);return {delay:6100};},{interval:10,transport:()=>({state,timeout:20000}),report:event=>events.push(event)});
 try{
  await health.start([{id:'tor-id',engine:'tor'}]);assert.equal(calls,0);assert.equal(health.get({id:'tor-id'}).httpStatus,'checking');assert.deepEqual(events,[]);
  state='ready';for(let n=0;n<100 && calls===0;n++)await new Promise(resolve=>setTimeout(resolve,5));
  assert.ok(calls>0);assert.equal(health.get({id:'tor-id'}).ping,6100);
  state='connecting';assert.equal(health.get({id:'tor-id'}).httpStatus,'checking');assert.equal(health.get({id:'tor-id'}).ping,null);
  state='failed';assert.equal(health.get({id:'tor-id'}).httpStatus,'error');assert.deepEqual(events,[]);
 }finally{health.stop();}
});
test('a Tor disconnect during an HTTP request does not record a website failure',async()=>{
 let state='ready',fail;const events=[];
 const health=createHttpHealth(()=>new Promise((_,reject)=>fail=reject),{transport:()=>({state}),report:event=>events.push(event)});
 try{const pending=health.start([{id:'tor-id'}]);state='connecting';fail(Error('gate closed'));await pending;assert.deepEqual(events,[]);assert.equal(health.get({id:'tor-id'}).httpStatus,'checking');assert.equal(health.get({id:'tor-id'}).httpHistory.length,0);}finally{health.stop();}
});
test('Tor transport policy applies to wrapped proxies and leaves other gateways unchanged',async()=>{
 const {MihomoSupervisor}=await import('../server/mihomo.js');let state='connecting';const supervisor=new MihomoSupervisor({tor:{status:()=>({tor:{state}})}});
 supervisor._routes.profiles=[{id:'tor',engine:'tor',enabled:true},{id:'inner',engine:'xray',gatewayId:'tor'}];
 assert.deepEqual(supervisor.httpHealthTransport(supervisor._routes.profiles[1]),{state:'connecting',timeout:20000});
 state='ready';assert.equal(supervisor.httpHealthTransport(supervisor._routes.profiles[1]).state,'ready');
 supervisor._routes.profiles[0].enabled=false;assert.equal(supervisor.httpHealthTransport(supervisor._routes.profiles[1]).state,'failed');
 assert.deepEqual(supervisor.httpHealthTransport(direct),{state:'ready'});
});
