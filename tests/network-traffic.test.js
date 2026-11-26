import test from 'node:test';
import assert from 'node:assert/strict';
import {createInterfaceTraffic} from '../server/network-traffic.js';
import {formatNetworkRate,interfaceRates} from '../web/src/lib/network-traffic.js';

test('interface rates use elapsed time, per-interface counters and a shared cached sample',async()=>{
 let time=0,calls=0,rows=[{name:'eth0',index:'2',receive:9007199254740993n,transmit:100n},{name:'eth0.20',index:'4',receive:100n,transmit:100n}];
 const collect=createInterfaceTraffic({now:()=>time,read:async()=>{calls++;return rows;}});
 assert.equal((await collect()).interfaces.eth0.receiveRate,null);
 time=500;await collect();assert.equal(calls,1);
 time=2000;rows=[{...rows[0],receive:rows[0].receive+4096n,transmit:2100n},{...rows[1],receive:1124n,transmit:100n}];
 const [a,b]=await Promise.all([collect(),collect()]);assert.deepEqual(a,b);assert.equal(calls,2);
 assert.deepEqual(a.interfaces.eth0,{receiveRate:2048,transmitRate:1000});assert.equal(a.interfaces['eth0.20'].receiveRate,512);
 assert.deepEqual(interfaceRates(a.interfaces,'eth0',true),{upload:1000,download:2048});
 assert.deepEqual(interfaceRates(a.interfaces,'eth0.20'),{upload:512,download:0});
});
test('counter resets, recreated/missing interfaces and read failures discard stale rates',async()=>{
 let time=0,rows=[{name:'eth0',index:'2',receive:100n,transmit:100n}],failure=false;
 const collect=createInterfaceTraffic({cacheMs:0,now:()=>time,read:async()=>{if(failure)throw Error('Unavailable');return rows;}});
 await collect();time=1000;rows=[{...rows[0],receive:50n}];assert.equal((await collect()).interfaces.eth0.receiveRate,null);
 time=2000;rows=[{...rows[0],index:'5',receive:1000n}];assert.equal((await collect()).interfaces.eth0.receiveRate,null);
 time=3000;rows=[];assert.deepEqual((await collect()).interfaces,{});
 time=4000;rows=[{name:'eth0'}];assert.equal((await collect()).interfaces.eth0.receiveRate,null);
 time=5000;failure=true;assert.deepEqual((await collect()).interfaces,{});
 assert.equal(formatNetworkRate(null,x=>x),'—');assert.equal(formatNetworkRate(0,x=>x),'0 Б/с');assert.equal(formatNetworkRate(2048,x=>x),'2 КБ/с');
});
