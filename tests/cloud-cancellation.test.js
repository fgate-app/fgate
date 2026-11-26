import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {Store} from '../server/store.js';import {AccessPointService} from '../server/access-points/service.js';
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const enrollment=server=>({id:server.secrets.instanceId,host:'192.0.2.1',publicPort:20000,transportPort:20001,token:'a'.repeat(64),tlsCert:'fixture'});
async function fixture(action){const dir=mkdtempSync(join(tmpdir(),'fg-cloud-cancel-')),store=new Store(':memory:');let service;
 try{await action(options=>service=new AccessPointService(store,{stateDir:dir,...options}));}finally{await service?.close();store.close();rmSync(dir,{recursive:true,force:true});}}

test('disabling pending cloud enrollment aborts transport and ignores a late successful response',()=>fixture(async create=>{
 const pending=deferred();let signal,starts=0,stops=0;
 const service=create({enroll:(_server,options)=>{signal=options.signal;return pending.promise;},runtime:{start:async()=>{starts++;},stop:async()=>{stops++;},status:async()=> 'stopped',close:async()=>{}}});
 const point=service.repository.all()[0],identity=structuredClone(point);
 await service.setEnabled(point.id,true);assert.equal(service.jobs.size,1);
 await service.setEnabled(point.id,false);assert.equal(signal.aborted,true);assert.equal(service.jobs.size,0);assert.equal(stops,1);
 pending.resolve(enrollment(point));await new Promise(resolve=>setImmediate(resolve));
 const saved=service.repository.get(point.id);assert.equal(saved.enabled,false);assert.equal(saved.stage,null);assert.equal(saved.error,null);assert.equal(saved.state,'stopped');assert.equal(starts,0);assert.deepEqual(saved.clients,identity.clients);assert.deepEqual(saved.secrets,identity.secrets);
}));
test('disabling during runtime startup waits for cleanup and cannot leave a tunnel running',()=>fixture(async create=>{
 const entered=deferred(),starting=deferred();let running=false,policies=[];
 const service=create({enroll:async p=>enrollment(p),prepare:async hosts=>policies.push(hosts),runtime:{start:async()=>{entered.resolve();await starting.promise;running=true;},stop:async()=>{running=false;},status:async()=>running?'active':'stopped',close:async()=>{}}});
 const point=service.repository.all()[0];await service.setEnabled(point.id,true);await entered.promise;
 const disabled=service.setEnabled(point.id,false);assert.equal(service.repository.get(point.id).enabled,false);starting.resolve();await disabled;
 assert.equal(running,false);assert.equal(service.jobs.size,0);assert.equal(service.repository.get(point.id).stage,null);assert.deepEqual(policies.at(-1),[]);
}));
test('a cancelled enrollment cannot overwrite a newer connection or clear its job',()=>fixture(async create=>{
 const old=deferred(),next=deferred();let attempt=0;
 const service=create({enroll:()=>++attempt===1?old.promise:next.promise,runtime:{start:async()=>{},stop:async()=>{},status:async()=> 'stopped',close:async()=>{}}});
 const point=service.repository.all()[0];await service.setEnabled(point.id,true);await service.setEnabled(point.id,false);await service.setEnabled(point.id,true);const job=service.jobs.get(point.id);
 old.reject(Error('late old transport error'));await new Promise(resolve=>setImmediate(resolve));assert.equal(service.jobs.get(point.id),job);assert.equal(service.repository.get(point.id).enabled,true);assert.equal(service.repository.get(point.id).error,null);
 next.resolve({...enrollment(point),token:'b'.repeat(64)});await job;assert.equal(service.jobs.size,0);assert.equal(service.repository.get(point.id).secrets.token,'b'.repeat(64));
}));
test('shutdown cancels a pending cloud connection instead of waiting for its network timeout',()=>fixture(async create=>{
 const pending=deferred();let signal;
 const service=create({enroll:(_p,options)=>{signal=options.signal;return pending.promise;},runtime:{start:async()=>{},stop:async()=>{},status:async()=> 'stopped',close:async()=>{}}});
 const point=service.repository.all()[0];await service.setEnabled(point.id,true);await service.close();assert.equal(signal.aborted,true);assert.equal(service.jobs.size,0);assert.equal(service.repository.get(point.id).enabled,true);
 pending.resolve(enrollment(point));await new Promise(resolve=>setImmediate(resolve));assert.equal(service.repository.get(point.id).host,undefined);
}));

