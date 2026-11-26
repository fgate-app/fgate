import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mergeLatencySamples,loadLatencyHistory,saveLatencyHistory} from '../web/src/lib/latency-history.js';
test('latency history normalizes timestamps, removes duplicates and retains 24 newest checks',()=>{
 const samples=Array.from({length:40},(_,i)=>({time:new Date(1000*i).toISOString(),delay:i+1}));
 const merged=mergeLatencySamples(samples,[samples[39],{time:'bad',delay:5},{time:samples[0].time,delay:-2}]);
 assert.equal(merged.length,24);assert.deepEqual(merged[0],samples[16]);assert.deepEqual(merged.at(-1),samples[39]);
});
test('saved histories survive reload, isolate gateways/groups and tolerate invalid or blocked storage',()=>{
 const values=new Map();globalThis.localStorage={getItem:key=>values.get(key),setItem:(key,value)=>values.set(key,value)};
 try{
  const history={http:[{time:'2026-11-12T10:00:00.000Z',delay:34}],udp:[{time:'2026-11-12T10:00:00.000Z',delay:null}]};
  saveLatencyHistory('profile:a',history);assert.deepEqual(loadLatencyHistory('profile:a'),history);assert.deepEqual(loadLatencyHistory('group:a'),{http:[],udp:[]});
  values.set('fg.latency-history.v1:profile:a','broken');assert.deepEqual(loadLatencyHistory('profile:a'),{http:[],udp:[]});
  globalThis.localStorage={getItem(){throw Error('blocked');},setItem(){throw Error('blocked');}};
  assert.doesNotThrow(()=>saveLatencyHistory('profile:a',history));assert.deepEqual(loadLatencyHistory('profile:a'),{http:[],udp:[]});
 }finally{delete globalThis.localStorage;}
});
