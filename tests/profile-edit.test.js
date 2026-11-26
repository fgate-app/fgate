import test from 'node:test';import assert from 'node:assert/strict';
import {Store} from '../server/store.js';import {buildMihomoConfig} from '../server/mihomo.js';import {defaultDnsSettings} from '../server/dns-resolvers.js';
test('editing preserves profile identity and group membership, disabling retains its secret',()=>{
 const s=new Store(':memory:');try{
  const p=s.importProfile({name:'Original',value:'socks5://127.0.0.1:9999'});
  const g=s.saveConnectionGroup(null,{name:'Group',members:[p.id]});
  const old=s.profileSnapshot(p.id);
  const updated=s.updateProfile(p.id,{name:'Updated',enabled:false});
  assert.equal(updated.enabled,false);assert.equal(updated.id,p.id);assert.deepEqual(s.connectionGroups()[0].members,[p.id]);
  assert.equal(s.profileSnapshot(p.id).config.config,old.config.config);
  s.updateProfile(p.id,{value:'socks5://127.0.0.1:9998',enabled:true});
  assert.equal(s.profileSnapshot(p.id).config.config,'socks5://127.0.0.1:9998');
  assert.equal(s.profiles().find(row=>row.id===p.id).enabled,true);
  assert.throws(()=>s.updateProfile(p.id,{name:''}));assert.throws(()=>s.updateProfile(p.id,{enabled:'false'}));
  assert.equal(s.connectionGroups()[0].id,g.id);
 }finally{s.close();}
});
test('disabled group members are skipped; empty groups and individual routes reject without direct fallback',()=>{
 const profiles=[{id:'disabled1',engine:'outline',enabled:false},{id:'enabled01',engine:'xray',enabled:true}];
 const yaml=buildMihomoConfig(defaultDnsSettings,{}, {profiles,configs:[{profile_id:'disabled1',engine:'outline',config:'ss://unused'},{profile_id:'enabled01',engine:'xray',config:'{}'}],bridges:{enabled01:{port:9999,address:'192.0.2.1'}},connectionGroups:[{id:'mixed',members:profiles.map(p=>p.id)},{id:'empty',members:['disabled1']}],devices:[{id:'phone',identifier:'10.20.0.2',routeId:'disabled1'}],groups:[{id:'site',entries:['example.com'],routeId:'disabled1'}]});
 assert.match(yaml,/name: cg-mixed\n    type: url-test\n    proxies:\n      - p-enabled0-grp\n/);
 assert.match(yaml,/name: cg-empty\n    type: url-test\n    proxies:\n      - REJECT\n/);
 assert.match(yaml,/SRC-IP-CIDR,10.20.0.2\/32,REJECT/);
 assert.match(yaml,/DOMAIN-SUFFIX,example.com,REJECT/);
 assert.ok(yaml.indexOf('DOMAIN-SUFFIX,example.com,REJECT')<yaml.indexOf('SRC-IP-CIDR,10.20.0.2/32,REJECT'),'ordered domain rules precede the device fallback even when disabled');
});
test('failed runtime edit restores the previous configuration and enabled state',async()=>{
 const {createServer}=await import('../server/index.js');const store=new Store(':memory:');
 const p=store.importProfile({name:'Original',value:'socks5://127.0.0.1:9999'});let configs=[];
 const supervisor={status:()=>({state:'running'}),setRoutes:(_d,_g,_p,c)=>configs=c,reapply:async()=>({ok:!configs.some(c=>c.config.includes('9998')),error:'Rejected runtime fixture'})};
 const server=createServer(store,{supervisor});await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
 try{
  const setup=await fetch(base+'/api/auth/setup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'admin',password:'test password 12345'})});
  const session=await setup.json(),cookie=setup.headers.get('set-cookie').split(';')[0];
  const response=await fetch(base+'/api/profiles/'+p.id,{method:'PUT',headers:{'Content-Type':'application/json',Cookie:cookie,'X-CSRF-Token':session.csrf},body:JSON.stringify({name:'Changed',value:'socks5://127.0.0.1:9998',enabled:false})});
  assert.equal(response.status,400);const saved=store.profiles().find(row=>row.id===p.id);assert.equal(saved.name,'Original');assert.equal(saved.enabled,true);assert.equal(store.profileSnapshot(p.id).config.config,'socks5://127.0.0.1:9999');
 }finally{await new Promise(r=>server.close(r));store.close();}
});
test('Direct cannot be edited or disabled',()=>{
 const store=new Store(':memory:');try{
  const direct=store.profiles().find(p=>p.engine==='direct');
  assert.throws(()=>store.updateProfile(direct.id,{enabled:false}));
  assert.throws(()=>store.updateProfile(direct.id,{name:'Changed'}));
  assert.equal(store.profiles().find(p=>p.id===direct.id).enabled,true);
 }finally{store.close();}
});
