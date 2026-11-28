import test from 'node:test';
import assert from 'node:assert/strict';
import {configRecords} from '../shared/gateway-config.js';
import {manualConfig,visibleFields} from '../shared/manual-gateway.js';
import {parseWireGuard,parseOpenVPN} from '../server/gateway-config.js';
import {Store} from '../server/store.js';
import {buildMihomoConfig} from '../server/mihomo.js';
const privateKey=Buffer.alloc(32,1).toString('base64'),publicKey=Buffer.alloc(32,2).toString('base64');
const wg=`[Interface]\nPrivateKey = ${privateKey}\nAddress = 10.2.0.2/32, fd00::2/128\n[Peer]\nPublicKey = ${publicKey}\nAllowedIPs = 0.0.0.0/0, ::/0\nEndpoint = [2001:db8::1]:51820`;
const vless='vless://00000000-0000-4000-8000-000000000001@example.com:443?security=none#Test';
test('subscription decoding preserves UTF-8 names and all records',()=>{const list=vless+'\n'+vless.replace('#Test','#'+encodeURIComponent('Амстердам'));assert.deepEqual(configRecords(Buffer.from(list).toString('base64')),[...list.split('\n')]);assert.throws(()=>configRecords('not a config'));});
test('WireGuard converts addresses and IPv6 endpoint; rejects multiple peers and invalid keys',()=>{const p=parseWireGuard(wg);assert.equal(p.server,'2001:db8::1');assert.equal(p.ipv6,'fd00::2');assert.throws(()=>parseWireGuard(wg+'\n[Peer]'));assert.throws(()=>parseWireGuard(wg.replace(privateKey,'bad')));});
test('OpenVPN extracts embedded keys; never reads external paths or runs directives',()=>{const p=parseOpenVPN('client\nremote vpn.example.com 1194\nproto udp\nauth SHA256\nup /tmp/script\n<ca>\n-----BEGIN CERTIFICATE-----\nCA\n</ca>\n<cert>\n-----BEGIN CERTIFICATE-----\nCERT\n</cert>\n<key>\n-----BEGIN PRIVATE KEY-----\nKEY\n</key>');assert.equal(p.server,'vpn.example.com');assert.equal(p.auth,'SHA256');assert.equal(p.up,undefined);assert.throws(()=>parseOpenVPN('client\nremote example.com\nca /tmp/ca'));});
test('manual fields follow security and transport; links escape credentials',()=>{assert.ok(!visibleFields('vless',{security:'none',network:'tcp'}).includes('publicKey'));assert.ok(visibleFields('vless',{security:'reality',network:'ws'}).includes('path'));const link=manualConfig('socks5',{server:'::1',port:'1080',username:'a@b',password:'p/#'});assert.equal(new URL(link).hostname,'[::1]');assert.equal(decodeURIComponent(new URL(link).password),'p/#');assert.throws(()=>manualConfig('vless',{server:'x',port:0}));});
test('batch imports are atomic and native profiles survive editing',()=>{const store=new Store(':memory:');try{const count=store.profiles().length;assert.throws(()=>store.importProfiles({value:vless+'\nss://invalid'}));assert.equal(store.profiles().length,count);const rows=store.importProfiles({value:vless+'\n'+vless});assert.equal(rows.length,2);const p=store.importProfile({value:wg,name:'WG'});assert.equal(p.engine,'mihomo');assert.equal(store.updateProfile(p.id,{name:'WG2'}).protocol,'wireguard');}finally{store.close();}});
test('native connections are emitted into mihomo and selected by routes',async()=>{
 const {defaultDnsSettings}=await import('../server/dns-resolvers.js');
 const store=new Store(':memory:');try{
  const p=store.importProfile({name:'WG',value:wg});
  store.addRouteGroup({name:'WG sites',entries:['example.org'],routeId:p.id});
  const yaml=buildMihomoConfig(defaultDnsSettings,{}, {profiles:store.profiles(),configs:store.db.prepare('SELECT * FROM profile_configs').all(),groups:store.routeGroups(),devices:[]});
  assert.ok(yaml.includes('"type":"wireguard"'));assert.ok(yaml.includes(`"name":"p-${p.id.slice(0,8)}"`));assert.ok(yaml.includes(`DOMAIN-SUFFIX,example.org,p-${p.id.slice(0,8)}-grp`));
 }finally{store.close();}
});
test('field editing preserves Xray options, native options and Outline prefix',async()=>{
 const {gatewayEditor}=await import('../server/gateway-editor.js');
 const store=new Store(':memory:');try{
  const root={outbounds:[{protocol:'vless',settings:{vnext:[{address:'example.com',port:443,users:[{id:'fixture-id',encryption:'none'}]}]},streamSettings:{network:'ws',security:'tls',tlsSettings:{serverName:'example.com',alpn:['h2'],allowInsecure:false},wsSettings:{path:'/vpn',headers:{Host:'edge.example.com',Custom:'keep'}}},mux:{enabled:true,concurrency:4}}]};
  const row=store.importProfile({name:'Advanced',value:JSON.stringify(root)}),snapshot=store.profileSnapshot(row.id),editor=gatewayEditor(snapshot);
  assert.equal(editor.fields.path,'/vpn');editor.fields.port='8443';
  store.updateProfile(row.id,{editor});
  const out=JSON.parse(store.profileSnapshot(row.id).config.config).outbounds[0];assert.equal(out.settings.vnext[0].port,8443);assert.deepEqual(out.mux,root.outbounds[0].mux);assert.deepEqual(out.streamSettings.tlsSettings.alpn,['h2']);assert.equal(out.streamSettings.wsSettings.headers.Custom,'keep');
  const native=store.importProfile({name:'WG',value:wg}),wgEditor=gatewayEditor(store.profileSnapshot(native.id));wgEditor.fields.server='new.example.com';store.updateProfile(native.id,{editor:wgEditor});assert.equal(JSON.parse(store.profileSnapshot(native.id).config.config).server,'new.example.com');
  const ss=store.importProfile({value:'ss://'+Buffer.from('aes-256-gcm:secret').toString('base64url')+'@example.com:8388/?prefix=%16%03%01',name:'Outline'}),ssEditor=gatewayEditor(store.profileSnapshot(ss.id));assert.equal(ssEditor.fields.prefix,'160301');ssEditor.fields.port='8389';store.updateProfile(ss.id,{editor:ssEditor});assert.ok(store.profileSnapshot(ss.id).config.config.includes('prefix=%16%03%01'));
  assert.throws(()=>store.updateProfile(ss.id,{editor:{...ssEditor,type:'vless'}}));
 }finally{store.close();}
});
