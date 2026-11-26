import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import {startDiagnosticControlRelay} from '../server/diagnostic-control-relay.js';
import {connectGatewayTcp,readGatewayBytes as read,probeGatewayTcp} from '../server/gateway-tunnel.js';

test('control relay pins the destination, preserves the observed tuple after close and never dials directly',async()=>{
 let connections=0,observedTuple;const sockets=new Set();
 const upper=net.createServer(socket=>{
  connections++;sockets.add(socket);socket.on('error',()=>{});socket.once('close',()=>sockets.delete(socket));
  void(async()=>{
   assert.deepEqual([...await read(socket,3)],[5,1,0]);socket.write(Buffer.from([5,0]));
   assert.deepEqual([...await read(socket,10)],[5,1,0,1,203,0,113,7,1,187]);
   socket.write(Buffer.from([5,0,0,1,127,0,0,1,0,0]));
   await read(socket,1);socket.end('reply');
  })().catch(()=>socket.destroy());
 });
 await new Promise(resolve=>upper.listen(0,'127.0.0.1',resolve));
 const controller=new AbortController();let relay,client;
 try{
  relay=await startDiagnosticControlRelay({upstream:{port:upper.address().port},target:{address:'203.0.113.7',port:443},signal:controller.signal,observe:async context=>{
   observedTuple=context.localPort;return {finish:async raw=>{assert.equal(raw.local_port,observedTuple);assert.equal(raw.local_ip,'127.0.0.1');return {state:'verified',evidence:'fixture'};}};
  }});
  assert.equal((await probeGatewayTcp(relay,{address:'203.0.113.8',port:443})).state,'failed');assert.equal(connections,0);
  const response=await connectGatewayTcp(relay,1,{address:'203.0.113.7',port:443},socket=>client=socket);response.socket.write('x');
  await new Promise(resolve=>{response.socket.resume();response.socket.once('end',resolve);});
  await new Promise(resolve=>setTimeout(resolve,10));
  const records=await relay.stats();assert.equal(records.length,1);assert.equal(records[0].routeVerified,true);assert.equal(records[0].sentBytes,1);assert.equal(records[0].receivedBytes,5);assert.equal(connections,1);
  controller.abort();await relay.stop();assert.equal((await relay.stats())[0].pathObservation.state,'verified');
 }finally{client?.destroy();await relay?.stop();for(const socket of sockets)socket.destroy();await new Promise(resolve=>upper.close(resolve));}
});
