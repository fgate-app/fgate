import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,writeFileSync,mkdirSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {updateDomainLists,domainListsStatus} from '../server/domain-lists.js';
import {Store} from '../server/store.js';
import {Auth} from '../server/auth.js';
import {AccessPointRepository} from '../server/access-points/repository.js';
import {ConfigurationBackups,generateBackupSecret,encryptConfiguration,decryptConfiguration} from '../server/configuration-backup.js';
import {createServer} from '../server/index.js';
async function fixture(action){const dir=mkdtempSync(join(tmpdir(),'fg-backup-')),store=new Store(':memory:');const auth=new Auth(store.db);await auth.create({username:'admin',password:'Backup fixture password'},true);const backups=new ConfigurationBackups(store,{stateDir:dir,present:value=>value});try{await action({dir,store,auth,backups});}finally{store.close();rmSync(dir,{recursive:true,force:true});}}
test('portable encrypted configuration restores every configuration table and secrets with a different device key',()=>fixture(async({dir,store,auth,backups})=>{
 const profile=store.importProfile({value:'socks5://account:VERY_SECRET_PASSWORD@proxy.example.com:1080#Fixture'});const group=store.saveConnectionGroup(null,{name:'Group',members:[profile.id]});store.addRouteGroup({name:'Rule',entries:['example.org'],routeId:group.id});
 const lantern=store.profiles().find(row=>row.engine==='lantern');store.updateProfile(lantern.id,{gatewayId:profile.id});
 const source=new AccessPointRepository(store.db,{stateDir:dir,present:value=>value});source.save({id:'point',secrets:{password:'SSH_PASSWORD',privateKey:'PRIVATE_KEY',instanceId:'preserved-instance'},clients:[{password:'CLIENT_KEY'}]});
 new AccessPointRepository(store.db,{stateDir:dir,present:value=>value,table:'gateway_subscriptions'}).save({id:'source',url:'https://example.org/SECRET_TOKEN'});
 store.db.prepare('INSERT INTO network_settings VALUES (1,?)').run(JSON.stringify({client:{password:'WIFI_PASSWORD'}}));mkdirSync(join(dir,'adguard'));writeFileSync(join(dir,'adguard/AdGuardHome.yaml'),'users:\n - password: HASHED_PASSWORD');
 const before=backups.capture(),secret=generateBackupSecret(),encrypted=await encryptConfiguration(before,secret),serialized=JSON.stringify(encrypted);assert.equal(secret.length,43);for(const sensitive of ['VERY_SECRET_PASSWORD','PRIVATE_KEY','SECRET_TOKEN','WIFI_PASSWORD','HASHED_PASSWORD','password_hash'])assert.ok(!serialized.includes(sensitive));assert.notDeepEqual(await encryptConfiguration(before,secret),encrypted);
 const other=mkdtempSync(join(tmpdir(),'fg-backup-target-')),target=new Store(':memory:');new Auth(target.db);
 try{const repo=new AccessPointRepository(target.db,{stateDir:other,present:value=>value});repo.save({id:'old',secret:'old'});const oldKey=readFileSync(join(other,'access-points.key'));assert.notDeepEqual(oldKey,readFileSync(join(dir,'access-points.key')));const restore=new ConfigurationBackups(target,{stateDir:other,present:value=>value});restore.apply(restore.validate(await decryptConfiguration(encrypted,secret)));const after=restore.capture();assert.deepEqual(after.tables,before.tables);assert.deepEqual(after.repositories,before.repositories);assert.deepEqual(after.files,before.files);assert.deepEqual(readFileSync(join(other,'access-points.key')),oldKey);assert.equal(target.db.prepare('SELECT count(*) n FROM sessions').get().n,0);const login=await new Auth(target.db).login('admin','Backup fixture password','fixture');assert.equal(login.user.username,'admin');}finally{target.close();rmSync(other,{recursive:true,force:true});}
}));
test('wrong secrets, damaged files, foreign versions and invalid rows never replace the current configuration',()=>fixture(async({store,backups})=>{
 const before=backups.capture(),secret=generateBackupSecret(),file=await encryptConfiguration(before,secret);
 await assert.rejects(decryptConfiguration(file,generateBackupSecret()),/incorrect/);await assert.rejects(decryptConfiguration({...file,tag:Buffer.alloc(16).toString('base64')},secret),/damaged/);await assert.rejects(decryptConfiguration({...file,version:2},secret),/version/);await assert.rejects(decryptConfiguration({...file,salt:'?bad'},secret),/Invalid/);
 for(const mutate of [s=>s.tables.users=[],s=>s.tables.profiles[0].untrusted_column='bad',s=>s.files['../../outside']='eA==',s=>s.tables.profiles[0].gateway_id='missing']){const invalid=structuredClone(before);mutate(invalid);assert.throws(()=>backups.validate(invalid));}
 assert.deepEqual(backups.capture().tables,before.tables);
}));
test('local backups are encrypted, private, removable, and factory reset removes users and custom configuration',()=>fixture(async({dir,store,auth,backups})=>{
 await auth.login('admin','Backup fixture password','fixture');const profile=store.importProfile({value:'socks5://secret:password@proxy.example.com:1080#Fixture'});const snapshot=backups.capture(),copy=await backups.create();assert.ok(copy.id);assert.ok(!readFileSync(backups.path(copy.id),'utf8').includes('proxy.example.com'));assert.equal(statSync(backups.path(copy.id)).mode&0o777,0o600);assert.equal(statSync(join(backups.folder,'backup.key')).mode&0o777,0o600);assert.deepEqual((await backups.read(copy.id)).tables,snapshot.tables);assert.throws(()=>backups.remove('../bad'),/not found/);
 backups.apply(backups.factory());assert.equal(auth.needsSetup(),true);assert.equal(store.profiles().some(p=>p.id===profile.id),false);assert.equal(store.profiles().length,4);assert.equal(store.hasNetworkSettings(),false);assert.equal(store.db.prepare('SELECT count(*) n FROM sessions').get().n,0);assert.equal(backups.list().length,1);backups.apply(await backups.read(copy.id));assert.equal(auth.needsSetup(),false);assert.ok(store.profiles().some(p=>p.id===profile.id));backups.remove(copy.id);assert.deepEqual(backups.list(),[]);
}));
test('configuration API protects all secrets with administrator role and CSRF; preview and confirmed restore create a safety backup',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'fg-backup-api-')),old=process.env.FREEDOMGATE_STATE_DIR;process.env.FREEDOMGATE_STATE_DIR=dir;const store=new Store(':memory:');let prepared=0,stopped=0,restarted=0;
 const server=createServer(store,{maintenanceRuntime:{prepare:async()=>{prepared++;},stop:async()=>{stopped++;},restart:async()=>{restarted++;}}});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{const base='http://127.0.0.1:'+server.address().port;const setup=await fetch(base+'/api/auth/setup',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'admin',password:'Backup fixture password'})});const cookie=setup.headers.get('set-cookie').split(';')[0],session=await setup.json();const req=(path,method='GET',body,cs=session.csrf,c=cookie)=>fetch(base+'/api/'+path,{method,headers:{cookie:c,'content-type':'application/json','x-csrf-token':cs||''},...(body?{body:JSON.stringify(body)}:{})});
 assert.equal((await req('configuration/export','POST',{},'')).status,403);assert.equal((await req('configuration/backups','GET',undefined,'','')).status,401);
 await req('users','POST',{username:'viewer',password:'Viewer fixture password',role:'viewer'});const login=await fetch(base+'/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'viewer',password:'Viewer fixture password'})});const viewer=login.headers.get('set-cookie').split(';')[0];assert.equal((await req('configuration/backups','GET',undefined,'',viewer)).status,403);
 const secret=(await(await req('configuration/secret','POST',{})).json()).secret;const exported=await(await req('configuration/export','POST',{secret})).json();assert.ok(exported.file);assert.equal((await req('configuration/preview','POST',{file:exported.file,secret:'incorrect secret here'})).status,400);let preview=await(await req('configuration/preview','POST',{file:exported.file,secret})).json();assert.equal(preview.users,2);
 const saved=await(await req('configuration/backups','POST',{})).json();const later=store.importProfile({value:'socks5://later.example.com:1080#Later'});
 const savedExport=await req('configuration/backups/'+saved.id+'/export','POST',{secret});assert.equal(savedExport.status,200);const savedFile=(await savedExport.json()).file;const savedSnapshot=await decryptConfiguration(savedFile,secret);assert.ok(!savedSnapshot.tables.profiles.some(row=>row.id===later.id),'export uses the selected backup, not the current state');assert.ok(store.profiles().some(row=>row.id===later.id));assert.equal((await req('configuration/backups/'+saved.id+'/export','POST',{secret},'')).status,403);await req('configuration/backups/'+saved.id,'DELETE');
 assert.equal((await req('configuration/restore','POST',{file:exported.file,secret})).status,400);assert.equal(prepared,0);
 store.importProfile({value:'socks5://extra.example.com:1080#Extra'});const response=await req('configuration/restore','POST',{file:exported.file,secret,confirm:true});assert.equal(response.status,200);assert.equal((await response.json()).restarting,true);assert.equal(prepared,1);assert.equal(stopped,1);assert.equal(store.profiles().some(p=>p.name==='Extra'),false);assert.equal(store.db.prepare('SELECT count(*) n FROM sessions').get().n,0);assert.equal(new ConfigurationBackups(store,{stateDir:dir,present:value=>value}).list().length,1);await new Promise(r=>setTimeout(r,300));assert.equal(restarted,1);
 }finally{await new Promise(r=>server.close(r));await server.cleanup;store.close();if(old===undefined)delete process.env.FREEDOMGATE_STATE_DIR;else process.env.FREEDOMGATE_STATE_DIR=old;rmSync(dir,{recursive:true,force:true});}
});

