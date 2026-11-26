import test from 'node:test';
import assert from 'node:assert/strict';
import {isAdminHost} from '../server/admin-host.js';
test('admin accepts its current interface IPs without test-machine addresses and rejects DNS rebinding',()=>{
 const opts={allowed:'custom.home:80',interfaces:{eth0:[{address:'192.168.10.2'},{address:'2001:db8::1'}]}};
 for(const host of ['192.168.10.2','192.168.10.2:80','[2001:db8::1]:80','fgate.home','fgate:80','localhost:8787','custom.home:80'])assert.equal(isAdminHost(host,opts),true,host);
 for(const host of ['attacker.example','192.168.10.99','192.168.10.2.evil.test','192.168.10.2:0','192.168.10.2:99999','user@192.168.10.2','192.168.10.2/path',''])assert.equal(isAdminHost(host,opts),false,host);
});
