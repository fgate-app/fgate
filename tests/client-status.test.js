import test from 'node:test';import assert from 'node:assert/strict';
import {clientPresence,clientActivity} from '../server/client-status.js';import {createRouteTrafficCollector} from '../server/route-traffic.js';
test('presence distinguishes associated stations from remembered leases and handles unavailable probes',async()=>{
 const setup={client:{interface:'wlan0',type:'ap'}};
 const presence=await clientPresence(setup,{run:async()=>({stdout:'Station AA:BB:CC:DD:EE:FF (on wlan0)\n'})});
 const rows=[{mac:'aa:bb:cc:dd:ee:ff'},{mac:'11:22:33:44:55:66'}];
 assert.deepEqual(clientActivity(rows,presence,null).map(c=>c.online),[true,false]);
 assert.equal(await clientPresence(setup,{run:async()=>{throw Error('Unavailable');}}),null);
 assert.equal(clientActivity(rows,null,null)[0].online,null);
 const wired=await clientPresence({client:{interface:'eth0',type:'ethernet'}},{run:async()=>({stdout:JSON.stringify([{lladdr:rows[0].mac,state:['REACHABLE']},{lladdr:rows[1].mac,state:['STALE']}])})});
 assert.deepEqual(clientActivity(rows,wired,null).map(c=>c.online),[true,null]);
});
test('client traffic follows MAC across flows/IP changes, includes unowned direct traffic and retains closed flow bytes',async()=>{
 let clients=[{mac:'aa:bb:cc:dd:ee:ff',ip:'10.20.0.1'}],flows=[{id:'one',upload:10,download:100,metadata:{sourceIP:'10.20.0.1'}}];
 const collector=createRouteTrafficCollector(async path=>path==='/rules'?{rules:[]}:{connections:flows},{clients:()=>clients});collector.setOwners([]);
 await collector.sample();await collector.sample();assert.deepEqual(collector.snapshot().clients[clients[0].mac],{upload:10,download:100});
 flows=[];await collector.sample();clients[0].ip='10.20.0.2';flows=[{id:'two',upload:5,download:20,metadata:{sourceIP:'10.20.0.2'}}];await collector.sample();
 assert.deepEqual(collector.snapshot().clients[clients[0].mac],{upload:15,download:120});
 assert.deepEqual(clientActivity(clients,null,collector.snapshot())[0].traffic,{upload:15,download:120});
});

test('presence merges AP stations and wired VLAN neighbours without marking unknown clients offline',async()=>{
 const calls=[];
 const setup={client:{interface:'wlan0',type:'ap'},wired:{enabled:true,interface:'eth0',vlanId:20}};
 const presence=await clientPresence(setup,{run:async(command,args)=>{calls.push([command,...args]);return {stdout:command==='iw'?'Station AA:BB:CC:DD:EE:FF (on wlan0)\n':JSON.stringify([{lladdr:'11:22:33:44:55:66',state:['REACHABLE']}])};}});
 assert.deepEqual([...presence.online],['aa:bb:cc:dd:ee:ff','11:22:33:44:55:66']);
 assert.ok(calls.some(call=>call.includes('eth0.20')));
 assert.equal(clientActivity([{mac:'00:00:00:00:00:00'}],presence,null)[0].online,null);
});
