import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHysteria2,normalizeHysteria2} from '../shared/hysteria2.js';
import {manualConfig,visibleFields} from '../shared/manual-gateway.js';
import {configRecords,configKind} from '../shared/gateway-config.js';
import {profileLinkName} from '../shared/profile-name.js';
import {Store} from '../server/store.js';
import {gatewayEditor} from '../server/gateway-editor.js';
import {buildMihomoConfig} from '../server/mihomo.js';
import {defaultDnsSettings} from '../server/dns-resolvers.js';
const pin='ab'.repeat(32),link=`hy2://user:p%40ss%3A%2F%23@[2001:db8::7]:8443/?sni=tls.example.com&insecure=1&pinSHA256=${pin}&obfs=salamander&obfs-password=mask%26secret#${encodeURIComponent('Тест + 日本')}`;

test('both URI schemes preserve escaped auth, IPv6, TLS pin, SNI, Salamander and UTF-8 labels',()=>{
  for(const uri of [link,link.replace('hy2:','hysteria2:')]){
    const p=parseHysteria2(uri);
    assert.deepEqual(p,{type:'hysteria2',server:'2001:db8::7',port:8443,password:'user:p@ss:/#',udp:true,'skip-cert-verify':true,sni:'tls.example.com',fingerprint:pin,obfs:'salamander','obfs-password':'mask&secret'});
    assert.equal(profileLinkName(uri),'Тест + 日本');assert.equal(configKind(uri),'Hysteria 2');
  }
  assert.equal(parseHysteria2('hy2://secret%3Awith%40symbols@vpn.example').password,'secret:with@symbols');
  assert.equal(parseHysteria2('hy2://vpn.example').port,443);
  assert.equal(parseHysteria2('hy2://vpn.example').password,'');
  assert.equal(parseHysteria2('hy2://vpn.example?insecure=0')['skip-cert-verify'],false);
  const list=link+'\n'+link.replace('hy2:','hysteria2:');
  assert.deepEqual(configRecords(Buffer.from(list).toString('base64')),list.split('\n'));
});

test('unsupported, ambiguous and unsafe parameters fail without echoing credentials or weakening TLS',()=>{
  for(const uri of ['hy2://private-secret@x:0','hy2://private-secret@x:65536','hy2://x:443,8443','hy2://x:443-8443','hy2://x/path','hy2://x?insecure=true','hy2://x?insecure=1&insecure=0','hy2://x?ech=config','hy2://x?obfs=gecko&obfs-password=secret','hy2://x?obfs=salamander','hy2://x?obfs-password=secret','hy2://x?pinSHA256=invalid','hy2://x?unknown=private-secret','hy2://bad%ZZ@x','hy2://%FF@x','hy2://a@b@x']){
    assert.throws(()=>parseHysteria2(uri),error=>{assert.doesNotMatch(error.message,/private-secret|[А-Яа-яЁё]/);return true;},uri);
  }
  for(const patch of [{udp:false},{'skip-cert-verify':'false'},{'skip-cert-verify':1},{fingerprint:'bad'},{ports:'443,8443'},{server:'x\\path'},{password:123},{'dialer-proxy':'DIRECT'}])assert.throws(()=>normalizeHysteria2({type:'hysteria2',server:'vpn.example',port:443,...patch}));
});

test('import, form editing, reopen and native mihomo retain every supported setting; old defaults normalize on read',()=>{
  const store=new Store(':memory:');
  try{
    const row=store.importProfile({value:link}),original=JSON.parse(store.profileSnapshot(row.id).config.config);
    assert.equal(row.engine,'mihomo');assert.equal(row.protocol,'hysteria2');assert.equal(row.name,'Тест + 日本');
    const editor=gatewayEditor(store.profileSnapshot(row.id));assert.equal(editor.fields['skip-cert-verify'],'true');assert.equal(editor.fields.fingerprint,pin);
    assert.deepEqual(JSON.parse(manualConfig(editor.type,editor.fields)),original);
    editor.fields.port='9443';store.updateProfile(row.id,{editor});
    const next=JSON.parse(store.profileSnapshot(row.id).config.config);assert.deepEqual(next,{...original,port:9443});
    const reopened=gatewayEditor(store.profileSnapshot(row.id));reopened.fields['skip-cert-verify']='false';store.updateProfile(row.id,{editor:reopened});
    assert.equal(JSON.parse(store.profileSnapshot(row.id).config.config)['skip-cert-verify'],false);
    const yaml=buildMihomoConfig(defaultDnsSettings,{}, {profiles:store.profiles(),configs:store.db.prepare('SELECT * FROM profile_configs').all(),groups:[],devices:[]});
    assert.ok(yaml.includes('"type":"hysteria2"'));assert.ok(yaml.includes('"port":9443'));assert.ok(yaml.includes('"skip-cert-verify":false'));assert.ok(yaml.includes('"fingerprint":"'+pin+'"'));
    // Simulate a row from an older version: optional settings did not exist.
    store.db.prepare('UPDATE profile_configs SET config=? WHERE profile_id=?').run(JSON.stringify({type:'hysteria2',server:'vpn.example',port:443,password:'secret'}),row.id);
    const old=gatewayEditor(store.profileSnapshot(row.id));assert.equal(old.fields['skip-cert-verify'],'false');assert.equal(old.fields.obfs,'');assert.equal(old.fields.fingerprint,'');
    old.fields.sni='tls.example';store.updateProfile(row.id,{editor:old});assert.equal(JSON.parse(store.profileSnapshot(row.id).config.config)['skip-cert-verify'],false);
    assert.equal(visibleFields('hysteria2',{obfs:''}).includes('obfs-password'),false);assert.equal(visibleFields('hysteria2',{obfs:'salamander'}).includes('obfs-password'),true);
  }finally{store.close();}
});

test('mixed subscriptions roll back on unsupported Hysteria parameters; manual mode safely clears disabled obfuscation',()=>{
  const store=new Store(':memory:');
  try{
    const count=store.profiles().length;
    assert.throws(()=>store.importProfiles({value:link+'\nhy2://x?obfs=unknown'}));assert.equal(store.profiles().length,count);
    assert.equal(store.importProfiles({value:link+'\nhysteria2://secret@vpn.example#Second'}).length,2);
    const p=JSON.parse(manualConfig('hysteria2',{server:'vpn.example',port:'443',password:'secret','skip-cert-verify':'false',obfs:'','obfs-password':'stale-secret'}));
    assert.equal(p.obfs,undefined);assert.equal(p['obfs-password'],undefined);assert.equal(p['skip-cert-verify'],false);
    assert.throws(()=>manualConfig('hysteria2',{server:'vpn.example',port:'443','skip-cert-verify':'invalid'}));
  }finally{store.close();}
});
