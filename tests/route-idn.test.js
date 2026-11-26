import test from 'node:test';import assert from 'node:assert/strict';
import {normalizeRouteEntries,mihomoRouteRule} from '../server/route-entries.js';import {normalizeRouteEntries as formEntries} from '../web/src/lib/form-validation.js';import {normalizeRouteEntry,routeEntrySelection} from '../shared/route-preset-entries.js';import {parseDomainList} from '../server/domain-lists.js';import {Store} from '../server/store.js';
const site='xn--80aswg.xn--p1ai';
test('IDNA is consistent for domain prefixes, exclusions, wildcards and different alphabets',()=>{
 for(const [input,expected] of [['рф','xn--p1ai'],['сайт.рф',site],['САЙТ.РФ',site],['domain:сайт.рф',site],['FULL:САЙТ.РФ','full:'+site],['*.сайт.рф','*.'+site],['exclude:сайт.рф','exclude:'+site],['EXCLUDE:FULL:САЙТ.РФ','exclude:full:'+site],['exclude:domain:сайт.рф','exclude:'+site],['bücher.de','xn--bcher-kva.de'],['例子.测试','xn--fsqu00a.xn--0zwm56d'],['www.сайт.рф','www.'+site],['сайт。рф',site]]){assert.equal(normalizeRouteEntry(input),expected);assert.deepEqual(normalizeRouteEntries([input]),[expected]);assert.deepEqual(formEntries([input]),[expected]);}
});
test('IDNA does not extract a host from URLs, credentials, ports or malformed domains; regex payload is unchanged',()=>{
 for(const input of ['https://сайт.рф','сайт.рф/path','user@сайт.рф','сайт.рф:443','сайт.рф?query','сайт.рф#hash','сайт .рф','\ud800.рф','exclude:сайт.рф/path','exclude:full:сайт.рф:443','keyword:сайт']){assert.throws(()=>normalizeRouteEntries([input]),undefined,input);assert.throws(()=>formEntries([input]),undefined,input);}
 assert.equal(normalizeRouteEntry('REGEXP:^САЙТ\\.РФ$'),'regexp:^САЙТ\\.РФ$');
});
test('Unicode and Punycode deduplicate and exclusion semantics survive normalization',()=>{
 assert.equal(mihomoRouteRule('рф','DIRECT'),'DOMAIN-SUFFIX,xn--p1ai,DIRECT');
 assert.deepEqual(normalizeRouteEntries(['рф','xn--p1ai']),['xn--p1ai']);
 assert.deepEqual(normalizeRouteEntries(['сайт.рф',site,'exclude:full:САЙТ.РФ','exclude:full:'+site]),[site,'exclude:full:'+site]);
 assert.deepEqual(routeEntrySelection(['сайт.рф','exclude:full:сайт.рф']),{entries:[site],exclusions:['full:'+site]});
 assert.deepEqual(routeEntrySelection(['сайт.рф','full:sub.сайт.рф','exclude:сайт.рф']),{entries:[],exclusions:[site]});
});
test('catalog parsing and stored groups use canonical IDNA without changing user exclusion intent',()=>{
 assert.deepEqual(parseDomainList('сайт.рф\nfull:例子.测试'),['full:xn--fsqu00a.xn--0zwm56d',site]);
 const store=new Store(':memory:');try{const group=store.addRouteGroup({name:'Unicode',routeId:'block',entries:['сайт.рф','exclude:full:сайт.рф']});assert.deepEqual(group.manualEntries,[site,'exclude:full:'+site]);assert.deepEqual(store.routeGroup(group.id).exclusions,['full:'+site]);assert.deepEqual(store.updateRouteGroup(group.id,{entries:['сайт.рф','exclude:сайт.рф']}).entries,[]);}finally{store.close();}
});
