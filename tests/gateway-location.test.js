import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {locationListeners,normalizeGatewayLocation,probeGatewayLocation,createGatewayLocations,requestLocationJson} from '../server/gateway-location.js';
import {buildMihomoConfig} from '../server/mihomo.js';
import {defaultDnsSettings} from '../server/dns-resolvers.js';
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('GeoIP normalization supports both providers, partial location and invalid replies',()=>{
 assert.deepEqual(normalizeGatewayLocation({ip:'203.0.113.5',success:true,country_code:'nl',country:'Netherlands',region:'North Holland',city:'Amsterdam',connection:{isp:'Example Transit',asn:64501}},'ipwho.is'),{ip:'203.0.113.5',countryCode:'NL',country:'Netherlands',region:'North Holland',city:'Amsterdam',provider:'Example Transit',asn:'AS64501',source:'ipwho.is'});
 const fallback=normalizeGatewayLocation({ip:'2001:db8::1',company:'Example Hosting',asn:'AS64501 Example Network',region:'Berlin'},'api.ipapi.is');
 assert.equal(fallback.provider,'Example Hosting');assert.equal(fallback.asn,'AS64501');assert.equal(fallback.countryCode,null);
 for(const raw of [null,{}, {ip:'invalid'}, {ip:'203.0.113.5',success:false},{ip:'192.168.0.1',is_bogon:true}])assert.throws(()=>normalizeGatewayLocation(raw,'test'));
});
test('provider fallback stays on the exact outbound and never falls back to direct',async()=>{
 const endpoint={port:28001,secret:'test'},calls=[];
 const result=await probeGatewayLocation(endpoint,{request:async(target,url)=>{calls.push([target,url]);if(calls.length===1)throw Error('rate limited');return {ip:'203.0.113.5',company:'Provider'};}});
 assert.equal(result.provider,'Provider');assert.equal(calls.length,2);assert.ok(calls.every(([target])=>target===endpoint));
 await assert.rejects(probeGatewayLocation(endpoint,{request:async()=>{throw Error('offline');}}));
});
test('GeoIP requests enforce authenticated loopback CONNECT, HTTPS, timeout and bounded output',async()=>{
 let args,input='';
 const result=await requestLocationJson({port:28001,secret:'private-secret'},'https://ipwho.is/',{spawnProcess:(binary,parameters)=>{
  assert.equal(binary,'curl');args=parameters;
  const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.stdin=new PassThrough();child.kill=()=>{};
  child.stdin.on('data',value=>input+=value);child.stdin.on('finish',()=>{child.stdout.end('{"ip":"203.0.113.1"}');child.emit('close',0);});return child;
 }});
 assert.equal(result.ip,'203.0.113.1');assert.ok(input.includes('http://127.0.0.1:28001'));assert.ok(input.includes('fg-geo:private-secret'));
 assert.equal(args[0],'--disable');assert.ok(!args.join(' ').includes('private-secret'));assert.equal(args[args.indexOf('--noproxy')+1],'');assert.equal(args[args.indexOf('--proto')+1],'=https');
 await assert.rejects(requestLocationJson({port:1},'http://example.com/'));
});
test('listener pinning excludes disabled/unsupported profiles and distinguishes reassigned ports',()=>{
 const profiles=[{id:'direct',engine:'direct'},{id:'aaaa1111',engine:'xray'},{id:'disabled',engine:'xray',enabled:false},{id:'unknown',engine:'bad'}];
 const configs=[{profile_id:'aaaa1111',engine:'xray',config:'credential fixture'}];
 const listeners=locationListeners(profiles,configs,new Set(['p-aaaa1111-grp']),'secret');
 assert.equal(listeners.length,2);assert.equal(listeners[0].tag,'p-aaaa1111-grp');assert.equal(listeners[1].tag,'DIRECT');assert.notEqual(listeners[0].secret,listeners[1].secret);
 let callback;
 const config=buildMihomoConfig(defaultDnsSettings,{controllerSecret:'secret',onLocationListeners:value=>callback=value},{profiles:[profiles[0],{id:'aaaa1111',engine:'socks5'}],configs:[{profile_id:'aaaa1111',engine:'socks5',config:'socks5://127.0.0.1:9999'}],groups:[],devices:[]});
 assert.equal(callback.length,2);
 const lines=config.split('\n').filter(line=>line.startsWith('  - {"name":"fg-geo-')).map(line=>JSON.parse(line.slice(4)));
 assert.equal(lines.length,2);assert.ok(lines.every(listener=>listener.type==='mixed' && listener.udp===true));assert.ok(lines.every(listener=>listener.listen==='127.0.0.1' && listener.users[0].password.length===64));assert.equal(lines[0].proxy,'p-aaaa1111-grp');
});
test('background location cache deduplicates, limits concurrency, retries, invalidates and avoids disabled probes',async()=>{
 let time=1000,started=0,running=0,max=0;const finish=[];
 const collector=createGatewayLocations(profile=>({key:profile.revision || 'v1',port:28000,secret:'test'}),{now:()=>time,ttl:100,retry:20,probe:async()=>{started++;running++;max=Math.max(max,running);return new Promise(resolve=>finish.push(()=>{running--;resolve({ip:'203.0.113.5'});}));}});
 const profiles=['a','b','c'].map(id=>({id}));for(const profile of profiles)assert.equal(collector.get(profile).status,'checking');
 collector.get(profiles[0]);await tick();assert.equal(started,2);assert.equal(max,2);
 finish.shift()();await tick();assert.equal(started,3);while(finish.length)finish.shift()();await tick();
 assert.equal(collector.get(profiles[0]).status,'ok');assert.equal(started,3);
 assert.equal(collector.get({...profiles[0],enabled:false}).status,'disabled');
 assert.equal(collector.get(profiles[0]).status,'checking');await tick();finish.shift()();await tick();
 time+=101;assert.equal(collector.get(profiles[0]).status,'checking');await tick();finish.shift()();await tick();
 collector.invalidate('a');assert.equal(collector.get(profiles[0]).status,'checking');await tick();finish.shift()();await tick();
 collector.prune([]);collector.stop();
 let failed=0;const failure=createGatewayLocations(()=>({key:'v1',port:28000,secret:'test'}),{now:()=>time,retry:20,probe:async()=>{failed++;throw Error('offline');}});
 failure.get(profiles[0]);await tick();assert.equal(failure.get(profiles[0]).status,'unavailable');assert.equal(failed,1);time+=21;assert.equal(failure.get(profiles[0]).status,'checking');await tick();failure.stop();
});

