import test from 'node:test';import assert from 'node:assert/strict';
import {createPresetSearch} from '../server/domain-preset-search.js';
import {parseRouteFile} from '../shared/route-file.js';
import {normalizeRouteEntries} from '../server/route-entries.js';
import {mkdtempSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {domainListSnapshot,restoreDomainListSnapshot,updateDomainLists,searchDomainPresets} from '../server/domain-lists.js';
import {Store} from '../server/store.js';import {createServer} from '../server/index.js';
test('preset search ranks exact names first and finds rules, IPs, IDNA, labels and list types',()=>{
 const search=createPresetSearch([{id:'extra',label:'Extra'},{id:'x',label:'X'},{id:'video',label:'Видео'},{id:'tracking--video',label:'Video',kind:'tracking',combined:true},{id:'hidden',hidden:true}],{extra:['example.com'],x:['x.com'],video:['youtube.com','192.0.2.7','xn--80aswg.xn--p1ai','regexp:^MixedCase[0-9]+$'], 'tracking--video':['ads.youtube.com'],hidden:['youtube.com']});
 assert.equal(search('x')[0].id,'x');assert.equal(search('mixedcase')[0].match,'regexp:^MixedCase[0-9]+$');assert.equal(search('192.0.2.7')[0].match,'192.0.2.7');assert.equal(search('Видео')[0].match,null);assert.deepEqual(search('192.0.2.7').map(p=>p.id),['video']);assert.deepEqual(search('сайт.рф').map(p=>p.id),['video']);assert.equal(search('Видео')[0].id,'video');assert.deepEqual(search('you').map(p=>p.id).sort(),['tracking--video','video']);assert.equal(search('ads.youtube.com')[0].kind,'tracking');assert.equal(search('ads.youtube.com')[0].count,1);assert.deepEqual(search('nomatch'),[]);assert.deepEqual(search(''),[]);assert.deepEqual(search('x'.repeat(1025)),[]);
});
test('text rule import handles BOM/comments/attributes, canonical duplicates, exclusions and all rule types atomically',()=>{
 assert.deepEqual(parseRouteFile('\uFEFF# comment\r\nСАЙТ.РФ @ads &service\r\nxn--80aswg.xn--p1ai\nexclude:full:сайт.рф\n192.0.2.0/24\n2001:db8::1\nregexp:^X[0-9]{1,3}\\.example$\n',normalizeRouteEntries),['xn--80aswg.xn--p1ai','exclude:full:xn--80aswg.xn--p1ai','192.0.2.0/24','2001:db8::1','regexp:^X[0-9]{1,3}\\.example$']);
 for(const text of ['# empty','valid.com\nnot a rule','valid.com\nhttps://bad.example','include:youtube','a'.repeat(2*1024*1024+1),Array(50002).fill('a.com').join('\n')])assert.throws(()=>parseRouteFile(text,normalizeRouteEntries));
});
test('search API follows catalog refresh and rollback without stale indexes',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'fg-search-')),old=process.env.FREEDOMGATE_STATE_DIR;process.env.FREEDOMGATE_STATE_DIR=dir;const store=new Store(':memory:'),server=createServer(store);await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{const base='http://127.0.0.1:'+server.address().port;assert.equal((await fetch(base+'/api/domain-lists/search?q=you')).status,401);const setup=await fetch(base+'/api/auth/setup',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'admin',password:'Fixture password 12345'})}),cookie=setup.headers.get('set-cookie').split(';')[0];
 await updateDomainLists({sources:{youtube:'youtube.com\n192.0.2.7'}});let result=await(await fetch(base+'/api/domain-lists/search?q=192.0.2.7',{headers:{cookie}})).json();assert.equal(result.presets[0].id,'youtube');assert.equal(result.presets[0].count,2);
 const snapshot=domainListSnapshot();await updateDomainLists({sources:{youtube:'new.example'}});assert.deepEqual(searchDomainPresets('192.0.2.7'),[]);assert.equal(searchDomainPresets('new.example')[0].count,1);restoreDomainListSnapshot(snapshot);assert.equal(searchDomainPresets('192.0.2.7')[0].count,2);assert.deepEqual(searchDomainPresets('new.example'),[]);
 }finally{await new Promise(r=>server.close(r));await server.cleanup;store.close();if(old===undefined)delete process.env.FREEDOMGATE_STATE_DIR;else process.env.FREEDOMGATE_STATE_DIR=old;rmSync(dir,{recursive:true,force:true});}
});
