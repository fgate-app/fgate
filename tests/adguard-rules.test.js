import test from 'node:test';
import assert from 'node:assert/strict';
import {buildAdGuardConfig,preserveAdGuardUserRules} from '../server/adguard.js';

test('AdGuard regeneration retains user rules but updates managed DNS listeners',()=>{
 const previous=buildAdGuardConfig().replace('  - "||blocked.example^"','  - "||blocked.example^"\n  - "||metrika.yandex.ru^"')+'other_setting: true\n';
 const config=preserveAdGuardUserRules(buildAdGuardConfig({listenPort:53054}),previous);
 assert.match(config,/metrika\.yandex\.ru/);
 assert.match(config,/port: 53054/);
 assert.doesNotMatch(config,/other_setting/);
});

test('AdGuard preserves intentional empty lists and multiline rule text',()=>{
 assert.match(preserveAdGuardUserRules(buildAdGuardConfig(),'user_rules: []\nfilters: []\n'),/user_rules: \[\]/);
 const section='user_rules:\n  - >-\n    ||metrika.yandex.ru^\n  - "@@||allowed.example^"\n';
 assert.ok(preserveAdGuardUserRules(buildAdGuardConfig(),section+'filters: []\n').includes(section));
 assert.equal(preserveAdGuardUserRules(buildAdGuardConfig(),'schema_version: 34\n'),buildAdGuardConfig());
});

test('concurrent rule edits retain other rules and hide the managed health probe',async()=>{
 const {AdGuardSupervisor}=await import('../server/adguard.js');
 let rules=['||blocked.example^','||metrika.yandex.ru^'];
 const filter=new AdGuardSupervisor({request:async(url,options)=>{
  if(url.endsWith('filtering/status'))return Response.json({user_rules:[...rules]});
  if(url.endsWith('filtering/set_rules')){await new Promise(resolve=>setTimeout(resolve,10));rules=JSON.parse(options.body).rules;}
  return new Response('',{status:200});
 }});
 assert.deepEqual(await filter.userRules(),['||metrika.yandex.ru^']);
 await Promise.all([filter.reconcileUserRules([],['||one.example^']),filter.reconcileUserRules([],['||two.example^'])]);
 assert.deepEqual(new Set(await filter.userRules()),new Set(['||metrika.yandex.ru^','||one.example^','||two.example^']));
 await filter.reconcileUserRules(['||one.example^'],[]);
 assert.ok(rules.includes('||metrika.yandex.ru^'));
 assert.ok(rules.includes('||blocked.example^'));

});

test('AdGuard dashboard statistics use native history, cache and do not turn failures into zeroes',async()=>{
 const {AdGuardSupervisor}=await import('../server/adguard.js');let requests=0;
 const filter=new AdGuardSupervisor({request:async url=>{requests++;assert.ok(url.endsWith('/control/stats'));return Response.json({time_units:'hours',num_dns_queries:120,num_blocked_filtering:20,dns_queries:[80,40],blocked_filtering:[15,5]});}});
 const [a,b]=await Promise.all([filter.statistics(),filter.statistics()]);assert.deepEqual(a,b);assert.equal(requests,1);assert.equal(a.queries,120);assert.equal(a.blocked,20);assert.equal(a.samples[1].time-a.samples[0].time,3600000);assert.deepEqual(a.samples.map(s=>s.queries),[80,40]);await filter.statistics();assert.equal(requests,1);
 const failed=new AdGuardSupervisor({request:async()=>{throw Error('offline');}});assert.deepEqual(await failed.statistics(),{available:false,samples:[]});
});
