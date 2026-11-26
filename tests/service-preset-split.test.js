import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';import {tmpdir} from 'node:os';
import {updateDomainLists,domainListsStatus,domainListDomains} from '../server/domain-lists.js';
import {Store} from '../server/store.js';
import {groupRouteRules,groupDnsEntries} from '../server/route-entries.js';
import {buildMihomoConfig} from '../server/mihomo.js';
import {defaultDnsSettings} from '../server/dns-resolvers.js';
async function isolated(action){const dir=mkdtempSync(join(tmpdir(),'fg-service-split-')),previous=process.env.FREEDOMGATE_STATE_DIR;process.env.FREEDOMGATE_STATE_DIR=dir;try{await action(dir);}finally{if(previous===undefined)delete process.env.FREEDOMGATE_STATE_DIR;else process.env.FREEDOMGATE_STATE_DIR=previous;rmSync(dir,{recursive:true,force:true});}}
test('service and combined trackers are disjoint across includes, attributes and duplicate untagged rows',()=>isolated(async()=>{
 await updateDomainLists({sources:{vk:'vk.com\ntracker.vk.com\ntracker.vk.com @ads\ninclude:vk-extra', 'vk-extra':'full:telemetry.vk.com @telemetry\n192.0.2.2 @ads\nregular.vk.com',parent:'include:vk'}});
 assert.deepEqual(domainListDomains('vk'),['regular.vk.com','vk.com']);assert.deepEqual(domainListDomains('tracking--vk'),['192.0.2.2','full:telemetry.vk.com','tracker.vk.com']);
 assert.deepEqual(domainListDomains('parent'),domainListDomains('vk'));assert.deepEqual(domainListDomains('tracking--parent'),domainListDomains('tracking--vk'));
 const visible=domainListsStatus().presets.filter(p=>!p.hidden);assert.ok(visible.some(p=>p.id==='vk' && p.kind==='service'));assert.ok(visible.some(p=>p.id==='tracking--vk' && p.combined));assert.ok(!visible.some(p=>p.id==='tracking--vk--ads'));
}));
test('legacy v3 catalog is split offline and existing bound groups refresh at startup',()=>isolated(async dir=>{
 mkdirSync(join(dir,'domain-lists'));writeFileSync(join(dir,'domain-lists/catalog.json'),JSON.stringify({version:3,ref:'a'.repeat(40),updatedAt:'2026-11-22',presets:[{id:'vk',label:'VK'},{id:'tracking--vk--ads',label:'VK',kind:'tracking',attribute:'ads'}],lists:{vk:['vk.com','ads.vk.com'],'tracking--vk--ads':['ads.vk.com']}}));
 assert.deepEqual(domainListDomains('vk'),['vk.com']);assert.deepEqual(domainListDomains('tracking--vk'),['ads.vk.com']);
 let store=new Store(join(dir,'db'));const id=store.addRouteGroup({name:'VK',routeId:'block',presetIds:['vk']}).id;
 const saved=JSON.parse(store.db.prepare('SELECT domain_presets FROM route_groups WHERE id=?').get(id).domain_presets);saved[0].entries=['vk.com','ads.vk.com'];delete saved[0].exclusions;store.db.prepare('UPDATE route_groups SET domain_presets=? WHERE id=?').run(JSON.stringify(saved),id);store.close();store=new Store(join(dir,'db'));
 try{const group=store.routeGroup(id);assert.deepEqual(group.entries,['vk.com']);assert.deepEqual(group.presets[0].exclusions,['ads.vk.com']);assert.deepEqual(groupDnsEntries(group),[]);const rules=groupRouteRules(group,'DIRECT');assert.equal(rules.length,1);assert.match(rules[0],/NOT,\(\(DOMAIN-SUFFIX,ads\.vk\.com\)\)/);
 store.updateRouteGroup(id,{presetIds:['vk','tracking--vk']});const both=store.routeGroup(id);assert.ok(groupRouteRules(both,'DIRECT').includes('DOMAIN-SUFFIX,ads.vk.com,DIRECT'));assert.deepEqual(groupDnsEntries(both),['ads.vk.com']);
 store.updateRouteGroup(id,{presetIds:['vk'],entries:['manual.example']});assert.deepEqual(groupDnsEntries(store.routeGroup(id)),['manual.example']);
 const config=buildMihomoConfig(defaultDnsSettings,{}, {profiles:store.profiles(),configs:[],devices:[],groups:store.routeGroups()});assert.match(config,/NOT,\(\(DOMAIN-SUFFIX,ads\.vk\.com\)\)/);
 }finally{store.close();}
}));
test('service exclusions do not create global DNS allow rules or defeat a separate tracker block',()=>isolated(async dir=>{
 const {FilterPolicy}=await import('../server/filter-policy.js');
 await updateDomainLists({sources:{vk:'vk.com\nads.vk.com @ads'}});const store=new Store(join(dir,'db'));let desired=[];
 const filter={status:()=>({state:'running'}),userRules:async()=>[],reconcileUserRules:async(_old,rules)=>{desired=rules;}};
 try{store.addRouteGroup({name:'Service',routeId:'block',presetIds:['vk']});store.addRouteGroup({name:'Trackers',routeId:'block',presetIds:['tracking--vk']});await new FilterPolicy(store,filter).change(()=>{});assert.deepEqual(desired,['||ads.vk.com^']);assert.ok(!desired.some(rule=>rule.startsWith('@@')));}
 finally{store.close();}
}));
