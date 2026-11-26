import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../server/store.js';
import {AccessPointTraffic} from '../server/access-points/traffic.js';
import {AccessPointService} from '../server/access-points/service.js';
import {accessUsername} from '../server/access-points/identity.js';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';
test('access traffic persists cumulative bytes, includes closed flows, deduplicates samples and handles engine restart',()=>{
 const store=new Store(':memory:');try{let traffic=new AccessPointTraffic(store.db);
 traffic.observe('a','first',{'phone@freedomgate':{uplink:10,downlink:100}});traffic.observe('a','first',{'phone@freedomgate':{uplink:10,downlink:100}});
 assert.deepEqual(traffic.total('a'),{upload:10,download:100});traffic=new AccessPointTraffic(store.db);traffic.observe('a','first',{'phone@freedomgate':{uplink:15,downlink:130}});traffic.observe('a','second',{'phone@freedomgate':{uplink:2,downlink:20}});
 assert.deepEqual(traffic.clients('a').phone,{upload:17,download:150});assert.deepEqual(traffic.total('b'),{upload:0,download:0});
 }finally{store.close();}
});
test('online clients count distinct active keys, isolate points and identify journal sources without exposing credentials',async()=>{
 const store=new Store(':memory:'),dir=mkdtempSync(join(tmpdir(),'fg-ap-counters-'));
 const service=new AccessPointService(store,{stateDir:dir,runtime:{status:async()=> 'active',close:async()=>{}}});
 try{const point=service.repository.all()[0];point.enabled=true;point.host='127.0.0.1';service.repository.save(point);const key=point.clients[0];
 const flow={active:true,inboundName:'fg-remote',inboundUser:accessUsername(point.id,key.id)};
 service.connections=()=>({available:true,connections:[flow,{...flow}, {...flow,inboundUser:accessUsername('another',key.id)}]});
 assert.equal((await service.list())[0].activeClients,1);assert.equal((await service.remoteClients())[0].online,true);assert.equal(service.describe([flow])[0].accessClientId,key.id);
 service.connections=()=>({available:true,connections:[{...flow,active:false}]});assert.equal((await service.list())[0].activeClients,0);
 service.connections=()=>({available:false,connections:[flow]});assert.equal((await service.list())[0].activeClients,null);
 }finally{await service.close();store.close();rmSync(dir,{recursive:true,force:true});}
});

test('access traffic survives closing and reopening the on-disk database',()=>{
 const dir=mkdtempSync(join(tmpdir(),'fg-ap-persist-'));let store=new Store(join(dir,'db.sqlite'));
 try{let traffic=new AccessPointTraffic(store.db);traffic.observe('a','first',{'phone@freedomgate':{uplink:7,downlink:50}});store.close();store=new Store(join(dir,'db.sqlite'));traffic=new AccessPointTraffic(store.db);assert.deepEqual(traffic.total('a'),{upload:7,download:50});traffic.observe('a','second',{'phone@freedomgate':{uplink:1,downlink:10}});assert.deepEqual(traffic.total('a'),{upload:8,download:60});}finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
