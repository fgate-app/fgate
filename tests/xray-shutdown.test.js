import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {XraySupervisor} from '../server/xray.js';

test('supervisor cleanup completes when a child already exited by signal',async()=>{
 const folder=await mkdtemp(join(tmpdir(),'fg-shutdown-'));
 const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)']);
 try{
  await once(child,'spawn');const exited=once(child,'exit');child.kill('SIGTERM');await exited;
  assert.equal(child.exitCode,null);assert.equal(child.signalCode,'SIGTERM');
  const supervisor=new XraySupervisor({stateDir:folder});const entryFolder=join(folder,'entry');await mkdir(entryFolder);
  supervisor.entries.set('test',{folder:entryFolder,process:child});
  await Promise.race([supervisor.stop(),new Promise((_,reject)=>{const timer=setTimeout(()=>reject(new Error('shutdown hung')),500);timer.unref();})]);
  assert.equal(supervisor.entries.size,0);
 }finally{child.kill('SIGKILL');await rm(folder,{recursive:true,force:true});}
});

test('shutdown cancels both bridge supervisors while the other is still stopping',async()=>{
 const {MihomoSupervisor}=await import('../server/mihomo.js');let release,ssStopped=false;
 const gate=new Promise(resolve=>{release=resolve;});
 const supervisor=new MihomoSupervisor({binary:'/missing/mihomo',xray:{stop:()=>gate},ssRelay:{stop:async()=>{ssStopped=true;}}});
 const stopping=supervisor.stop();
 try{await Promise.resolve();assert.equal(ssStopped,true);}finally{release();await stopping;}
});
test('a restart timer contains filesystem failures and schedules another attempt',t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 const supervisor=new XraySupervisor();const entry={id:'broken',process:null,retries:0,stopping:false};
 supervisor.entries.set(entry.id,entry);let starts=0;
 supervisor.start=()=>{starts++;throw Object.assign(new Error('fixture denied'),{code:'EACCES'});};
 supervisor.scheduleRestart(entry);t.mock.timers.tick(1000);
 assert.equal(starts,1);assert.equal(entry.process,null);assert.equal(entry.retries,2);
 entry.stopping=true;clearTimeout(entry.timer);t.mock.timers.tick(30000);assert.equal(starts,1);
});
