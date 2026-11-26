import test from 'node:test';
import assert from 'node:assert/strict';
import {mergeMetricSamples,loadMetricHistory,saveMetricHistory} from '../web/src/lib/metric-history.js';
test('metric history restores only recent valid samples and tolerates old or corrupt storage',()=>{
 const now=1000000,values=new Map();globalThis.localStorage={getItem:k=>values.get(k),setItem:(k,v)=>values.set(k,v)};
 const samples=mergeMetricSamples([[{time:now-300001,cpu:10},{time:now+1,cpu:10},{time:now,cpu:40,memory:80,upload:123,download:456},{time:now,cpu:45,memory:101,upload:-1}]],now);
 assert.deepEqual(samples,[{time:now,cpu:45,memory:null,upload:null,download:null}]);
 saveMetricHistory('admin',samples);assert.deepEqual(loadMetricHistory('admin',now),samples);assert.deepEqual(loadMetricHistory('other',now),[]);
 values.set('fg.metric-history.v1:admin','invalid');assert.deepEqual(loadMetricHistory('admin',now),[]);
 values.set('fg.metric-history.v1:admin','{}');assert.deepEqual(loadMetricHistory('admin',now),[]);
 globalThis.localStorage={getItem(){throw Error('blocked');},setItem(){throw Error('blocked');}};assert.deepEqual(loadMetricHistory('admin',now),[]);saveMetricHistory('admin',samples);
 delete globalThis.localStorage;
});
