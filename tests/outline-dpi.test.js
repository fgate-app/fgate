import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../server/store.js';
import {gatewayEditor} from '../server/gateway-editor.js';
import {outlineDpiArgs,outlineDpiNft} from '../server/outline-dpi.js';
import {SsRelaySupervisor} from '../server/ss-relay.js';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
const link='ss://'+Buffer.from('chacha20-ietf-poly1305:fixture-secret').toString('base64url')+'@192.0.2.12:44127/?prefix=%16%03%01%00%C2%A8%01%01';
test('SS DPI defaults, editing, rollback and conversion preserve a valid profile',()=>{
 const store=new Store(':memory:');
 try{
  const ss=store.importProfile({value:link}),other=store.importProfile({value:'socks5://192.0.2.1:1080'});
  assert.equal(store.profiles().find(p=>p.id===ss.id).dpiBypass,false);
  const old=store.profileSnapshot(ss.id),editor=gatewayEditor(old);
  assert.equal(editor.dpiBypass,false);
  store.updateProfile(ss.id,{editor,dpiBypass:true});
  assert.equal(gatewayEditor(store.profileSnapshot(ss.id)).dpiBypass,true);
  assert.equal(store.profileSnapshot(ss.id).config.config,link,'switch never rewrites credentials or prefix');
  store.updateProfile(ss.id,{name:'Renamed'});
  assert.equal(store.profiles().find(p=>p.id===ss.id).dpiBypass,true);
  assert.throws(()=>store.updateProfile(other.id,{dpiBypass:true}),/Shadowsocks/);
  assert.throws(()=>store.updateProfile(ss.id,{dpiBypass:'true'}),/DPI/);
  store.restoreProfile(old);assert.equal(gatewayEditor(store.profileSnapshot(ss.id)).dpiBypass,false);
  store.updateProfile(ss.id,{dpiBypass:true});store.updateProfile(ss.id,{value:'socks5://192.0.2.1:1080'});
  assert.equal(store.profiles().find(p=>p.id===ss.id).dpiBypass,false);
 }finally{store.close();}
});
test('DPI queue accepts only the dedicated mark and service uid on TCP; strategy handles unknown encrypted payloads',()=>{
 const nft=outlineDpiNft(987);assert.match(nft,/meta skuid 987 meta mark 0x10000007 meta l4proto tcp/);assert.doesNotMatch(nft,/dport|udp/);
 assert.throws(()=>outlineDpiNft('root'));
 const args=outlineDpiArgs({binary:'nfqws2',lua:'/lua',pidfile:'/run/freedomgate/outline-nfqws2.pid'});
 assert.ok(args.includes('--reasm-disable'));assert.ok(args.includes('--lua-desync=multidisorder:pos=1:payload=all'));assert.ok(args.includes('--filter-mark=0x10000007/0xffffffff'));
});
test('SS switch replaces only its bridge; failed helper setup preserves the previous bridge',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'fg-dpi-'));let calls=0,fail=false;
 const relay=new SsRelaySupervisor({stateDir:dir,ensureDpi:async()=>{calls++;return fail?{ok:false,error:'fixture failure'}:{ok:true};}});
 relay.start=e=>{e.process={};};relay.ready=async()=>{};relay.stopEntry=async e=>{e.process=null;};
 try{
  const row={profile_id:'ss-fixture',engine:'outline',config:link};
  let prepared=await relay.prepare([row]);await prepared.commit();const original=relay.entries.get(row.profile_id);
  prepared=await relay.prepare([{...row,dpiBypass:1}]);
  assert.equal(calls,1);assert.notEqual(prepared.bridges[row.profile_id].port,original.port);
  const candidate=[...relay.entries.values()][0];assert.equal(candidate,original);
  await prepared.rollback();assert.equal(relay.entries.get(row.profile_id),original);
  fail=true;await assert.rejects(relay.prepare([{...row,dpiBypass:true}]),/fixture failure/);assert.equal(relay.entries.get(row.profile_id),original);
  fail=false;prepared=await relay.prepare([{...row,dpiBypass:true}]);await prepared.commit();
  assert.equal(JSON.parse(readFileSync(relay.entries.get(row.profile_id).path)).node.dpi_bypass,true);
  prepared=await relay.prepare([row]);await prepared.commit();assert.equal(JSON.parse(readFileSync(relay.entries.get(row.profile_id).path)).node.dpi_bypass,false);
 }finally{await relay.stop();rmSync(dir,{recursive:true,force:true});}
});
test('older databases gain a disabled DPI field and rename only the default zapret label',()=>{
 const dir=mkdtempSync(join(tmpdir(),'fg-dpi-migration-')),path=join(dir,'db.sqlite');let store;
 try{
  store=new Store(path);const ss=store.importProfile({value:link});
  store.db.exec('ALTER TABLE profiles DROP COLUMN dpi_bypass');
  store.db.prepare("UPDATE profiles SET name='zapret' WHERE engine='zapret'").run();store.close();
  store=new Store(path);
  assert.equal(store.profiles().find(p=>p.id===ss.id).dpiBypass,false);
  assert.equal(store.profiles().find(p=>p.engine==='zapret').name,'Обход DPI');
  store.db.prepare("UPDATE profiles SET name='Custom DPI' WHERE engine='zapret'").run();store.close();store=new Store(path);
  assert.equal(store.profiles().find(p=>p.engine==='zapret').name,'Custom DPI');
 }finally{store?.close();rmSync(dir,{recursive:true,force:true});}
});
