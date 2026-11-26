import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {Store} from '../server/store.js';
import {FilterPolicy} from '../server/filter-policy.js';
import {AdGuardSupervisor,preserveAdGuardPolicy,preserveAdGuardUserRules,buildAdGuardConfig} from '../server/adguard.js';
import {normalizeDnsPolicy,normalizeAdGuardSettings} from '../shared/adguard-policy.js';

test('DNS policy validates subscriptions/rules and old route databases normalize safely',()=>{
 const dir=mkdtempSync(join(tmpdir(),'fg-dns-policy-')),path=join(dir,'db.sqlite');
 try{
  let store=new Store(path);const old=store.addRouteGroup({name:'Legacy',entries:['example.com'],routeId:'block'});store.close();
  const db=new DatabaseSync(path);db.exec('ALTER TABLE route_groups DROP COLUMN dns_policy');db.close();
  store=new Store(path);assert.deepEqual(store.routeGroup(old.id).dnsFilters,[]);assert.deepEqual(store.routeGroup(old.id).entries,['example.com']);assert.equal(store.adGuardSettings(),null);store.close();
  for(const url of ['file:///etc/passwd','https://user:pass@example.com/list','javascript:1','bad'])assert.throws(()=>normalizeDnsPolicy({routeId:'block',dnsFilters:[{url}]}));
  assert.throws(()=>normalizeDnsPolicy({routeId:'direct',dnsFilters:['https://example.com/list']}));
  assert.equal(normalizeDnsPolicy({routeId:'block',dnsRules:'@@||allowed.example^\n||blocked.example^'}).dnsRules.length,2);
  assert.throws(()=>normalizeAdGuardSettings({cacheSize:-1}));assert.throws(()=>normalizeAdGuardSettings({logEnabled:'false'}));
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('subscriptions migrate into DNS settings once, preserve disabled sources and leave domain rules',async()=>{
 const store=new Store(':memory:');let rules=['||old.example^','@@||allowed.example^'],filters=[{url:'https://example.com/list',name:'Legacy',enabled:false}];
 const filter={userRules:async()=>rules,policySnapshot:async()=>({filters,userRules:rules}),reconcileUserRules:async(previous,desired)=>{rules=desired;},reconcileFilters:async(previous,desired)=>{filters=desired;}};
 const policy=new FilterPolicy(store,filter);
 try{await policy.change(()=>{});await policy.load();assert.equal(store.routeGroups().length,2);assert.ok(store.routeGroups().every(group=>!group.dnsFilters.length));assert.equal(store.adGuardSettings().subscriptions[0].enabled,false);
 await policy.change(()=>store.saveAdGuardSettings({...store.adGuardSettings(),subscriptions:[]}));assert.deepEqual(filters,[]);await policy.load();assert.equal(store.adGuardSettings().subscriptions.length,0);
 }finally{store.close();}
});
test('block zone is last, new blocks are inserted at its start and cannot move',()=>{
 const store=new Store(':memory:');try{const direct=store.profiles().find(p=>p.engine==='direct');
 const first=store.addRouteGroup({name:'First',entries:['first.example'],routeId:'block'}),allow=store.addRouteGroup({name:'Allow',entries:['example.com'],routeId:direct.id}),second=store.addRouteGroup({name:'Second',entries:['second.example'],routeId:'block'});
 assert.deepEqual(store.routeGroups().map(g=>g.id),[allow.id,second.id,first.id]);assert.throws(()=>store.moveRouteGroup(second.id,'up'));assert.throws(()=>store.moveRouteGroup(allow.id,'down'));
 }finally{store.close();}
});

test('AdGuard regeneration preserves filter subscriptions and query logging but keeps generated listeners',()=>{
 const previous='http:\n  address: 127.0.0.1:9999\nfilters:\n  - enabled: false\n    url: https://example.com/list\n    name: Custom\n    id: 9\nwhitelist_filters: []\nquerylog:\n  enabled: false\n  interval: 168h\nuser_rules:\n  - "@@||allowed.example^"\n';
 const generated=buildAdGuardConfig({listenPort:53053,upstreamPort:15353,webPort:13000});
 const result=preserveAdGuardPolicy(preserveAdGuardUserRules(generated,previous),previous);
 assert.match(result,/https:\/\/example.com\/list/);assert.match(result,/enabled: false/);assert.match(result,/interval: 168h/);assert.match(result,/@@\|\|allowed.example\^/);assert.match(result,/address: 127.0.0.1:13000/);assert.doesNotMatch(result,/127.0.0.1:9999/);
});

test('AdGuard settings retain unrelated querylog options; subscription removal is scoped to owned URLs',async()=>{
 const calls=[];let log={enabled:true,interval:86400000,anonymize_client_ip:true,ignored:['private.example']},dns={cache_size:4194304,blocked_response_ttl:10};
 const filters=[{url:'https://example.com/owned',name:'Owned',enabled:true},{url:'https://example.com/external',name:'External',enabled:true}];
 const adapter=new AdGuardSupervisor({binary:'/nonexistent',request:async(url,options)=>{
  const path=new URL(url).pathname.replace('/control/',''),body=options.body?JSON.parse(options.body):null;calls.push({path,body,method:options.method});
  if(path==='dns_config')dns={...dns,...body};if(path==='querylog/config/update')log=body;
  return {ok:true,json:async()=>path==='dns_info'?dns:path==='querylog/config'?log:path==='filtering/status'?{filters,user_rules:[]}:null};
 }});
 await adapter.configure({cacheSize:8388608,blockedTtl:20,logEnabled:false,logInterval:604800000});
 assert.equal(calls.find(call=>call.path==='querylog/config/update').method,'PUT');assert.deepEqual(log.ignored,['private.example']);assert.equal(log.anonymize_client_ip,true);assert.equal(dns.cache_size,8388608);
 await adapter.reconcileFilters(['https://example.com/owned'],[]);
 assert.deepEqual(calls.filter(call=>call.path==='filtering/remove_url').map(call=>call.body.url),['https://example.com/owned']);
});

test('AdGuard settings API requires write permission and CSRF; persists only validated successful changes',async()=>{
 const {createServer}=await import('../server/index.js');const store=new Store(':memory:');let configured=0,current=normalizeAdGuardSettings();
 const server=createServer(store,{filter:{status:()=>({state:'running'}),configuration:async()=>current,configure:async input=>{const value=normalizeAdGuardSettings(input);configured++;current=value;return value;}}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
 async function req(path,method='GET',body,session){const r=await fetch(base+'/api/'+path,{method,headers:{'Content-Type':'application/json',...(session?{Cookie:session.cookie,'X-CSRF-Token':session.csrf}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,data:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]};}
 try{
  assert.equal((await req('dns/adguard')).status,401);
  const setup=await req('auth/setup','POST',{username:'admin',password:'fixture password 12345'}),admin={cookie:setup.cookie,csrf:setup.data.csrf};
  assert.equal((await req('dns/adguard','PUT',{}, {...admin,csrf:'bad'})).status,403);
  await req('users','POST',{username:'viewer',password:'fixture password 12345',role:'viewer'},admin);
  const login=await req('auth/login','POST',{username:'viewer',password:'fixture password 12345'}),viewer={cookie:login.cookie,csrf:login.data.csrf};
  assert.equal((await req('dns/adguard','GET',null,viewer)).status,200);assert.equal((await req('dns/adguard','PUT',current,viewer)).status,403);
  assert.equal((await req('dns/adguard','PUT',{...current,cacheSize:-1},admin)).status,400);assert.equal(configured,0);assert.equal(store.adGuardSettings(),null);
  assert.equal((await req('dns/adguard','PUT',{...current,cacheSize:8388608},admin)).status,200);assert.equal(store.adGuardSettings().cacheSize,8388608);
 }finally{await new Promise(r=>server.close(r));store.close();}
});

test('failed subscription changes restore route data and previously active DNS policy',async()=>{
 const store=new Store(':memory:');let fail=false,rules=[],filters=[];
 const adapter={userRules:async()=>rules,policySnapshot:async()=>({userRules:rules,filters}),reconcileUserRules:async(previous,desired)=>{rules=[...desired];},reconcileFilters:async(previous,desired)=>{if(fail && desired.some(source=>source.url.endsWith('/bad')))throw Error('Download failed');filters=[...desired];}};
 const policy=new FilterPolicy(store,adapter);
 try{
  await policy.change(()=>store.saveAdGuardSettings({subscriptions:[{url:'https://example.com/good'}]}));
  fail=true;await assert.rejects(policy.change(()=>store.saveAdGuardSettings({subscriptions:[{url:'https://example.com/bad'}]})),/Download failed/);
  assert.equal(store.adGuardSettings().subscriptions[0].url,'https://example.com/good');assert.equal(filters[0].url,'https://example.com/good');

 }finally{store.close();}
});
