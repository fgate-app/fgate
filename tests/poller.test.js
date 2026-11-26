import test from 'node:test';
import assert from 'node:assert/strict';
import {createPoller} from '../web/src/lib/poller.js';
const flush=()=>new Promise(resolve=>setImmediate(resolve));
test('poller serializes requests, cancels timers, and ignores stale successes and errors',async()=>{
 const requests=[],data=[],errors=[],timers=new Map();let next=0;
 const poller=createPoller({interval:5000,request:signal=>new Promise((resolve,reject)=>requests.push({signal,resolve,reject})),onData:value=>data.push(value),onError:error=>errors.push(error),schedule:(fn,delay)=>{assert.equal(delay,5000);timers.set(++next,fn);return next;},cancel:id=>timers.delete(id)});
 poller.start();assert.equal(requests.length,1);assert.equal(timers.size,0);
 poller.start();assert.ok(requests[0].signal.aborted);requests[0].resolve('stale');await flush();assert.deepEqual(data,[]);assert.equal(timers.size,0);
 requests[1].resolve('current');await flush();assert.deepEqual(data,['current']);assert.equal(timers.size,1);
 const [id,callback]=[...timers][0];timers.delete(id);callback();assert.equal(requests.length,3);
 poller.stop();requests[2].reject(Error('late failure'));await flush();assert.deepEqual(errors,[]);assert.equal(timers.size,0);
 poller.start();requests[3].reject(Error('offline'));await flush();assert.equal(errors[0].message,'offline');assert.equal(timers.size,1);poller.stop();assert.equal(timers.size,0);
});
