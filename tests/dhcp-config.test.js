import test from 'node:test';
import assert from 'node:assert/strict';
import {dhcpHostname,dhcpHostLine,safeDhcpLeases,replaceDhcpConfig} from '../server/dhcp-config.js';
import {multiDnsmasqConfig} from '../server/network-runtime.js';

test('friendly device names cannot invalidate or inject DHCP configuration',()=>{
 const lease={mac:'00:11:22:33:44:55',ip:'10.20.0.100',hostname:'Example laptop'};
 for(const name of ['Example laptop','Телефон','foo,ignore','foo\nport=0','-bad','bad-','a'.repeat(64)])assert.equal(dhcpHostname(name),'');
 assert.equal(dhcpHostname('pixel-7'),'pixel-7');assert.equal(dhcpHostname('host.example'),'host.example');
 assert.equal(dhcpHostLine(lease),'dhcp-host=00:11:22:33:44:55,10.20.0.100');
 assert.equal(safeDhcpLeases([lease])[0].hostname,'');assert.equal(lease.hostname,'Example laptop');
 const config=multiDnsmasqConfig([{interface:'wlan0',address:'10.20.0.1',dhcp:{start:'10.20.0.100',end:'10.20.0.200'}}],[lease]);
 assert.ok(config.includes(dhcpHostLine(lease)));assert.ok(!config.includes('Example laptop'));
});
test('invalid DHCP replacement never stops the working daemon or overwrites its config',async()=>{
 let config='old',running=true;
 await assert.rejects(replaceDhcpConfig('invalid',{read:async()=>config,validate:async()=>{throw Error('invalid');},write:async value=>config=value,stop:async()=>running=false,start:async()=>running=true}),/invalid/);
 assert.equal(config,'old');assert.equal(running,true);
});
test('DHCP startup failure restores previous config and service',async()=>{
 let config='old',running=true,attempts=0;
 await assert.rejects(replaceDhcpConfig('new',{read:async()=>config,validate:async()=>{},write:async value=>config=value,stop:async()=>running=false,start:async()=>{if(!attempts++)throw Error('startup failed');running=true;}}),/startup failed/);
 assert.equal(config,'old');assert.equal(running,true);assert.equal(attempts,2);
});
