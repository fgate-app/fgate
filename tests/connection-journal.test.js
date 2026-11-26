import test from 'node:test';
import assert from 'node:assert/strict';
import {createConnectionJournal} from '../server/connection-journal.js';
const connection=(id,sourceIP='10.20.0.2')=>({id,metadata:{sourceIP,host:'example.com',network:'tcp',destinationPort:'443'},chains:['DIRECT'],rule:'DomainSuffix',rulePayload:'example.com',download:20,upload:10});
test('journal retains closed flows, preserves them on outages, bounds and expires history',async()=>{
 let time=1000,connections=[connection('one'),connection('two')],fail=false;
 const journal=createConnectionJournal(async()=>{if(fail)throw Error('offline');return {connections};},{now:()=>time,retention:100,maxClosed:1});
 assert.equal((await journal.poll()).connections.length,2);
 fail=true;assert.equal((await journal.poll()).available,false);assert.ok(journal.snapshot().connections.every(c=>c.active));fail=false;
 time+=10;connections=[connection('two')];let result=await journal.poll();assert.equal(result.connections.find(c=>c.id==='one').active,false);
 time+=10;connections=[];result=await journal.poll();assert.equal(result.connections.length,1);assert.equal(result.connections[0].id,'two');
 time+=101;assert.equal((await journal.poll()).connections.length,0);
});
test('disconnect targets only the selected active flow and preserves failed requests',async()=>{
 const calls=[];let fail=true;
 const journal=createConnectionJournal(async(path,options)=>{calls.push([path,options]);if(options?.method==='DELETE'){if(fail)throw Error('offline');return null;}return {connections:[connection('one/a'),connection('two')]};});
 await journal.poll();await assert.rejects(journal.close('one/a'));assert.equal(journal.snapshot().connections[0].active,true);
 fail=false;assert.equal(await journal.close('one/a'),true);assert.deepEqual(calls.at(-1),['/connections/one%2Fa',{method:'DELETE'}]);assert.equal(await journal.close('one/a'),false);assert.equal(journal.snapshot().connections.find(c=>c.id==='two').active,true);
});

test('journal API requires authentication and CSRF; viewers read but cannot disconnect',async()=>{
 const {Store}=await import('../server/store.js'),{createServer}=await import('../server/index.js');
 const store=new Store(':memory:');let closed=[],active=[connection('one'),connection('two','10.20.0.3')];
 const server=createServer(store,{supervisor:{status:()=>({state:'running'}),controller:async(path,options)=>{if(options?.method==='DELETE'){closed.push(path);active=active.filter(c=>path!=='/connections/'+c.id);return null;}return {connections:active};}}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
 async function req(path,method='GET',body,session){const r=await fetch(base+'/api/'+path,{method,headers:{'Content-Type':'application/json',...(session?{Cookie:session.cookie,'X-CSRF-Token':session.csrf}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,data:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]};}
 try{
  assert.equal((await req('connection-journal')).status,401);
  const login=await req('auth/setup','POST',{username:'admin',password:'fixture password 12345'}),admin={cookie:login.cookie,csrf:login.data.csrf};
  assert.equal((await req('connection-journal?client=10.20.0.2','GET',null,admin)).data.connections.length,1);
  assert.equal((await req('connection-journal/one','DELETE',null,{...admin,csrf:'bad'})).status,403);
  await req('users','POST',{username:'viewer',password:'fixture password 12345',role:'viewer'},admin);
  const v=await req('auth/login','POST',{username:'viewer',password:'fixture password 12345'}),viewer={cookie:v.cookie,csrf:v.data.csrf};
  assert.equal((await req('connection-journal','GET',null,viewer)).status,200);
  assert.equal((await req('connection-journal/one','DELETE',null,viewer)).status,403);assert.deepEqual(closed,[]);
  assert.equal((await req('connection-journal/one','DELETE',null,admin)).status,200);assert.deepEqual(closed,['/connections/one']);
  assert.equal((await req('connection-journal/missing','DELETE',null,admin)).status,404);
 }finally{await new Promise(r=>server.close(r));store.close();}
});

test('details preserve inbound/process metadata and compute sampled transfer rates',async()=>{
 let time=1000,upload=2000,download=6200;
 const journal=createConnectionJournal(async()=>({connections:[{...connection('details'),upload,download,metadata:{sourceIP:'198.18.0.1',sourcePort:37996,host:'api.telegram.org',destinationPort:443,destinationIP:'149.154.166.110',network:'tcp',type:'Tun',sniffHost:'api.telegram.org',dnsMode:'normal',inboundName:'DEFAULT-TUN',inboundIP:'198.18.0.1',inboundPort:39735,inboundUser:'',process:'browser',processPath:'/bin/browser',uid:0}}]}),{now:()=>time});
 let row=(await journal.poll()).connections[0];assert.equal(row.uploadSpeed,0);assert.equal(row.uid,0);assert.equal(row.inboundName,'DEFAULT-TUN');assert.equal(row.sniffHost,'api.telegram.org');assert.equal(row.processPath,'/bin/browser');
 time+=2000;upload+=1000;download+=4000;row=(await journal.poll()).connections[0];assert.equal(row.uploadSpeed,500);assert.equal(row.downloadSpeed,2000);
 await journal.close('details');row=journal.snapshot().connections[0];assert.equal(row.downloadSpeed,0);assert.equal(row.uploadSpeed,0);assert.equal(row.dnsMode,'normal');
});

test('REJECT flows do not appear as active or recently closed connections',async()=>{
 const journal=createConnectionJournal(async()=>({connections:[{...connection('blocked'),chains:['REJECT']},connection('allowed')]}));
 assert.deepEqual((await journal.poll()).connections.map(row=>row.id),['allowed']);
});

test('empty engine list encoded as null closes active flows without marking the engine unavailable',async()=>{
 let connections=[connection('one')];const journal=createConnectionJournal(async()=>({connections}));await journal.poll();connections=null;const result=await journal.poll();assert.equal(result.available,true);assert.equal(result.connections[0].active,false);
});
