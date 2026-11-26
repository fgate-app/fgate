import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../server/store.js';
import {FilterPolicy} from '../server/filter-policy.js';
import {createServer} from '../server/index.js';

function adapter(initial) {
 let rules=[...initial];
 return {userRules:async()=>[...rules],reconcileUserRules:async(previous,desired)=>{
  rules=[...new Set([...rules.filter(rule=>!previous.includes(rule)),...desired])];return rules;
 }};
}

test('existing domain blocks import into common routes once and edits remove owned DNS rules',async()=>{
 const store=new Store(':memory:'),filter=adapter(['||metrika.yandex.ru^','@@||allowed.example^']);
 const policy=new FilterPolicy(store,filter);
 try{
  await policy.load();await policy.load();
  const groups=store.routeGroups();assert.equal(groups.length,1);
  assert.deepEqual(groups[0].entries,['metrika.yandex.ru']);assert.equal(groups[0].routeId,'block');
  const direct=store.profiles().find(profile=>profile.engine==='direct');
  await policy.change(()=>store.updateRouteGroup(groups[0].id,{routeId:direct.id}));
  assert.deepEqual(await filter.userRules(),['@@||allowed.example^']);
  await policy.load();assert.equal(store.routeGroups().length,1,'unblocked rules do not reimport');
  await policy.change(()=>store.updateRouteGroup(groups[0].id,{routeId:'block'}));
  assert.ok((await filter.userRules()).includes('||metrika.yandex.ru^'));
  await policy.change(()=>store.removeRouteGroup(groups[0].id));
  assert.deepEqual(await filter.userRules(),['@@||allowed.example^']);
 }finally{store.close();}
});

test('domain/IP groups create DNS rules only for domains and keep overlapping blocks until the last owner is removed',async()=>{
 const store=new Store(':memory:'),filter=adapter([]),policy=new FilterPolicy(store,filter);
 try{
  const first=await policy.change(()=>store.addRouteGroup({name:'Mixed',entries:['example.com','*.sub.example.com','192.0.2.1','2001:db8::/32'],routeId:'block'}));
  assert.deepEqual(await filter.userRules(),['||example.com^','||*.sub.example.com^']);
  const second=await policy.change(()=>store.addRouteGroup({name:'Other',entries:['example.com'],routeId:'block'}));
  await policy.change(()=>store.removeRouteGroup(first.id));
  assert.deepEqual(await filter.userRules(),['||example.com^']);
  await policy.change(()=>store.removeRouteGroup(second.id));assert.deepEqual(await filter.userRules(),[]);
 }finally{store.close();}
});

test('common routes API exposes imported blocks and creates or deletes them through the existing group endpoints',async()=>{
 const store=new Store(':memory:'),filter=adapter(['||metrika.yandex.ru^']);
 const server=createServer(store,{filter});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const base='http://127.0.0.1:'+server.address().port+'/api/';
 try{
  const setup=await fetch(base+'auth/setup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'admin',password:'fixture password 12345'})});
  const session=await setup.json(),headers={'Content-Type':'application/json',Cookie:setup.headers.get('set-cookie').split(';')[0],'X-CSRF-Token':session.csrf};
  const data=await(await fetch(base+'routes',{headers})).json();
  assert.equal(data.groups[0].routeId,'block');assert.deepEqual(data.groups[0].entries,['metrika.yandex.ru']);
  const created=await fetch(base+'routes/groups',{method:'POST',headers,body:JSON.stringify({name:'Analytics',entries:['analytics.example'],routeId:'block'})});
  assert.equal(created.status,201);const group=await created.json();
  assert.ok((await filter.userRules()).includes('||analytics.example^'));
  const removed=await fetch(base+'routes/groups/'+group.id,{method:'DELETE',headers});assert.equal(removed.status,200);
  assert.deepEqual(await filter.userRules(),['||metrika.yandex.ru^']);
 }finally{await new Promise(resolve=>server.close(resolve));store.close();}
});

test('local aliases produce exact DNS rewrites, update and delete without affecting other rules',async()=>{
 const store=new Store(':memory:'),filter=adapter(['@@||allowed.example^']),policy=new FilterPolicy(store,filter);
 try {
  const local=await policy.change(()=>store.addLocalRoute({alias:'fgate.home',target:'10.20.0.1'}));
  assert.ok((await filter.userRules()).includes('/^fgate\\.home$/$dnsrewrite=NOERROR;A;10.20.0.1'));
  await policy.change(()=>store.updateLocalRoute(local.id,{alias:'fgate.home',target:'2001:db8::1'}));
  assert.deepEqual(await filter.userRules(),['@@||allowed.example^','/^fgate\\.home$/$dnsrewrite=NOERROR;AAAA;2001:db8::1']);
  await policy.change(()=>store.removeLocalRoute(local.id));
  assert.deepEqual(await filter.userRules(),['@@||allowed.example^']);
 }finally{store.close();}
});
