import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,readFileSync,existsSync,statSync,symlinkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import net from 'node:net';
import {normalizeTorSettings} from '../shared/tor.js';
import {TorGateway,TorSupervisor,torConfig,waitForTor,seedTorCache} from '../server/tor/runtime.js';
import {Store} from '../server/store.js';
import {gatewayEditor} from '../server/gateway-editor.js';
import {gatewayWrapCandidates,validateGatewayWrap} from '../shared/gateway-wrap.js';
import {buildMihomoConfig} from '../server/mihomo.js';
import {defaultDnsSettings} from '../server/dns-resolvers.js';
import {diagnoseDomains} from '../server/domain-diagnostics.js';
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check){for(let n=0;n<200;n++){if(check())return;await delay(5);}throw Error('Test condition timed out.');}
function fixture(){const root=mkdtempSync(join(tmpdir(),'fg-tor-test-'));mkdirSync(join(root,'tor/pluggable_transports'),{recursive:true});writeFileSync(join(root,'tor/tor'),'fixture');writeFileSync(join(root,'tor/pluggable_transports/lyrebird'),'fixture');writeFileSync(join(root,'tor/pluggable_transports/pt_config.json'),JSON.stringify({bridges:{snowflake:['snowflake 192.0.2.1:443 fingerprint=fixture']}}));return {root,close:()=>rmSync(root,{recursive:true,force:true})};}
function fakeSpawn(onSpawn=()=>{}){return (_binary,args)=>{const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.exitCode=null;child.kill=()=>{child.exitCode=0;child.emit('exit',0);};onSpawn(readFileSync(args[1],'utf8'),child);return child;};}
test('Tor settings normalize legacy records and reject invalid/injected options',()=>{
 assert.deepEqual(normalizeTorSettings({}),{mode:'snowflake',connectTimeout:120,retries:2,retryDelay:30});
 assert.equal(normalizeTorSettings({mode:'auto'}).mode,'auto');assert.throws(()=>normalizeTorSettings({mode:'direct\nUseBridges 0'}));assert.throws(()=>normalizeTorSettings({connectTimeout:2}));assert.throws(()=>normalizeTorSettings({retries:100}));
 assert.equal(Object.hasOwn(normalizeTorSettings({socksPort:9050}),'socksPort'),false);
});
test('Tor profiles persist settings, edit in place, normalize old data and allow only outer wrapping',()=>{
 const store=new Store(':memory:');try{const tor=store.profiles().find(row=>row.engine==='tor'),proxy=store.importProfile({value:'socks5://198.51.100.1:443'});assert.equal(tor.engine,'tor');assert.equal(gatewayEditor(store.profileSnapshot(tor.id)).settings.mode,'snowflake');
 assert.equal(tor.builtin,1);assert.equal(tor.enabled,false);assert.deepEqual(store.profiles().slice(0,4).map(row=>row.engine),['direct','tor','lantern','zapret']);store.updateProfile(tor.id,{settings:{mode:'snowflake'}});assert.throws(()=>store.updateProfile(tor.id,{name:'Private Tor'}));assert.equal(gatewayEditor(store.profileSnapshot(tor.id)).settings.mode,'snowflake');
 assert.ok(gatewayWrapCandidates(store.profiles(),proxy.id).some(row=>row.id===tor.id));store.updateProfile(proxy.id,{gatewayId:tor.id});assert.throws(()=>store.updateProfile(tor.id,{gatewayId:proxy.id}));assert.throws(()=>store.removeProfile(tor.id));
 store.db.prepare('UPDATE profile_configs SET config=? WHERE profile_id=?').run('{}',tor.id);assert.equal(gatewayEditor(store.profileSnapshot(tor.id)).settings.connectTimeout,120);
 }finally{store.close();}
});
test('Tor config uses private control, no exit service, and shipped Snowflake bridge defaults',()=>{
 const f=fixture();try{const options={dir:f.root,bundle:f.root,socksPort:12345,controlPort:12346};const direct=torConfig({...options,mode:'direct'}),snow=torConfig({...options,mode:'snowflake'});
 assert.match(direct,/ClientOnly 1/);assert.match(direct,/SocksPort 127\.0\.0\.1:12345/);assert.match(direct,/CookieAuthentication 1/);assert.doesNotMatch(direct,/Bridge snowflake/);assert.match(snow,/ClientTransportPlugin snowflake exec/);assert.match(snow,/Bridge snowflake/);assert.doesNotMatch(snow,/^ORPort /m);
 }finally{f.close();}
});
test('direct success never starts Snowflake; gate rejects before bootstrap and closes on stop',async()=>{
 const f=fixture();let ready=false,spawns=0;const row=new TorGateway({id:'direct',settings:{mode:'auto'},stateDir:f.root,bundle:f.root,pollMs:5,spawnProcess:fakeSpawn(()=>spawns++),info:async()=>({progress:ready?100:20,ready})});
 try{await row.start();assert.equal(row.gate.address().address,'127.0.0.1');await until(()=>row.progress===20);
 const closed=await new Promise(resolve=>{const socket=net.connect(row.port,'127.0.0.1');socket.on('close',()=>resolve(true));socket.on('error',()=>{});socket.write('test');});assert.equal(closed,true);
 ready=true;await until(()=>row.state==='ready');await delay(30);assert.equal(spawns,1);assert.equal(row.mode,'direct');assert.equal((await waitForTor(row)).outcome,'ok');
 }finally{await row.stop();f.close();}assert.equal(row.gate.listening,false);
});
test('direct timeout falls back to Snowflake and retains healthy Snowflake',async()=>{
 const f=fixture(),modes=[];let time=0;const row=new TorGateway({id:'fallback',stateDir:f.root,bundle:f.root,pollMs:5,settings:{mode:'auto',connectTimeout:30,retries:0},clock:()=>time,spawnProcess:fakeSpawn(config=>modes.push(config.includes('UseBridges 1')?'snowflake':'direct')),info:async()=>{time+=11000;return {progress:modes.at(-1)==='snowflake'?100:5,ready:modes.at(-1)==='snowflake'};}});
 try{await row.start();await until(()=>row.state==='ready');assert.deepEqual(modes,['direct','snowflake']);await delay(30);assert.deepEqual(modes,['direct','snowflake']);assert.equal(row.snapshot().attempts[0].reason,'bootstrap-timeout');}
 finally{await row.stop();f.close();}
});
test('Snowflake-only has no direct attempt; exhausted cycles fail closed; cancellation stops waiting',async()=>{
 const f=fixture(),modes=[];let time=0;const row=new TorGateway({id:'only',stateDir:f.root,bundle:f.root,pollMs:5,settings:{mode:'snowflake',connectTimeout:30,retries:0},clock:()=>time,spawnProcess:fakeSpawn(config=>modes.push(config.includes('UseBridges 1')?'snowflake':'direct')),info:async()=>{time+=11000;return {progress:0,ready:false};}});
 try{await row.start();await until(()=>row.state==='failed');assert.deepEqual(modes,['snowflake']);assert.equal(row.sockets.size,0);assert.equal((await waitForTor(row)).outcome,'failed');const controller=new AbortController();controller.abort();await assert.rejects(()=>waitForTor(row,{signal:controller.signal}));}
 finally{await row.stop();f.close();}
});
test('Tor supervisor commits atomically, reuses existing process, and rolls back new entries',async()=>{
 const f=fixture();let starts=0,stops=0;const create=options=>({key:null,options,port:12000+(starts++),start:async()=>{},stop:async()=>{stops++;},snapshot:()=>({state:'connecting'})});const supervisor=new TorSupervisor({stateDir:f.root,bundle:f.root,create});
 try{const configs=[{profile_id:'abc',engine:'tor',config:'{"mode":"auto"}'}];let prepared=await supervisor.prepare(configs);assert.equal(supervisor.entries.size,0);await prepared.commit();assert.equal(supervisor.entries.size,1);const dir=supervisor.entries.get('abc').options.stateDir;prepared=await supervisor.prepare(configs);await prepared.commit();assert.equal(starts,1);assert.equal(supervisor.entries.get('abc').options.stateDir,dir);
 prepared=await supervisor.prepare([{...configs[0],config:'{"mode":"snowflake"}'}]);await prepared.rollback();assert.equal(stops,1);assert.equal(supervisor.entries.get('abc').options.settings.mode,'auto');
 }finally{await supervisor.stop();f.close();}assert.equal(stops,2);
});
test('Tor routing is TCP only, preserves hostname mapping and bypasses service transports before user rules',()=>{
 const profile={id:'12345678-tor',name:'Tor',engine:'tor',protocol:'tor',enabled:true};const output=buildMihomoConfig({...structuredClone(defaultDnsSettings),enhancedMode:'redir-host'},{},{profiles:[profile],configs:[{profile_id:profile.id,engine:'tor',config:'{}'}],devices:[],groups:[{id:'r',entries:['example.com'],route_id:profile.id}],bridges:{[profile.id]:{port:12345,address:'127.0.0.1',udp:false}}});
 assert.match(output,/enhanced-mode: fake-ip/);assert.match(output,/udp: false/);assert.match(output,/type: socks5/);assert.ok(output.indexOf('PROCESS-NAME,tor,DIRECT')<output.indexOf('example.com'));assert.match(output,/NETWORK,udp/);
});
test('failed Tor bootstrap stops before domain checks and retains transport evidence',async()=>{
 let requests=0;const report=await diagnoseDomains({profile:{engine:'tor'},domains:['example.com'],checks:{},services:{prepare:async()=>{},tor:async({onProgress})=>{const value={state:'failed',outcome:'failed',attempts:[{id:1,mode:'direct',state:'failed',progress:10},{id:2,mode:'snowflake',state:'failed',progress:0}]};onProgress(value);return value;},gateway:()=>{requests++;}},onProgress:()=>{}});
 assert.equal(requests,0);assert.deepEqual(report.domains,[]);assert.equal(report.torConnection.attempts.length,2);assert.equal(report.progress.state,'completed');assert.equal(report.outcome,'failed');
});

