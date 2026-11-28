import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../server/store.js';
import {gatewayEditor} from '../server/gateway-editor.js';
import {normalizeXrayProfile} from '../server/xray-profile.js';
import {manualConfig} from '../shared/manual-gateway.js';
import {combinations,uri} from './fixtures/vless-matrix.js';
for(const item of combinations)test(`VLESS ${item.network}/${item.security}: import, form save, reopen and runtime normalization`,()=>{
 const store=new Store(':memory:');
 try{
  const row=store.importProfile({name:'Matrix',value:uri(item)}),before=normalizeXrayProfile(store.profileSnapshot(row.id).config.config);
  let editor=gatewayEditor(store.profileSnapshot(row.id));assert.equal(editor.fields.network,item.network);assert.equal(editor.fields.security,item.security);
  if(['ws','httpupgrade','xhttp','splithttp'].includes(item.network)){assert.equal(editor.fields.path,'/путь?ed=2048');assert.equal(editor.fields.host,'edge.example');}
  if(item.network==='grpc'){assert.equal(editor.fields.serviceName,'grpc-service');assert.equal(before.outbounds[0].streamSettings.grpcSettings.multiMode,true);assert.equal(before.outbounds[0].streamSettings.grpcSettings.authority,'grpc.example');}
  editor.fields.port='8443';store.updateProfile(row.id,{editor});
  const after=normalizeXrayProfile(store.profileSnapshot(row.id).config.config);before.outbounds[0].settings.vnext[0].port=8443;assert.deepEqual(after,before);
  editor=gatewayEditor(store.profileSnapshot(row.id));assert.equal(editor.fields.port,'8443');
  const stream=after.outbounds[0].streamSettings;
  if(item.security==='tls'){assert.equal(stream.tlsSettings.allowInsecure,false);assert.deepEqual(stream.tlsSettings.alpn,['h2','http/1.1']);}
  if(item.security==='reality')assert.equal(stream.realitySettings.spiderX,'/spider');
  if(['xhttp','splithttp'].includes(item.network))assert.equal(stream.xhttpSettings.mode,'packet-up');
  const saved=store.profileSnapshot(row.id).config.config;store.updateProfile(row.id,{editor});assert.equal(store.profileSnapshot(row.id).config.config,saved);
 }finally{store.close();}
});
test('advanced JSON transport options survive unrelated and represented field edits',()=>{
 for(const network of ['tcp','raw','ws','grpc','httpupgrade','xhttp','splithttp']){
  const root=normalizeXrayProfile(uri({network,security:'tls'})),out=root.outbounds[0],s=out.streamSettings;
  out.mux={enabled:true,concurrency:['xhttp','splithttp'].includes(network)?-1:4,xudpConcurrency:8};s.tlsSettings.pinnedPeerCertSha256='ab'.repeat(32);
  const key={tcp:'tcpSettings',raw:'rawSettings',ws:'wsSettings',grpc:'grpcSettings',httpupgrade:'httpupgradeSettings',xhttp:'xhttpSettings',splithttp:'splithttpSettings'}[network];
  if(network==='splithttp'){s[key]=s.xhttpSettings;delete s.xhttpSettings;}
  s[key]={...s[key],...(network==='grpc'?{multiMode:true,authority:'authority.example',idle_timeout:19}:network==='ws'?{headers:{...s[key].headers,Custom:'preserved'},maxEarlyData:2048}:['xhttp','splithttp'].includes(network)?{extra:{xPaddingBytes:'100-200',xmux:{maxConcurrency:3}}}:{acceptProxyProtocol:false})};
  const store=new Store(':memory:');try{
   const row=store.importProfile({value:JSON.stringify(root)}),before=normalizeXrayProfile(store.profileSnapshot(row.id).config.config),editor=gatewayEditor(store.profileSnapshot(row.id));
   if(['ws','httpupgrade','xhttp','splithttp'].includes(network)){editor.fields.path='/updated';editor.fields.host='new.example';}
   else if(network==='grpc')editor.fields.serviceName='new-service';
   editor.fields.server='new-vpn.example';store.updateProfile(row.id,{editor});
   const expected=structuredClone(before);expected.outbounds[0].settings.vnext[0].address='new-vpn.example';const target=expected.outbounds[0].streamSettings;
   if(['ws','httpupgrade','xhttp','splithttp'].includes(network)){const config=target[network==='ws'?'wsSettings':network==='httpupgrade'?'httpupgradeSettings':'xhttpSettings'];config.path='/updated';if(network==='ws')config.headers.Host='new.example';else config.host='new.example';}
   if(network==='grpc')target.grpcSettings.serviceName='new-service';
   assert.deepEqual(normalizeXrayProfile(store.profileSnapshot(row.id).config.config),expected,network);
  }finally{store.close();}
 }
});
test('REALITY password alias edits the effective key and preserves other security fields',()=>{
 const root=normalizeXrayProfile(uri({network:'tcp',security:'reality'}));Object.assign(root.outbounds[0].streamSettings.realitySettings,{publicKey:'old-alias',password:'effective-key',mldsa65Verify:Buffer.alloc(1952,1).toString('base64url')});
 const store=new Store(':memory:');try{
  const row=store.importProfile({value:JSON.stringify(root)}),editor=gatewayEditor(store.profileSnapshot(row.id));assert.equal(editor.fields.publicKey,'effective-key');editor.fields.publicKey='new-key';store.updateProfile(row.id,{editor});
  const s=normalizeXrayProfile(store.profileSnapshot(row.id).config.config).outbounds[0].streamSettings.realitySettings;assert.equal(s.password,'new-key');assert.equal(s.publicKey,'new-key');assert.equal(s.mldsa65Verify,Buffer.alloc(1952,1).toString('base64url'));
 }finally{store.close();}
});
test('security and transport changes patch the new settings branch without losing advanced fields',()=>{
 const store=new Store(':memory:');try{
  const row=store.importProfile({value:uri({network:'ws',security:'tls'})}),e=gatewayEditor(store.profileSnapshot(row.id));Object.assign(e.fields,{network:'grpc',security:'reality',publicKey:'key',shortId:'abcd',serviceName:'service'});store.updateProfile(row.id,{editor:e});
  const next=gatewayEditor(store.profileSnapshot(row.id));assert.equal(next.fields.serviceName,'service');assert.equal(next.fields.sni,'tls.example');assert.equal(next.fields.publicKey,'key');assert.equal(next.fields.security,'reality');
 }finally{store.close();}
});
test('invalid transport/security/flow combinations fail atomically with an explanation',()=>{
 const store=new Store(':memory:');try{
  const row=store.importProfile({value:uri({network:'tcp',security:'tls'})}),snapshot=store.profileSnapshot(row.id);
  for(const patch of [{network:'ws',security:'reality'},{network:'httpupgrade',security:'reality'},{network:'kcp'},{security:'unknown'},{flow:'unknown'},{network:'grpc',flow:'xtls-rprx-vision'},{security:'none',flow:'xtls-rprx-vision'}]){
   const editor=gatewayEditor(snapshot);Object.assign(editor.fields,patch);assert.throws(()=>store.updateProfile(row.id,{editor}),/REALITY|transport|security|flow|Vision/);assert.deepEqual(store.profileSnapshot(row.id),snapshot);
   assert.throws(()=>manualConfig('vless',editor.fields));
  }
  assert.throws(()=>store.importProfile({value:uri({network:'ws',security:'reality'})}),/REALITY/);
 }finally{store.close();}
});
test('Vision TCP/RAW variants survive form edits; advanced encryption is preserved',()=>{
 for(const network of ['tcp','raw'])for(const security of ['tls','reality'])for(const flow of ['xtls-rprx-vision','xtls-rprx-vision-udp443']){
  const store=new Store(':memory:');try{const row=store.importProfile({value:uri({network,security})+'&flow='+flow}),e=gatewayEditor(store.profileSnapshot(row.id));e.fields.port='8443';store.updateProfile(row.id,{editor:e});assert.equal(gatewayEditor(store.profileSnapshot(row.id)).fields.flow,flow);}finally{store.close();}
 }
 const root=normalizeXrayProfile(uri({network:'grpc',security:'tls'}));Object.assign(root.outbounds[0].settings.vnext[0].users[0],{encryption:'mlkem768x25519plus.native.0rtt.AQAQAQAQAQAQAQAQAQAQAQAQAQAQAQAQAQAQAQAQAQA',flow:'xtls-rprx-vision'});
 const store=new Store(':memory:');try{const row=store.importProfile({value:JSON.stringify(root)}),e=gatewayEditor(store.profileSnapshot(row.id));e.fields.port='8443';store.updateProfile(row.id,{editor:e});assert.equal(normalizeXrayProfile(store.profileSnapshot(row.id).config.config).outbounds[0].settings.vnext[0].users[0].encryption,root.outbounds[0].settings.vnext[0].users[0].encryption);}finally{store.close();}
});

test('unrepresented URI options are rejected explicitly instead of silently replaced',()=>{
 for(const suffix of ['&headerType=http','&extra=%7B%7D','&downloadSettings=%7B%7D'])assert.throws(()=>normalizeXrayProfile(uri({network:'tcp',security:'tls'})+suffix),/Import an Xray JSON/);
});
test('TLS URI verification flags retain explicit true/false and reject malformed values',()=>{
 for(const name of ['allowInsecure','insecure'])for(const [value,expected] of [['0',false],['1',true],['false',false],['true',true]]){
  const link=new URL(uri({network:'ws',security:'tls'}));link.searchParams.delete('allowInsecure');link.searchParams.set(name,value);
  if(expected)assert.throws(()=>normalizeXrayProfile(link.href),/Disabling certificate/);else assert.equal(normalizeXrayProfile(link.href).outbounds[0].streamSettings.tlsSettings.allowInsecure,false);
 }
 const link=new URL(uri({network:'ws',security:'tls'}));link.searchParams.set('allowInsecure','sometimes');assert.throws(()=>normalizeXrayProfile(link.href),/Invalid/);
});
