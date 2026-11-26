import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,writeFileSync,mkdirSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {gzipSync} from 'node:zlib';
import {DOMAIN_PRESETS,parseDomainList,readDomainArchive,domainListsStatus,domainListDomains,updateDomainLists} from '../server/domain-lists.js';
const TRACKING_PLACEHOLDERS=['tracking--all','tracking--yandex--telemetry','tracking--vk--ads'].filter(id=>!DOMAIN_PRESETS.some(p=>p.id===id)).length;
async function isolated(action){const dir=mkdtempSync(join(tmpdir(),'fg-domain-lists-'));process.env.FREEDOMGATE_STATE_DIR=dir;try{return await action(dir);}finally{delete process.env.FREEDOMGATE_STATE_DIR;rmSync(dir,{recursive:true,force:true});}}
test('full bundled manifest covers every upstream file, including categories and !cn names',()=>{
 assert.ok(DOMAIN_PRESETS.length>2000);assert.ok(DOMAIN_PRESETS.some(p=>p.id==='category-ai-!cn'));assert.ok(DOMAIN_PRESETS.some(p=>p.id==='2gis'));
});
test('parser retains suffix/exact/regexp types including comma quantifiers',()=>{
 assert.deepEqual(parseDomainList('# comment\nDomain:unused'.replace('Domain:unused','domain:example.com')+'\nfull:exact.example.com\nregexp:^x[0-9]{1,3}\\.example$ @ads\nexample.com\ninclude:other'),['example.com','full:exact.example.com','regexp:^x[0-9]{1,3}\\.example$']);
});
test('full-source refresh includes every file, expands filters and affiliations, and discovers new files',()=>isolated(async()=>{
 await updateDomainLists({ref:'fixture',sources:{youtube:'include:common @ads @-cn\nfull:yt3.googleusercontent.com',common:'ad.example @ads\ncn.example @ads @cn\nother.example &new-service', 'new-service':'new.example','category-ai-!cn':'include:new-service'}});
 assert.deepEqual(domainListDomains('youtube'),['full:yt3.googleusercontent.com']);
 assert.deepEqual(domainListDomains('tracking--youtube'),['ad.example']);
 assert.deepEqual(domainListDomains('new-service'),['new.example','other.example']);
 assert.ok(domainListsStatus().presets.length>=4);assert.equal(domainListDomains('missing'),null);
 assert.deepEqual(domainListDomains('category-ai-!cn'),['new.example','other.example']);
}));
test('failed HTTP, invalid rules and cycles retain the entire previous snapshot',()=>isolated(async dir=>{
 await updateDomainLists({ref:'initial',sources:{youtube:'youtube.com'}});
 const before=readFileSync(join(dir,'domain-lists/catalog.json'),'utf8');
 await assert.rejects(updateDomainLists({ref:'broken',fetchImpl:async()=>({ok:false,status:503})}),/503/);
 await assert.rejects(updateDomainLists({ref:'cycle',sources:{youtube:'include:other',other:'include:youtube'}}),/Cyclic/);
 await assert.rejects(updateDomainLists({ref:'invalid',sources:{youtube:'invalid:/rule'}}),/Unsupported/);
 assert.equal(readFileSync(join(dir,'domain-lists/catalog.json'),'utf8'),before);
}));
test('large expanded categories exceed the former 10000 rule limit without truncation',()=>isolated(async()=>{
 const entries=Array.from({length:12001},(_,index)=>'d'+index+'.example');
 await updateDomainLists({sources:{large:entries.join('\n'),'category-large-!cn':'include:large'}});
 assert.equal(domainListDomains('category-large-!cn').length,12001);
}));
test('archive reader includes files beyond GitHub directory page limits and never extracts archive paths',async()=>{
 const chunks=[];
 for(let index=0;index<1100;index++){
  const body=Buffer.from('example.com\n'),header=Buffer.alloc(512);header.write('repo/data/service-'+index);header.write(body.length.toString(8).padStart(11,'0')+'\0',124);header[156]=48;
  chunks.push(header,body,Buffer.alloc(512-body.length));
 }
 const sources=await readDomainArchive(gzipSync(Buffer.concat([...chunks,Buffer.alloc(1024)])));assert.equal(Object.keys(sources).length,1100);assert.equal(sources['service-1099'],'example.com\n');
 await assert.rejects(readDomainArchive(Buffer.from('not gzip')));
});
test('empty or obsolete catalogs still expose the full downloadable manifest',()=>isolated(async dir=>{
 assert.equal(domainListsStatus().presets.length,DOMAIN_PRESETS.length+TRACKING_PLACEHOLDERS);assert.ok(domainListsStatus().presets.every(p=>!p.available));
 mkdirSync(join(dir,'domain-lists'));writeFileSync(join(dir,'domain-lists/catalog.json'),JSON.stringify({ref:'old'}));
 assert.equal(domainListsStatus().presets.length,DOMAIN_PRESETS.length+TRACKING_PLACEHOLDERS);assert.deepEqual(domainListDomains('youtube'),[]);
}));