test('starting applied gateways probes new proxies without a telemetry request',async()=>{
 const calls=[];
 const collector=createGatewayLocations(profile=>({key:profile.id,port:28000,secret:'test'}),{probe:async endpoint=>{calls.push(endpoint.key);return {ip:'203.0.113.5'};}});
 collector.start([{id:'existing'}]);await tick();
 collector.start([{id:'existing'},{id:'new-proxy'},{id:'disabled',enabled:false}]);await tick();
 assert.deepEqual(calls,['existing','new-proxy']);
 assert.equal(collector.get({id:'new-proxy'}).status,'ok');collector.stop();
});

test('equal exit IPs share location spelling and prefer the primary provider',async()=>{
 const collector=createGatewayLocations(profile=>({key:profile.id,port:28000,secret:'test'}),{probe:async endpoint=>({ip:'203.0.113.5',city:endpoint.key==='fallback'?'gorod Solnetchnogorsk':'Solnechnogorsk',source:endpoint.key==='fallback'?'api.ipapi.is':'ipwho.is'})});
 collector.start([{id:'fallback'}]);await tick();
 collector.start([{id:'fallback'},{id:'primary'}]);await tick();
 assert.equal(collector.get({id:'fallback'}).city,'Solnechnogorsk');
 assert.equal(collector.get({id:'primary'}).city,'Solnechnogorsk');collector.stop();
});

