import test from 'node:test';import assert from 'node:assert/strict';
import {Store} from '../server/store.js';import {gatewayEditor} from '../server/gateway-editor.js';import {manualConfig} from '../shared/manual-gateway.js';import {normalizeXrayProfile} from '../server/xray-profile.js';import {vlessEncryption} from '../shared/vless-encryption.js';
import {Auth} from '../server/auth.js';import {ConfigurationBackups,generateBackupSecret,encryptConfiguration,decryptConfiguration} from '../server/configuration-backup.js';import {mkdtempSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
const key=Buffer.alloc(32,1).toString('base64url'),pq=Buffer.alloc(1184,2).toString('base64url'),draft={server:'fixture.test',port:'443',uuid:'00000000-0000-4000-8000-000000000001',security:'tls',network:'tcp'},enc=`mlkem768x25519plus.native.0rtt.${key}`;
const encryption=store=>JSON.parse(store.config.config).outbounds[0].settings.vnext[0].users[0].encryption;
test('VLESS Encryption supports appearances, RTT modes, key types, padding and relay keys without rewriting',()=>{
 for(const appearance of ['native','xorpub','random'])for(const rtt of ['0rtt','1rtt'])for(const keys of [key,pq,key+'.'+pq])for(const pad of ['', '100-35-100.0-0-0.50-0-50.']){const value=`mlkem768x25519plus.${appearance}.${rtt}.${pad}${keys}`;assert.equal(vlessEncryption(value),value);assert.equal(normalizeXrayProfile(manualConfig('vless',{...draft,encryption:value})).outbounds[0].settings.vnext[0].users[0].encryption,value);}
});
test('malformed Encryption in URI, JSON and form is rejected without leaking the input',()=>{
 for(const value of ['',null,12,'auto','mlkem768x25519plus.native.600s.'+key,'mlkem768x25519plus.native.0rtt.fixture',enc+'.100-35-40',`mlkem768x25519plus.native.0rtt.100-0-10.${key}`,`mlkem768x25519plus.native.0rtt.100-35-65554.${key}`,enc+'=',enc.slice(0,-1)+'B']){
  assert.throws(()=>vlessEncryption(value),e=>e.code==='VLESS_ENCRYPTION_INVALID' && (String(value).length<15 || !e.message.includes(String(value))));
  const root=normalizeXrayProfile(manualConfig('vless',draft));root.outbounds[0].settings.vnext[0].users[0].encryption=value;assert.throws(()=>normalizeXrayProfile(root),/Invalid VLESS Encryption/);
  if(typeof value==='string'){const u=new URL(manualConfig('vless',draft));u.searchParams.set('encryption',value);assert.throws(()=>normalizeXrayProfile(u.href),/Invalid VLESS Encryption/);}
 }
});
test('link, JSON, form edits, Mux and old absent fields keep Encryption; invalid edits are atomic and isolated',()=>{
 const s=new Store(':memory:');try{
  const other=s.importProfile({value:manualConfig('vless',draft)}),before=s.profileSnapshot(other.id);
  for(const json of [false,true]){const link=manualConfig('vless',{...draft,encryption:enc}),p=s.importProfile({value:json?JSON.stringify(normalizeXrayProfile(link)):link}),e=gatewayEditor(s.profileSnapshot(p.id));assert.equal(e.fields.encryption,enc);e.fields.encryption=enc.replace('native','random');e.fields.port='8443';s.updateProfile(p.id,{editor:e});assert.equal(encryption(s.profileSnapshot(p.id)),e.fields.encryption);const old=s.profileSnapshot(p.id);e.fields.encryption='secret-invalid-string';assert.throws(()=>s.updateProfile(p.id,{editor:e}),/Invalid VLESS Encryption/);assert.deepEqual(s.profileSnapshot(p.id),old);}
  const old=normalizeXrayProfile(manualConfig('vless',draft));delete old.outbounds[0].settings.vnext[0].users[0].encryption;assert.equal(gatewayEditor(s.profileSnapshot(s.importProfile({value:JSON.stringify(old)}).id)).fields.encryption,'none');
  assert.equal(normalizeXrayProfile(manualConfig('vless',{...draft,encryption:enc,muxEnabled:'true'})).outbounds[0].settings.vnext[0].users[0].encryption,enc);assert.deepEqual(s.profileSnapshot(other.id),before);
  assert.ok(!JSON.stringify(s.profiles()).includes(key));
 }finally{s.close();}
});
test('Encryption preserves Vision compatibility and TLS/REALITY while none keeps previous restrictions',()=>{
 for(const security of ['none','tls','reality'])for(const network of ['tcp','grpc','xhttp']){const d={...draft,security,network,encryption:enc,publicKey:key,flow:'xtls-rprx-vision'};assert.equal(normalizeXrayProfile(manualConfig('vless',d)).outbounds[0].settings.vnext[0].users[0].encryption,enc);}
 assert.throws(()=>manualConfig('vless',{...draft,security:'none',flow:'xtls-rprx-vision'}),/Vision requires/);
});
test('Encryption portable encrypted backup restores on another device with linked profile identity',async()=>{
 const a=mkdtempSync(join(tmpdir(),'fg-enc-backup-')),b=mkdtempSync(join(tmpdir(),'fg-enc-restore-')),s=new Store(':memory:'),t=new Store(':memory:');try{new Auth(t.db);await new Auth(s.db).create({username:'admin',password:'fixture password 12345'},true);const p=s.importProfile({value:manualConfig('vless',{...draft,encryption:enc})}),backup=new ConfigurationBackups(s,{stateDir:a}),restore=new ConfigurationBackups(t,{stateDir:b}),secret=generateBackupSecret(),blob=await encryptConfiguration(backup.capture(),secret);assert.ok(!JSON.stringify(blob).includes(key));restore.apply(restore.validate(await decryptConfiguration(blob,secret)));assert.deepEqual(gatewayEditor(t.profileSnapshot(p.id)),gatewayEditor(s.profileSnapshot(p.id)));}finally{s.close();t.close();rmSync(a,{recursive:true,force:true});rmSync(b,{recursive:true,force:true});}
});
