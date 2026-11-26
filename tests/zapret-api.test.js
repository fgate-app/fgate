import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../server/store.js';
import {createServer} from '../server/index.js';

test('autotune probes the draft, reapplies the winner, and save reports helper rejection',async()=>{
 const store=new Store(':memory:');let draft,applied,fail=false;
 const server=createServer(store,{
  zapretProbe:async(strategy,target,settings)=>{draft=settings;return {ok:strategy.id==='autottl'};},
  zapretApply:async input=>{applied=input;return fail?{ok:false,error:'fixture rejected'}:{ok:true};},
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const url='http://127.0.0.1:'+server.address().port+'/api/';
 try{
  const setup=await fetch(url+'auth/setup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'admin',password:'fixture password 12345'})});
  const session=await setup.json();
  const headers={'Content-Type':'application/json',Cookie:setup.headers.get('set-cookie').split(';')[0],'X-CSRF-Token':session.csrf};
  const response=await fetch(url+'zapret/autotune',{method:'POST',headers,body:JSON.stringify({target:'youtube.com',https:true,http:false,quic:false,tcpPorts:'443,8443'})});
  assert.equal(response.status,200);
  assert.equal(draft.tcpPorts,'443,8443');
  assert.equal(draft.http,false);
  assert.equal(applied.strategy,'autottl');
  assert.equal(store.zapretSettings().strategy,'autottl');
  fail=true;
  const saved=await fetch(url+'zapret',{method:'PUT',headers,body:JSON.stringify({strategy:'nfqws2'})});
  assert.equal(saved.status,502);
  assert.equal((await saved.json()).error,'fixture rejected');
 }finally{await new Promise(resolve=>server.close(resolve));store.close();}
});
