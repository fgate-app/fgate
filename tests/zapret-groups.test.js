import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../server/store.js';
import {buildMihomoConfig} from '../server/mihomo.js';
import {defaultDnsSettings} from '../server/dns-resolvers.js';
import {strategyProfiles} from '../server/zapret.js';
import {ZAPRET_PRESETS,ZAPRET_MARK,zapretMark} from '../shared/zapret.js';

test('legacy route groups migrate idempotently and inherit the global strategy',()=>{
 const dir=mkdtempSync(join(tmpdir(),'fg-group-migration-')),path=join(dir,'old.sqlite');
 let store;
 try{
  const old=new DatabaseSync(path);
  old.exec("CREATE TABLE route_groups (id TEXT PRIMARY KEY,name TEXT NOT NULL,entries TEXT NOT NULL,route_id TEXT,created_at TEXT NOT NULL); INSERT INTO route_groups VALUES ('old','Legacy','[\"example.com\"]',NULL,'2026-01-01');");old.close();
  store=new Store(path);
  assert.equal(store.routeGroup('old').zapretStrategy,null);
  const zapret=store.profiles().find(p=>p.engine==='zapret');
  store.updateRouteGroup('old',{routeId:zapret.id,zapretStrategy:'nfqws2'});
  store.close();store=new Store(path);
  assert.equal(store.routeGroup('old').zapretStrategy,'nfqws2');
  assert.deepEqual(store.routeGroup('old').entries,['example.com']);
 }finally{store?.close();rmSync(dir,{recursive:true,force:true});}
});

test('group strategy overrides persist, validate, reset and clear on non-zapret routes',()=>{
 const store=new Store(':memory:');
 try{
  const zapret=store.profiles().find(p=>p.engine==='zapret'),direct=store.profiles().find(p=>p.engine==='direct');
  const group=store.addRouteGroup({name:'Media',entries:['googlevideo.com'],routeId:zapret.id});
  assert.equal(group.zapretStrategy,null);
  store.updateRouteGroup(group.id,{zapretStrategy:'md5sum'});
  assert.equal(store.updateRouteGroup(group.id,{name:'Renamed'}).zapretStrategy,'md5sum');
  assert.throws(()=>store.updateRouteGroup(group.id,{zapretStrategy:'--lua-init=evil'}),/strategy/);
  assert.equal(store.routeGroup(group.id).zapretStrategy,'md5sum');
  assert.equal(store.updateRouteGroup(group.id,{zapretStrategy:null}).zapretStrategy,null);
  store.updateRouteGroup(group.id,{zapretStrategy:'nfqws2'});
  assert.equal(store.updateRouteGroup(group.id,{routeId:direct.id}).zapretStrategy,null);
  assert.equal(store.updateRouteGroup(group.id,{routeId:zapret.id}).zapretStrategy,null);
 }finally{store.close();}
});

test('mihomo selects preset marks per group and keeps device rules ahead of groups',()=>{
 const profiles=[{id:'zapret-id',engine:'zapret'},{id:'direct-id',engine:'direct'}];
 const config=buildMihomoConfig(defaultDnsSettings,{}, {
  profiles,configs:[{profile_id:'zapret-id',engine:'zapret',config:''}],
  devices:[{identifier:'10.20.0.115',routeId:'zapret-id'}],
  groups:[
   {entries:['googlevideo.com','192.0.2.0/24','*.example.com'],routeId:'zapret-id',zapretStrategy:'nfqws2'},
   {entries:['inherited.example'],routeId:'zapret-id'},
   {entries:['direct.example'],routeId:'direct-id',zapretStrategy:'md5sum'},
   {entries:['metrika.yandex.ru'],routeId:'block'},
  ],
 });
 assert.match(config,/name: zapret-nfqws2\n    type: direct\n    udp: true\n    routing-mark: 268435461/);
 assert.match(config,/DOMAIN-SUFFIX,googlevideo.com,zapret-nfqws2/);
 assert.match(config,/IP-CIDR,192.0.2.0\/24,zapret-nfqws2/);
 assert.match(config,/DOMAIN-WILDCARD,\*\.example.com,zapret-nfqws2/);
 assert.match(config,/DOMAIN-SUFFIX,inherited.example,p-zapret-i-grp/);
 assert.match(config,/DOMAIN-SUFFIX,direct.example,DIRECT/);
 assert.doesNotMatch(config,/name: zapret-md5sum/);
 assert.ok(config.indexOf('DOMAIN-SUFFIX,metrika.yandex.ru,REJECT')<config.indexOf('SRC-IP-CIDR,10.20.0.115/32'),'explicit blocks must not be bypassed by a device exit');
 assert.ok(config.indexOf('DOMAIN-SUFFIX,googlevideo.com')<config.indexOf('SRC-IP-CIDR,10.20.0.115/32,p-zapret-i-grp'));
});

test('one nfqws2 command isolates each preset and applies global changes only to inheritance',()=>{
 const split=args=>args.reduce((profiles,arg)=>{if(arg==='--new')profiles.push([]);else profiles.at(-1).push(arg);return profiles;},[[]]);
 const args=split(strategyProfiles({strategy:'tpws2',http:true,https:true,quic:true}));
 assert.equal(args.length,(ZAPRET_PRESETS.length+1)*3);
 for(const profile of args)assert.equal(profile.filter(arg=>arg.startsWith('--filter-mark=')).length,1);
 for(const mark of [ZAPRET_MARK,...ZAPRET_PRESETS.map(preset=>zapretMark(preset.id))]) {
  assert.equal(args.filter(profile=>profile.includes(`--filter-mark=0x${mark.toString(16)}/0xffffffff`)).length,3);
 }
 const tls=(profiles,mark)=>profiles.find(profile=>profile.includes('--filter-l7=tls')&&profile.includes(`--filter-mark=0x${mark.toString(16)}/0xffffffff`));
 const changed=split(strategyProfiles({strategy:'ipid',http:true,https:true,quic:true}));
 assert.deepEqual(tls(args,zapretMark('nfqws2')),tls(changed,zapretMark('nfqws2')));
 assert.notDeepEqual(tls(args,ZAPRET_MARK),tls(changed,ZAPRET_MARK));
 assert.ok(tls(changed,ZAPRET_MARK).some(arg=>arg.includes('ip_id=rnd')));
 assert.ok(args.findIndex(profile=>profile.includes('--filter-mark=0x10000005/0xffffffff'))<args.findIndex(profile=>profile.includes('--filter-mark=0x10000000/0xffffffff')));
});
