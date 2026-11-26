import test from 'node:test';import assert from 'node:assert/strict';
import {routeSyntaxCases} from './fixtures/route-syntax.js';
import {normalizeRouteEntries,validRouteEntry,mihomoRouteRule,adguardDomainRule} from '../server/route-entries.js';
import {normalizeRouteEntries as normalizeForm} from '../web/src/lib/form-validation.js';
import {uniqueRouteEntries} from '../shared/route-preset-entries.js';
import {Store} from '../server/store.js';import {buildMihomoConfig} from '../server/mihomo.js';import {defaultDnsSettings} from '../server/dns-resolvers.js';
import {parseDomainList,updateDomainLists,domainListDomains} from '../server/domain-lists.js';
import {mkdtempSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
for(const row of routeSyntaxCases)test('rule syntax survives form, storage and config: '+row.id,()=>{
 const normalized=normalizeRouteEntries([row.entry]);assert.deepEqual(normalizeForm([row.entry]),normalized);assert.ok(validRouteEntry(normalized[0]));
 const store=new Store(':memory:');try{const routeId=store.profiles().find(p=>p.engine==='direct').id;const group=store.addRouteGroup({name:row.id,routeId,entries:normalized});assert.deepEqual(store.routeGroup(group.id).manualEntries,normalized);store.updateRouteGroup(group.id,{name:'renamed'});assert.deepEqual(store.routeGroup(group.id).entries,normalized);
 const config=buildMihomoConfig(defaultDnsSettings,{}, {profiles:store.profiles(),configs:[],groups:store.routeGroups(),devices:[]});assert.ok(config.includes(mihomoRouteRule(normalized[0],'DIRECT')));assert.equal(adguardDomainRule(normalized[0])===null,['ipv4','ipv6','cidr4','cidr6'].includes(row.id));}finally{store.close();}
});
test('prefix normalization preserves regex payload case, aliases and preview deduplication',()=>{
 const values=['REGEXP:^API[0-9]+$','regexp:^API[0-9]+$','domain:EXAMPLE.COM','example.com','FULL:Exact.Example','KEYWORD:VIDEO'];const expected=['regexp:^API[0-9]+$','example.com','full:exact.example','keyword:video'];
 assert.deepEqual(normalizeRouteEntries(values),expected);assert.deepEqual(normalizeForm(values),expected);assert.deepEqual(uniqueRouteEntries(values),expected);
 assert.deepEqual(parseDomainList('domain:EXAMPLE.COM\nREGEXP:^API[0-9]+$'),['example.com','regexp:^API[0-9]+$']);
 assert.equal(mihomoRouteRule('domain:EXAMPLE.COM','DIRECT'),'DOMAIN-SUFFIX,example.com,DIRECT');assert.equal(adguardDomainRule('REGEXP:^API[0-9]+$'),'/^API[0-9]+$/');
});
test('invalid rule syntax and known non-RE2 constructs never persist',()=>{
 const invalid=['999.1.2.3','192.0.2.0/33','2001:db8::/129','192.0.2.0/-1','*.','full:*.example','full:'+Array(5).fill('a'.repeat(60)).join('.'),'keyword:','regexp:','regexp:[','regexp:(?=a)b','regexp:(a)\\1','regexp:\\q','regexp:\\u0061','regexp:\\cA','regexp:\\xZ1','regexp:[\\b]','regexp:a{1001}','regexp:a{1,1001}','include:youtube','example.com @ads','MATCH,DIRECT','regexp:.*\nMATCH,DIRECT'];
 const store=new Store(':memory:');try{for(const value of invalid){assert.throws(()=>normalizeRouteEntries([value]),undefined,value);assert.throws(()=>normalizeForm([value]),undefined,value);assert.throws(()=>store.addRouteGroup({name:'Invalid',routeId:'block',entries:[value]}),undefined,value);}assert.equal(store.routeGroups().length,0);}
 finally{store.close();}
 for(const value of ['regexp:a{1000}','regexp:[a{1001}]','regexp:\\x41','regexp:\\\\q'])assert.ok(validRouteEntry(value),value);
});
test('preset includes, positive/negative attributes and affiliations apply all rule forms without leaking to manual syntax',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'fg-syntax-presets-')),previous=process.env.FREEDOMGATE_STATE_DIR;process.env.FREEDOMGATE_STATE_DIR=dir;
 try{await updateDomainLists({sources:{base:'domain:Example.COM\nfull:exact.example @ads\nkeyword:video @telemetry\nregexp:^api[0-9]{1,3}\\.example$\n192.0.2.0/24\n2001:db8::/32\n*.wild.example\naffiliated.example &affiliate',filtered:'include:base @-ads @-telemetry',ads:'include:base @ads',affiliate:'base-affiliate.example'}});
 assert.deepEqual(domainListDomains('base'),['*.wild.example','192.0.2.0/24','2001:db8::/32','affiliated.example','example.com','regexp:^api[0-9]{1,3}\\.example$']);assert.deepEqual(domainListDomains('filtered'),domainListDomains('base'));assert.deepEqual(domainListDomains('tracking--base'),['full:exact.example','keyword:video']);assert.deepEqual(domainListDomains('tracking--ads'),['full:exact.example']);assert.deepEqual(domainListDomains('affiliate'),['affiliated.example','base-affiliate.example']);}
 finally{if(previous===undefined)delete process.env.FREEDOMGATE_STATE_DIR;else process.env.FREEDOMGATE_STATE_DIR=previous;rmSync(dir,{recursive:true,force:true});}
});
