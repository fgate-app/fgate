import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../server/store.js';
import {updateDomainLists,domainListDomains} from '../server/domain-lists.js';
import {createServer} from '../server/index.js';
import {buildMihomoConfig} from '../server/mihomo.js';
import {defaultDnsSettings} from '../server/dns-resolvers.js';
async function isolated(action){const dir=mkdtempSync(join(tmpdir(),'fg-bound-presets-')),previous=process.env.FREEDOMGATE_STATE_DIR;process.env.FREEDOMGATE_STATE_DIR=dir;try{await action(dir);}finally{if(previous===undefined)delete process.env.FREEDOMGATE_STATE_DIR;else process.env.FREEDOMGATE_STATE_DIR=previous;rmSync(dir,{recursive:true,force:true});}}

test('preset references survive reopening, deduplicate manual/preset overlap and keep manual rules after removal',()=>isolated(async dir=>{
 await updateDomainLists({ref:'a'.repeat(40),sources:{youtube:'youtube.com\n192.0.2.1\nfull:exact.example',second:'youtube.com\nother.example'}});
 let store=new Store(join(dir,'db'));try{
  const routeId=store.profiles().find(p=>p.engine==='direct').id;
  const group=store.addRouteGroup({name:'Bound',routeId,entries:['YOUTUBE.COM','custom.example','192.0.2.1'],presetIds:['youtube','second','youtube']});
  assert.deepEqual(group.presetIds,['youtube','second']);assert.equal(group.entries.filter(e=>e==='youtube.com').length,1);assert.equal(group.entries.filter(e=>e==='192.0.2.1').length,1);
  assert.deepEqual(group.manualEntries,['youtube.com','custom.example','192.0.2.1']);
  const yaml=buildMihomoConfig(defaultDnsSettings,{}, {profiles:store.profiles(),configs:[],devices:[],groups:store.routeGroups()});
  assert.equal(yaml.split('\n').filter(line=>line.includes('DOMAIN-SUFFIX,youtube.com,')).length,1);
  store.close();store=new Store(join(dir,'db'));assert.deepEqual(store.routeGroup(group.id).presetIds,['youtube','second']);
  await updateDomainLists({ref:'b'.repeat(40),sources:{youtube:'new.example\n198.51.100.1',second:'new.example'}});store.close();store=new Store(join(dir,'db'));
  const updated=store.routeGroup(group.id);assert.ok(updated.entries.includes('new.example'));assert.ok(updated.entries.includes('198.51.100.1'));assert.ok(!updated.entries.includes('full:exact.example'));assert.ok(updated.entries.includes('youtube.com'));assert.equal(updated.entries.filter(e=>e==='new.example').length,1);
  const removed=store.updateRouteGroup(group.id,{presetIds:[]});assert.deepEqual(removed.entries,group.manualEntries);
 }finally{store.close();}
}));
test('old databases migrate to manual tags; unavailable presets retain their saved rules',()=>isolated(async dir=>{
 let store=new Store(join(dir,'db'));const routeId=store.profiles().find(p=>p.engine==='direct').id;const old=store.addRouteGroup({name:'Old',routeId,entries:['legacy.example']});store.db.exec('ALTER TABLE route_groups DROP COLUMN domain_presets');store.close();store=new Store(join(dir,'db'));
 try{
  assert.deepEqual(store.routeGroup(old.id).presetIds,[]);assert.deepEqual(store.routeGroup(old.id).manualEntries,['legacy.example']);
  await updateDomainLists({ref:'a'.repeat(40),sources:{youtube:'saved.example'}});const bound=store.addRouteGroup({name:'Bound',routeId,presetIds:['youtube']});
  await updateDomainLists({ref:'b'.repeat(40),sources:{other:'other.example'}});store.refreshDomainPresets();const saved=store.routeGroup(bound.id);assert.deepEqual(saved.entries,['saved.example']);assert.equal(saved.presets[0].available,false);
  assert.deepEqual(store.updateRouteGroup(bound.id,{name:'Renamed'}).entries,['saved.example']);
  assert.throws(()=>store.addRouteGroup({name:'Bad',routeId,presetIds:['missing']}),/unavailable/);assert.throws(()=>store.addRouteGroup({name:'Bad',routeId,presetIds:['../bad']}),/valid domain presets/);
 }finally{store.close();}
}));
test('module update refreshes bound routes and DNS policy; failed runtime application restores catalog and rules',()=>isolated(async dir=>{
 const initial='a'.repeat(40),next='b'.repeat(40);await updateDomainLists({ref:initial,sources:{youtube:'old.example\n192.0.2.1'}});
 const store=new Store(join(dir,'db'));let fail=false,applied=[],dnsRules=[];
 const supervisor={status:()=>({state:'running'}),setRoutes:(_devices,groups)=>{applied=groups;},reapply:async()=>{if(fail){fail=false;return {ok:false,error:'Fixture route rejected'};}return {ok:true};}};
 const filter={status:()=>({state:'running'}),userRules:async()=>dnsRules,reconcileUserRules:async(_previous,desired)=>{dnsRules=desired;}};
 const realFetch=globalThis.fetch;globalThis.fetch=async()=>({ok:true,json:async()=>({sha:next})});
 const server=createServer(store,{resourceFetch:async()=>({ok:true,json:async()=>({sha:next})}),supervisor,filter,modulesHelper:async()=>({ok:true,modules:[]}),domainListUpdate:options=>updateDomainLists({...options,ref:options?.ref || next,sources:{youtube:'new.example\n198.51.100.2'}})});globalThis.fetch=realFetch;
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{
  const base='http://127.0.0.1:'+server.address().port;const setup=await realFetch(base+'/api/auth/setup',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'admin',password:'Fixture password 12345'})});const cookie=setup.headers.get('set-cookie').split(';')[0],auth=await setup.json();
  const request=async(path,body)=>{const response=await realFetch(base+'/api/'+path,{method:body?'POST':'GET',headers:{'content-type':'application/json',cookie,'x-csrf-token':auth.csrf},...(body?{body:JSON.stringify(body)}:{})});return {status:response.status,body:await response.json()};};
  const created=await request('routes/groups',{name:'Bound block',routeId:'block',presetIds:['youtube'],entries:['manual.example']});assert.equal(created.status,201);
  const previous=readFileSync(join(dir,'domain-lists/catalog.json'));fail=true;
  assert.equal((await request('domain-lists/update',{})).status,502);assert.deepEqual(readFileSync(join(dir,'domain-lists/catalog.json')),previous);assert.ok(store.routeGroup(created.body.id).entries.includes('old.example'));assert.ok(applied.find(r=>r.id===created.body.id).entries.includes('old.example'));assert.ok(dnsRules.includes('||old.example^'));
  await request('modules',{id:'domain-lists',op:'check'});
  let status;for(let attempt=0;attempt<30;attempt++){status=(await request('modules')).body.modules.find(row=>row.id==='domain-lists');if(status.state==='available')break;await new Promise(r=>setTimeout(r,5));}assert.equal(status.state,'available');
  await request('modules',{id:'domain-lists',op:'update',version:next});for(let attempt=0;attempt<30;attempt++){status=(await request('modules')).body.modules.find(row=>row.id==='domain-lists');if(status.state==='updated')break;await new Promise(r=>setTimeout(r,5));}assert.equal(status.state,'updated');
  assert.deepEqual(store.routeGroup(created.body.id).entries,['manual.example','198.51.100.2','new.example']);assert.deepEqual(domainListDomains('youtube'),['198.51.100.2','new.example']);assert.ok(dnsRules.includes('||new.example^'));assert.ok(!dnsRules.includes('||old.example^'));assert.ok(applied.find(r=>r.id===created.body.id).entries.includes('198.51.100.2'));
 }finally{globalThis.fetch=realFetch;await new Promise(r=>server.close(r));await server.cleanup;store.close();}
}));
