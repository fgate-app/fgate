import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {dnsEvidence,sniEvidence} from '../shared/diagnostic-evidence.js';
import {diagnosticSummary} from '../shared/diagnostic-summary.js';
test('DNS describes individual resolver, transport and IP family outcomes for one domain',()=>{
 const base={provider:'resolver',transport:'udp',qtype:'AAAA'};
 const matrix={name:'example.com',attempts:[{...base,state:'ok',rcode:0,routeVerified:true,answers:[]},{...base,state:'failed',reason:'timeout'},{...base,transport:'tcp',qtype:'A',state:'unavailable',reason:'gateway-udp-unavailable'}]};
 const evidence=dnsEvidence(matrix,[{id:'resolver',name:'Catalog resolver'}]);
 assert.deepEqual(evidence.params,{ok:1,failed:1,unavailable:1,total:3});assert.equal(evidence.rows.length,2);assert.equal(evidence.rows[0].target,'Catalog resolver · UDP · IPv4 · AAAA');assert.equal(evidence.rows[0].state,'partial');assert.ok(evidence.rows[0].details.some(row=>row.message.includes('no addresses')));assert.ok(evidence.rows[0].details.some(row=>row.message.includes('time limit')));
 const card=diagnosticSummary({gatewayDnsMatrix:matrix},{providers:[{id:'resolver',name:'Catalog resolver'}]}).find(row=>row.id==='dns-gateway');assert.match(card.description,/one domain/);assert.equal(card.params.failed,1);
 matrix.path={configChanged:true};assert.ok(dnsEvidence(matrix).rows.every(row=>row.state==='unavailable'));
});
test('SNI identifies the operation, site name and concrete incomplete evidence',()=>{
 const rows=sniEvidence({attempts:[{provider:'resolver',kind:'target-own-ip',servername:'example.com',state:'unavailable',observation:'dns-address-unavailable'},{provider:'resolver',kind:'foreign-sni',address:'1.1.1.1',servername:'example.com',state:'unavailable',observation:'baseline-unavailable'},{provider:'resolver',kind:'baseline-before',address:'1.1.1.1',state:'failed',observation:'timeout'}]},[{id:'resolver',name:'Catalog resolver'}]);
 assert.match(rows[0].operation,/own site/);assert.match(rows[0].message,/IP address/);assert.equal(rows[0].details[0].params.name,'example.com');assert.match(rows[1].message,/initial control/);assert.match(rows[2].message,/time limit/);
 const card=diagnosticSummary({gatewaySniControl:{comparisons:[{provider:'resolver',state:'observed',experimentState:'ok'}],attempts:[{provider:'resolver',kind:'foreign-sni',state:'ok',pathObservation:{state:'verified'}},{provider:'resolver',kind:'target-own-ip',state:'unavailable',observation:'dns-address-unavailable'}]}}).find(row=>row.id==='sni-gateway');assert.equal(card.state,'partial');
});
test('server results show the actual port and do not discuss unperformed authentication',()=>{
 const card=diagnosticSummary({endpointControl:{port:8443,results:[{address:'216.57.110.88',state:'ok'}]}}).find(row=>row.id==='server');assert.equal(card.params.port,8443);assert.equal(card.rows[0].target,'216.57.110.88:8443');assert.doesNotMatch(card.message,/authentication/);
});
test('evidence messages and operations have translations in every supported language',()=>{
 const source=readFileSync(new URL('../shared/diagnostic-evidence.js',import.meta.url),'utf8');
 const keys=[...source.matchAll(/'([^'\n]+)'/g)].map(row=>row[1]).filter(value=>/[A-Z]/.test(value[0]) && value.includes(' '));
 for(const locale of ['en','ru','zh-CN']){const d=JSON.parse(readFileSync(new URL(`../web/src/locales/${locale}.json`,import.meta.url),'utf8'));for(const key of keys)assert.ok(d[key],`${locale}: ${key}`);}
});
