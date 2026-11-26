import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {Store} from '../server/store.js';import {normalizeRouteEntries,groupRouteRules,groupDnsEntries,adguardDomainRule} from '../server/route-entries.js';import {normalizeRouteEntries as formEntries} from '../web/src/lib/form-validation.js';import {routeEntrySelection} from '../shared/route-preset-entries.js';import {updateDomainLists} from '../server/domain-lists.js';import {FilterPolicy} from '../server/filter-policy.js';import {createServer} from '../server/index.js';import {AccessPointService} from '../server/access-points/service.js';

test('exclusion syntax normalizes, deduplicates, filters exact members and preserves partial suffixes',()=>{
 const input=['EXCLUDE:Example.COM','exclude:domain:example.com','exclude:full:Exact.Other','full:sub.example.com','*.example.com','example.com','full:exact.other','other','192.0.2.5'];
 const normalized=normalizeRouteEntries(input);assert.deepEqual(formEntries(input),normalized);assert.equal(normalized.filter(value=>value==='exclude:example.com').length,1);
 assert.deepEqual(routeEntrySelection(normalized),{entries:['other','192.0.2.5'],exclusions:['example.com','full:exact.other']});
 assert.deepEqual(routeEntrySelection(['example.com','exclude:full:example.com']).entries,['example.com'],'exact exclusion leaves other subdomains in scope');
 assert.equal(adguardDomainRule('exclude:example.com'),null);
 for(const value of ['exclude:','exclude:full:','exclude:*.example.com','exclude:regexp:x','exclude:keyword:video','exclude:192.0.2.5','exclude:2001:db8::1','exclude:192.0.2.0/24','exclude:exclude:example.com','exclude:bad/path']){assert.throws(()=>normalizeRouteEntries([value]),undefined,value);assert.throws(()=>formEntries([value]),undefined,value);}
});

test('group exclusions win over manual/preset inclusions and never become global DNS allow rules',async()=>{
 const store=new Store(':memory:');let dns=[];const filter={userRules:async()=>[],reconcileUserRules:async(_old,desired)=>{dns=desired;}};
 try{
  const group=store.addRouteGroup({name:'Local exclusion',routeId:'block',entries:['example.com','full:ads.example.com','exclude:ads.example.com']});assert.deepEqual(group.exclusions,['ads.example.com']);assert.deepEqual(group.entries,['example.com']);assert.ok(group.manualEntries.includes('exclude:ads.example.com'));assert.deepEqual(groupDnsEntries(group),[]);const compiled=groupRouteRules(group,'REJECT');assert.equal(compiled.length,1);assert.match(compiled[0],/NOT,\(\(DOMAIN-SUFFIX,ads\.example\.com\)\)/);
  const other=store.addRouteGroup({name:'Independent block',routeId:'block',entries:['ads.example.com']});await new FilterPolicy(store,filter).change(()=>{});assert.deepEqual(dns,['||ads.example.com^']);assert.ok(!dns.some(rule=>rule.startsWith('@@')));assert.deepEqual(groupRouteRules(store.routeGroup(other.id),'REJECT'),['DOMAIN-SUFFIX,ads.example.com,REJECT']);
  store.updateRouteGroup(group.id,{name:'Renamed'});assert.deepEqual(store.routeGroup(group.id).exclusions,['ads.example.com']);
  assert.throws(()=>store.addRouteGroup({name:'Only exclusions',routeId:'block',entries:['exclude:example.com']}),/included address/);
  assert.throws(()=>store.updateRouteGroup(group.id,{dnsRules:['||example.com^']}),/custom DNS/);assert.deepEqual(store.routeGroup(group.id).dnsRules,[]);
  assert.ok(!store.routeGroups().some(row=>row.name==='Only exclusions'));
 }finally{store.close();}
});

test('preset updates and reopen preserve exclusions without freezing or copying the preset',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'fg-excluded-presets-')),previous=process.env.FREEDOMGATE_STATE_DIR;process.env.FREEDOMGATE_STATE_DIR=dir;let store;
 try{
  await updateDomainLists({ref:'a'.repeat(40),sources:{service:'example.com\nfull:ads.example.com\nfull:exact.other'}});store=new Store(join(dir,'db'));const id=store.addRouteGroup({name:'Service',routeId:'block',presetIds:['service'],entries:['exclude:ads.example.com','exclude:full:exact.other']}).id;assert.deepEqual(store.routeGroup(id).entries,['example.com']);
  await updateDomainLists({ref:'b'.repeat(40),sources:{service:'example.com\nfull:ads.example.com\nfull:sub.ads.example.com\nfull:exact.other\nfull:sub.exact.other\nnew.example'}});store.refreshDomainPresets();store.close();store=new Store(join(dir,'db'));const group=store.routeGroup(id);
  assert.deepEqual(group.presetIds,['service']);assert.deepEqual(group.manualEntries,['exclude:ads.example.com','exclude:full:exact.other']);assert.deepEqual(group.entries,['example.com','full:sub.exact.other','new.example']);assert.equal(group.presets[0].entries.length,6);
  assert.throws(()=>store.updateRouteGroup(id,{presetIds:[]}),/included address/);assert.deepEqual(store.routeGroup(id).presetIds,['service']);
 }finally{store?.close();if(previous===undefined)delete process.env.FREEDOMGATE_STATE_DIR;else process.env.FREEDOMGATE_STATE_DIR=previous;rmSync(dir,{recursive:true,force:true});}
});

test('exclusion API saves explicit syntax, rejects invalid edits and rolls back failed application',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'fg-exclusion-api-')),store=new Store(':memory:');let fail=false;
 const supervisor={status:()=>({state:'running'}),setRoutes:()=>{},reapply:async()=>{if(fail){fail=false;return {ok:false,error:'Fixture apply failed'};}return {ok:true};}};
 const points=new AccessPointService(store,{stateDir:dir}),server=createServer(store,{supervisor,accessPoints:points});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{const base='http://127.0.0.1:'+server.address().port,setup=await fetch(base+'/api/auth/setup',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'admin',password:'Fixture password 12345'})}),cookie=setup.headers.get('set-cookie').split(';')[0],auth=await setup.json();
  const request=async(path,method,body)=>{const response=await fetch(base+'/api/routes/groups'+path,{method,headers:{'content-type':'application/json',cookie,'x-csrf-token':auth.csrf},body:JSON.stringify(body)});return {status:response.status,body:await response.json()};};
  const created=await request('','POST',{name:'API exclusions',routeId:'block',entries:['example.com','EXCLUDE:FULL:Ads.Example.com']});assert.equal(created.status,201);const id=created.body.id;assert.deepEqual(created.body.exclusions,['full:ads.example.com']);
  const before=store.routeGroup(id);fail=true;assert.equal((await request('/'+id,'PUT',{entries:['example.com','exclude:other.example.com']})).status,400);assert.deepEqual(store.routeGroup(id),before);
  assert.equal((await request('/'+id,'PUT',{entries:['exclude:example.com']})).status,400);assert.deepEqual(store.routeGroup(id),before);
  assert.equal((await request('/'+id,'PUT',{entries:['example.com']})).status,200);assert.deepEqual(store.routeGroup(id).exclusions,[]);
 }finally{await new Promise(r=>server.close(r));await server.cleanup;store.close();rmSync(dir,{recursive:true,force:true});}
});
