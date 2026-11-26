import test from 'node:test';import assert from 'node:assert/strict';import net from 'node:net';import dgram from 'node:dgram';import {probeUdp,createUdpTelemetry} from '../server/udp-telemetry.js';

test('UDP RTT uses SOCKS association, validates DNS response and reports timeout without direct fallback',async()=>{
 const udp=dgram.createSocket('udp4');await new Promise(r=>udp.bind(0,'127.0.0.1',r));let respond=true,packets=0;
 udp.on('message',(packet,source)=>{packets++;if(!respond)return;const reply=Buffer.from(packet);reply[12]=0x81;reply[13]=0x80;const wrong=Buffer.from(reply);wrong[10]^=1;udp.send(wrong,source.port,source.address);udp.send(reply,source.port,source.address);});
 const peers=new Set();const server=net.createServer(socket=>{peers.add(socket);socket.on('close',()=>peers.delete(socket));let stage=0;socket.on('data',()=>{if(stage++===0){socket.write(Buffer.from([5]));setImmediate(()=>socket.write(Buffer.from([0])));}else{const reply=Buffer.from('050000017f0000010000','hex');reply.writeUInt16BE(udp.address().port,8);socket.write(reply);}});});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{
  const success=await probeUdp(server.address().port);assert.equal(success.status,'ok');assert.ok(success.delay>0);assert.equal(packets,1);
  respond=false;const timeout=await probeUdp(server.address().port,{timeout:100});assert.equal(timeout.status,'timeout');assert.equal(timeout.delay,null);
 }finally{for(const socket of peers)socket.destroy();await new Promise(r=>server.close(r));udp.close();}
});
test('UDP measurements coalesce, expire and invalidate when the bridge changes; disabled profiles never probe',async()=>{
 let time=0,port=1234,calls=0,release;const collect=createUdpTelemetry(()=>({port,process:{pid:1}}),{now:()=>time,ttl:100,probe:async()=>{calls++;return new Promise(r=>release=()=>r({status:'ok',delay:12}));}});
 const profile={id:'one'};assert.equal(collect(profile).status,'checking');assert.equal(collect(profile).status,'checking');await new Promise(r=>setImmediate(r));assert.equal(calls,1);release();await new Promise(r=>setImmediate(r));assert.equal(collect(profile).delay,12);
 assert.equal(collect({...profile,enabled:false}).status,'disabled');time=101;assert.equal(collect(profile).status,'checking');await new Promise(r=>setImmediate(r));release();await new Promise(r=>setImmediate(r));port=1235;assert.equal(collect(profile).status,'checking');await new Promise(r=>setImmediate(r));release();await new Promise(r=>setImmediate(r));assert.equal(calls,3);
});

test('zapret uses its marked helper probe without requiring or falling back to SOCKS',async()=>{
 let calls=0,socksCalls=0;
 const collect=createUdpTelemetry(()=>({key:'zapret',probe:async()=>{calls++;return {status:'ok',delay:9,measuredAt:new Date().toISOString()};}}),{probe:async()=>{socksCalls++;throw Error('wrong path');}});
 assert.equal(collect({id:'zapret'}).status,'checking');
 await new Promise(r=>setImmediate(r));
 assert.equal(collect({id:'zapret'}).status,'ok');
 assert.equal(collect({id:'zapret'}).delay,9);
 assert.equal(calls,1);assert.equal(socksCalls,0);
});
test('authenticated direct endpoint is used explicitly and never falls back after authentication failure',async()=>{
 let stage=0,seen=[];const peers=new Set();const server=net.createServer(socket=>{peers.add(socket);socket.on('close',()=>peers.delete(socket));socket.on('data',data=>{seen.push(data);if(stage++===0)socket.write(Buffer.from([5,2]));else socket.write(Buffer.from([1,1]));});});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{const result=await probeUdp(server.address().port,{auth:{username:'fg-geo',password:'secret'}});assert.equal(result.status,'error');assert.deepEqual([...seen[0]],[5,1,2]);assert.ok(seen[1].includes(Buffer.from('secret')));assert.equal(seen.length,2);}finally{for(const socket of peers)socket.destroy();await new Promise(r=>server.close(r));}
});
test('DIRECT STUN probe authenticates, validates transaction and measures UDP without DNS port 53',async()=>{
 const udp=dgram.createSocket('udp4');await new Promise(r=>udp.bind(0,'127.0.0.1',r));let packets=0;
 udp.on('message',(packet,source)=>{packets++;assert.equal(packet[3],3);assert.equal(packet.subarray(5,5+packet[4]).toString(),'stun.cloudflare.com');assert.equal(packet.readUInt16BE(5+packet[4]),3478);
  const response=Buffer.from(packet.subarray(-20));response.writeUInt16BE(0x0101,0);const header=Buffer.from([0,0,0,1,162,159,207,0,13,150]);const wrong=Buffer.from(response);wrong[8]^=1;udp.send(Buffer.concat([header,wrong]),source.port,source.address);udp.send(Buffer.concat([header,response]),source.port,source.address);
 });
 const peers=new Set();const server=net.createServer(socket=>{peers.add(socket);socket.on('close',()=>peers.delete(socket));let stage=0;socket.on('data',()=>{if(stage===0)socket.write(Buffer.from([5,2]));else if(stage===1)socket.write(Buffer.from([1,0]));else{const reply=Buffer.from('050000017f0000010000','hex');reply.writeUInt16BE(udp.address().port,8);socket.write(reply);}stage++;});});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{const result=await probeUdp(server.address().port,{auth:{username:'fg-geo',password:'secret'},kind:'stun'});assert.equal(result.status,'ok');assert.equal(result.protocol,'stun');assert.ok(result.delay>=1);assert.equal(packets,1);}finally{for(const socket of peers)socket.destroy();await new Promise(r=>server.close(r));udp.close();}
});
