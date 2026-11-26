// Run as root on an isolated Linux stage. Only loopback fixture traffic.
import assert from 'node:assert/strict';
import {createServer} from 'node:net';
import {mkdtemp,rm} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {ProxyStrategyHelper} from '../server/proxy-strategy-helper.js';
import {connectGatewayTcp} from '../server/gateway-tunnel.js';
import {safeProxyFlow} from '../shared/proxy-flow-evidence.js';
const execute=promisify(execFile),directory=await mkdtemp('/tmp/fg-flow-native-'),servers=[],sockets=new Set();
const helper=new ProxyStrategyHelper({run:async(command,args)=>(await execute(command,args)).stdout,paths:async()=>({}),stopDaemon:async()=>{},runDir:directory});
try{
 for(const kind of ['reset','silent','response','refused']){
  const server=createServer(socket=>{sockets.add(socket);socket.on('error',()=>{});socket.on('close',()=>sockets.delete(socket));socket.once('data',()=>{if(kind==='reset')socket.resetAndDestroy();if(kind==='response')socket.end('fixture reply');});});servers.push(server);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;
  if(kind==='refused')await new Promise(resolve=>server.close(resolve));
  const lease='a'.repeat(32),relay=await helper.handle({op:'start',lease,address:'127.0.0.1',port,strategy:'baseline',capture:true},{interface:'lo'});
  let socket;
  try{
   try{const value=await connectGatewayTcp(relay,1,{address:'127.0.0.1',port},value=>{socket=value;value.on('error',()=>{});});value.socket.on('data',()=>{});value.socket.write('private-fixture-payload');}catch{assert.equal(kind,'refused');}
   await new Promise(resolve=>setTimeout(resolve,150));
   const stats=await helper.handle({op:'stats',lease}),flow=safeProxyFlow(stats.records[0]);
   assert.equal(flow.tcpCapture.probeCorrelated,true,JSON.stringify(flow));
   assert.equal(flow.tcpCapture.limits.payloadBytes,0);assert.ok(flow.tcpCapture.packets.length<=16);
   assert.ok(({reset:['reset-after-data'],silent:['no-response-after-data','data-acknowledged-no-response'],response:['peer-data-received'],refused:['tcp-rejected']})[kind].includes(flow.evidence.code),JSON.stringify(flow));
   assert.doesNotMatch(JSON.stringify(flow),/private-fixture-payload|localAddress|localPort/);
   console.log(kind+': '+flow.evidence.code+'; correlated header-only capture passed');
  }finally{socket?.destroy();await helper.stop(lease);}
 }
 console.log('Native proxy flow preflight passed; all relay sockets/processes closed.');
}finally{await helper.stop();for(const socket of sockets)socket.destroy();await Promise.all(servers.filter(server=>server.listening).map(server=>new Promise(resolve=>server.close(resolve))));await rm(directory,{recursive:true,force:true});}
