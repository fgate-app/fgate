import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {Store} from '../server/store.js';import {Auth} from '../server/auth.js';
import {TelegramNotifications} from '../server/telegram.js';
import {observeTelegramRuntime} from '../server/telegram-events.js';
import {ConfigurationBackups} from '../server/configuration-backup.js';
import {createResourceFetch,curlRequest} from '../server/resource-fetch.js';
import {createServer} from '../server/index.js';import {createServer as httpServer} from 'node:http';
const token='123456789:THIS_IS_A_FAKE_TEST_TOKEN_123456789';
const config={enabled:true,token,chatId:'-123456',language:'en',systemName:'Test system',categories:['gateways','services','cloud','updates','backups']};
async function fixture(action){const dir=mkdtempSync(join(tmpdir(),'fg-telegram-')),store=new Store(':memory:');let time=1000000;const calls=[];const notifier=new TelegramNotifications(store,{stateDir:dir,now:()=>time,fetchImpl:async(url,opts)=>{calls.push({url,...opts});return new Response('{"ok":true}');}});try{await action({notifier,store,dir,calls,advance:n=>time+=n});}finally{notifier.stop();store.close();rmSync(dir,{recursive:true,force:true});}}
test('Telegram defaults, encrypted token, masked API and category validation',()=>fixture(async({notifier,store,dir})=>{
 assert.equal(notifier.status().enabled,false);notifier.configure(config);const shown=notifier.status();assert.equal(shown.hasToken,true);assert.equal(JSON.stringify(shown).includes(token),false);assert.equal(JSON.stringify(store.db.prepare('SELECT * FROM telegram_integrations').all()).includes(token),false);assert.equal(readFileSync(join(dir,'access-points.key')).length,32);
 notifier.configure({token:'',systemName:'Renamed'});assert.equal(notifier.status().hasToken,true);assert.throws(()=>notifier.configure({categories:['everything']}));assert.throws(()=>notifier.configure({chatId:'@arbitrary'}));assert.throws(()=>notifier.configure({token:'invalid'}));
}));
test('Telegram confirms stable failure/recovery, suppresses fluctuations and filters categories',()=>fixture(async({notifier,calls,advance})=>{
 notifier.configure(config);const observe=value=>notifier.observe('gateway',value,{category:'gateways',component:'Gateway test',kind:'health',failed:value==='failed'});
 observe('ready');observe('failed');advance(10000);observe('ready');advance(20000);observe('ready');assert.equal(notifier.state.queue.length,0);
 observe('failed');advance(15001);observe('failed');observe('failed');assert.equal(notifier.state.queue.length,1);await notifier.deliver();assert.equal(calls.length,1);assert.match(calls[0].body,/is unavailable/);
 observe('ready');advance(15001);observe('ready');await notifier.deliver();assert.equal(calls.length,2);assert.match(calls[1].body,/working again/);
 notifier.configure({categories:['backups']});notifier.enqueue('gateways','failed','Gateway test');assert.equal(notifier.state.queue.length,0);
}));
test('Telegram queue survives restart without resending delivered messages, expires, bounds and disables retries',()=>fixture(async({notifier,store,dir,calls,advance})=>{
 notifier.configure(config);for(let n=0;n<60;n++)notifier.enqueue('cloud','changed','Cloud access','cloud-'+n);assert.equal(notifier.state.queue.length,50);await notifier.deliver();
 const restarted=new TelegramNotifications(store,{stateDir:dir,now:notifier.now,fetchImpl:notifier.fetch});assert.equal(restarted.state.queue.length,49);assert.equal(restarted.state.lastDelivered,notifier.state.lastDelivered);advance(3600001);await restarted.deliver();assert.equal(restarted.state.queue.length,0);assert.equal(calls.length,1);
 restarted.enqueue('cloud','changed','Cloud access');restarted.configure({enabled:false});await restarted.deliver();assert.equal(calls.length,1);restarted.stop();
}));
test('Telegram handles rate limiting without leaking response details, then retries',()=>fixture(async({notifier,calls,advance})=>{
 notifier.configure(config);notifier.fetch=async()=>new Response(JSON.stringify({ok:false,error_code:429,description:'PRIVATE token detail',parameters:{retry_after:30}}),{status:429});notifier.enqueue('services','failed','mihomo');await notifier.deliver();assert.equal(notifier.state.queue.length,1);assert.equal(notifier.state.queue[0].nextAt,notifier.now()+30000);assert.equal(JSON.stringify(notifier.status()).includes('PRIVATE'),false);
 notifier.fetch=async(url,o)=>{calls.push(o);return new Response('{"ok":true}');};advance(29999);await notifier.deliver();assert.equal(calls.length,0);advance(1);await notifier.deliver();assert.equal(calls.length,1);
}));
test('Telegram disabled or changed settings abort in-flight delivery and prevent stale persistence',()=>fixture(async({notifier,calls})=>{
 notifier.configure(config);let release;notifier.fetch=async(url,o)=>{calls.push(o);await new Promise(r=>release=r);return new Response('{"ok":true}');};notifier.enqueue('cloud','changed','Cloud access');const sending=notifier.deliver();await new Promise(r=>setImmediate(r));notifier.configure({enabled:false});assert.equal(calls[0].signal.aborted,true);release();await sending;assert.equal(notifier.status().delivery.lastDelivered,null);assert.equal(notifier.state.queue.length,0);
}));
test('Telegram backup is portable but restores disabled without its delivery queue; old backups remain valid',()=>fixture(async({notifier,store,dir})=>{
 await new Auth(store.db).create({username:'admin',password:'test configuration password'},true);notifier.configure(config);notifier.enqueue('cloud','changed','Cloud access');notifier.persist();const backup=new ConfigurationBackups(store,{stateDir:dir}),snapshot=backup.capture();assert.equal(snapshot.telegram.token,token);backup.validate(snapshot);backup.apply(snapshot);const fresh=new TelegramNotifications(store,{stateDir:dir,fetchImpl:notifier.fetch});assert.equal(fresh.status().enabled,false);assert.equal(fresh.status().hasToken,true);assert.equal(fresh.state.queue.length,0);delete snapshot.telegram;backup.validate(snapshot);fresh.stop();
}));
test('Telegram POST reuses direct→gateway fallback, preserves body, and does not retry rate limits on another path',async()=>{
 const paths=[],gateway={id:'test',port:28000,secret:'a'.repeat(20)};const request=async(url,o)=>{paths.push(o.gateway?.id||'direct');assert.equal(o.method,'POST');assert.equal(o.body,'{"test":true}');if(!o.gateway)throw Error('blocked');return {status:200,body:Buffer.from('{"ok":true}'),headers:new Headers()};};
 const send=createResourceFetch({gateways:()=>[gateway],request});await send('https://api.telegram.org/botFAKE/sendMessage',{method:'POST',body:'{"test":true}'});assert.deepEqual(paths,['direct','test']);
 let count=0;const limited=createResourceFetch({gateways:()=>[gateway],request:async()=>{count++;return {status:429,body:Buffer.from('{}'),headers:new Headers()};}});assert.equal((await limited('https://api.telegram.org/botFAKE/sendMessage',{acceptStatus:s=>s===429})).status,429);assert.equal(count,1);
});
test('actual curl POST carries JSON over stdin, not command arguments',async()=>{
 let actual;const server=httpServer((req,res)=>{let body='';req.on('data',c=>body+=c);req.on('end',()=>{actual={method:req.method,body,content:req.headers['content-type']};res.end('{"ok":true}');});});await new Promise(r=>server.listen(0,'127.0.0.1',r));try{await curlRequest('http://127.0.0.1:'+server.address().port,{method:'POST',body:'{"text":"test"}',headers:{'Content-Type':'application/json'},maxBytes:100});assert.deepEqual(actual,{method:'POST',body:'{"text":"test"}',content:'application/json'});}finally{await new Promise(r=>server.close(r));}
});
test('Telegram uses confirmed aggregate gateway health and real group selection, not individual site failure',()=>fixture(async({notifier,store,advance})=>{
 notifier.configure(config);const profile=store.importProfile({value:'socks5://fixture.example:1080#Fixture'});store.addRouteGroup({name:'Test route',entries:['example.com'],routeId:profile.id});let status='ok';const supervisor={status:()=>({state:'running'}),httpHealth:{get:()=>({httpStatus:status})}};const snapshot=()=>observeTelegramRuntime(notifier,{store,supervisor,modulesHelper:async()=>({modules:[]})});await snapshot();status='error';await snapshot();advance(15001);await snapshot();assert.ok(notifier.state.queue.some(e=>e.category==='gateways'&&e.kind==='failed'));assert.equal(JSON.stringify(notifier.state.queue).includes('fixture.example'),false);
}));
test('Telegram API enforces admin/CSRF, masks token, tests only stored recipient',()=>fixture(async({store,dir})=>{
 const sent=[],server=createServer(store,{telegramOptions:{stateDir:dir,fetchImpl:async(url,o)=>{sent.push(JSON.parse(o.body));return new Response('{"ok":true}');}}});await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
 async function req(path,method='GET',body,session,csrf=true){const r=await fetch(base+'/api/'+path,{method,headers:{'Content-Type':'application/json',...(session?{cookie:session.cookie,...(csrf?{'X-CSRF-Token':session.csrf}:{})}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,data:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]};}
 try{assert.equal((await req('telegram')).status,401);const login=await req('auth/setup','POST',{username:'admin',password:'test telegram password'}),admin={cookie:login.cookie,csrf:login.data.csrf};assert.equal((await req('telegram','PUT',config,admin,false)).status,403);assert.equal((await req('telegram/chats','POST',{},admin,false)).status,403);assert.equal((await req('telegram','PUT',config,admin)).status,200);assert.equal(JSON.stringify((await req('telegram','GET',null,admin)).data).includes(token),false);assert.equal((await req('telegram/test','POST',{chatId:'999'},admin)).status,200);assert.equal(sent[0].chat_id,config.chatId);
 await req('users','POST',{username:'operator',password:'test telegram password',role:'operator'},admin);const op=await req('auth/login','POST',{username:'operator',password:'test telegram password'}),session={cookie:op.cookie,csrf:op.data.csrf};assert.equal((await req('telegram','GET',null,session)).status,403);assert.equal((await req('telegram/test','POST',{},session)).status,403);assert.equal((await req('telegram/chats','POST',{},session)).status,403);
 }finally{await new Promise(r=>server.close(r));await server.cleanup;}
}));
test('Telegram runtime sources cover group outage/failover, cloud, services and update results',()=>fixture(async({notifier,store,advance})=>{
 notifier.configure(config);const profile=store.importProfile({value:'socks5://fixture.example:1080#Fixture'}),other=store.importProfile({value:'socks5://other.example:1080#Other'}),group=store.saveConnectionGroup(null,{name:'Group',members:[profile.id,other.id]});store.addRouteGroup({name:'Test route',entries:['example.com'],routeId:group.id});
 let metric='ok',selected='p-'+profile.id.slice(0,8)+'-grp',cloud='active',service='running',update='current';const point={id:'cloud-test',managed:true,enabled:true};
 const snapshot=()=>observeTelegramRuntime(notifier,{store,supervisor:{status:()=>({state:service}),httpHealth:{get:()=>({httpStatus:metric})},controller:async()=>({proxies:{['cg-'+group.id]:{now:selected}}})},accessPoints:{repository:{all:()=>[point]},runtime:{status:async()=>cloud,entries:new Map()}},modulesHelper:async()=>({modules:[{id:'system',state:update}]})});
 await snapshot();metric='error';selected='p-'+other.id.slice(0,8)+'-grp';cloud='error';service='failed';update='installing';await snapshot();advance(15001);await snapshot();service='running';await snapshot();advance(15001);await snapshot();update='updated';await snapshot();
 for(const category of ['gateways','cloud','services','updates'])assert.ok(notifier.state.queue.some(e=>e.category===category),category);
 assert.ok(notifier.state.queue.some(e=>e.component.startsWith('Gateway group')&&e.kind==='failed'));assert.ok(notifier.state.queue.some(e=>e.kind==='switched'));assert.ok(notifier.state.queue.some(e=>e.kind==='updated'));
 notifier.state.queue=[];update='checking';await snapshot();update='error';await snapshot();assert.equal(notifier.state.queue.length,0,'failed update check is not failed installation');
}));
test('Telegram journal does not replay history, sends backup failures and confirms Wi-Fi recovery',()=>fixture(async({notifier,store,advance,calls})=>{
 notifier.configure(config);store.recordEvent('admin','POST /api/configuration/backups',500,'SECRET LOG');store.recordEvent('system','SYSTEM wifi-failed',503,'PRIVATE');store.db.prepare('UPDATE events SET timestamp=?').run(new Date(notifier.now()).toISOString());await notifier.tick();advance(15001);await notifier.tick();advance(10001);await notifier.tick();assert.ok(calls.some(c=>JSON.parse(c.body).text.includes('backup failed')));assert.ok(calls.some(c=>JSON.parse(c.body).text.includes('unavailable')));assert.equal(JSON.stringify(calls).includes('SECRET LOG'),false);
 store.recordEvent('system','SYSTEM wifi-started',200);store.db.prepare('UPDATE events SET timestamp=? WHERE action=?').run(new Date(notifier.now()).toISOString(),'SYSTEM wifi-started');await notifier.tick();advance(15001);await notifier.tick();assert.ok(calls.some(c=>JSON.parse(c.body).text.includes('working again')));
}));
test('Telegram discovery uses unsaved token without storing it, deduplicates chats and removes message payloads',()=>fixture(async({notifier,advance})=>{
 let payload,url;notifier.fetch=async(u,o)=>{url=u;payload=JSON.parse(o.body);return new Response(JSON.stringify({ok:true,result:[{message:{text:'PRIVATE MESSAGE',chat:{id:123,type:'private',first_name:'Anton'}}},{message:{chat:{id:123,type:'private',first_name:'Anton'}}},{message:{chat:{id:-100456,type:'supergroup',title:'Home'}}},{message:{chat:{id:1.5,type:'private',first_name:'Invalid'}}},{my_chat_member:{chat:{id:-77,type:'group',title:'Removed'},new_chat_member:{status:'left'}}}]}));};
 const result=await notifier.chats({token});assert.deepEqual(result,{chats:[{id:'123',type:'private',name:'Anton'},{id:'-100456',type:'supergroup',name:'Home'}]});assert.equal(JSON.stringify(result).includes('PRIVATE'),false);assert.deepEqual(payload,{limit:100,timeout:0});assert.ok(url.endsWith('/getUpdates'));assert.equal(notifier.status().hasToken,false);assert.equal(notifier.status().chatId,'');assert.equal(notifier.status().enabled,false);
 await assert.rejects(notifier.chats({token}),/Wait before/);advance(5001);notifier.configure(config);await notifier.chats();assert.ok(url.includes(token));
}));
test('Telegram discovery handles empty updates, webhook conflict, malformed responses and cancellation without raw errors',()=>fixture(async({notifier,advance})=>{
 notifier.configure(config);notifier.fetch=async()=>new Response('{"ok":true,"result":[]}');assert.deepEqual(await notifier.chats(),{chats:[]});advance(5001);
 notifier.fetch=async()=>new Response('{"ok":false,"error_code":409,"description":"SECRET webhook URL"}',{status:409});await assert.rejects(notifier.chats(),e=>e.status===409 && /webhook/.test(e.message) && !e.message.includes('SECRET'));advance(5001);
 notifier.fetch=async()=>new Response('{"ok":true,"result":{}}');await assert.rejects(notifier.chats(),/Could not detect/);advance(5001);
 let release,signal;notifier.fetch=async(u,o)=>{signal=o.signal;await new Promise(r=>release=r);return new Response('{"ok":true,"result":[]}');};const pending=notifier.chats();await new Promise(r=>setImmediate(r));notifier.configure({enabled:false});assert.equal(signal.aborted,true);release();await assert.rejects(pending,/Could not detect/);
}));
