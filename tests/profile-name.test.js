import test from 'node:test';
import assert from 'node:assert/strict';
import {deflateSync} from 'node:zlib';
import {profileLinkName,normalizeImportedName} from '../shared/profile-name.js';
import {Store} from '../server/store.js';

test('link labels decode once, preserve plus, reject malformed escapes and fit the name limit',()=>{
 for(const scheme of ['ss','vless','socks5','socks','vpn'])assert.equal(profileLinkName(`${scheme}://fixture#${encodeURIComponent('Москва + Gateway')}`),'Москва + Gateway');
 assert.equal(profileLinkName('ss://fixture#A+B'),'A+B');assert.equal(profileLinkName('ss://fixture#%2520'),'%20');
 for(const link of ['ss://fixture#%FF','ss://fixture','{"name":"test#name"}'])assert.equal(profileLinkName(link),'');
 const name=normalizeImportedName('😀'.repeat(60));assert.equal(name.length,100);assert.equal([...name].length,50);
});
test('imports use labels or Amnezia metadata, explicit names win and later edits persist',()=>{
 const store=new Store(':memory:');
 try {
  const socks=store.importProfile({value:'socks5://127.0.0.1:1080#'+encodeURIComponent('Gateway test')});assert.equal(socks.name,'Gateway test');
  assert.equal(store.importProfile({name:'Manual',value:'socks5://127.0.0.1:1080#Original'}).name,'Manual');
  assert.equal(store.updateProfile(socks.id,{name:'Renamed'}).name,'Renamed');
  const config={description:'Amnezia test',defaultContainer:'amnezia-xray',containers:[{container:'amnezia-xray',xray:{last_config:{outbounds:[{protocol:'vless',settings:{vnext:[{address:'192.0.2.1',port:443,users:[{id:'fixture'}]}]}}]}}}]};
  const raw=Buffer.from(JSON.stringify(config)),header=Buffer.alloc(4);header.writeUInt32BE(raw.length);const link='vpn://'+Buffer.concat([header,deflateSync(raw)]).toString('base64url');
  assert.equal(store.importProfile({value:link}).name,'Amnezia test');assert.equal(store.importProfile({value:link+'#Fragment'}).name,'Fragment');
 } finally {store.close();}
});
