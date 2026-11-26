import test from 'node:test';
import {nativeFixtures} from './fixtures/mihomo-proxies.js';
import assert from 'node:assert/strict';
import {mihomoTypes,normalizeMihomoProxy,parseMihomoLink,mihomoDraft,mihomoFromDraft} from '../shared/mihomo-proxy.js';
import {configRecords} from '../shared/gateway-config.js';
import {manualConfig} from '../shared/manual-gateway.js';
import {Store} from '../server/store.js';
import {gatewayEditor} from '../server/gateway-editor.js';
import {buildMihomoConfig} from '../server/mihomo.js';
import {defaultDnsSettings} from '../server/dns-resolvers.js';
import {gatewayHost} from '../server/gateway-recursion.js';
const key=Buffer.alloc(32,1).toString('base64');
const fixture=type=>({type,server:'192.0.2.1',port:443,...nativeFixtures[type]});
test('all pinned mihomo outbound types round-trip through import, settings, DB, routes and native generation',()=>{
 assert.deepEqual(Object.keys(nativeFixtures).sort(),[...mihomoTypes].sort());
 const store=new Store(':memory:');
 try{for(const type of mihomoTypes){
  const node=fixture(type);if(['tailscale','zerotier','easytier'].includes(type)){delete node.server;delete node.port;}
  const records=configRecords(JSON.stringify({proxies:[{...node,name:'Native '+type}]}));
  const profile=store.importProfiles({value:records[0]})[0];assert.equal(profile.engine,'mihomo');assert.equal(profile.name,'Native '+type);
  const before=store.profileSnapshot(profile.id),editor=gatewayEditor(before);assert.equal(editor.type,'mihomo:'+type);
  if(editor.fields.server)editor.fields.server='192.0.2.2';
  store.updateProfile(profile.id,{editor});
  const saved=JSON.parse(store.profileSnapshot(profile.id).config.config).mihomo;
  assert.deepEqual(saved,{...node,...(node.server?{server:'192.0.2.2'}:{})});
  assert.deepEqual(JSON.parse(manualConfig(editor.type,editor.fields)).mihomo,saved);
  assert.equal(gatewayHost(store.profileSnapshot(profile.id)),node.server?'192.0.2.2':'');
  store.addRouteGroup({name:type,entries:[type+'.example.com'],routeId:profile.id});
 }
 const yaml=buildMihomoConfig(defaultDnsSettings,{}, {profiles:store.profiles(),configs:store.db.prepare('SELECT * FROM profile_configs').all(),groups:store.routeGroups(),devices:[]});
 assert.ok(!yaml.includes('"mihomo":'));for(const type of mihomoTypes)assert.ok(yaml.includes('"type":"'+type+'"'));
 }finally{store.close();}
});
test('YAML complete configs import only proxies, preserving native options and named list selection',()=>{
 const records=configRecords('mixed-port: 9999\ndns: {enable: false}\nproxies:\n  - name: "Токио"\n    type: trojan\n    server: example.com\n    port: 443\n    password: secret\n    alpn: [h2, http/1.1]\n    ws-opts:\n      path: /proxy\n      headers: {Host: cdn.example.com}\n  - {name: HTTP, type: http, server: example.net, port: 8080}\nrules: [MATCH,DIRECT]');
 assert.equal(records.length,2);assert.equal(configRecords(JSON.stringify(records)).length,2);const a=JSON.parse(records[0]).mihomo;assert.equal(a.name,'Токио');assert.deepEqual(a.alpn,['h2','http/1.1']);assert.equal(a['ws-opts'].headers.Host,'cdn.example.com');assert.ok(!records.join('').includes('mixed-port'));
 assert.deepEqual(JSON.parse(configRecords(JSON.stringify(fixture('wireguard')))[0]).mihomo.reserved,[1,2,3]);
 assert.equal(JSON.parse(configRecords(manualConfig('hysteria2',{server:'192.0.2.1',port:'443',password:'fixture'}))[0]).mihomo.udp,true);
});
test('links preserve UTF-8, escaped passwords, IPv6, VMess transports, SSR and mixed Base64 subscriptions',()=>{
 const trojan='trojan://p%40ss%3Aword@[2001:db8::1]:8443?sni=example.com&type=ws&path=%2Fproxy&host=cdn.example.com#'+encodeURIComponent('Токио');
 const p=parseMihomoLink(trojan);assert.equal(p.password,'p@ss:word');assert.equal(p.server,'2001:db8::1');assert.equal(p.name,'Токио');assert.equal(p['ws-opts'].path,'/proxy');
 const vmess='vmess://'+Buffer.from(JSON.stringify({v:'2',ps:'VM',add:'example.com',port:'443',id:nativeFixtures.vmess.uuid,aid:'0',net:'grpc',path:'service',tls:'tls',sni:'edge.example.com'})).toString('base64');
 assert.equal(parseMihomoLink(vmess)['grpc-opts']['grpc-service-name'],'service');
 const ssr='ssr://'+Buffer.from('example.com:443:origin:aes-128-cfb:plain:'+Buffer.from('password').toString('base64url')+'/?remarks='+Buffer.from('SSR').toString('base64url')).toString('base64url');assert.equal(parseMihomoLink(ssr).name,'SSR');
 for(const uri of ['tuic://'+nativeFixtures.tuic.uuid+':secret@example.com:443','anytls://secret@example.com:443','https://user:secret@example.com:8443','ssh://user:secret@example.com:22','hysteria://example.com:443?auth=secret&upmbps=10&downmbps=50'])assert.ok(parseMihomoLink(uri).type);
 assert.equal(configRecords(Buffer.from(trojan+'\n'+vmess+'\n'+ssr).toString('base64')).length,3);
});
test('invalid batches, aliases, duplicate keys, paths, injected runtime settings and incorrect types fail atomically',()=>{
 const store=new Store(':memory:');try{
 const count=store.profiles().length;assert.throws(()=>store.importProfiles({value:'trojan://secret@example.com:443\ntrojan://@example.com:443'}));assert.equal(store.profiles().length,count);
 for(const extra of [{'dialer-proxy':'DIRECT'},{'interface-name':'eth0'},{'routing-mark':1},{'state-dir':'cache'},{certificate:'client.pem'},{'private-key':'id_rsa'},{'ws-opts':{'__proto__':null,'state-dir':'x'}},{tls:'false'},{unknown:true}])assert.throws(()=>normalizeMihomoProxy({...fixture('trojan'),...extra}));
 assert.throws(()=>configRecords('type: trojan\ntype: http\nserver: example.com\nport: 443\npassword: secret'));
 assert.throws(()=>normalizeMihomoProxy(JSON.parse('{"type":"http","server":"x","port":443,"__proto__":{}}')));
 assert.throws(()=>parseMihomoLink('trojan://secret@example.com:443?unsupported=1'));
 assert.throws(()=>normalizeMihomoProxy({...fixture('trojan'),'private-key':1}));
 assert.throws(()=>normalizeMihomoProxy({...fixture('trojan'),port:443.5}));
 assert.equal(normalizeMihomoProxy({...fixture('wireguard'),'private-key':'/'+key.slice(1)})['private-key'],'/'+key.slice(1));
 assert.throws(()=>normalizeMihomoProxy({...fixture('trojan'),'shadow-tls-opts':{'private-key':'client.key'}}));
 assert.equal(parseMihomoLink('trojan://secret@example.com:443?security=tls').type,'trojan');
 assert.equal(parseMihomoLink('http://example.com:443?security=tls').tls,true);
 assert.throws(()=>parseMihomoLink('trojan://secret@example.com:443?insecure=1&insecure=0'));
 assert.throws(()=>parseMihomoLink('trojan://secret@example.com:443?auth=ignored'));
 assert.throws(()=>configRecords('type: trojan\nserver: example.com\nport: 443\npassword: secret\nws-opts: &cycle {headers: *cycle}'));
 assert.throws(()=>mihomoFromDraft('trojan',{server:'x',port:'443',password:'s',options:'{"password":"override"}'}));
 assert.deepEqual(normalizeMihomoProxy(mihomoFromDraft('trojan',mihomoDraft(fixture('trojan')))),fixture('trojan'));
 }finally{store.close();}
});


test('EasyTier imports remain outbound-only and cannot advertise services',()=>{
 const node=fixture('easytier');delete node.server;delete node.port;delete node['no-listener'];
 assert.equal(normalizeMihomoProxy(node)['no-listener'],true);
 for(const options of [{listeners:['tcp://0.0.0.0:11010']},{'mapped-listeners':['tcp://0.0.0.0:11010']},{'proxy-networks':['10.0.0.0/8']},{'enable-exit-node':true},{'no-listener':false}])assert.throws(()=>normalizeMihomoProxy({...node,...options}),/runtime routing/);
});


test('native Hysteria 2 hopping uses seconds and MASQUE requires its tunnel address',()=>{
 assert.throws(()=>normalizeMihomoProxy({...fixture('hysteria2'),'hop-interval':'30s'}),/hop-interval/);
 assert.equal(normalizeMihomoProxy({...fixture('hysteria2'),'hop-interval':'30-60'})['hop-interval'],'30-60');
 const node=fixture('masque');delete node.ip;assert.throws(()=>normalizeMihomoProxy(node),/MASQUE interface address/);
 assert.equal(normalizeMihomoProxy({...node,network:'h3-l4proxy'}).network,'h3-l4proxy');
});
