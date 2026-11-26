import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import {spawn,execFileSync} from 'node:child_process';
import {allocateDiagnosticTcpPort} from '../server/diagnostic-port.js';

test('plain client allocation survives sequential connections and TIME_WAIT; actual tuple matches',async()=>{
  const server=net.createServer(socket=>socket.on('end',()=>socket.end()));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    for(let i=0;i<20;i++){
      const port=await allocateDiagnosticTcpPort();
      await new Promise((resolve,reject)=>{
        const socket=net.connect({host:'127.0.0.1',port:server.address().port,localAddress:'127.0.0.1',localPort:port});
        socket.on('error',reject);
        socket.once('connect',()=>{assert.equal(socket.localPort,port);assert.equal(socket.localAddress,'127.0.0.1');socket.end();});
        socket.once('close',resolve);
      });
      // The active closer's plain bind must fail while its old tuple is held.
      const result=execFileSync('python3',['-I','-c',`import socket\ns=socket.socket()\ntry:\n s.bind(('127.0.0.1',${port}))\n print('free')\nexcept OSError:\n print('held')`],{encoding:'utf8'});
      assert.equal(result.trim(),'held');
    }
  }finally{await new Promise(resolve=>server.close(resolve));}
});

test('allocator cancellation and deadline reap the worker; invalid output never becomes a port',async()=>{
  let child;
  const hanging=()=>child=spawn('python3',['-I','-c','import time; time.sleep(10)'],{stdio:['ignore','pipe','ignore']});
  const controller=new AbortController();
  const pending=allocateDiagnosticTcpPort({signal:controller.signal,spawnProcess:hanging});
  controller.abort();
  await assert.rejects(pending,{code:'ABORTED'});
  assert.equal(child.signalCode,'SIGKILL');
  await assert.rejects(allocateDiagnosticTcpPort({spawnProcess:hanging,timeoutMs:25}),/timed out/);
  assert.equal(child.signalCode,'SIGKILL');
  for(const output of ['0','65536','45000 extra','45000\n45001','x'.repeat(100)]){
    await assert.rejects(allocateDiagnosticTcpPort({spawnProcess:()=>spawn('python3',['-I','-c',`print(${JSON.stringify(output)})`],{stdio:['ignore','pipe','ignore']})}),/Invalid/);
  }
  await assert.rejects(allocateDiagnosticTcpPort({signal:controller.signal,spawnProcess:()=>assert.fail('must not spawn')}),{code:'ABORTED'});
});
