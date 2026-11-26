// Run as root in a fresh network namespace with loopback up; uses no production state.
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {Store} from '../server/store.js';
import {MihomoSupervisor} from '../server/mihomo.js';
import {AdGuardSupervisor} from '../server/adguard.js';
import {FilterPolicy} from '../server/filter-policy.js';
import {applyRoutesIfReady} from '../server/route-runtime.js';
import {restoreStartup,runtimeStartupStages} from '../server/startup.js';
const directory=mkdtempSync('/tmp/fg-startup-native-');
const store=new Store(':memory:'),supervisor=new MihomoSupervisor({stateDir:directory}),filter=new AdGuardSupervisor({stateDir:directory});
const events=[];let attempts=0,ready=false;
const restore=supervisor.restore.bind(supervisor);
supervisor.restore=settings=>++attempts===1?{ok:false,error:'Transient fixture'}:restore(settings);
try{
 const stages=runtimeStartupStages({store,supervisor,filter,accessPoints:{restore:async()=>{}},networkEnabled:false,applyRoutes:applyRoutesIfReady,filterPolicy:new FilterPolicy(store,filter)});
 const result=await restoreStartup(stages,{retryDelays:[100,200],log:event=>events.push(event),onReady:()=>{ready=true;}});
 assert.deepEqual(result,{ok:true});assert.equal(ready,true);assert.equal(attempts,2);
 assert.equal(supervisor.status().state,'running');assert.equal(filter.status().state,'running');
 assert.equal(events.filter(event=>event.stage==='routes-prepare'&&event.state==='started').length,1);
 assert.ok(events.some(event=>event.stage==='mihomo'&&event.state==='failed'));
 console.log('PASS: real ARM64 mihomo and AdGuard restore offline in isolated namespace; transient restore failure recovers and readiness follows verification.');
}finally{await Promise.allSettled([filter.stop(),supervisor.stop()]);store.close();rmSync(directory,{recursive:true,force:true});}