test('large configuration payloads validate without recursive regular expressions',async()=>{
 const snapshot={payload:'a'.repeat(8*1024*1024)},secret=generateBackupSecret();
 const encrypted=await encryptConfiguration(snapshot,secret);
 assert.deepEqual(await decryptConfiguration(encrypted,secret),snapshot);
 for(const data of [encrypted.data+'=', '====', 'YQ=A', 'YQ==AAAA', 'YR=='])
  await assert.rejects(decryptConfiguration({...encrypted,data},secret),/Invalid/);
});

test('portable snapshots contain selected lists once and references survive offline restore and module updates',()=>fixture(async({dir,store,backups})=>{
 const old=process.env.FREEDOMGATE_STATE_DIR,other=mkdtempSync(join(tmpdir(),'fg-compact-target-'));let target;
 try{
  process.env.FREEDOMGATE_STATE_DIR=dir;
  const ref='a'.repeat(40);
  await updateDomainLists({ref,sources:{'geosite/youtube':'DOMAIN-SUFFIX,youtube.com\nDOMAIN-SUFFIX,video.example','geoip/youtube':'IP-CIDR,192.0.2.0/24','geosite/unselected':'DOMAIN-SUFFIX,unselected.example'}});
  const group=store.addRouteGroup({name:'Video',entries:['manual.example','exclude:video.example'],routeId:store.profiles().find(p=>p.engine==='direct').id,presetIds:['youtube']});
  store.addRouteGroup({name:'Second',entries:[],routeId:store.profiles().find(p=>p.engine==='direct').id,presetIds:['youtube']});
  const snapshot=backups.capture();assert.equal(snapshot.version,2);
  for(const row of snapshot.tables.route_groups)if(JSON.parse(row.domain_presets).length)assert.deepEqual(JSON.parse(row.domain_presets),[{id:'youtube'}]);
  const catalog=JSON.parse(Buffer.from(snapshot.files['domain-lists/catalog.json'],'base64'));
  assert.deepEqual(Object.keys(catalog.lists),['youtube']);assert.equal(catalog.partial,true);assert.ok(!JSON.stringify(snapshot).includes('unselected.example'));
  const file=await encryptConfiguration(snapshot,generateBackupSecret());assert.ok(JSON.stringify(file).length<20000);
  process.env.FREEDOMGATE_STATE_DIR=other;target=new Store(':memory:');new Auth(target.db);
  const restore=new ConfigurationBackups(target,{stateDir:other});restore.apply(restore.validate(snapshot));
  assert.equal(domainListsStatus().partial,true);
  assert.deepEqual(target.routeGroup(group.id).presetIds,['youtube']);
  assert.ok(target.routeGroup(group.id).entries.includes('youtube.com'));assert.ok(target.routeGroup(group.id).entries.includes('192.0.2.0/24'));assert.ok(!target.routeGroup(group.id).entries.includes('video.example'));assert.ok(target.routeGroup(group.id).entries.includes('manual.example'));
  await updateDomainLists({ref:'b'.repeat(40),sources:{'geosite/youtube':'DOMAIN-SUFFIX,new.youtube.example','geoip/youtube':'IP-CIDR6,2001:db8::/32','geosite/unselected':'DOMAIN-SUFFIX,local.example'}});target.refreshDomainPresets();
  assert.equal(domainListsStatus().partial,false);assert.deepEqual(target.routeGroup(group.id).presetIds,['youtube']);assert.ok(target.routeGroup(group.id).entries.includes('new.youtube.example'));assert.ok(!target.routeGroup(group.id).entries.includes('youtube.com'));assert.ok(target.routeGroup(group.id).entries.includes('manual.example'));assert.deepEqual(target.routeGroup(group.id).manualEntries,['manual.example','exclude:video.example']);
  const local=readFileSync(join(other,'domain-lists/catalog.json'));restore.apply(restore.validate(snapshot));assert.deepEqual(readFileSync(join(other,'domain-lists/catalog.json')),local);assert.ok(target.routeGroup(group.id).entries.includes('new.youtube.example'));
 }finally{target?.close();if(old===undefined)delete process.env.FREEDOMGATE_STATE_DIR;else process.env.FREEDOMGATE_STATE_DIR=old;rmSync(other,{recursive:true,force:true});}
}));
test('legacy snapshots compact cached lists, preserve unknown IDs and reject malformed references',()=>fixture(async({store,backups})=>{
 const group=store.addRouteGroup({name:'Legacy',entries:['manual.example'],routeId:store.profiles().find(p=>p.engine==='direct').id}),snapshot=backups.capture();snapshot.version=1;
 const row=snapshot.tables.route_groups.find(r=>r.id===group.id);row.domain_presets=JSON.stringify([{id:'legacy-only',label:'Legacy',entries:['saved.example'],ref:'a'.repeat(40)}]);
 const compact=backups.validate(snapshot),catalog=JSON.parse(Buffer.from(compact.files['domain-lists/catalog.json'],'base64'));assert.deepEqual(catalog.lists['legacy-only'],['saved.example']);assert.deepEqual(JSON.parse(compact.tables.route_groups.find(r=>r.id===group.id).domain_presets),[{id:'legacy-only'}]);
 row.domain_presets=JSON.stringify([{id:'removed-category'}]);const unresolved=backups.validate(snapshot);assert.deepEqual(JSON.parse(unresolved.tables.route_groups.find(r=>r.id===group.id).domain_presets),[{id:'removed-category'}]);
 for(const refs of [[{id:'../bad'}],[{id:'youtube',entries:'bad'}],[{id:'youtube'},{id:'youtube'}]]){row.domain_presets=JSON.stringify(refs);assert.throws(()=>backups.validate(snapshot),/Invalid/);}
}));