test('API supports !cn filenames and saving a large complete preset without request truncation',()=>isolated(async()=>{
 const {Store}=await import('../server/store.js'),{createServer}=await import('../server/index.js');
 const entries=Array.from({length:12001},(_,index)=>'long-label-'+index+'.large-domain.example.org');
 await updateDomainLists({sources:{'category-example-!cn':entries.join('\n')}});
 const store=new Store(':memory:'),server=createServer(store);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port;
 try{
  const setup=await fetch(base+'/api/auth/setup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'admin',password:'test password 12345'})});const session=await setup.json();
  const headers={'Content-Type':'application/json',Cookie:setup.headers.get('set-cookie').split(';')[0],'X-CSRF-Token':session.csrf};
  const preset=await fetch(base+'/api/domain-lists/category-example-!cn',{headers});assert.equal(preset.status,200);assert.equal((await preset.json()).domains.length,12001);
  const body=JSON.stringify({name:'Large category',entries,routeId:store.profiles()[0].id});assert.ok(Buffer.byteLength(body)>300000);
  const response=await fetch(base+'/api/routes/groups',{method:'POST',headers,body});assert.equal(response.status,201);assert.equal((await response.json()).entries.length,12001);
 }finally{await new Promise(resolve=>server.close(resolve));store.close();}
}));


test('tracking presets preserve attribute scopes without blocking entire services',()=>isolated(async()=>{
 await updateDomainLists({sources:{yandex:'yandex.ru\nmc.yandex.ru @ads @telemetry\nfull:analytics.mobile.yandex.net @telemetry',vk:'vk.com\nanalytics.vk.com @ads',parent:'include:yandex',unrelated:'example.org'}});
 assert.deepEqual(domainListDomains('tracking--yandex--telemetry'),['full:analytics.mobile.yandex.net','mc.yandex.ru']);
 assert.deepEqual(domainListDomains('tracking--vk--ads'),['analytics.vk.com']);
 assert.deepEqual(domainListDomains('tracking--parent--telemetry'),domainListDomains('tracking--yandex--telemetry'));
 assert.deepEqual(domainListDomains('tracking--all'),['analytics.vk.com','full:analytics.mobile.yandex.net','mc.yandex.ru']);
 assert.ok(!domainListDomains('tracking--all').includes('yandex.ru'));
 assert.equal(domainListsStatus().presets.find(p=>p.id==='tracking--yandex--telemetry').kind,'tracking');
}));

test('refresh preserves an already installed catalog revision',()=>isolated(async()=>{
 await updateDomainLists({ref:'installed-newer',sources:{yandex:'mc.yandex.ru @telemetry'}});
 await updateDomainLists({sources:{yandex:'mc.yandex.ru @telemetry'}});
 assert.equal(domainListsStatus().ref,'installed-newer');
}));
