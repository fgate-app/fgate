import test from 'node:test';
import assert from 'node:assert/strict';
import {deflateSync} from 'node:zlib';
import {normalizeXrayProfile,decodeAmnezia} from '../server/xray-profile.js';
import {Store} from '../server/store.js';
import {buildMihomoConfig} from '../server/mihomo.js';
import {defaultDnsSettings} from '../server/dns-resolvers.js';
const fixture={inbounds:[{listen:'0.0.0.0',port:9999}],log:{access:'/private/file'},routing:{rules:[]},dns:{servers:['8.8.8.8']},outbounds:[{tag:'provider',protocol:'vless',settings:{vnext:[{address:'192.0.2.3',port:443,users:[{id:'c761077e-69c6-4f67-a18f-f94cc4b22426',encryption:'none',flow:'xtls-rprx-vision'}]}]},streamSettings:{network:'tcp',security:'reality',sockopt:{mark:123,interface:'untrusted'},realitySettings:{serverName:'example.com',fingerprint:'chrome',publicKey:'fixture-public-key',shortId:'1234',privateKey:'must-not-import'}}}]};
function link(root){const data=Buffer.from(JSON.stringify(root)),header=Buffer.alloc(4);header.writeUInt32BE(data.length);return 'vpn://'+Buffer.concat([header,deflateSync(data)]).toString('base64url');}
const root={defaultContainer:'amnezia-xray',containers:[{container:'amnezia-xray',xray:{last_config:JSON.stringify(fixture)}}]};

test('Amnezia qCompress/base64url import preserves REALITY and strips provider runtime configuration',()=>{
 const result=normalizeXrayProfile(link(root));
 assert.deepEqual(Object.keys(result),['outbounds']);
 assert.equal(result.outbounds[0].settings.vnext[0].users[0].flow,'xtls-rprx-vision');
 assert.equal(result.outbounds[0].streamSettings.realitySettings.publicKey,'fixture-public-key');
 assert.equal(result.outbounds[0].streamSettings.sockopt,undefined);
 assert.equal(result.outbounds[0].streamSettings.realitySettings.privateKey,undefined);
 assert.deepEqual(normalizeXrayProfile(root),result);
 assert.deepEqual(normalizeXrayProfile(fixture),result);
});
test('Amnezia rejects corrupt, oversized, ambiguous and wrong-protocol configurations without echoing secrets',()=>{
 for(const value of ['vpn://secret-invalid',link({...root,defaultContainer:'amnezia-awg',containers:[{container:'amnezia-awg',awg:{last_config:'secret'}}]}),link({...root,containers:[]})])assert.throws(()=>normalizeXrayProfile(value));
 const raw=Buffer.from(link(root).slice(6),'base64url');raw.writeUInt32BE(2*1024*1024);assert.throws(()=>decodeAmnezia('vpn://'+raw.toString('base64url')));
 const corrupt=Buffer.from(link(root).slice(6),'base64url');corrupt[corrupt.length-1]^=1;assert.throws(()=>decodeAmnezia('vpn://'+corrupt.toString('base64url')));
 assert.throws(()=>normalizeXrayProfile({outbounds:[...fixture.outbounds,...fixture.outbounds]}));
 assert.throws(()=>normalizeXrayProfile({outbounds:[{protocol:'freedom'}]}));
});
test('Amnezia import stores only normalized outbound and works in individual and group routes with peer excluded from TUN',()=>{
 const store=new Store(':memory:');
 try{
  const profile=store.importProfile({name:'Amnezia',value:link(root)});
  assert.equal(profile.engine,'xray');assert.equal(profile.protocol,'vless');
  const configs=store.db.prepare('SELECT * FROM profile_configs').all();
  assert.ok(!configs.find(c=>c.profile_id===profile.id).config.includes('must-not-import'));
  assert.ok(!JSON.stringify(store.profiles()).includes('fixture-public-key'));
  const group=store.saveConnectionGroup(null,{name:'Auto',members:[profile.id]});
  store.addRouteGroup({name:'Site',entries:['example.org'],routeId:profile.id});
  store.addDeviceRoute({name:'Phone',identifier:'10.20.0.5',routeId:group.id});
  const yaml=buildMihomoConfig(defaultDnsSettings,{}, {profiles:store.profiles(),configs,groups:store.routeGroups(),devices:store.deviceRoutes(),connectionGroups:store.connectionGroups(),bridges:{[profile.id]:{port:21000,address:'192.0.2.3'}}});
  assert.match(yaml,/server: 127\.0\.0\.1\n    port: 21000\n    udp: true/);
  assert.ok(yaml.includes('192.0.2.3/32'));assert.ok(yaml.includes(`DOMAIN-SUFFIX,example.org,p-${profile.id.slice(0,8)}-grp`));
  assert.ok(yaml.includes(`SRC-IP-CIDR,10.20.0.5/32,cg-${group.id}`));
 }finally{store.close();}
});
test('VLESS links retain transport, flow, fingerprint and REALITY credentials',()=>{
 const config=normalizeXrayProfile('vless://c761077e-69c6-4f67-a18f-f94cc4b22426@192.0.2.3:443?security=reality&type=tcp&flow=xtls-rprx-vision&fp=firefox&sni=example.com&pbk=key&sid=1234');
 assert.equal(config.outbounds[0].streamSettings.realitySettings.fingerprint,'firefox');
 assert.equal(config.outbounds[0].settings.vnext[0].users[0].flow,'xtls-rprx-vision');
});

test('failed runtime import removes newly added profile and keeps the previous route configuration',async()=>{
 const {createServer}=await import('../server/index.js');
 const store=new Store(':memory:');let snapshot=[];
 const supervisor={status:()=>({state:'running'}),setRoutes:(_devices,_groups,_profiles,configs)=>{snapshot=configs;},reapply:async()=>({ok:!snapshot.some(row=>row.engine==='xray'),error:'Xray rejected fixture'})};
 const server=createServer(store,{supervisor});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const base=`http://127.0.0.1:${server.address().port}`;
 try{
  const response=await fetch(base+'/api/auth/setup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'admin',password:'test password 12345'})});
  const session=await response.json(),cookie=response.headers.get('set-cookie').split(';')[0];
  const imported=await fetch(base+'/api/profiles/import',{method:'POST',headers:{'Content-Type':'application/json',Cookie:cookie,'X-CSRF-Token':session.csrf},body:JSON.stringify({value:link(root)})});
  assert.equal(imported.status,400);assert.equal(store.profiles().length,4);assert.ok(!snapshot.some(row=>row.engine==='xray'));
 }finally{await new Promise(resolve=>server.close(resolve));store.close();}
});
