import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DailyUpdateChecks,updateCheckDay} from '../server/daily-update-checks.js';

test('daily update checks persist across restarts and never install or run before readiness',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'fg-daily-'));let now=1000,calls=0,ready=false,cleared=0;
 const options={path:join(dir,'state.json'),now:()=>now,canRun:()=>ready,check:async()=>{calls++;},setTimer:()=>({unref(){}}),clearTimer:()=>cleared++};
 try{
  const first=new DailyUpdateChecks(options);assert.equal(await first.tick(),false);ready=true;assert.equal(await first.tick(),true);assert.equal(calls,1);first.stop();
  const second=new DailyUpdateChecks(options);assert.equal(await second.tick(),false);now+=updateCheckDay-1;await second.tick();assert.equal(calls,1);now++;await second.tick();assert.equal(calls,2);second.stop();await second.tick();assert.equal(calls,2);assert.equal(cleared,2);
  assert.equal(JSON.parse(readFileSync(options.path)).nextAt,now+updateCheckDay);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('busy, unavailable, concurrent, interrupted and malformed schedules are bounded',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'fg-daily-'));let now=1000,calls=0,release,mode='busy';
 const options={path:join(dir,'state.json'),now:()=>now,setTimer:()=>({unref(){}}),clearTimer:()=>{},check:async()=>{calls++;if(mode==='busy')return false;if(mode==='error')throw Error('private error');if(mode==='waiting')return new Promise(r=>{release=r;});return true;}};
 try{
  writeFileSync(options.path,'corrupt');const job=new DailyUpdateChecks(options);await job.tick();assert.equal(calls,1);await job.tick();assert.equal(calls,1);now+=60000;mode='error';await job.tick();assert.equal(job.nextAt,now+3600000);now+=3599999;await job.tick();assert.equal(calls,2);now++;mode='waiting';const pending=job.tick();await job.tick();assert.equal(calls,3);
  const restarted=new DailyUpdateChecks(options);await restarted.tick();assert.equal(calls,3);restarted.stop();job.stop();release(true);await pending;assert.equal(job.nextAt,now+3600000);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('automatic checks use only check operation and include both catalogs without a browser',async()=>{
 const {Store}=await import('../server/store.js');const {createServer}=await import('../server/index.js');
 const dir=mkdtempSync(join(tmpdir(),'fg-auto-api-')),previous=process.env.FREEDOMGATE_STATE_DIR;process.env.FREEDOMGATE_STATE_DIR=dir;
 const store=new Store(':memory:'),calls=[],sources=[];let busy=false;
 const server=createServer(store,{modulesHelper:async(...args)=>{calls.push(args);return busy?{ok:false,status:409}:{ok:true,accepted:true};},resourceFetch:async url=>{sources.push(String(url));return {ok:true,json:async()=>({sha:'a'.repeat(40)})};}});
 try{
  busy=true;assert.equal(await server.checkUpdates(),false);assert.equal(sources.length,0);busy=false;
  assert.equal(await server.checkUpdates(),true);await new Promise(r=>setImmediate(r));assert.equal(sources.length,2);assert.ok(sources.some(url=>url.includes('MetaCubeX')));assert.ok(calls.every(args=>args[0]==='check' && args[1]===undefined && args[2]===undefined));
 }finally{server.emit('close');await server.cleanup;store.close();if(previous===undefined)delete process.env.FREEDOMGATE_STATE_DIR;else process.env.FREEDOMGATE_STATE_DIR=previous;rmSync(dir,{recursive:true,force:true});}
});
