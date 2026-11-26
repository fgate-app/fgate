import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/store.js';
import { createServer } from '../server/index.js';
test('authentication, CSRF, roles, revocation and last administrator',async()=>{
 const store=new Store(':memory:'), server=createServer(store);await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
 const request=async(path,method='GET',body,session,csrf=true)=>{const res=await fetch(base+'/api/'+path,{method,headers:{'Content-Type':'application/json',...(session?{Cookie:session.cookie,...(csrf?{'X-CSRF-Token':session.csrf}:{})}:{})},body:body===undefined?undefined:JSON.stringify(body)});const data=await res.json();return {status:res.status,data,cookie:res.headers.get('set-cookie')?.split(';')[0]};};
 const login=async username=>{const r=await request('auth/login','POST',{username,password:'test password 12345'});assert.equal(r.status,200);return {cookie:r.cookie,csrf:r.data.csrf};};
 try{
 assert.equal((await request('logs')).status,401);assert.equal((await request('profiles')).status,401);assert.equal((await request('system')).status,401);
 const setup=await request('auth/setup','POST',{username:'admin',password:'test password 12345'});assert.equal(setup.status,200);const admin={cookie:setup.cookie,csrf:setup.data.csrf};
 assert.match(setup.cookie,/fg_session=/);assert.equal((await request('auth/setup','POST',{username:'second',password:'test password 12345'})).status,409);
 assert.equal((await request('profiles','POST',{name:'a',protocol:'ss'},admin,false)).status,403);
 const viewer=await request('users','POST',{username:'viewer',password:'test password 12345',role:'viewer'},admin);assert.equal(viewer.status,201);
 const operator=await request('users','POST',{username:'operator',password:'test password 12345',role:'operator'},admin);assert.equal(operator.status,201);
 assert.equal(JSON.stringify((await request('users','GET',undefined,admin)).data).includes('password'),false);
 const v=await login('viewer'),o=await login('operator');assert.equal((await request('logs','GET',undefined,v)).status,403);assert.equal((await request('support/ssh','GET',undefined,o)).status,403);const events=await request('logs','GET',undefined,admin);assert.equal(events.status,200);assert.ok(events.data.length>0);assert.equal(JSON.stringify(events.data).includes('test password'),false);const system=await request('system','GET',undefined,v);assert.equal(system.status,200);assert.deepEqual((await request('clients','GET',undefined,v)).data.clients, []);assert.ok(system.data.memory.total>0);assert.ok(system.data.cpu.cores>0);
 assert.equal((await request('status','GET',undefined,v)).status,200);const viewerUsers=await request('users','GET',undefined,v);assert.equal(viewerUsers.status,200);assert.equal(viewerUsers.data.length,1);assert.equal(viewerUsers.data[0].username,'viewer');
 assert.equal((await request('system/action','POST',{action:'nope'},admin)).status,400);
 assert.equal((await request('system/action','POST',{action:'config'},v)).status,403);
 assert.equal((await request('system/action','POST',{action:'config'},o)).status,403);
 assert.equal((await request('profiles','POST',{name:'no',protocol:'ss'},v)).status,403);const adminPassword=await request('users/'+viewer.data.id+'/password','PUT',{password:'new viewer password 12345'},admin);assert.equal(adminPassword.status,200);
 assert.equal((await request('profiles','POST',{name:'yes',protocol:'ss'},o)).status,201);
 assert.equal((await request('settings','PUT',{topology:'router-uplink'},o)).status,403);
 assert.equal((await request('users/'+operator.data.id,'PUT',{role:'admin'},o)).status,403);
 assert.equal((await request('users/'+setup.data.user.id,'PUT',{disabled:true},admin)).status,409);
 assert.equal((await request('users/'+viewer.data.id,'PUT',{disabled:true},admin)).status,200);
 assert.equal((await request('status','GET',undefined,v)).status,401);
 assert.equal((await request('auth/login','POST',{username:'viewer',password:'test password 12345'})).status,401);
 assert.equal((await request('auth/password','PUT',{currentPassword:'test password 12345',password:'changed password 12345'},o)).status,200);
 assert.equal((await request('status','GET',undefined,o)).status,401);
 assert.equal((await request('auth/logout','POST',{},admin)).status,200);assert.equal((await request('status','GET',undefined,admin)).status,401);
 }finally{await new Promise(r=>server.close(r));store.close();}
});
