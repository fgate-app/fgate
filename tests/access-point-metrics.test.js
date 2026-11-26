import test from 'node:test';
import assert from 'node:assert/strict';
import {AccessPointRuntime} from '../server/access-points/runtime.js';
test('access point traffic sampling fetches metrics and retains the runtime generation',async t=>{
 const runtime=new AccessPointRuntime({stateDir:'/unused'}),entry={metricsPort:12345,generation:'test-generation'};
 runtime.entries.set('cloud',entry);let observed;
 t.mock.method(globalThis,'fetch',async(url,options)=>{assert.equal(url,'http://127.0.0.1:12345/debug/vars');assert.ok(options.signal instanceof AbortSignal);return {ok:true,json:async()=>({stats:{user:{client:{uplink:12,downlink:34}}}})};});
 runtime.onTraffic=(...args)=>{observed=args;};await runtime.sample('cloud');
 assert.deepEqual(observed,['cloud','test-generation',{client:{uplink:12,downlink:34}}]);assert.equal(entry.sampling,null);
});
