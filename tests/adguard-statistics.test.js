import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeAdGuardStatistics} from '../server/adguard-statistics.js';

const fixture={time_units:'hours',num_dns_queries:3,num_blocked_filtering:1,dns_queries:[1,2],blocked_filtering:[0,1]};
test('AdGuard history retains native hourly and daily buckets aligned to time',()=>{
 for(const [units,interval] of [['hours',3600000],['days',86400000]]){
  const now=Date.UTC(2026,10,14,13,25);
  const result=normalizeAdGuardStatistics({...fixture,time_units:units},now);
  assert.equal(result.interval,interval);
  assert.equal(result.samples[1].time,Math.floor(now/interval)*interval);
  assert.equal(result.samples[1].time-result.samples[0].time,interval);
  assert.deepEqual(result.samples.map(s=>s.blocked),[0,1]);
 }
});
test('AdGuard missing or malformed counters stay unknown and invalid histories are rejected',()=>{
 const result=normalizeAdGuardStatistics({...fixture,num_dns_queries:-1,num_blocked_filtering:'1',dns_queries:[NaN,2],blocked_filtering:[0]});
 assert.equal(result.queries,null);assert.equal(result.blocked,null);
 assert.equal(result.samples[0].queries,null);assert.equal(result.samples[1].blocked,null);
 for(const value of [null,{}, {...fixture,time_units:'minutes'},{...fixture,dns_queries:null}])assert.throws(()=>normalizeAdGuardStatistics(value));
 assert.deepEqual(normalizeAdGuardStatistics({...fixture,dns_queries:[],blocked_filtering:[]}).samples,[]);
});
