import test from 'node:test';
import assert from 'node:assert/strict';
import {isIP} from 'node:net';
import {ipVersion,normalizeRouteEntries,normalizeLocalRoute,validDeviceIdentifier,validPort,validResolver} from '../web/src/lib/form-validation.js';
import {validUsername,validPassword} from '../shared/account-validation.js';

test('form address checks reject malformed IPv4, IPv6 and out-of-range ports',()=>{
 for(const value of ['1.2.3.4','255.255.255.255','0.0.0.0','999.1.1.1','01.2.3.4','a','::','::1','2001:db8::1','::ffff:192.0.2.1','::::','1:2:3:4:5:6:7:8:9','::ffff:999.0.0.1'])assert.equal(ipVersion(value),isIP(value),value);
 for(const value of [0,-1,65536,1.5,'',NaN,'bad'])assert.equal(validPort(value),false);
 for(const value of [1,65535,'443'])assert.equal(validPort(value),true);
 assert.equal(validDeviceIdentifier('00:11:22:aa:bb:cc'),true);
 assert.equal(validDeviceIdentifier('not an IP'),false);
});
test('forms use the server route normalization including duplicate and regexp handling',()=>{
 assert.deepEqual(normalizeRouteEntries('Example.com\nexample.com\nregexp:^Foo$'),['example.com','regexp:^Foo$']);
 assert.throws(()=>normalizeRouteEntries('bad domain'));
 assert.throws(()=>normalizeLocalRoute({alias:'bad name',target:'example.com'}));
 assert.throws(()=>normalizeLocalRoute({alias:'router.home',target:'not an address'}));
 assert.deepEqual(normalizeLocalRoute({alias:'Router.Home',target:'192.168.1.0/24'}),{alias:'router.home',target:'192.168.1.0/24'});
});
test('credentials and resolver checks match form limits',()=>{
 assert.equal(validUsername('admin'),true);assert.equal(validUsername('bad login'),false);
 for(const value of ['', 'x'.repeat(11),'x'.repeat(257)])assert.equal(validPassword(value),false);
 assert.equal(validPassword('x'.repeat(256)),true);
 for(const value of ['https://dns.example/dns-query','tls://1.1.1.1','udp://[::1]:53'])assert.equal(validResolver(value),true,value);
 for(const value of ['https://','ftp://dns.example','udp://','https://user:pass@dns.example'])assert.equal(validResolver(value),false,value);
});
