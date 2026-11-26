import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../server/store.js';
import {gatewayEditor} from '../server/gateway-editor.js';
import {gatewayChainAvailable,gatewayWrapCandidates} from '../shared/gateway-wrap.js';
import {buildMihomoConfig} from '../server/mihomo.js';
import {defaultDnsSettings} from '../server/dns-resolvers.js';
import {XraySupervisor} from '../server/xray.js';
import {SsRelaySupervisor} from '../server/ss-relay.js';
const ss='ss://'+Buffer.from('chacha20-ietf-poly1305:fixture-secret').toString('base64url')+'@192.0.2.12:44127/?prefix=%16%03%01';
test('wrapping persists independently of keys, rejects missing gateways/cycles and protects referenced gateways',()=>{
 const store=new Store(':memory:');
 try{
  const a=store.importProfile({value:ss}),b=store.importProfile({value:'vless://fixture@192.0.2.2:443?security=none'}),c=store.importProfile({value:'socks5://192.0.2.3:1080'});
  const before=store.profileSnapshot(a.id);
  assert.equal(gatewayEditor(before).gatewayId,null);
  store.updateProfile(a.id,{gatewayId:b.id});store.updateProfile(b.id,{gatewayId:c.id});
  assert.equal(gatewayEditor(store.profileSnapshot(a.id)).gatewayId,b.id);
  assert.equal(store.profileSnapshot(a.id).config.config,ss);
  assert.throws(()=>store.updateProfile(c.id,{gatewayId:a.id}),/cycle/);
  assert.throws(()=>store.updateProfile(a.id,{gatewayId:a.id}),/cycle/);
  assert.throws(()=>store.updateProfile(a.id,{gatewayId:'missing'}),/missing/);
  assert.throws(()=>store.updateProfile(a.id,{gatewayId:false}),/Select/);
  assert.throws(()=>store.updateProfile(a.id,{gatewayId:store.profiles().find(p=>p.engine==='direct').id}),/cycle/);
  assert.throws(()=>store.removeProfile(b.id),/wraps/);
  assert.ok(!gatewayWrapCandidates(store.profiles(),c.id).some(p=>p.id===a.id));
  store.updateProfile(c.id,{enabled:false});assert.equal(gatewayChainAvailable(store.profiles(),a.id),false);
  store.updateProfile(c.id,{enabled:true});assert.equal(gatewayChainAvailable(store.profiles(),a.id),true);
  store.updateProfile(a.id,{name:'Renamed'});assert.equal(gatewayEditor(store.profileSnapshot(a.id)).gatewayId,b.id);
  store.restoreProfile(before);assert.equal(gatewayEditor(store.profileSnapshot(a.id)).gatewayId,null);
  store.updateProfile(a.id,{gatewayId:b.id});store.updateProfile(a.id,{gatewayId:null});assert.equal(store.profileSnapshot(a.id).config.config,ss);
 }finally{store.close();}
});
test('older databases migrate to unwrapped profiles',()=>{
 const dir=mkdtempSync(join(tmpdir(),'fg-wrap-migration-'));let store;
 try{
  const path=join(dir,'db');store=new Store(path);const a=store.importProfile({value:ss});store.db.exec('ALTER TABLE profiles DROP COLUMN gateway_id');store.close();store=new Store(path);
  assert.equal(store.profiles().find(p=>p.id===a.id).gatewayId,null);
 }finally{store?.close();rmSync(dir,{recursive:true,force:true});}
});
test('mihomo pins nested listeners and native dialers; a disabled outer rejects the inner without a direct fallback',()=>{
 const profiles=[{id:'inner001',engine:'socks5',gatewayId:'outer001'},{id:'outer001',engine:'socks5'}],configs=profiles.map((p,i)=>({profile_id:p.id,engine:'socks5',config:`socks5://192.0.2.${i+1}:1080`}));
 const routes={profiles,configs,groups:[],devices:[]};
 const options={wrapperEndpoints:new Map([['outer001',{port:24001,username:'fg-wrap',password:'secret'}]])};
 let yaml=buildMihomoConfig(defaultDnsSettings,options,routes);
 assert.match(yaml,/dialer-proxy: p-outer001/);assert.match(yaml,/"name":"fg-wrap-outer001".*"proxy":"p-outer001"/);
 yaml=buildMihomoConfig(defaultDnsSettings,options,{...routes,profiles:profiles.map(p=>p.id==='outer001'?{...p,enabled:false}:p)});
 assert.match(yaml,/"name":"p-inner001","type":"reject"/);assert.match(yaml,/"name":"fg-wrap-outer001".*"proxy":"REJECT"/);
 assert.doesNotMatch(yaml,/dialer-proxy:/);
});
test('Xray and Outline prepare private wrapped transports and rollback without replacing live entries',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'fg-wrap-runtime-')),xray=new XraySupervisor({binary:process.execPath,stateDir:dir}),relay=new SsRelaySupervisor({stateDir:dir});
 xray.validate=async()=>{};xray.start=e=>{e.process={};};xray.ready=async()=>{};
 relay.start=e=>{e.process={};};relay.ready=async()=>{};
 const endpoint={port:24001,username:'fg-wrap',password:'secret'};
 try{
  const xp=await xray.prepare([{profile_id:'x',engine:'xray',config:'vless://fixture@192.0.2.2:443?security=none',wrapEndpoint:endpoint}]);await xp.commit();
  const cfg=JSON.parse(readFileSync(xray.entries.get('x').path));assert.equal(cfg.outbounds[0].streamSettings.sockopt.dialerProxy,'gateway-wrapper');assert.equal(cfg.outbounds[1].settings.servers[0].port,24001);
  const row={profile_id:'ss',engine:'outline',config:ss};const direct=await relay.prepare([row]);await direct.commit();const original=relay.entries.get('ss');
  const wrapped=await relay.prepare([{...row,wrapEndpoint:endpoint,dpiBypass:true}]);
  assert.equal(relay.entries.get('ss'),original);await wrapped.rollback();assert.equal(relay.entries.get('ss'),original);
  const next=await relay.prepare([{...row,wrapEndpoint:endpoint,dpiBypass:true}]);await next.commit();const entry=relay.entries.get('ss'),node=JSON.parse(readFileSync(entry.path)).node;
  assert.equal(node.server,'127.0.0.1');assert.equal(node.port,entry.tunnel.port);assert.equal(node.prefix_hex,'160301');assert.equal(node.dpi_bypass,false);
 }finally{await xray.stop();await relay.stop();rmSync(dir,{recursive:true,force:true});}
});
