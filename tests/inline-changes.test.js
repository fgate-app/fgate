import test from 'node:test';
import assert from 'node:assert/strict';
import {InlineChanges} from '../server/inline-changes.js';
test('inline changes apply once after five quiet seconds; every change resets the same server timer',async t=>{
 t.mock.timers.enable({apis:['setTimeout','Date']});let calls=0,edits=0;const queue=new InlineChanges(async()=>{calls++;});
 try{
  await queue.change(()=>edits++);assert.equal(queue.status().deadline-Date.now(),5000);assert.equal(edits,1);assert.equal(calls,0);
  t.mock.timers.tick(4000);await queue.change(()=>edits++);t.mock.timers.tick(4999);await queue.tail;assert.equal(calls,0);
  t.mock.timers.tick(1);await queue.tail;assert.equal(calls,1);assert.equal(edits,2);assert.equal(queue.status().state,'applied');
  t.mock.timers.tick(10000);await queue.tail;assert.equal(calls,1);
 }finally{queue.close();}
});
test('invalid actions do not postpone valid changes; closing cancels timers; failures are visible and recover on the next change',async t=>{
 t.mock.timers.enable({apis:['setTimeout','Date']});let fail=true;const queue=new InlineChanges(async()=>{if(fail)throw Error('fixture');});
 await queue.change(()=>{});const deadline=queue.status().deadline;await assert.rejects(queue.change(()=>{throw Error('invalid');}));assert.equal(queue.status().deadline,deadline);
 t.mock.timers.tick(5000);await queue.tail;assert.equal(queue.status().state,'error');assert.equal(queue.status().error,'fixture');
 fail=false;await queue.change(()=>{});t.mock.timers.tick(5000);await queue.tail;assert.equal(queue.status().state,'applied');
 await queue.change(()=>{});queue.close();t.mock.timers.tick(5000);await queue.tail;assert.equal(queue.status().state,'pending');
});
