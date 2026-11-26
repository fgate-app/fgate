import test from 'node:test';
import assert from 'node:assert/strict';
import {observeDiagnostic} from '../server/diagnostic-observer.js';
const endpoint={id:'12345678-abcd',tag:'p-12345678-grp',port:28000};
const context={endpoint,url:'https://www.gstatic.com/generate_204',localPort:45000,interval:1};
const flow=(overrides={})=>({id:'flow',chains:['p-12345678','p-12345678-grp'],metadata:{sourceIP:'127.0.0.1',sourcePort:45000,inboundPort:28000,inboundName:'fg-geo-12345678-abcd',host:'www.gstatic.com',destinationIP:'203.0.113.7',destinationPort:443,network:'tcp'},...overrides});
const tuple={local_ip:'127.0.0.1',local_port:45000};
async function observe(rows,{baseline=[],raw=tuple}={}){
 let count=0,sampled;
 const ready=new Promise(resolve=>sampled=resolve);
 const observer=await observeDiagnostic(async()=>{if(count++===0)return {connections:baseline};sampled();return {connections:rows};},context);
 await ready;return observer.finish(raw);
}
test('engine evidence requires the exact new loopback tuple, inbound and target',async()=>{
 const good=flow(),others=[
  flow({id:'geo',metadata:{...good.metadata,sourcePort:45001}}),
  flow({id:'wrong-inbound',metadata:{...good.metadata,inboundName:'another'}}),
  flow({id:'wrong-host',metadata:{...good.metadata,host:'example.com'}}),
  flow({id:'remote-client',metadata:{...good.metadata,sourceIP:'10.20.0.2'}}),
 ];
 const result=await observe([...others,good]);assert.equal(result.state,'verified');assert.equal(result.connectionId,'flow');assert.equal(result.target.address,'203.0.113.7');
 assert.equal((await observe(others)).state,'unavailable');
 assert.equal((await observe([good],{baseline:[good]})).reason,'flow-not-observed');
 assert.equal((await observe([good],{raw:{local_ip:'127.0.0.1',local_port:45001}})).reason,'client-tuple-unconfirmed');
});
test('wrong outbound, ambiguous flows and controller outage never become verified',async()=>{
 assert.equal((await observe([flow({chains:['DIRECT']})])).state,'mismatch');
 assert.equal((await observe([flow(),flow({id:'second'})])).reason,'ambiguous-flow');
 const observer=await observeDiagnostic(async()=>{throw Error('offline');},context);
 assert.equal((await observer.finish(tuple)).reason,'controller-unavailable');
});
test('stopping observer aborts in-flight controller work and leaves no poller',async()=>{
 let count=0,aborted=false;
 const observer=await observeDiagnostic(async(path,{signal})=>{
  if(count++===0)return {connections:[]};
  return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>{aborted=true;reject(Error('aborted'));},{once:true}));
 },context);
 await observer.finish(tuple);assert.equal(aborted,true);assert.equal(count,2);
});

test('DNS CONNECT evidence matches a numeric target and exact non-HTTPS port',async()=>{
 let count=0,ready;const sampled=new Promise(resolve=>ready=resolve);
 const row=flow();Object.assign(row.metadata,{host:'',destinationIP:'8.8.8.8',destinationPort:853});
 const observer=await observeDiagnostic(async()=>{if(count++===0)return {connections:[]};ready();return {connections:[row]};},{...context,url:'https://8.8.8.8:853/'});
 await sampled;const result=await observer.finish(tuple);assert.equal(result.state,'verified');assert.equal(result.target.port,853);assert.equal(result.target.address,'8.8.8.8');
});

test('UDP evidence cannot be satisfied by a TCP flow with the same source port',async()=>{
 let count=0,ready;const sampled=new Promise(resolve=>ready=resolve);
 const tcp=flow();Object.assign(tcp.metadata,{host:'',destinationIP:'1.1.1.1',destinationPort:53});
 const udp={...tcp,id:'udp-flow',metadata:{...tcp.metadata,network:'udp'}};
 const observer=await observeDiagnostic(async()=>{if(count++===0)return {connections:[]};ready();return {connections:[tcp,udp]};},{...context,url:'https://1.1.1.1:53/',network:'udp'});
 await sampled;const result=await observer.finish(tuple);assert.equal(result.state,'verified');assert.equal(result.connectionId,'udp-flow');
});

test('a null initial connection list is a valid empty mihomo snapshot',async()=>{
 let count=0,ready;const sampled=new Promise(resolve=>ready=resolve);
 const observer=await observeDiagnostic(async()=>{if(count++===0)return {connections:null};ready();return {connections:[flow()]};},context);
 await sampled;assert.equal((await observer.finish(tuple)).state,'verified');
});

test('the final sample can confirm a short-lived flow before the observer stops',async()=>{
 let count=0;
 const observer=await observeDiagnostic(async()=>({connections:++count>=3?[flow()]:[]}),{...context,interval:10000});
 const result=await observer.finish(tuple,{sampleFinal:true});assert.equal(result.state,'verified');assert.equal(count,3);
});
