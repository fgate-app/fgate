import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import dgram from 'node:dgram';
import {once} from 'node:events';
import {startGatewayTunnel} from '../server/gateway-tunnel.js';

test('fixed endpoint tunnel carries TCP and UDP through SOCKS and never retries directly',async()=>{
 const peers=new Set();let connects=0,associations=0;const udp=dgram.createSocket('udp4');
 await new Promise(r=>udp.bind(0,'127.0.0.1',r));
 udp.on('message',(packet,remote)=>{assert.equal(packet.readUInt16BE(8),9999);udp.send(packet,remote.port,remote.address);});
 const outer=net.createServer(socket=>{
  peers.add(socket);socket.on('error',()=>{});socket.once('close',()=>peers.delete(socket));let buffer=Buffer.alloc(0),stage=0;
  socket.on('data',chunk=>{
   if(stage===2){socket.write(chunk);return;}
   buffer=Buffer.concat([buffer,chunk]);
   if(stage===0 && buffer.length>=3){assert.deepEqual([...buffer.subarray(0,3)],[5,1,0]);buffer=buffer.subarray(3);socket.write(Buffer.from([5,0]));stage=1;}
   if(stage===1 && buffer.length>=10){
    const command=buffer[1],reply=Buffer.from('050000017f0000010000','hex');
    if(command===1){connects++;assert.deepEqual([...buffer.subarray(4,8)],[192,0,2,12]);assert.equal(buffer.readUInt16BE(8),9999);stage=2;}
    else {associations++;reply.writeUInt16BE(udp.address().port,8);stage=3;}
    buffer=buffer.subarray(10);socket.write(reply);if(stage===2 && buffer.length)socket.write(buffer);
   }
  });
 });
 await new Promise(r=>outer.listen(0,'127.0.0.1',r));
 const tunnel=await startGatewayTunnel({upstream:{port:outer.address().port},target:{address:'192.0.2.12',port:9999}});
 const client=dgram.createSocket('udp4');
 try{
  const tcp=net.connect(tunnel.port,'127.0.0.1');await once(tcp,'connect');const data=once(tcp,'data');tcp.write('nested TCP');assert.equal(String((await data)[0]),'nested TCP');tcp.destroy();
  await new Promise(r=>client.bind(0,'127.0.0.1',r));const response=once(client,'message');client.send(Buffer.from('nested UDP'),tunnel.port,'127.0.0.1');assert.equal(String((await response)[0]),'nested UDP');
  assert.equal(connects,1);assert.equal(associations,1);
  for(const peer of peers)peer.destroy();await new Promise(r=>outer.close(r));
  const failed=net.connect(tunnel.port,'127.0.0.1');failed.on('error',()=>{});await once(failed,'connect');const closed=once(failed,'close');failed.write('must fail');await closed;assert.equal(connects,1);
 }finally{client.close();await tunnel.stop();for(const peer of peers)peer.destroy();if(outer.listening)await new Promise(r=>outer.close(r));udp.close();}
});