test('invalid selected catalogue data is rejected before replacing configuration',()=>fixture(async({store,backups})=>{
 const group=store.addRouteGroup({name:'Validate saved catalogue',entries:['manual.example'],routeId:store.profiles().find(p=>p.engine==='direct').id});
 const snapshot=backups.capture(),row=snapshot.tables.route_groups.find(row=>row.id===group.id);row.domain_presets=JSON.stringify([{id:'youtube'}]);
 const catalog={version:5,repository:'MetaCubeX/meta-rules-dat',ref:'a'.repeat(40),updatedAt:new Date().toISOString(),presets:[{id:'youtube',label:'YouTube'}],lists:{youtube:['youtube.com']}};
 for(const change of [c=>c.lists.youtube=[42],c=>c.lists.youtube=['MATCH,DIRECT'],c=>c.lists.youtube=['exclude:youtube.com'],c=>c.presets[0].exclusions=['MATCH,DIRECT'],c=>c.presets.push({...c.presets[0]}),c=>c.lists.youtube='youtube.com']){
  const invalid=structuredClone(catalog);change(invalid);snapshot.files['domain-lists/catalog.json']=Buffer.from(JSON.stringify(invalid)).toString('base64');assert.throws(()=>backups.validate(snapshot),/Invalid configuration/);
 }
 assert.ok(store.routeGroup(group.id).entries.includes('manual.example'));
}));

