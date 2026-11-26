import test from 'node:test';
import assert from 'node:assert/strict';
import {auditAction,eventLabels,eventResult,moduleAuditDetail,presentEvent} from '../shared/event-log.js';
import {Store} from '../server/store.js';
import {createServer} from '../server/index.js';

test('audit actions whitelist templates and never retain unknown paths, IDs or query strings',()=>{
 const id='12345678-1234-1234-1234-123456789abc';
 assert.equal(auditAction('POST',`/api/routes/groups/${id}/move?key=secret`),'POST /api/routes/groups/:id/move');
 assert.equal(auditAction('POST','/api/profiles/import?key=secret'),'POST /api/profiles/import');
 assert.equal(auditAction('POST','/api/private/secret'),'POST /api/unknown');
 assert.equal(auditAction('POST','/api/system/action','reboot'),'POST /api/system/action:reboot');
 assert.equal(auditAction('POST','/api/system/action','secret'),'POST /api/system/action');
 for(const action of Object.keys(eventLabels))assert.ok(eventLabels[action].length>5);
 assert.equal(eventResult(299),'Disconnected');assert.equal(eventResult(202),'Принято в работу');assert.equal(eventResult(200),'Выполнено');assert.equal(eventResult(403),'Нет доступа');assert.equal(eventResult(502),'Ошибка службы');
});

test('API logs readable action identities and usernames without storing request secrets',async()=>{
 const store=new Store(':memory:'),server=createServer(store);
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const url='http://127.0.0.1:'+server.address().port+'/api/';
 try {
  const login=await fetch(url+'auth/setup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'admin',password:'fixture password 12345'})});
  const session=await login.json(),headers={'Content-Type':'application/json',Cookie:login.headers.get('set-cookie').split(';')[0],'X-CSRF-Token':session.csrf};
  await fetch(url+'profiles/import',{method:'POST',headers,body:JSON.stringify({value:'socks5://secret:secret@192.0.2.1:1080#fixture'})});
  await fetch(url+'routes/groups',{method:'POST',headers,body:JSON.stringify({name:'fixture rule',entries:['example.com'],routeId:store.profiles().find(p=>p.engine==='direct').id})});
  await fetch(url+'profiles/import',{method:'POST',headers,body:JSON.stringify({value:'invalid secret config'})});
  const logs=await(await fetch(url+'logs',{headers})).json();
  assert.ok(logs.some(event=>event.action==='POST /api/routes/groups' && event.actor==='admin'));
  assert.ok(logs.some(event=>event.action==='POST /api/profiles/import' && event.status===400));
  assert.equal(logs.find(event=>event.action==='POST /api/auth/setup').actor,'admin');
  assert.ok(!JSON.stringify(logs).includes('secret'));assert.ok(!JSON.stringify(logs).includes('fixture password'));
  const count=logs.length;await fetch(url+'logs',{headers});assert.equal(store.events().length,count,'polling is not audited');
  store.recordEvent(session.user.id,'PUT /api/dns',200);assert.equal(store.events()[0].actor,'admin','legacy user IDs resolve to usernames');
  store.recordEvent('f'.repeat(32),'PUT /api/dns',200);assert.equal(store.events()[0].actorDeleted,1,'deleted legacy user is identified');
  const hexName='a'.repeat(32);store.db.prepare('UPDATE users SET username=? WHERE id=?').run(hexName,session.user.id);store.recordEvent(hexName,'PUT /api/dns',200);assert.equal(store.events()[0].actorDeleted,0,'a valid hex username is not mistaken for a deleted user');
  for(let index=0;index<1001;index++)store.recordEvent('admin','PUT /api/dns',200);
  assert.equal(store.events().length,100);assert.equal(store.db.prepare('SELECT count(*) AS n FROM events').get().n,1000);
 } finally {await new Promise(resolve=>server.close(resolve));store.close();}
});

test('module and recovery events name the module/service without retaining request secrets',()=>{
 const detail=moduleAuditDetail({id:'adguard',op:'update',version:'v1.0.0',url:'secret',password:'secret'});assert.ok(!detail.includes('secret'));const event=presentEvent({action:'POST /api/modules',detail});assert.equal(event.parameters.module,'AdGuard Home');assert.equal(event.parameters.version,'v1.0.0');assert.ok(event.key.startsWith('Starting update'));
 assert.equal(moduleAuditDetail({id:'secret',op:'update'}),'');assert.ok(!moduleAuditDetail({id:'adguard',op:'update',version:'secret token'}).includes('secret'));
 assert.equal(presentEvent({action:'SYSTEM restore-failed'}).parameters.service,'freedomgate.service');assert.equal(presentEvent({action:'SYSTEM restore-failed',detail:JSON.stringify({service:'freedomgate.service',stage:'adguard'})}).parameters.component,'AdGuard Home');
});
