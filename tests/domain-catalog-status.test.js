import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {Store} from '../server/store.js';import {createServer} from '../server/index.js';import {domainListRef,domainListsStatus,updateDomainLists} from '../server/domain-lists.js';
test('downloaded catalog stays loaded with empty services and unavailable legacy placeholders',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'fg-catalog-loaded-')),old=process.env.FREEDOMGATE_STATE_DIR;process.env.FREEDOMGATE_STATE_DIR=dir;
 try{assert.equal(domainListsStatus().loaded,false);await updateDomainLists({sources:{empty:'# no entries',vk:'vk.com\nads.vk.com @ads'}});const status=domainListsStatus();assert.equal(status.loaded,true);assert.ok(status.presets.some(p=>!p.available));assert.ok(status.updatedAt);}
 finally{if(old===undefined)delete process.env.FREEDOMGATE_STATE_DIR;else process.env.FREEDOMGATE_STATE_DIR=old;rmSync(dir,{recursive:true,force:true});}
});
test('module API offers initial download even when HEAD equals the pinned revision, then reports loaded current version',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'fg-catalog-first-')),old=process.env.FREEDOMGATE_STATE_DIR;process.env.FREEDOMGATE_STATE_DIR=dir;const store=new Store(':memory:'),realFetch=globalThis.fetch,pin=domainListRef();globalThis.fetch=async()=>({ok:true,json:async()=>({sha:pin})});
 const server=createServer(store,{resourceFetch:async()=>({ok:true,json:async()=>({sha:pin})}),modulesHelper:async()=>({ok:true,modules:[]}),domainListUpdate:options=>updateDomainLists({...options,sources:{empty:'# empty',vk:'vk.com\nads.vk.com @ads'}})});globalThis.fetch=realFetch;await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{const base='http://127.0.0.1:'+server.address().port,setup=await realFetch(base+'/api/auth/setup',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'admin',password:'Fixture password 12345'})}),cookie=setup.headers.get('set-cookie').split(';')[0],auth=await setup.json();
 const request=async body=>{const response=await realFetch(base+'/api/modules',{method:body?'POST':'GET',headers:{'content-type':'application/json',cookie,'x-csrf-token':auth.csrf},...(body?{body:JSON.stringify(body)}:{})});assert.ok(response.ok);return response.json();};
 const row=async()=>(await request()).modules.find(module=>module.id==='domain-lists');let before=await row();assert.equal(before.loaded,false);assert.equal(before.current,'—');
 const wait=async state=>{let result;for(let i=0;i<50;i++){result=await row();if(result.state===state)return result;await new Promise(r=>setTimeout(r,5));}assert.fail(JSON.stringify(result));};
 await request({id:'domain-lists',op:'check'});assert.equal((await wait('available')).candidate.version,pin);await request({id:'domain-lists',op:'update',version:pin});const updated=await wait('updated');assert.equal(updated.loaded,true);assert.equal(updated.current,pin.slice(0,7));await request({id:'domain-lists',op:'check'});assert.equal((await wait('current')).loaded,true);
 }finally{globalThis.fetch=realFetch;await new Promise(r=>server.close(r));await server.cleanup;store.close();if(old===undefined)delete process.env.FREEDOMGATE_STATE_DIR;else process.env.FREEDOMGATE_STATE_DIR=old;rmSync(dir,{recursive:true,force:true});}
});
