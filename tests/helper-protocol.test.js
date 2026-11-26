import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer,connect} from 'node:net';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {serveHelperConnection} from '../server/helper-protocol.js';
import {sendCommand} from '../server/network-helper.js';

async function fixture(t,handle){
  const dir=await mkdtemp(join(tmpdir(),'fg-helper-')),path=join(dir,'socket');
  const server=createServer({allowHalfOpen:true},socket=>serveHelperConnection(socket,handle));
  await new Promise((resolve,reject)=>server.listen(path,resolve).once('error',reject));
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});});
  return path;
}

test('diagnostic abort kills a real helper child',async t=>{
  let child,notifyStarted,notifyExited;
  const started=new Promise(resolve=>notifyStarted=resolve),exited=new Promise(resolve=>notifyExited=resolve);
  const path=await fixture(t,(_request,{signal})=>new Promise((resolve,reject)=>{
    child=execFile(process.execPath,['-e','setInterval(()=>{},1000)'],{signal,killSignal:'SIGKILL'},error=>error?reject(error):resolve({ok:true}));
    child.once('spawn',notifyStarted);child.once('exit',(code,signal)=>notifyExited({code,signal}));
  }));
  const controller=new AbortController();
  const request=sendCommand({action:'diagnostic-uplink'},{socketPath:path,signal:controller.signal});
  const rejected=assert.rejects(request,{name:'AbortError'});
  await started;controller.abort();await rejected;
  const result=await Promise.race([exited,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('Child did not exit.')),2000);timer.unref();})]);
  assert.ok(['SIGTERM','SIGKILL'].includes(result.signal));
  assert.throws(()=>process.kill(child.pid,0),{code:'ESRCH'});
});

test('helper timeout cancels the running diagnostic',async t=>{
  let notify;const cancelled=new Promise(resolve=>notify=resolve);
  const path=await fixture(t,(_request,{signal})=>new Promise(resolve=>signal.addEventListener('abort',()=>{notify();resolve({ok:false});},{once:true})));
  await assert.rejects(sendCommand({action:'diagnostic-endpoint'},{socketPath:path,timeout:50}),/timed out/);
  await cancelled;
});

test('legacy commands keep EOF framing and are not cancelled',async t=>{
  const path=await fixture(t,async(request,{signal})=>{assert.equal(signal,undefined);return {ok:true,action:request.action};});
  assert.deepEqual(await sendCommand({action:'status'},{socketPath:path}),{ok:true,action:'status'});
});

test('newline framing cannot invoke a mutating operation',async t=>{
  let called=false;
  const path=await fixture(t,()=>{called=true;});
  const response=await new Promise((resolve,reject)=>{
    const socket=connect(path);let raw='';
    socket.on('connect',()=>socket.write('{"action":"apply"}\n'));
    socket.on('data',chunk=>raw+=chunk);socket.on('end',()=>{socket.end();resolve(JSON.parse(raw));});socket.on('error',reject);
  });
  assert.equal(response.ok,false);assert.equal(called,false);
});

test('already cancelled requests never reach the helper',async()=>{
  const controller=new AbortController();controller.abort();
  await assert.rejects(sendCommand({action:'diagnostic-uplink'},{signal:controller.signal,socketPath:'/missing/socket'}),{name:'AbortError'});
});

test('helper preserves a request when a UTF-8 character is split between socket chunks',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'fg-helper-utf8-')),path=join(dir,'socket');let firstChunk;
 const received=new Promise(resolve=>firstChunk=resolve);
 const server=createServer({allowHalfOpen:true},socket=>{serveHelperConnection(socket,async request=>({ok:true,name:request.name}));socket.once('data',firstChunk);});
 await new Promise((resolve,reject)=>server.listen(path,resolve).once('error',reject));
 t.after(async()=>{await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});});
 const name='Сеть 中文',bytes=Buffer.from(JSON.stringify({action:'status',name})),cut=bytes.indexOf(Buffer.from('С'))+1;
 const response=await new Promise((resolve,reject)=>{
  const socket=connect(path),parts=[];socket.on('error',reject);socket.on('data',chunk=>parts.push(chunk));socket.on('end',()=>{socket.end();resolve(JSON.parse(Buffer.concat(parts).toString('utf8')));});
  socket.on('connect',async()=>{socket.write(bytes.subarray(0,cut));await received;socket.end(bytes.subarray(cut));});
 });
 assert.equal(response.name,name);
});

test('helper client preserves UTF-8 characters split across response chunks',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'fg-helper-client-utf8-')),path=join(dir,'socket'),name='Сеть 中文';
 const bytes=Buffer.from(JSON.stringify({ok:true,name})),cut=bytes.indexOf(Buffer.from('С'))+1;
 const server=createServer({allowHalfOpen:true},socket=>{socket.resume();socket.on('end',()=>{socket.write(bytes.subarray(0,cut));setTimeout(()=>socket.end(bytes.subarray(cut)),20);});});
 await new Promise((resolve,reject)=>server.listen(path,resolve).once('error',reject));
 t.after(async()=>{await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});});
 assert.equal((await sendCommand({action:'status'},{socketPath:path})).name,name);
});
