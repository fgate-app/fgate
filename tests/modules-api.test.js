import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../server/store.js';
import {createServer} from '../server/index.js';
test('module API requires admin and CSRF, forwards only fixed operations and reports helper failures',async()=>{
 const stateDir=await mkdtemp(join(tmpdir(),'fg-modules-api-'));const previousState=process.env.FREEDOMGATE_STATE_DIR;process.env.FREEDOMGATE_STATE_DIR=stateDir;const store=new Store(':memory:');let calls=[],fail=false,engineState='running';
 const server=createServer(store,{supervisor:{status:()=>({state:engineState})},modulesHelper:async(op,id,version)=>{calls.push({op,id,version});return fail?{ok:false,status:409,error:"Wait for the current update to finish."}:op==='status'?{ok:true,modules:[{id:'mihomo',state:'available',current:'v1.0.0'},{id:'frp',state:'current',current:'v1.0.0'}]}:{ok:true,accepted:true};}});
 server.accessPoints.moduleState=async()=> 'connecting';
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}/api/`;
 try{
  assert.equal((await fetch(base+'modules')).status,401);
  engineState='error';assert.equal((await(await fetch(base+'health')).json()).ready,false);engineState='running';assert.equal((await(await fetch(base+'health')).json()).ready,true);server.runtimeReady=false;assert.equal((await(await fetch(base+'health')).json()).ready,false);server.runtimeReady=true;
  const setup=await fetch(base+'auth/setup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'admin',password:'test password 12345'})});const auth=await setup.json();
  const headers={'Content-Type':'application/json',Cookie:setup.headers.get('set-cookie').split(';')[0],'X-CSRF-Token':auth.csrf};
  assert.equal((await fetch(base+'modules',{method:'POST',headers:{Cookie:headers.Cookie,'Content-Type':'application/json'},body:'{"op":"check"}'})).status,403);
  const rows=await(await fetch(base+'modules',{headers})).json();assert.equal(rows.modules.length,4);assert.equal(rows.modules[1].runtimeState,'connecting');assert.equal(rows.modules[2].id,'domain-lists');
  assert.equal((await fetch(base+'modules',{method:'POST',headers,body:'{"op":"shell"}'})).status,400);
  assert.equal((await fetch(base+'modules',{method:'POST',headers,body:JSON.stringify({op:'update',id:'mihomo',version:'v2.0.0',url:'https://evil.example'})})).status,202);
  assert.deepEqual(calls.at(-1),{op:'update',id:'mihomo',version:'v2.0.0'});
  assert.equal((await fetch(base+'modules',{method:'POST',headers,body:JSON.stringify({op:'check',id:'system'})})).status,202);assert.equal(calls.at(-1).id,'system');
  const staleCatalog=await fetch(base+'modules',{method:'POST',headers,body:JSON.stringify({op:'update',id:'domain-lists',version:'main'})});assert.equal(staleCatalog.status,409);assert.match((await staleCatalog.json()).error,/updates first/);
  const checkAll=await fetch(base+'modules',{method:'POST',headers,body:'{"op":"check"}'});assert.equal(checkAll.status,202,await checkAll.text());
  assert.deepEqual(calls.at(-1),{op:'check',id:undefined,version:undefined});
  fail=true;assert.equal((await fetch(base+'modules',{method:'POST',headers,body:'{"op":"check"}'})).status,409);
  for(const id of ['outline','tor','lantern'])for(const op of ['check','update']){
   const before=calls.length;const response=await fetch(base+'modules',{method:'POST',headers,body:JSON.stringify({id,op,version:'99'})});assert.equal(response.status,400);assert.equal(calls.length,before);
  }
  await fetch(base+'users',{method:'POST',headers,body:JSON.stringify({username:'operator',password:'operator password 12345',role:'operator'})});
  const login=await fetch(base+'auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'operator',password:'operator password 12345'})});const operator=await login.json();const operatorHeaders={'Content-Type':'application/json',Cookie:login.headers.get('set-cookie').split(';')[0],'X-CSRF-Token':operator.csrf};
  assert.equal((await fetch(base+'modules',{method:'POST',headers:operatorHeaders,body:'{"op":"check"}'})).status,403);
 }finally{await new Promise(r=>server.close(r));store.close();if(previousState===undefined)delete process.env.FREEDOMGATE_STATE_DIR;else process.env.FREEDOMGATE_STATE_DIR=previousState;await rm(stateDir,{recursive:true,force:true});}
});
