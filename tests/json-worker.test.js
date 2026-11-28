import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter,getEventListeners} from 'node:events';
import {PassThrough} from 'node:stream';
import {runJsonWorker,gatewayCurlConfig} from '../server/json-worker.js';
function fixture(){const child=new EventEmitter();for(const name of ['stdin','stdout','stderr'])child[name]=new PassThrough();child.signals=[];child.kill=signal=>{child.signals.push(signal);child.emit('close',null);};return child;}

test('JSON worker keeps input private and preserves nonzero process status',async()=>{
 const child=fixture(),config=gatewayCurlConfig({port:12345,secret:'secret\nvalue'},'https://example.com/');let input='',args;
 child.stdin.on('data',chunk=>{input+=chunk;});const task=runJsonWorker('curl',['--config','-'],{input:config,timeoutMs:100,spawnProcess:(_command,passed)=>{args=passed;return child;}});
 child.stdout.write('{"http_code":');child.stdout.write('403}');child.stderr.write('private token and system error');child.emit('close',22);
 assert.deepEqual(await task,{value:{http_code:403},exitCode:22});assert.equal(input,config);assert.ok(!args.join(' ').includes('secret'));assert.ok(config.includes('secret\\nvalue'));assert.ok(gatewayCurlConfig({port:1,type:'socks5'},'https://example.com/').includes('socks5h://'));assert.ok(!gatewayCurlConfig({port:1},'https://example.com/').includes('proxy-user'));
});
test('JSON worker cancels without spawn and handles abort racing with startup',async()=>{
 let spawns=0;await assert.rejects(runJsonWorker('fixture',[],{signal:AbortSignal.abort(),spawnProcess:()=>spawns++}),{code:'ABORTED'});assert.equal(spawns,0);
 const controller=new AbortController(),child=fixture();const task=runJsonWorker('fixture',[],{signal:controller.signal,timeoutMs:100,spawnProcess:()=>{controller.abort();return child;}});await assert.rejects(task,{code:'ABORTED'});assert.deepEqual(child.signals,['SIGKILL']);assert.equal(getEventListeners(controller.signal,'abort').length,0);
});
test('JSON worker rejects oversized, malformed and non-object replies without exposing output',async()=>{
 for(const value of ['secret error','null','[]','42','{"secret":"'+ 'x'.repeat(100)+'"}']){
  const child=fixture(),controller=new AbortController();const task=runJsonWorker('fixture',[],{signal:controller.signal,timeoutMs:100,maxBytes:64,spawnProcess:()=>child});child.stdout.write(value);child.emit('close',0);await assert.rejects(task,error=>error.code==='INVALID_RESPONSE' && !error.message.includes('secret'));assert.equal(getEventListeners(controller.signal,'abort').length,0);
 }
});
test('JSON worker streams body without retaining it and reads metadata from stderr',async()=>{
 const child=fixture();let bytes=0;const task=runJsonWorker('fixture',[],{timeoutMs:100,jsonStream:'stderr',onBody:chunk=>{bytes+=chunk.length;},spawnProcess:()=>child});
 for(let n=0;n<30;n++)child.stdout.write(Buffer.alloc(65536));child.stderr.write('{"size_download":1966080}');child.emit('close',0);
 const result=await task;assert.equal(bytes,1966080);assert.deepEqual(result.value,{size_download:bytes});
});
test('JSON worker timeout, spawn failures and cancellation settle once and release timers',async()=>{
 const child=fixture(),controller=new AbortController();const task=runJsonWorker('fixture',[],{signal:controller.signal,timeoutMs:10,spawnProcess:()=>child});await assert.rejects(task,{code:'TIMEOUT'});assert.deepEqual(child.signals,['SIGKILL']);assert.equal(getEventListeners(controller.signal,'abort').length,0);controller.abort();assert.equal(child.signals.length,1);
 await assert.rejects(runJsonWorker('fixture',[],{spawnProcess:()=>{throw Error('private path');}}),error=>error.code==='UNAVAILABLE' && !error.message.includes('private'));
 const failed=fixture();const other=runJsonWorker('fixture',[],{timeoutMs:10,spawnProcess:()=>failed});failed.emit('error',Error('private path'));await assert.rejects(other,{code:'UNAVAILABLE'});await new Promise(r=>setTimeout(r,25));assert.deepEqual(failed.signals,[]);
});