test('failed automatic probes retry in the background for every gateway without polling',async()=>{
 const calls=new Map();
 const collector=createGatewayLocations(profile=>({key:profile.id,port:28000,secret:'test'}),{retry:10,probe:async endpoint=>{
  const count=(calls.get(endpoint.key)||0)+1;calls.set(endpoint.key,count);
  if(count===1)throw Error('temporary startup failure');return {ip:'203.0.113.5'};
 }});
 collector.start(['a','b','c','d','e'].map(id=>({id})));
 await new Promise(resolve=>setTimeout(resolve,80));
 assert.equal(calls.size,5);for(const count of calls.values())assert.equal(count,2);
 for(const id of calls.keys())assert.equal(collector.get({id}).status,'ok');
 collector.stop();
});
test('direct probes share an authenticated loopback mixed listener pinned to DIRECT',()=>{
 const config=buildMihomoConfig(defaultDnsSettings,{}, {profiles:[{id:'direct',engine:'direct'}],configs:[],devices:[],groups:[]});
 const listener=JSON.parse(config.split('\n').find(line=>line.startsWith('  - {"name":"fg-geo-direct')).slice(4));
 assert.equal(listener.type,'mixed');assert.equal(listener.udp,true);assert.equal(listener.proxy,'DIRECT');assert.equal(listener.listen,'127.0.0.1');assert.ok(listener.users[0].password);
});
test('probe ports stay reserved through disable, removal and sorted insertion during hot reload',()=>{
 const ports=new Map(),secret='secret';
 const a={id:'a',engine:'mihomo'},direct={id:'b',engine:'direct'},zapret={id:'c',engine:'zapret'};
 const supported=new Set(['p-a-grp','p-c-grp']);
 const initial=locationListeners([a,direct,zapret],[],supported,secret,{ports});
 for(const profiles of [[{...a,enabled:false},direct,zapret],[direct,zapret],[{id:'0-new',engine:'direct'},direct,zapret]]){
  const next=locationListeners(profiles,[],supported,secret,{ports});
  for(const id of ['b','c'])assert.equal(next.find(row=>row.id===id).port,initial.find(row=>row.id===id).port);
  assert.equal(new Set(next.map(row=>row.port)).size,next.length);
 }
 assert.equal(ports.get('a'),initial[0].port,'removed gateway port is not reassigned while its old listener may still exist');
});

test('diagnostic refresh awaits a fresh connection result and updates the shared row cache',async()=>{
 let count=0;const collector=createGatewayLocations(()=>({key:'v1',port:28000,secret:'fixture'}),{probe:async()=>({ip:++count===1?'203.0.113.1':'203.0.113.2'})});
 try{collector.start([{id:'a'}]);await tick();assert.equal(collector.get({id:'a'}).ip,'203.0.113.1');
 const value=await collector.refresh({id:'a'});assert.equal(value.ip,'203.0.113.2');assert.equal(collector.get({id:'a'}).ip,value.ip);
 }finally{collector.stop();}
});

test('cancelling a queued diagnostic connection check releases it immediately',async()=>{
 const controller=new AbortController(),finish=[];
 const collector=createGatewayLocations(p=>({key:p.id,port:28000,secret:'fixture'}),{probe:async()=>new Promise(resolve=>finish.push(()=>resolve({ip:'203.0.113.1'})))});
 collector.start([{id:'a'},{id:'b'}]);await tick();
 const pending=collector.refresh({id:'c'},{signal:controller.signal});controller.abort();
 await pending;assert.equal(finish.length,2);
 for(const done of finish)done();await tick();collector.stop();
});

