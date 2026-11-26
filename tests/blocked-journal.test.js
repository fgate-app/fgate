import test from 'node:test';
import assert from 'node:assert/strict';
import {createBlockedJournal,parseRejectedLog} from '../server/blocked-journal.js';
const log={type:'info',payload:'[TCP] 10.20.0.2:1234(browser, uid=1000) --> blocked.test:443 match DomainSuffix(blocked.test) using REJECT'};
test('parses explicit REJECT decisions, IPv6 and warning format; ignores unrelated failures',()=>{
 const row=parseRejectedLog(log);assert.equal(row.host,'blocked.test');assert.equal(row.process,'browser, uid=1000');
 assert.equal(parseRejectedLog({payload:'[UDP] dial REJECT (match DomainSuffix/blocked.test) [2001:db8::1]:1234 --> [2001:db8::2]:443 error: rejected'}).sourceIP,'2001:db8::1');
 for(const payload of ['[TCP] 10.0.0.1:2 --> a.test:443 match Match using DIRECT','[TCP] dial Proxy (match DomainSuffix/a.test) 10.0.0.1:2 --> a.test:443 error: timeout','not a connection'])assert.equal(parseRejectedLog({payload}),null);
});
test('collects route and DNS blocks, groups repeats, deduplicates DNS pages, ignores allowed and rewrites',async()=>{
 let time=Date.parse('2026-11-14T10:00:00Z');
 const collector=createBlockedJournal({now:()=>time,retention:1000,rules:async()=>[{type:'DomainSuffix',payload:'blocked.test',id:'route1',name:'Blocked route'}]});
 await collector.poll();collector.ingestLog(log);collector.ingestLog(log);collector.ingestLog({payload:'[TCP] 10.20.0.2:1234 --> internal.test:443 match DomainSuffix(internal.test) using REJECT'});
 const item={time:new Date(time).toISOString(),client:'10.20.0.3',question:{name:'ads.test',type:'A'},reason:'FilteredBlackList',rules:[{filter_list_id:1,text:'||ads.test^'}]};
 collector.ingestDns({data:[item,{...item,reason:'NotFilteredWhiteList'},{...item,reason:'Rewrite'},{...item,reason:'FilteredSafeSearch'}],filters:{'1':'Ads filter'}});collector.ingestDns({data:[item]});
 let rows=collector.snapshot().connections;assert.equal(rows.length,2);assert.equal(rows.find(r=>r.blockSource==='route').attempts,2);assert.equal(rows.find(r=>r.blockSource==='dns').attempts,1);assert.equal(rows.find(r=>r.blockSource==='dns').ruleName,'Ads filter');
 collector.ingestDns({data:[{...item,question:{name:'route.test',type:'A'},rules:[{filter_list_id:0,text:'||route.test^'}]}],routeRules:{'||route.test^':{id:'route2',name:'Route block'}}});
 assert.equal(collector.snapshot().connections.find(r=>r.host==='route.test').blockSource,'route');
 time+=1001;assert.equal(collector.snapshot().connections.length,0);collector.stop();
});
test('reconnects log feed and aborts it on stop',async()=>{
 let started=0,aborted=false;
 const collector=createBlockedJournal({watchLogs:async(fn,{signal})=>{started++;if(started===1)throw Error('offline');return new Promise(resolve=>signal.addEventListener('abort',()=>{aborted=true;resolve();}));}});
 await collector.poll();await new Promise(r=>setImmediate(r));await collector.poll();await new Promise(r=>setImmediate(r));assert.equal(started,2);assert.equal(collector.snapshot().sources.route,null,'reconnecting idle stream is unknown until its first event');collector.stop();assert.equal(aborted,true);
});

test('applied route registry excludes internal and disabled-gateway REJECTs',async()=>{
 const {MihomoSupervisor}=await import('../server/mihomo.js');
 const target={_routes:{groups:[{id:'blocked',name:'My block',routeId:'block'},{id:'proxy',routeId:'proxy'}],devices:[]},_appliedRuleOwners:[{id:'blocked'},{id:'proxy'},null],controller:async()=>({rules:[{type:'DomainSuffix',payload:'blocked.test',proxy:'REJECT'},{type:'DomainSuffix',payload:'proxy.test',proxy:'REJECT'},{type:'Match',payload:'',proxy:'REJECT'}]})};
 const method=Object.values(await import('../server/mihomo.js')).find(value=>typeof value==='function' && value.prototype?.blockedRouteRules)?.prototype.blockedRouteRules;
 assert.ok(method);assert.deepEqual(await method.call(target),[{type:'DomainSuffix',payload:'blocked.test',id:'blocked',name:'My block'}]);
});

test('mihomo log stream authenticates, handles split NDJSON and aborts cleanly',async()=>{
 const {createServer}=await import('node:http'),{MihomoSupervisor}=await import('../server/mihomo.js');
 let authenticated=false;
 const server=createServer((req,res)=>{authenticated=req.headers.authorization==='Bearer fixture';assert.equal(req.url,'/logs?level=info');res.writeHead(200,{'Content-Type':'application/json'});res.write('{"type":"info","pay');setTimeout(()=>res.write('load":"first"}\n{"type":"info","payload":"second"}\n'),5);});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const controller=new AbortController(),events=[];
 try{
  await assert.rejects(MihomoSupervisor.prototype.watchLogs.call({state:'running',controllerPort:server.address().port,controllerSecret:'fixture'},event=>{events.push(event);if(events.length===2)controller.abort();},{signal:controller.signal}));
  assert.ok(authenticated);assert.deepEqual(events.map(event=>event.payload),['first','second']);
 }finally{controller.abort();server.closeAllConnections();await new Promise(r=>server.close(r));}
});
