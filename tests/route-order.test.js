import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../server/store.js';
import {FilterPolicy} from '../server/filter-policy.js';
import {buildMihomoConfig} from '../server/mihomo.js';
import {defaultDnsSettings} from '../server/dns-resolvers.js';

test('DNS and network blocking precede routing regardless of allowed route priority',async()=>{
 const store=new Store(':memory:');let dns=[];
 const policy=new FilterPolicy(store,{userRules:async()=>dns,reconcileUserRules:async(previous,desired)=>{dns=desired;}});
 try {
  const direct=store.profiles().find(p=>p.engine==='direct');
  const broad=await policy.change(()=>store.addRouteGroup({name:'Zone',entries:['ru','com'],routeId:'block'}));
  const specific=await policy.change(()=>store.addRouteGroup({name:'Exception',entries:['example.ru'],routeId:direct.id}));
  assert.ok(dns.includes('||ru^'));
  assert.deepEqual(store.routeGroups().map(g=>g.id),[specific.id,broad.id]);
  assert.ok(dns.includes('||ru^'),'blocking is unconditional before routing');
  const config=buildMihomoConfig(defaultDnsSettings,{}, {profiles:store.profiles(),configs:[],groups:store.routeGroups(),devices:[]});
  assert.ok(config.indexOf('DOMAIN-SUFFIX,ru,REJECT')<config.indexOf('DOMAIN-SUFFIX,example.ru,DIRECT'));
  assert.throws(()=>store.moveRouteGroup(specific.id,'down'));
  assert.throws(()=>store.moveRouteGroup(specific.id,'invalid'));
  assert.throws(()=>store.moveRouteGroup('missing','up'));
 }finally{store.close();}
});

test('old database migrates block priority once and retains manual order after reopening',async()=>{
 const {mkdtempSync,rmSync}=await import('node:fs');
 const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const folder=mkdtempSync(join(tmpdir(),'fg-order-')),path=join(folder,'db.sqlite');let store;
 try{
  store=new Store(path);const direct=store.profiles().find(p=>p.engine==='direct');
  const ordinary=store.addRouteGroup({name:'Direct',entries:['ru'],routeId:direct.id});
  const block=store.addRouteGroup({name:'Block',entries:['example.ru'],routeId:'block'});
  store.saveFilterRuleState({...store.filterRuleState(),bottomPriority:false});store.db.exec('ALTER TABLE route_groups DROP COLUMN position');store.close();
  store=new Store(path);assert.deepEqual(store.routeGroups().map(g=>g.id),[ordinary.id,block.id]);
  assert.throws(()=>store.moveRouteGroup(ordinary.id,'down'));store.close();
  store=new Store(path);assert.deepEqual(store.routeGroups().map(g=>g.id),[ordinary.id,block.id]);
 }finally{store?.close();rmSync(folder,{recursive:true,force:true});}
});

test('lower allowing rules win and moving changes both runtime priority and ownership',()=>{
 const store=new Store(':memory:');try{
 const direct=store.profiles().find(p=>p.engine==='direct'),a=store.addRouteGroup({name:'Zone',entries:['com'],routeId:direct.id}),b=store.addRouteGroup({name:'Specific',entries:['example.com'],routeId:direct.id});
 const render=()=>buildMihomoConfig(defaultDnsSettings,{}, {profiles:store.profiles(),configs:[],groups:store.routeGroups(),devices:[]});
 assert.ok(render().indexOf('DOMAIN-SUFFIX,example.com,DIRECT')<render().indexOf('DOMAIN-SUFFIX,com,DIRECT'));
 store.moveRouteGroup(b.id,'up');assert.ok(render().indexOf('DOMAIN-SUFFIX,com,DIRECT')<render().indexOf('DOMAIN-SUFFIX,example.com,DIRECT'));
 }finally{store.close();}
});
