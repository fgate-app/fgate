import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../server/store.js';
import {diagnosticGatewaySession} from '../server/diagnostic-gateway-session.js';

test('disabled diagnostic gateway and its dependency run temporarily without changing saved flags',async()=>{
 const store=new Store(':memory:');
 const parent=store.importProfile({name:'Parent',value:'socks5://192.0.2.1:1080'}),child=store.importProfile({name:'Child',value:'socks5://192.0.2.2:1080'});
 store.db.prepare('UPDATE profiles SET enabled=0 WHERE id IN (?,?)').run(parent.id,child.id);
 store.db.prepare('UPDATE profiles SET gateway_id=? WHERE id=?').run(parent.id,child.id);
 let current,applied=0,remembered=0;
 const supervisor={status:()=>({state:'running'}),setRoutes:(_d,_g,profiles)=>{current=profiles;},reapply:async()=>{applied++;return {ok:true};},rememberDiagnosticLocation:()=>{remembered++;}};
 try{
  const release=await diagnosticGatewaySession(store,supervisor,child.id);
  assert.equal(current.find(p=>p.id===child.id).enabled,true);assert.equal(current.find(p=>p.id===parent.id).enabled,true);
  assert.equal(store.profiles().find(p=>p.id===child.id).enabled,false);
  // An explicit user edit during diagnostics must survive cleanup.
  store.db.prepare('UPDATE profiles SET enabled=1 WHERE id=?').run(parent.id);
  await release();await release();
  assert.equal(current.find(p=>p.id===child.id).enabled,false);assert.equal(current.find(p=>p.id===parent.id).enabled,true);
  assert.equal(supervisor.diagnosticEnabledIds,null);assert.equal(applied,2);assert.equal(remembered,1);
 }finally{store.close();}
});

test('failed temporary apply restores original runtime and cancellation never enables a gateway',async()=>{
 const store=new Store(':memory:');const p=store.importProfile({name:'Disabled',value:'socks5://192.0.2.1:1080'});store.db.prepare('UPDATE profiles SET enabled=0 WHERE id=?').run(p.id);
 let applied=0,current;
 const supervisor={status:()=>({state:'running'}),setRoutes:(_d,_g,profiles)=>{current=profiles;},reapply:async()=>({ok:++applied!==1})};
 try{
  await assert.rejects(diagnosticGatewaySession(store,supervisor,p.id));
  assert.equal(current.find(row=>row.id===p.id).enabled,false);assert.equal(supervisor.diagnosticEnabledIds,null);
  const controller=new AbortController();controller.abort();
  await assert.rejects(diagnosticGatewaySession(store,supervisor,p.id,{signal:controller.signal}),/cancelled/);
  assert.equal(applied,2);
 }finally{store.close();}
});

test('temporary diagnostic listeners cannot activate ordinary domain or group routes',async()=>{
 const {buildMihomoConfig}=await import('../server/mihomo.js');const {defaultDnsSettings}=await import('../server/dns-resolvers.js');
 const id='12345678-parent',child='abcdefgh-child',profiles=[{id,engine:'mihomo',enabled:true,diagnosticOnly:true},{id:child,engine:'mihomo',enabled:true,gatewayId:id}];
 const config=buildMihomoConfig(defaultDnsSettings,{controllerSecret:'fixture'},{devices:[],groups:[{id:'route',entries:['test.example'],routeId:child}],profiles,configs:profiles.map(p=>({profile_id:p.id,engine:'mihomo',config:JSON.stringify({type:'socks5',server:'192.0.2.1',port:1080})})),connectionGroups:[{id:'group',members:[id,child]}]});
 assert.match(config,/DOMAIN-SUFFIX,test\.example,REJECT/);
 assert.match(config,/name: cg-group\n    type: url-test\n    proxies:\n      - REJECT/);
 assert.match(config,/"name":"fg-geo-12345678-parent"/);
 assert.match(config,/"proxy":"p-12345678-grp"/);
});

test('an exit identity measured before a gateway edit cannot be assigned to the new configuration',async()=>{
 const {MihomoSupervisor}=await import('../server/mihomo.js');
 const subject=Object.create(MihomoSupervisor.prototype),profiles=[{id:'fixture',enabled:true,engine:'mihomo'}];
 subject._routes={profiles,configs:[{profile_id:'fixture',config:'old'}]};subject.diagnosticLocationResults=new Map();subject.gatewayLocations={refresh:async()=>({status:'ok',ip:'203.0.113.1'})};
 await subject.checkGatewayConnection('fixture',{});subject._routes.configs[0].config='edited';subject.rememberDiagnosticLocation('fixture',profiles);
 assert.equal(subject.diagnosticLocationResults.size,0);
 await subject.checkGatewayConnection('fixture',{});subject.rememberDiagnosticLocation('fixture',profiles.map(p=>({...p,enabled:false})));
 assert.equal(subject.diagnosticLocationResults.get('fixture').value.ip,'203.0.113.1');
});


test('temporary DPI diagnostics do not activate saved per-domain bypass strategies',async()=>{
 const {buildMihomoConfig}=await import('../server/mihomo.js');const {defaultDnsSettings}=await import('../server/dns-resolvers.js');
 const config=buildMihomoConfig(defaultDnsSettings,{}, {devices:[],groups:[{id:'route',entries:['dpi.example'],routeId:'dpi',zapretStrategy:'nfqws2'}],profiles:[{id:'dpi',engine:'zapret',enabled:true,diagnosticOnly:true}],configs:[],connectionGroups:[]});
 assert.match(config,/DOMAIN-SUFFIX,dpi\.example,REJECT/);
 assert.doesNotMatch(config,/name: zapret-nfqws2/);
});
