import test from 'node:test';
import assert from 'node:assert/strict';
import {DomainListUpdates} from '../server/domain-list-updates.js';
test('domain catalogs check pinned commit and update only the checked revision',async()=>{
 let current='a'.repeat(40);const next='b'.repeat(40),updater=new DomainListUpdates({current:()=>current,update:async ref=>{current=ref;},fetchImpl:async()=>({ok:true,json:async()=>({sha:next})})});
 updater.start('check');await updater.task;assert.equal(updater.row.state,'available');assert.throws(()=>updater.start('update','main'),/updates first/);updater.start('update',next);await updater.task;assert.equal(updater.row.state,'updated');assert.equal(current,next);
 updater.start('check');await updater.task;assert.equal(updater.row.state,'current');
});
test('failed catalog download preserves the current revision and allows retry',async()=>{
 const current='a'.repeat(40),next='b'.repeat(40),updater=new DomainListUpdates({current:()=>current,update:async()=>{throw new Error('network failed');},fetchImpl:async()=>({ok:true,json:async()=>({sha:next})})});
 updater.start('check');await updater.task;updater.start('update',next);await updater.task;assert.equal(updater.row.state,'error');assert.equal(updater.snapshot().current,current.slice(0,7));updater.start('check');await updater.task;assert.equal(updater.row.state,'available');
});
