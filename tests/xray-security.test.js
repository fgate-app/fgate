import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../server/store.js';
import {gatewayEditor} from '../server/gateway-editor.js';
import {normalizeXrayProfile} from '../server/xray-profile.js';
import {manualConfig,visibleFields} from '../shared/manual-gateway.js';
import {xrayAlpnHint} from '../shared/xray-security.js';
import {Auth} from '../server/auth.js';
import {ConfigurationBackups,encryptConfiguration,decryptConfiguration,generateBackupSecret} from '../server/configuration-backup.js';
const fields={server:'fixture.test',port:'443',uuid:'00000000-0000-4000-8000-000000000001',network:'tcp',security:'tls',alpn:'h2, http/1.1',pinnedPeerCertSha256:'ab'.repeat(32),verifyPeerCertByName:'fixture.test'};
test('TLS advanced fields survive URI import, edits, clearing and old defaults',()=>{
 const store=new Store(':memory:');try{
  const row=store.importProfile({value:manualConfig('vless',fields)}),e=gatewayEditor(store.profileSnapshot(row.id));assert.equal(e.fields.alpn,'h2, http/1.1');assert.equal(e.fields.pinnedPeerCertSha256,fields.pinnedPeerCertSha256);
  e.fields.port='8443';store.updateProfile(row.id,{editor:e});let next=gatewayEditor(store.profileSnapshot(row.id));assert.equal(next.fields.verifyPeerCertByName,'fixture.test');
  next.fields.alpn='http/1.1';next.fields.pinnedPeerCertSha256='';next.fields.verifyPeerCertByName='';store.updateProfile(row.id,{editor:next});const tls=normalizeXrayProfile(store.profileSnapshot(row.id).config.config).outbounds[0].streamSettings.tlsSettings;assert.deepEqual(tls.alpn,['http/1.1']);assert.equal(tls.pinnedPeerCertSha256,undefined);assert.equal(tls.verifyPeerCertByName,undefined);
  const old=store.importProfile({value:'vless://'+fields.uuid+'@fixture.test:443?security=tls'});assert.equal(gatewayEditor(store.profileSnapshot(old.id)).fields.pinnedPeerCertSha256,'');
 }finally{store.close();}
});
test('REALITY advanced keys and SpiderX survive import and represented edits',()=>{
 const store=new Store(':memory:');try{
  const values={...fields,security:'reality',publicKey:Buffer.alloc(32,1).toString('base64url'),spiderX:'/path?x=1',mldsa65Verify:Buffer.alloc(1952,2).toString('base64url')};
  const row=store.importProfile({value:manualConfig('vless',values)}),e=gatewayEditor(store.profileSnapshot(row.id));assert.equal(e.fields.mldsa65Verify,values.mldsa65Verify);e.fields.spiderX='/new';store.updateProfile(row.id,{editor:e});const next=gatewayEditor(store.profileSnapshot(row.id));assert.equal(next.fields.spiderX,'/new');assert.equal(next.fields.mldsa65Verify,values.mldsa65Verify);assert.ok(!visibleFields('vless',values).includes('alpn'));
 }finally{store.close();}
});
test('invalid advanced security values fail without replacing saved configuration',()=>{
 const store=new Store(':memory:');try{
  const row=store.importProfile({value:manualConfig('vless',fields)}),before=store.profileSnapshot(row.id);
  for(const patch of [{pinnedPeerCertSha256:'bad'},{alpn:'h2,,http/1.1'},{verifyPeerCertByName:'https://fixture.test'},{security:'reality',publicKey:'key',spiderX:'relative'},{security:'reality',publicKey:'key',mldsa65Verify:'bad'}]){
   const e=gatewayEditor(before);Object.assign(e.fields,patch);assert.throws(()=>store.updateProfile(row.id,{editor:e}));assert.deepEqual(store.profileSnapshot(row.id),before);
  }
  const root=normalizeXrayProfile(manualConfig('vless',fields));root.outbounds[0].streamSettings.tlsSettings.pinnedPeerCertificateChainSha256=['legacy'];assert.throws(()=>store.importProfile({value:JSON.stringify(root)}),/Legacy certificate/);
  delete root.outbounds[0].streamSettings.tlsSettings.pinnedPeerCertificateChainSha256;root.outbounds[0].streamSettings.tlsSettings.allowInsecure=true;assert.throws(()=>store.importProfile({value:JSON.stringify(root)}),/Disabling certificate/);
 }finally{store.close();}
});
test('ALPN compatibility hints explain transports without rewriting provider values',()=>{
 const v={...fields,network:'ws',alpn:'h2'};assert.match(xrayAlpnHint(v),/needs HTTP\/1.1/);assert.equal(v.alpn,'h2');assert.match(xrayAlpnHint({...v,network:'grpc',alpn:'http/1.1,h2'}),/first/);assert.equal(xrayAlpnHint({...v,security:'reality'}),'');
});
test('advanced security survives encrypted portable backup on another device key',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'fg-tls-backup-')),other=mkdtempSync(join(tmpdir(),'fg-tls-target-')),source=new Store(':memory:'),target=new Store(':memory:');
 try{
  new Auth(target.db);
  await new Auth(source.db).create({username:'admin',password:'fixture password 12345'},true);
  const row=source.importProfile({value:manualConfig('vless',fields)}),r=source.importProfile({value:manualConfig('vless',{...fields,security:'reality',publicKey:'key',spiderX:'/x',mldsa65Verify:Buffer.alloc(1952,2).toString('base64url')})});
  const backup=new ConfigurationBackups(source,{stateDir:dir}),restore=new ConfigurationBackups(target,{stateDir:other}),secret=generateBackupSecret(),encrypted=await encryptConfiguration(backup.capture(),secret);
  assert.ok(!JSON.stringify(encrypted).includes(fields.uuid));restore.apply(restore.validate(await decryptConfiguration(encrypted,secret)));
  for(const id of [row.id,r.id])assert.deepEqual(gatewayEditor(target.profileSnapshot(id)),gatewayEditor(source.profileSnapshot(id)));
 }finally{source.close();target.close();rmSync(dir,{recursive:true,force:true});rmSync(other,{recursive:true,force:true});}
});
test('standard security URI aliases preserve requirements and never import logging/private files',()=>{
 const link='vless://'+fields.uuid+'@fixture.test:443?security=tls&pcs='+fields.pinnedPeerCertSha256+'&vcn=fixture.test';const root=normalizeXrayProfile(link);assert.equal(root.outbounds[0].streamSettings.tlsSettings.pinnedPeerCertSha256,fields.pinnedPeerCertSha256);
 root.outbounds[0].streamSettings.tlsSettings.masterKeyLog='/private/secrets';assert.ok(!JSON.stringify(normalizeXrayProfile(root)).includes('/private/secrets'));
 assert.throws(()=>normalizeXrayProfile(link+'&pinnedPeerCertSha256='+'ff'.repeat(32)),/unsupported options/);
});