test('Tor API enforces permissions and CSRF and exposes built-in status without runtime secrets',async()=>{
 const {createServer}=await import('../server/index.js');const store=new Store(':memory:'),server=createServer(store);
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port+'/api/';
 try{
  assert.equal((await fetch(base+'profiles/tor',{method:'POST',body:'{}',headers:{'Content-Type':'application/json'}})).status,401);
  const setup=await fetch(base+'auth/setup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'admin',password:'fixture password 12345'})}),auth=await setup.json(),headers={'Content-Type':'application/json',Cookie:setup.headers.get('set-cookie').split(';')[0],'X-CSRF-Token':auth.csrf};
  assert.equal((await fetch(base+'profiles/tor',{method:'POST',headers:{Cookie:headers.Cookie,'Content-Type':'application/json'},body:'{}'})).status,403);
  assert.equal((await fetch(base+'profiles/tor',{method:'POST',headers,body:'{}'})).status,404);const profile=store.profiles().find(row=>row.engine==='tor');assert.equal((await fetch(base+'profiles/'+profile.id,{method:'DELETE',headers})).status,400);const rows=await (await fetch(base+'profiles',{headers})).json();assert.equal(rows.find(row=>row.id===profile.id).managed,false);assert.equal(rows.find(row=>row.id===profile.id).builtin,1);assert.equal(rows.some(row=>Object.hasOwn(row,'settings')),false);
  await fetch(base+'users',{method:'POST',headers,body:JSON.stringify({username:'viewer',password:'fixture password 12345',role:'viewer'})});const login=await fetch(base+'auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'viewer',password:'fixture password 12345'})}),viewer=await login.json();assert.equal((await fetch(base+'profiles/tor',{method:'POST',headers:{'Content-Type':'application/json',Cookie:login.headers.get('set-cookie').split(';')[0],'X-CSRF-Token':viewer.csrf},body:'{}'})).status,403);
 }finally{await new Promise(resolve=>server.close(resolve));await server.cleanup;store.close();}
});

test('Tor control readiness authenticates by private cookie and parses circuit and network liveness',async()=>{
 const {torInfo}=await import('../server/tor/runtime.js');const f=fixture(),cookie=join(f.root,'cookie');writeFileSync(cookie,Buffer.alloc(32,42));let received='';
 const server=net.createServer(socket=>socket.on('data',chunk=>{received+=chunk;socket.end('250 OK\r\n250-status/bootstrap-phase=NOTICE BOOTSTRAP PROGRESS=100 TAG=done SUMMARY="Done"\r\n250-status/circuit-established=1\r\n250-network-liveness=up\r\n250 OK\r\n250 closing connection\r\n');}));await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{const result=await torInfo(server.address().port,cookie);assert.deepEqual(result,{progress:100,ready:true,alive:true});assert.match(received,/AUTHENTICATE 2a2a/);assert.match(received,/network-liveness/);}finally{await new Promise(resolve=>server.close(resolve));f.close();}
});

test('existing Tor is promoted without changing its ID, settings, enabled state or wrapping references',()=>{
 const f=fixture(),file=join(f.root,'legacy.db');let store=new Store(file);
 try{const tor=store.profiles().find(row=>row.engine==='tor'),proxy=store.importProfile({value:'socks5://198.51.100.20:443'});store.updateProfile(tor.id,{settings:{mode:'snowflake'},enabled:true});store.updateProfile(proxy.id,{gatewayId:tor.id});store.db.prepare('UPDATE profiles SET builtin=0,name=? WHERE id=?').run('Legacy Tor',tor.id);store.close();store=new Store(file);const restored=store.profiles().find(row=>row.engine==='tor');assert.equal(restored.id,tor.id);assert.equal(restored.builtin,1);assert.equal(restored.enabled,true);assert.equal(store.profiles().filter(row=>row.engine==='tor').length,1);assert.equal(JSON.parse(store.profileSnapshot(tor.id).config.config).mode,'snowflake');assert.equal(store.profiles().find(row=>row.id===proxy.id).gatewayId,tor.id);assert.throws(()=>store.removeProfile(tor.id));assert.throws(()=>store.addProfile({name:'Duplicate',protocol:'other',engine:'tor'}));}
 finally{store.close();f.close();}
});

test('disabled built-in Tor remains a wrapping candidate but nested traffic is REJECT',()=>{
 const store=new Store(':memory:');try{const tor=store.profiles().find(row=>row.engine==='tor'),proxy=store.importProfile({name:'Wrapped',value:'socks5://198.51.100.10:443'});store.updateProfile(proxy.id,{gatewayId:tor.id});const configs=store.db.prepare('SELECT * FROM profile_configs').all(),config=buildMihomoConfig(structuredClone(defaultDnsSettings),{},{profiles:store.profiles(),configs,groups:[],devices:[]});assert.ok(gatewayWrapCandidates(store.profiles(),proxy.id).some(row=>row.id===tor.id));assert.ok(config.includes(JSON.stringify({name:'p-'+proxy.id.slice(0,8),type:'reject'})));}finally{store.close();}
});

test('an unused disabled built-in Tor does not override the existing DNS mode',()=>{
 const store=new Store(':memory:');try{const config=buildMihomoConfig({...defaultDnsSettings,enhancedMode:'redir-host'},{},{profiles:store.profiles(),configs:store.db.prepare('SELECT * FROM profile_configs').all(),groups:[],devices:[]});assert.match(config,/enhanced-mode: redir-host/);assert.doesNotMatch(config,/PROCESS-NAME,tor,DIRECT/);}finally{store.close();}
});

test('a failed website through connected Tor does not trigger proxy-server DPI or path strategies',async()=>{
 let strategies=0,comparisons=0;const profile={id:'tor-test',engine:'tor',protocol:'tor'},report=await diagnoseDomains({profile,domains:['example.com'],checks:{},services:{prepare:async()=>{},identity:()=>({state:'unavailable'}),tor:async()=>({state:'ready',outcome:'ok',mode:'snowflake',attempts:[]}),gateway:async({targets})=>({path:{chain:[profile]},attempts:[{url:targets[0],outcome:'failed',observation:'timeout'}]}),strategies:async()=>{strategies++;},pathComparison:async()=>{comparisons++;}}});assert.equal(strategies,0);assert.equal(comparisons,0);assert.equal(report.torConnection.mode,'snowflake');assert.equal(report.attempts.length,1);
});

test('Tor timeout/retry edits preserve the live process and cache and rollback keeps settings unchanged',async()=>{
 const f=fixture(),active=new Set();let starts=0,stops=0;
 const create=options=>({options,settings:options.settings,port:13000+starts,snapshot:()=>({state:'ready'}),start:async()=>{assert.ok(!active.has(options.stateDir),'No concurrent process may use this directory');active.add(options.stateDir);starts++;mkdirSync(options.stateDir,{recursive:true});writeFileSync(join(options.stateDir,'cache-fixture'),'cached');},stop:async()=>{active.delete(options.stateDir);stops++;}});
 const supervisor=new TorSupervisor({stateDir:f.root,bundle:f.root,create}),config=settings=>[{profile_id:'cache',engine:'tor',config:JSON.stringify(settings)}];
 try{
  let transaction=await supervisor.prepare(config({}));await transaction.commit();const row=supervisor.entries.get('cache'),dir=row.options.stateDir;
  transaction=await supervisor.prepare(config({connectTimeout:180,retries:4,retryDelay:50}));assert.equal(starts,1);assert.equal(row.settings.connectTimeout,120);await assert.rejects(supervisor.prepare(config({})),/already pending/);await transaction.rollback();assert.equal(row.settings.connectTimeout,120);assert.equal(stops,0);
  transaction=await supervisor.prepare(config({connectTimeout:180,retries:4,retryDelay:50}));await transaction.commit();assert.equal(row.settings.connectTimeout,180);assert.equal(row.settings.retries,4);assert.equal(starts,1);assert.equal(supervisor.entries.get('cache'),row);
  transaction=await supervisor.prepare([]);await transaction.commit();assert.equal(stops,1);
  transaction=await supervisor.prepare(config({connectTimeout:240,retries:1}));await transaction.commit();assert.equal(starts,2);assert.equal(supervisor.entries.get('cache').options.stateDir,dir);assert.equal(readFileSync(join(dir,'cache-fixture'),'utf8'),'cached');
  transaction=await supervisor.prepare(config({mode:'auto'}));assert.notEqual(transaction.bridges.cache.port,undefined);assert.equal(active.size,2,'Mode changes use isolated directories');await transaction.rollback();assert.equal(active.size,1);
  await supervisor.stop();const replacement=new TorSupervisor({stateDir:f.root,bundle:join(f.root,'updated-module'),create});
  try{transaction=await replacement.prepare(config({connectTimeout:250,retries:2}));await transaction.commit();assert.equal(replacement.entries.get('cache').options.stateDir,dir,'A new supervisor and module path retain the same cache');}finally{await replacement.stop();}
 }finally{await supervisor.stop();f.close();}
});
test('legacy Tor cache migration copies only reusable regular files with private permissions',()=>{
 const f=fixture();try{
  const source=join(f.root,'legacy'),target=join(f.root,'stable'),folder=join(source,'tor','cache','snowflake');mkdirSync(folder,{recursive:true});
  for(const name of ['state','cached-microdesc-consensus','lock','control.cookie','torrc'])writeFileSync(join(folder,name),name);
  symlinkSync(join(folder,'state'),join(folder,'cached-descriptors'));
  seedTorCache(source,target,'cache');const dest=join(target,'tor','cache','snowflake');assert.equal(readFileSync(join(dest,'state'),'utf8'),'state');assert.equal(statSync(join(dest,'state')).mode&0o777,0o600);assert.ok(existsSync(join(dest,'cached-microdesc-consensus')));
  for(const name of ['lock','control.cookie','torrc','cached-descriptors'])assert.equal(existsSync(join(dest,name)),false);
  writeFileSync(join(dest,'state'),'updated');seedTorCache(source,target,'cache');assert.equal(readFileSync(join(dest,'state'),'utf8'),'updated');assert.equal(readFileSync(join(folder,'state'),'utf8'),'state');
 }finally{f.close();}
});

test('failed Tor prepare cleans its child and releases the pending transaction even if cleanup fails',async()=>{
 const f=fixture();let fail=true,stops=0;
 const supervisor=new TorSupervisor({stateDir:f.root,bundle:f.root,create:()=>({port:12000,snapshot:()=>({state:'connecting'}),start:async()=>{if(fail)throw Error('fixture startup failure');},stop:async()=>{stops++;if(fail)throw Error('fixture cleanup failure');}})});
 try{const configs=[{profile_id:'failure',engine:'tor',config:'{}'}];await assert.rejects(supervisor.prepare(configs),/fixture startup failure/);assert.equal(stops,1);assert.equal(supervisor.pending,false);fail=false;const next=await supervisor.prepare(configs);await next.rollback();assert.equal(supervisor.pending,false);}finally{await supervisor.stop();f.close();}
});
