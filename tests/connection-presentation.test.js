import test from 'node:test';
import assert from 'node:assert/strict';
import {describeConnections} from '../server/connection-presentation.js';
import {clientActivity} from '../server/client-status.js';

test('open socket of a disconnected device is not treated as evidence of online presence',()=>{
 const clients=clientActivity([{ip:'10.20.0.200',mac:'aa:bb:cc:dd:ee:ff',hostname:'Redmi'}],{kind:'ap',online:new Set()},{available:true,clients:{'aa:bb:cc:dd:ee:ff':{upload:100,download:200}}});
 const [row]=describeConnections([{id:'idle',sourceIP:'10.20.0.200',active:true,type:'Tun'}],{clients,interfaces:{}});
 assert.equal(row.clientOnline,false);assert.equal(row.sourceName,'Redmi');assert.equal(row.sourceKind,'device');assert.equal(row.active,true,'transport remains open until mihomo closes it');
 assert.deepEqual(clients[0].traffic,{upload:100,download:200},'disconnect does not erase cumulative usage');
});

test('internal, loopback and local interface traffic is identified separately from devices and remote peers',()=>{
 const inputs=[{type:'Inner',sourceIP:''},{type:'HTTPS',sourceIP:'127.0.0.1'},{type:'Tun',sourceIP:'192.168.1.86'},{type:'Tun',sourceIP:'10.20.0.201'}];
 const rows=describeConnections(inputs,{interfaces:{eth0:[{address:'192.168.1.86'}]}});
 assert.deepEqual(rows.map(row=>row.sourceKind),['service','service','service','unknown']);
 assert.ok(rows.slice(0,3).every(row=>row.sourceName==='FreedomGate'));
 assert.equal(rows[3].clientOnline,null,'unknown source is not declared offline');
});