test('catalogue normalization keeps legacy tracker exclusions and repairs an incomplete target cache',()=>fixture(async({store,backups})=>{
 const {configurationCatalog,compactConfigurationCatalog,mergeConfigurationCatalog}=await import('../server/configuration-catalog.js');
 const legacy=configurationCatalog({version:3,repository:'fixture/lists',ref:'old',presets:[{id:'vk',label:'VK'},{id:'tracking--vk--ads',label:'VK ads',kind:'tracking',attribute:'ads'}],lists:{vk:['vk.com','ads.vk.com'],'tracking--vk--ads':['ads.vk.com']}});
 const group=store.addRouteGroup({name:'Legacy catalogue',entries:['manual.example'],routeId:store.profiles().find(p=>p.engine==='direct').id});
 const row=backups.capture().tables.route_groups.find(r=>r.id===group.id);row.domain_presets=JSON.stringify([{id:'vk'}]);
 const compact=compactConfigurationCatalog([row],legacy,new Date().toISOString());assert.deepEqual(compact.catalog.lists.vk,['vk.com']);assert.deepEqual(compact.catalog.presets[0].exclusions,['ads.vk.com']);
 const local={version:5,repository:'fixture/lists',ref:'current',presets:[{id:'other',label:'Other'}],lists:{other:['other.example'],vk:['INVALID,RULE']}};
 const merged=mergeConfigurationCatalog(compact.catalog,local);assert.deepEqual(merged.lists.vk,['vk.com']);assert.deepEqual(merged.lists.other,['other.example']);assert.equal(merged.partial,true);
 const invalidLocal={...local,presets:[...local.presets,{id:'vk'}]};assert.equal(mergeConfigurationCatalog(compact.catalog,invalidLocal),compact.catalog);
}));

test('portable backup preserves nested group references and rejects recursive references',()=>fixture(async({store,backups})=>{
 const profile=store.importProfile({value:'socks5://192.0.2.11:1080'}),child=store.saveConnectionGroup(null,{name:'Europa',members:[profile.id]}),parent=store.saveConnectionGroup(null,{name:'VPN',members:[child.id]});
 const snapshot=backups.capture(),valid=backups.validate(snapshot);assert.deepEqual(valid.tables.connection_groups.find(row=>row.id===parent.id).members,JSON.stringify([child.id]));backups.apply(valid);assert.deepEqual(store.connectionGroups().find(row=>row.id===parent.id).members,[child.id]);
 const cyclic=structuredClone(snapshot);cyclic.tables.connection_groups.find(row=>row.id===child.id).members=JSON.stringify([parent.id]);assert.throws(()=>backups.validate(cyclic),/Invalid configuration/);assert.deepEqual(store.connectionGroups().find(row=>row.id===child.id).members,[profile.id]);
}));