const cache=point=>Object.assign(point,{host:'192.0.2.1',publicPort:20000,transportPort:20001,secrets:{...point.secrets,token:'a'.repeat(64),tlsCert:'-----BEGIN CERTIFICATE-----fixture'}});
test('known cloud relay starts from saved credentials without enrollment and prepares its route first',()=>fixture(async create=>{
 let enrollments=0,prepared=false,started=false;
 const service=create({enroll:async()=>{enrollments++;throw Error('broker unavailable');},prepare:async hosts=>{prepared=hosts.includes('192.0.2.1/32');},runtime:{start:async()=>{assert.equal(prepared,true);started=true;},stop:async()=>{},status:async()=>started?'active':'stopped',close:async()=>{}}});
 const point=cache(service.repository.all()[0]);service.repository.save(point);await service.setEnabled(point.id,true);await Promise.all(service.jobs.values());assert.equal(started,true);assert.equal(enrollments,0);assert.deepEqual(service.repository.get(point.id).clients,point.clients);assert.equal((await service.list())[0].state,'active');
}));
test('a fresh cloud registration prepares the control endpoint route before sending credentials',()=>fixture(async create=>{
 let prepared=[];
 const service=create({prepare:async hosts=>prepared=hosts,enroll:async point=>{assert.ok(prepared.length);return enrollment(point);},runtime:{start:async()=>{},stop:async()=>{},status:async()=> 'active',close:async()=>{}}});
 const point=service.repository.all()[0];point.cloudAddress='https://192.0.2.44:7443';service.repository.save(point);await service.setEnabled(point.id,true);await Promise.all(service.jobs.values());assert.equal(service.repository.get(point.id).error,null);
}));
test('a stalled cached relay retries registration but an active relay survives broker failure',()=>fixture(async create=>{
 let active=true,enrollments=0;
 const service=create({enroll:async()=>{enrollments++;active=true;throw Error('broker unavailable');},runtime:{start:async()=>{},waitActive:async()=>active,stop:async()=>{},status:async()=>active?'active':'connecting',close:async()=>{}}});
 const point=cache(service.repository.all()[0]);service.repository.save(point);await service.setEnabled(point.id,true);await Promise.all(service.jobs.values());assert.equal(enrollments,0);
 active=false;service.connectAttempts.set(point.id,Date.now()-31000);await service.reconcile();await Promise.all(service.jobs.values());assert.equal(enrollments,1);assert.equal(service.repository.get(point.id).error,null);assert.equal((await service.list())[0].state,'active');
}));

test('cloud relay tries direct first then available gateways and preserves the selected path for key edits',()=>fixture(async create=>{
 let last,starts=[];const routes=[{id:'invalid',port:1,secret:'a'.repeat(64)},{id:'one',port:28001,secret:'a'.repeat(64)},{id:'two',port:28002,secret:'b'.repeat(64)}];
 const service=create({gateways:()=>routes,enroll:async()=>{throw Error('broker unavailable');},runtime:{start:async(_p,{gateway})=>{last=gateway;starts.push(gateway?.id || 'direct');},waitActive:async()=>last?.id==='two',stop:async()=>{},status:async()=> 'active',close:async()=>{}}});
 const point=cache(service.repository.all()[0]);service.repository.save(point);await service.setEnabled(point.id,true);await Promise.all(service.jobs.values());assert.deepEqual(starts,['direct','one','two']);assert.equal(service.repository.get(point.id).error,null);
 routes[2].secret='c'.repeat(64);await service.addClient(point.id,{name:'New client'});assert.equal(starts.at(-1),'two');assert.equal(last.secret,'c'.repeat(64));
}));
test('healthy direct cloud access does not use an external gateway',()=>fixture(async create=>{
 const starts=[];const service=create({gateways:()=>[{id:'one',port:28001,secret:'a'.repeat(64)}],runtime:{start:async(_p,{gateway})=>starts.push(gateway?.id || 'direct'),waitActive:async()=>true,stop:async()=>{},status:async()=> 'active',close:async()=>{}}});
 const point=cache(service.repository.all()[0]);service.repository.save(point);await service.setEnabled(point.id,true);await Promise.all(service.jobs.values());assert.deepEqual(starts,['direct']);
}));
