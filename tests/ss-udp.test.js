import test from 'node:test';import {execFile} from 'node:child_process';import {promisify} from 'node:util';import assert from 'node:assert/strict';
import {ssPython,outlineBinary} from '../server/ss-profile.js';
test('SS UDP authentication, replay rejection, SOCKS association ownership and socket cleanup',async()=>{
 const result=await promisify(execFile)(ssPython(),['-m','unittest','discover','-s','tests','-p','test_ss_udp.py'],{timeout:15000,env:{...process.env,FREEDOMGATE_OUTLINE:outlineBinary()}});assert.match(result.stderr,/OK/);
});

import {buildMihomoConfig} from '../server/mihomo.js';import {defaultDnsSettings} from '../server/dns-resolvers.js';
test('UDP safety guards remain for legacy bridges and disappear only for explicitly UDP-capable bridges',()=>{
 const routes={profiles:[{id:'ss',engine:'outline'}],configs:[{profile_id:'ss',engine:'outline',config:'unused'}],groups:[{id:'domain',entries:['example.com'],routeId:'ss'}],devices:[{id:'phone',identifier:'10.20.0.2',routeId:'ss'}],connectionGroups:[],bridges:{ss:{port:12345,address:'192.0.2.1'}}};
 const legacy=buildMihomoConfig(defaultDnsSettings,{},routes);assert.match(legacy,/udp: false/);assert.match(legacy,/AND,\(\(NETWORK,udp\)/);
 routes.bridges.ss.udp=true;const supported=buildMihomoConfig(defaultDnsSettings,{},routes);assert.match(supported,/udp: true/);assert.match(supported,/AND,\(\(NETWORK,udp\)/);assert.match(supported,/DOMAIN-SUFFIX,example.com,p-ss-grp/);
});
