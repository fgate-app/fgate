import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,writeFileSync,mkdirSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {gzipSync} from 'node:zlib';
import {buildMetaCatalog,parseMetaList} from '../server/metacube-catalog.js';
import {readDomainArchive,updateDomainLists,domainListDomains,domainListsStatus,searchDomainPresets} from '../server/domain-lists.js';
import {DomainListUpdates} from '../server/domain-list-updates.js';import {Store} from '../server/store.js';import {groupRouteRules} from '../server/route-entries.js';
const sources={
 'geosite/telegram':'DOMAIN-SUFFIX,telegram.org\nDOMAIN,t.me',
 'geoip/telegram':'IP-CIDR,149.154.160.0/20\nIP-CIDR,2001:67c:4e8::/48',
 'geosite/vk':'DOMAIN-SUFFIX,vk.com\nDOMAIN,ads.vk.com\nDOMAIN,stats.vk.com',
 'geosite/vk@ads':'DOMAIN,ads.vk.com\nDOMAIN,stats.vk.com',
 'geosite/vk@telemetry':'DOMAIN,stats.vk.com',
 'geosite/microsoft@cn':'DOMAIN-SUFFIX,microsoft.cn',
 'geosite/category-ads-all':'DOMAIN-SUFFIX,independent-ad.example',
 'geoip/jp':'IP-CIDR,192.0.2.0/24',
};
async function isolated(action){const dir=mkdtempSync(join(tmpdir(),'fg-meta-')),old=process.env.FREEDOMGATE_STATE_DIR;process.env.FREEDOMGATE_STATE_DIR=dir;try{await action(dir);}finally{if(old===undefined)delete process.env.FREEDOMGATE_STATE_DIR;else process.env.FREEDOMGATE_STATE_DIR=old;rmSync(dir,{recursive:true,force:true});}}
function tarFile(name,text,type=48){const body=Buffer.from(text),head=Buffer.alloc(512);head.write(name.slice(0,100));head.write(body.length.toString(8).padStart(11,'0')+'\0',124);head[156]=type;return Buffer.concat([head,body,Buffer.alloc((512-body.length%512)%512)]);}
test('MetaCubeX classical lists retain exact/suffix/keyword/regex/IP semantics and reject rule injection',()=>{
 assert.deepEqual(parseMetaList('DOMAIN,x.example\nDOMAIN-SUFFIX,example\nDOMAIN-KEYWORD,video\nDOMAIN-REGEX,^x[0-9]{1,3}\\.example$','geosite'),['example','full:x.example','keyword:video','regexp:^x[0-9]{1,3}\\.example$']);
 assert.deepEqual(parseMetaList('IP-CIDR,192.0.2.0/24,no-resolve\nIP-CIDR,2001:db8::/32','geoip'),['192.0.2.0/24','2001:db8::/32']);
 for(const line of ['MATCH,DIRECT','DOMAIN-SUFFIX,example,DIRECT','IP-CIDR,192.0.2.0/99'])assert.throws(()=>parseMetaList(line,'geosite'));
});
test('streaming archive reader selects full canonical lists, honors long PAX paths, and ignores ASN, lite and duplicate formats',async()=>{
 const long='repo/geo/geosite/classical/'+('a'.repeat(85))+'.list';const attr='path='+long+'\n';let length=attr.length+3;while((String(length)+' '+attr).length!==length)length=(String(length)+' '+attr).length;
 const archive=gzipSync(Buffer.concat([tarFile('repo/geo/geosite/classical/telegram.list',sources['geosite/telegram']),tarFile('repo/geo/geoip/classical/telegram.list',sources['geoip/telegram']),tarFile('repo/geo/geosite/telegram.list','+.ignored.example'),tarFile('repo/asn/AS123.list','192.0.2.0/24'),tarFile('repo/geo-lite/geosite/classical/telegram.list','DOMAIN,wrong.example'),tarFile('pax',String(length)+' '+attr,120),tarFile(long,'DOMAIN,long.example'),Buffer.alloc(1024)]));
 const parsed=await readDomainArchive(archive);assert.equal(Object.keys(parsed).length,3);assert.equal(parsed['geosite/telegram'],sources['geosite/telegram']);assert.equal(parsed['geosite/'+'a'.repeat(85)],'DOMAIN,long.example');await assert.rejects(readDomainArchive(archive.subarray(0,archive.length-5)));await assert.rejects(readDomainArchive(gzipSync(tarFile('repo/geo/geoip/classical/../escape.list','bad'))));
});
test('service presets merge IPv4/IPv6 with domains, preserve tracking scopes and expose @cn independently',()=>isolated(async()=>{
 await updateDomainLists({ref:'a'.repeat(40),sources});assert.equal(domainListsStatus().repository,'MetaCubeX/meta-rules-dat');assert.equal(domainListsStatus().branch,'meta');assert.deepEqual(domainListDomains('telegram'),['149.154.160.0/20','2001:67c:4e8::/48','full:t.me','telegram.org']);assert.deepEqual(domainListDomains('vk'),['vk.com']);assert.deepEqual(domainListDomains('tracking--vk'),['full:ads.vk.com','full:stats.vk.com']);assert.deepEqual(domainListDomains('tracking--vk--telemetry'),['full:stats.vk.com']);assert.deepEqual(domainListDomains('microsoft@cn'),['microsoft.cn']);assert.ok(domainListDomains('tracking--all').includes('independent-ad.example'));assert.ok(!domainListDomains('tracking--all').includes('149.154.160.0/20'));assert.ok(searchDomainPresets('149.154.160').some(p=>p.id==='telegram'));
}));
test('source migration preserves manual entries, unavailable bound presets and local exclusions across later updates',()=>isolated(async dir=>{
 await updateDomainLists({ref:'legacy',sources:{telegram:'old.example',disappeared:'keep.example'}});const oldCatalog=JSON.parse(readFileSync(join(dir,'domain-lists/catalog.json')));oldCatalog.repository='v2fly/domain-list-community';writeFileSync(join(dir,'domain-lists/catalog.json'),JSON.stringify(oldCatalog));
 let store=new Store(join(dir,'db'));const route=store.addRouteGroup({name:'Telegram',routeId:store.profiles().find(p=>p.engine==='direct').id,presetIds:['telegram','disappeared'],entries:['149.154.160.0/20','manual.example','exclude:blocked.example']});store.close();
 await updateDomainLists({ref:'b'.repeat(40),sources});store=new Store(join(dir,'db'));
 try{let result=store.routeGroup(route.id);assert.deepEqual(result.manualEntries,['149.154.160.0/20','manual.example','exclude:blocked.example']);assert.equal(result.entries.filter(e=>e==='149.154.160.0/20').length,1);assert.ok(result.entries.includes('keep.example'));assert.ok(!result.entries.includes('old.example'));assert.ok(result.presets.find(p=>p.id==='disappeared').available===false);assert.ok(groupRouteRules(result,'DIRECT').some(r=>r.includes('blocked.example')));
 await updateDomainLists({ref:'c'.repeat(40),sources:{...sources,'geoip/telegram':'IP-CIDR,198.51.100.0/24'}});store.refreshDomainPresets();result=store.routeGroup(route.id);assert.ok(result.entries.includes('198.51.100.0/24'));assert.ok(result.manualEntries.includes('149.154.160.0/20'));
 }finally{store.close();}
}));
test('large country catalogs are complete and may be bound without the previous 50000-entry ceiling',()=>isolated(async()=>{
 const rows=Array.from({length:50001},(_,i)=>`IP-CIDR,10.${i>>8}.${i&255}.0/24`).join('\n');await updateDomainLists({sources:{...sources,'geoip/us':rows}});assert.equal(domainListDomains('us').length,50001);const store=new Store(':memory:');try{const route=store.addRouteGroup({name:'Country',routeId:store.profiles()[0].id,presetIds:['us']});assert.equal(route.entries.length,50001);}finally{store.close();}
}));
test('updates follow the generated meta branch rather than master and failed downloads preserve data',()=>isolated(async dir=>{
 await updateDomainLists({sources,ref:'a'.repeat(40)});const before=readFileSync(join(dir,'domain-lists/catalog.json'));let url;const updater=new DomainListUpdates({current:()=>null,fetchImpl:async input=>{url=input;return {ok:true,json:async()=>({sha:'b'.repeat(40)})};},update:async()=>{throw Error('Download failed');}});updater.start('check');await updater.task;assert.ok(url.endsWith('/commits/meta'));updater.start('update','b'.repeat(40));await updater.task;assert.equal(updater.row.state,'error');assert.deepEqual(readFileSync(join(dir,'domain-lists/catalog.json')),before);await assert.rejects(updateDomainLists({sources:{'geosite/bad':'MATCH,DIRECT','geoip/telegram':sources['geoip/telegram']}}));assert.deepEqual(readFileSync(join(dir,'domain-lists/catalog.json')),before);
}));
