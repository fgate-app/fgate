import test from 'node:test';
import assert from 'node:assert/strict';
import {diagnoseEndpoint} from '../server/endpoint-diagnostics.js';
const success={state:'ok',complete:true,results:[]};
test('literal endpoints skip DNS and probes cannot expand the configured port or leak credentials',async()=>{
 const calls=[];
 const result=await diagnoseEndpoint({host:'203.0.113.7',port:44127},{resolve:()=>{throw Error('must skip');},probe:async value=>{calls.push(value);return success;}});
 assert.deepEqual(calls,[{addresses:['203.0.113.7'],port:44127}]);assert.equal(result.bootstrap.method,'literal-address');assert.equal(result.complete,true);
});
test('all A/AAAA addresses are deduplicated and bounded; system DNS path is explicitly unverified',async()=>{
 const rows=[{address:'203.0.113.7'},{address:'2001:db8::7'},{address:'203.0.113.7'},...Array.from({length:10},(_,i)=>({address:`203.0.113.${i+20}`}))];
 let selected;
 const result=await diagnoseEndpoint({host:'proxy.example',port:443},{resolve:async()=>rows,probe:async value=>{selected=value;return success;}});
 assert.equal(selected.addresses.length,8);assert.equal(result.resolvedAddressCount,12);assert.equal(result.truncated,true);assert.equal(result.complete,false);assert.equal(result.bootstrap.pathVerified,false);
});
test('DNS timeout, cancellation and helper failure do not fall back to an unbound connection',async()=>{
 let called=false;const probe=async()=>{called=true;throw Error('must not call');};
 const failed=await diagnoseEndpoint({host:'proxy.example',port:443},{resolve:()=>new Promise(()=>{}),timeout:5,probe});
 assert.equal(failed.bootstrap.reason,'timeout');assert.equal(called,false);
 const controller=new AbortController();controller.abort();
 await assert.rejects(diagnoseEndpoint({host:'203.0.113.7',port:443},{signal:controller.signal,probe}),{code:'ABORTED'});assert.equal(called,false);
 const unavailable=await diagnoseEndpoint({host:'203.0.113.7',port:443},{probe:async()=>{throw Error('private details');}});
 assert.equal(unavailable.reason,'endpoint-probe-unavailable');assert.equal(JSON.stringify(unavailable).includes('private details'),false);
 assert.equal((await diagnoseEndpoint(null)).state,'unavailable');
});

test('gateway endpoint extraction omits credentials and skips UDP-only profiles',async()=>{
 const {gatewayPeer}=await import('../server/endpoint-diagnostics.js');
 assert.deepEqual(gatewayPeer({profile:{builtin:0},config:{engine:'socks5',config:'socks5://private-user:private-password@203.0.113.7:1080'}}),{host:'203.0.113.7',port:1080});
 assert.equal(gatewayPeer({profile:{builtin:0},config:{engine:'mihomo',config:JSON.stringify({type:'wireguard',server:'203.0.113.7',port:51820,'private-key':'private-key'})}}),null);
});

test('synthetic DNS addresses never become direct TCP targets or evidence of IP blocking',async()=>{
 let called=false;
 const result=await diagnoseEndpoint({host:'proxy.example',port:443},{fakeIpRanges:['10.99.0.1/16'],resolve:async()=>[{address:'10.99.0.12'}],probe:()=>{called=true;}});
 assert.equal(called,false);assert.equal(result.reason,'synthetic-dns-address');assert.equal(result.state,'unavailable');
 const mixed=await diagnoseEndpoint({host:'proxy.example',port:443},{fakeIpRanges:['10.99.0.1/16'],resolve:async()=>[{address:'10.99.0.12'},{address:'203.0.113.7'}],probe:async({addresses})=>{assert.deepEqual(addresses,['203.0.113.7']);return success;}});
 assert.equal(mixed.complete,false);assert.equal(mixed.bootstrap.state,'partial');assert.equal(mixed.resolvedAddressCount,2);
});
