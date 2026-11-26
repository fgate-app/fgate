import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeNetworkSettings,networkResponse} from '../web/src/lib/network-settings.js';

test('old network settings normalize without dropping values or unknown fields',()=>{
 const input={client:{ssid:'fgate',password:'test only',extra:true},uplink:{interface:'eth0'},custom:1};
 const setup=normalizeNetworkSettings(input);
 assert.equal(setup.client.ssid,'fgate');assert.equal(setup.client.password,'test only');assert.equal(setup.client.extra,true);assert.equal(setup.custom,1);
 assert.equal(setup.dhcp.start,'10.10.0.100');assert.equal(input.dhcp,undefined);
 for(const old of [null,{},[],{client:null,dhcp:null}])assert.equal(normalizeNetworkSettings(old).client.type,'ap');
});
test('network apply response preserves inventory and uses explicit warnings consistently',()=>{
 const previous={setup:normalizeNetworkSettings({}),interfaces:[{name:'wlan0'}],plan:['before']};
 const result=networkResponse({setup:{client:{type:'ethernet'},warnings:['setup warning']},plan:['after']},previous);
 assert.deepEqual(result.interfaces,previous.interfaces);assert.deepEqual(result.plan,['after']);assert.deepEqual(result.warnings,['setup warning']);
 assert.deepEqual(networkResponse({setup:{warnings:['old']},warnings:[]},previous).warnings,[]);
});
