import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {restoreStartup,runtimeStartupStages,startupLogger} from '../server/startup.js';

test('startup retries only the failing stage and validates false restore results',async()=>{
  const calls=[],events=[];let attempts=0,ready=false;
  const result=await restoreStartup([
    {name:'prepare',run:()=>calls.push('prepare')},
    {name:'engine',run:()=>{calls.push('engine');return {ok:++attempts===3,error:'secret-password'};}},
    {name:'verify',run:()=>calls.push('verify')},
  ],{log:event=>events.push(event),wait:async ms=>calls.push(ms),onReady:()=>{ready=true;}});
  assert.deepEqual(result,{ok:true});assert.equal(ready,true);
  assert.deepEqual(calls,['prepare','engine',2000,'engine',5000,'engine','verify']);
  assert.equal(events.filter(event=>event.state==='failed').length,2);
  assert.doesNotMatch(JSON.stringify(events),/secret-password/);
});

test('exhausted prepare failure never proceeds or marks runtime ready; logs omit secrets',async()=>{
  let ready=false,later=false;const events=[];
  const result=await restoreStartup([
    {name:'prepare',run:()=>{throw Object.assign(Error('private config'),{code:'secret-token'});}},
    {name:'engine',run:()=>{later=true;}},
  ],{wait:async()=>{},log:event=>events.push(event),onReady:()=>{ready=true;}});
  assert.deepEqual(result,{ok:false,stage:'prepare'});assert.equal(ready,false);assert.equal(later,false);
  assert.equal(events.filter(event=>event.stage==='prepare'&&event.state==='started').length,3);
  assert.doesNotMatch(JSON.stringify(events),/private config|secret-token/);
});

test('shutdown cancels retry backoff and cannot make readiness true',async()=>{
  const controller=new AbortController();let ready=false,attempts=0;
  await assert.rejects(restoreStartup([{name:'engine',run:()=>{attempts++;return {ok:false};}}],{
    signal:controller.signal,log:()=>{},onReady:()=>{ready=true;},
    wait:async()=>{controller.abort();controller.signal.throwIfAborted();},
  }),{name:'AbortError'});
  assert.equal(ready,false);assert.equal(attempts,1);
});

test('startup waits for network and verifies actual engine state before readiness',async()=>{
  const calls=[];let releaseNetwork;
  const network=new Promise(resolve=>{releaseNetwork=resolve;});
  const stages=runtimeStartupStages({
    store:{networkSettings:()=>({}),staticLeases:()=>[],zapretSettings:()=>({}),dnsSettings:()=>({})},
    networkEnabled:true,applyNetwork:()=>{calls.push('network');return network;},
    applyZapret:()=>{calls.push('zapret');return {ok:true};},
    applyRoutes:()=>{calls.push('routes');},
    supervisor:{restore:()=>{calls.push('mihomo');return {ok:true};},status:()=>({state:'running',xray:{state:'stopped'}})},
    accessPoints:{restore:()=>{calls.push('keys');}},
    filter:{restore:()=>{calls.push('adguard');return {ok:true};},status:()=>({state:'error'})},
    filterPolicy:{change:()=>{calls.push('policy');}},
  });
  let ready=false;
  const pending=restoreStartup(stages,{log:()=>{},retryDelays:[],onReady:()=>{ready=true;}});
  assert.deepEqual(calls,['network']);releaseNetwork({ok:true});
  assert.deepEqual(await pending,{ok:false,stage:'runtime-verify'});assert.equal(ready,false);
  assert.deepEqual(calls,['network','zapret','routes','mihomo','keys','adguard','policy','routes']);
});

test('startup evidence survives new logger instances and rotates at a bounded size',()=>{
  const directory=mkdtempSync(join(tmpdir(),'fg-startup-'));const path=join(directory,'startup.jsonl');
  try{
    startupLogger({directory,output:()=>{}})({stage:'mihomo',state:'failed'});
    startupLogger({directory,output:()=>{}})({stage:'mihomo',state:'completed'});
    assert.equal(readFileSync(path,'utf8').trim().split('\n').length,2);
    writeFileSync(path,'x'.repeat(1024*1024));
    startupLogger({directory,output:()=>{}})({stage:'runtime',state:'completed'});
    assert.equal(JSON.parse(readFileSync(path,'utf8')).stage,'runtime');
    assert.equal(readFileSync(path+'.previous').length,1024*1024);
  }finally{rmSync(directory,{recursive:true,force:true});}
});

test('fresh startup skips an unsaved LAN while saved network settings retain restoration',async()=>{
 const {Store}=await import('../server/store.js'),store=new Store(':memory:');let applied=0;
 try{
  const options={store,networkEnabled:true,applyNetwork:()=>{applied++;return {ok:true};},applyZapret:()=>({ok:true}),applyRoutes:()=>{},supervisor:{restore:()=>({ok:true}),status:()=>({state:'running'})},accessPoints:{restore:()=>{}},filter:{restore:()=>({ok:true}),status:()=>({state:'running'})},filterPolicy:{change:()=>{}}};
  assert.equal(store.hasNetworkSettings(),false);let ready=false;const stages=runtimeStartupStages(options);assert.ok(!stages.some(row=>row.name==='network'));assert.equal((await restoreStartup(stages,{log:()=>{},onReady:()=>{ready=true;}})).ok,true);assert.equal(ready,true);assert.equal(applied,0);
  const interfaces=[{name:'enp1s0',type:'ethernet',carrier:true,addresses:['192.0.2.1/24']},{name:'enp2s0',type:'ethernet',carrier:false,addresses:[]}];
  store.updateNetworkSettings({uplink:{interface:'enp1s0'},client:{interface:'enp2s0',type:'ethernet',subnet:'10.10.0.1/24'},dhcp:{start:'10.10.0.100',end:'10.10.0.200'}},interfaces);
  assert.equal(store.hasNetworkSettings(),true);assert.ok(runtimeStartupStages(options).some(row=>row.name==='network'));await restoreStartup(runtimeStartupStages(options),{log:()=>{}});assert.equal(applied,1);
 }finally{store.close();}
});
