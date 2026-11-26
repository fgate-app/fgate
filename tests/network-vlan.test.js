import test from 'node:test';
import assert from 'node:assert/strict';
import {validateNetworkSetup} from '../server/network.js';
import {logicalInterface,normalizeNetworkSetup} from '../shared/network.js';
import {runtimeNetworks,multiDnsmasqConfig,multiNftConfig} from '../server/network-runtime.js';
const interfaces=[{name:'eth0',type:'ethernet',carrier:true,addresses:['192.168.1.86/24']},{name:'wlan0',type:'wifi',state:'up'},{name:'eth1',type:'ethernet'}];
const legacy={uplink:{interface:'eth0'},client:{interface:'wlan0',type:'ap',ssid:'fgate',password:'testpass123',subnet:'10.20.0.1/24'},dhcp:{start:'10.20.0.100',end:'10.20.0.200'}};
const wired={enabled:true,interface:'eth0',vlanId:20,subnet:'10.30.0.1/24',dhcp:{start:'10.30.0.100',end:'10.30.0.200'}};
test('one cable supports uplink plus VLAN LAN alongside independent AP',()=>{
 const setup=validateNetworkSetup({...legacy,wired},interfaces),networks=runtimeNetworks(setup);
 assert.equal(networks[0].interface,'wlan0');assert.equal(networks[1].interface,'eth0.20');
 const dns=multiDnsmasqConfig(networks),nft=multiNftConfig(networks,'eth0','192.168.1.86/24');
 assert.match(dns,/dhcp-range=set:lan1,10.30.0.100,10.30.0.200/);assert.match(dns,/dhcp-option=tag:lan1,3,10.30.0.1/);
 assert.match(nft,/iifname "wlan0" ip daddr 10.30.0.1\/24 drop/);assert.match(nft,/iifname "eth0.20" ip daddr 10.20.0.1\/24 drop/);
 assert.match(nft,/oifname "eth0" ip saddr 10.30.0.1\/24 masquerade/);
 assert.equal(normalizeNetworkSetup(legacy).wired.enabled,false);
});
test('unsafe shared ports, invalid VLAN IDs and overlapping address spaces are rejected',()=>{
 for(const change of [{vlanId:''},{vlanId:0},{vlanId:4095},{vlanId:'20.5'},{subnet:'10.20.0.1/24',dhcp:legacy.dhcp},{subnet:'192.168.1.1/24',dhcp:{start:'192.168.1.100',end:'192.168.1.200'}}])assert.throws(()=>validateNetworkSetup({...legacy,wired:{...wired,...change}},interfaces));
 assert.doesNotThrow(()=>validateNetworkSetup({...legacy,wired:{...wired,interface:'eth1',vlanId:''}},interfaces));
 assert.throws(()=>validateNetworkSetup({...legacy,dhcp:{start:'10.20.0.0',end:'10.20.0.200'}},interfaces));
 assert.throws(()=>validateNetworkSetup({...legacy,client:{...legacy.client,password:'password\ninterface=eth0'}},interfaces));
 assert.ok(logicalInterface('enx123456789012',4094).length<=15);
});