test('Tor and Tor-wrapped gateways wait for bootstrap, refresh without polling and invalidate on reconnect',async()=>{
 let state='connecting',generation=1,calls=0;
 const collector=createGatewayLocations(profile=>({key:profile.id+':'+generation,port:28000,secret:'fixture',transportState:state,timeoutMs:30000,ttl:100}),{transportPollMs:5,probe:async()=>{calls++;return {ip:generation===1?'203.0.113.1':'203.0.113.2'};}});
 try{
  collector.start([{id:'tor'},{id:'wrapped'}]);await new Promise(r=>setTimeout(r,12));assert.equal(calls,0);assert.equal(collector.get({id:'tor'}).status,'checking');
  const pending=collector.refresh({id:'wrapped'});state='ready';const result=await pending;assert.equal(result.status,'ok');assert.equal(result.ip,'203.0.113.1');await new Promise(r=>setTimeout(r,12));assert.equal(collector.get({id:'tor'}).status,'ok');assert.equal(calls,2);
  generation++;state='connecting';assert.equal(collector.get({id:'wrapped'}).status,'checking');state='ready';await new Promise(r=>setTimeout(r,12));assert.equal(collector.get({id:'wrapped'}).ip,'203.0.113.2');assert.equal(calls,3);
 }finally{collector.stop();}
});
test('Tor exit data has a short freshness window and location request gets its longer transport budget',async()=>{
 let time=0,calls=0,args;
 const collector=createGatewayLocations(()=>({key:'tor',port:28000,secret:'fixture',ttl:10}),{now:()=>time,probe:async()=>{calls++;return {ip:'203.0.113.1'};}});
 try{collector.get({id:'tor'});await tick();time=11;collector.get({id:'tor'});await tick();assert.equal(calls,2);}finally{collector.stop();}
 await requestLocationJson({port:28001,secret:'fixture',timeoutMs:30000},'https://ipwho.is/',{spawnProcess:(_binary,parameters)=>{args=parameters;const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.stdin=new PassThrough();child.kill=()=>{};child.stdin.on('finish',()=>{child.stdout.end('{"ip":"203.0.113.1"}');child.emit('close',0);});return child;}});
 assert.equal(args[args.indexOf('--max-time')+1],'30');assert.equal(args[args.indexOf('--connect-timeout')+1],'10');
});
test('location endpoints retain the selected proxy and include the Tor session identity for nested chains',async()=>{
 const {MihomoSupervisor}=await import('../server/mihomo.js');let session={state:'connecting',mode:'snowflake',startedAt:'first'};
 const supervisor=new MihomoSupervisor({tor:{status:()=>({tor:session})}});
 const profiles=[{id:'tor',engine:'tor',enabled:true},{id:'outer',engine:'socks5',gatewayId:'tor'},{id:'inner',engine:'xray',gatewayId:'outer'},{id:'direct',engine:'direct'}];supervisor._routes.profiles=profiles;
 for(const profile of profiles)supervisor.locationEndpoints.set(profile.id,{key:profile.id,port:28000+profiles.indexOf(profile),secret:'fixture'});
 for(const profile of profiles.slice(0,3)){const endpoint=supervisor.locationEndpoint(profile);assert.equal(endpoint.port,supervisor.locationEndpoints.get(profile.id).port,'Probe must remain pinned to the requested final proxy');assert.equal(endpoint.transportState,'connecting');assert.equal(endpoint.timeoutMs,30000);assert.equal(endpoint.ttl,300000);}
 const before=supervisor.locationEndpoint(profiles[2]).key;session={...session,state:'ready',startedAt:'second'};assert.notEqual(supervisor.locationEndpoint(profiles[2]).key,before);assert.equal(supervisor.locationEndpoint(profiles[2]).transportState,'ready');assert.equal(supervisor.locationEndpoint(profiles[3]),supervisor.locationEndpoints.get('direct'));
 supervisor.gatewayLocations.stop();
});
