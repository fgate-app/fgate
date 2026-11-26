import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../server/store.js';
import {createServer} from '../server/index.js';
test('config editor requires write permission and disables caching; list never contains secrets',async()=>{
 const store=new Store(':memory:'),server=createServer(store);
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const base=`http://127.0.0.1:${server.address().port}/api/`;
 const call=(path,method='GET',body,auth)=>fetch(base+path,{method,headers:{'Content-Type':'application/json',...(auth?{Cookie:auth.cookie,'X-CSRF-Token':auth.csrf}:{})},...(body?{body:JSON.stringify(body)}:{})});
 try{
  const setup=await call('auth/setup','POST',{username:'admin',password:'test password 12345'}),data=await setup.json();const admin={cookie:setup.headers.get('set-cookie').split(';')[0],csrf:data.csrf};
  await call('users','POST',{username:'viewer',password:'test password 12345',role:'viewer'},admin);
  const login=await call('auth/login','POST',{username:'viewer',password:'test password 12345'}),v=await login.json(),viewer={cookie:login.headers.get('set-cookie').split(';')[0],csrf:v.csrf};
  const p=store.importProfile({value:'vless://secret-uuid@example.com:443?security=none'}),path='profiles/'+p.id+'/config';
  assert.equal((await call(path)).status,401);assert.equal((await call(path,'GET',undefined,viewer)).status,403);
  const res=await call(path,'GET',undefined,admin);assert.equal(res.status,200);assert.equal(res.headers.get('cache-control'),'no-store');assert.equal((await res.json()).fields.uuid,'secret-uuid');
  assert.ok(!(await (await call('profiles','GET',undefined,viewer)).text()).includes('secret-uuid'));
 }finally{await new Promise(r=>server.close(r));store.close();}
});
