import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeRouteEntries,mihomoRouteRule,adguardDomainRule} from '../server/route-entries.js';
import {Store} from '../server/store.js';
import {FilterPolicy} from '../server/filter-policy.js';

test('route types retain exact, regex, keyword, TLD and CIDR semantics without broadening',async()=>{
 const entries=normalizeRouteEntries(['full:Exact.Example.org','regexp:(^|\\.)API[0-9]+\\.example$','keyword:Video','youtube','192.0.2.0/24']);
 assert.equal(entries[0],'full:exact.example.org');assert.equal(entries[1],'regexp:(^|\\.)API[0-9]+\\.example$');
 assert.equal(mihomoRouteRule(entries[0],'REJECT'),'DOMAIN,exact.example.org,REJECT');
 assert.equal(mihomoRouteRule(entries[1],'DIRECT'),'DOMAIN-REGEX,(^|\\.)API[0-9]+\\.example$,DIRECT');
 assert.equal(mihomoRouteRule(entries[2],'DIRECT'),'DOMAIN-KEYWORD,video,DIRECT');
 assert.equal(mihomoRouteRule(entries[3],'DIRECT'),'DOMAIN-SUFFIX,youtube,DIRECT');
 assert.equal(adguardDomainRule(entries[0]),'/^exact\\.example\\.org$/');
 assert.equal(adguardDomainRule(entries[1]),'/(^|\\.)API[0-9]+\\.example$/');
 assert.equal(adguardDomainRule(entries[4]),null);
 assert.throws(()=>normalizeRouteEntries(['regexp:.*\nMATCH,DIRECT']));
 assert.deepEqual(normalizeRouteEntries(['regexp:a{1,3}']),['regexp:a{1,3}']);
 const store=new Store(':memory:');let current=[];
 const policy=new FilterPolicy(store,{userRules:async()=>current,reconcileUserRules:async(_previous,desired)=>{current=desired;}});
 try{
  const group=await policy.change(()=>store.addRouteGroup({name:'Preset block',entries,routeId:'block'}));
  assert.ok(current.includes('/^exact\\.example\\.org$/'));assert.ok(!current.includes('||full:exact.example.org^'));
  await policy.change(()=>store.removeRouteGroup(group.id));assert.deepEqual(current,[]);
 }finally{store.close();}
});
