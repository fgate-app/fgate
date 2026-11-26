import net from 'node:net';
import dgram from 'node:dgram';

// Fixed destination relay for the Outline SDK. Both TCP and UDP use the selected
// loopback SOCKS gateway; a failed handshake never opens a direct connection.
export function readGatewayBytes(socket,size){
 return new Promise((resolve,reject)=>{
  const clear=()=>{socket.off('readable',drain);socket.off('close',fail);socket.off('end',fail);socket.off('error',fail);};
  const fail=()=>{clear();reject(Error('Gateway SOCKS connection closed'));};
  const drain=()=>{const b=socket.read(size);if(b){clear();resolve(b);}else if(socket.destroyed || socket.readableEnded)fail();};
  socket.on('readable',drain);socket.once('close',fail);socket.once('end',fail);socket.once('error',fail);drain();
 });
}
function address(host,port){
 const name=Buffer.from(host),p=Buffer.alloc(2);p.writeUInt16BE(port);
 if(net.isIP(host)===4)return Buffer.concat([Buffer.from([1,...host.split('.').map(Number)]),p]);
 if(name.length>255)throw Error('Invalid gateway destination');
 return Buffer.concat([Buffer.from([3,name.length]),name,p]);
}
export async function connectGatewayTcp(upstream,command,target,track,beforeRequest){
 const socket=net.connect({host:'127.0.0.1',port:upstream.port});track(socket);
 socket.on('error',()=>{});socket.setTimeout(5000,()=>socket.destroy());
 try{
  await new Promise((resolve,reject)=>{socket.once('connect',resolve);socket.once('error',reject);socket.once('close',()=>reject(Error('Gateway unavailable')));});
  await beforeRequest?.(socket);
  socket.write(Buffer.from([5,1,upstream.password?2:0]));
  if(!(await readGatewayBytes(socket,2)).equals(Buffer.from([5,upstream.password?2:0])))throw Error('Gateway SOCKS greeting rejected');
  if(upstream.password){
   const user=Buffer.from(upstream.username),password=Buffer.from(upstream.password);
   socket.write(Buffer.concat([Buffer.from([1,user.length]),user,Buffer.from([password.length]),password]));
   if(!(await readGatewayBytes(socket,2)).equals(Buffer.from([1,0])))throw Error('Gateway authentication failed');
  }
  socket.write(Buffer.concat([Buffer.from([5,command,0]),address(command===3?'0.0.0.0':target.address,command===3?0:target.port)]));
  const header=await readGatewayBytes(socket,4);
  if(header[0]!==5 || header[1]!==0 || header[2]!==0)throw Error('Gateway rejected destination');
  let host;
  if(header[3]===1)host=[...await readGatewayBytes(socket,4)].join('.');
  else if(header[3]===3)host=(await readGatewayBytes(socket,(await readGatewayBytes(socket,1))[0])).toString();
  else if(header[3]===4){await readGatewayBytes(socket,16);host='::';}
  else throw Error('Invalid gateway SOCKS address');
  const port=(await readGatewayBytes(socket,2)).readUInt16BE();socket.setTimeout(0);
  return {socket,host,port};
 }catch(error){socket.destroy();throw error;}
}
// Complete only the fixed-server TCP connection; do not send proxy credentials or a site request.
export async function probeGatewayTcp(upstream,target,{signal}={}){
 let socket;
 const cancel=()=>socket?.destroy();signal?.addEventListener('abort',cancel,{once:true});
 try{
  if(signal?.aborted)throw Object.assign(Error('Diagnostic cancelled.'),{code:'ABORTED'});
  const result=await connectGatewayTcp(upstream,1,target,value=>{socket=value;if(signal?.aborted)value.destroy();});
  result.socket.destroy();return {state:'ok'};
 }catch(error){if(signal?.aborted)throw Object.assign(Error('Diagnostic cancelled.'),{code:'ABORTED'});return {state:'failed',reason:'endpoint-tcp-unreachable'};}
 finally{signal?.removeEventListener('abort',cancel);socket?.destroy();}
}
export async function startGatewayTunnel({upstream,target}){
 const sockets=new Set(),sessions=new Map();let stopped=false;
 const track=socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));if(stopped)socket.destroy();};
 const server=net.createServer({allowHalfOpen:true},client=>{
  if(stopped || sockets.size>=512){client.destroy();return;}
  track(client);client.on('error',()=>{});
  (async()=>{
   const {socket}=await connectGatewayTcp(upstream,1,target,track);
   if(client.destroyed){socket.destroy();return;}
   client.once('close',()=>socket.destroy());socket.once('close',()=>client.destroy());
   client.once('error',()=>socket.destroy());socket.once('error',()=>client.destroy());
   client.pipe(socket);socket.pipe(client);
  })().catch(()=>client.destroy());
 });
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 const port=server.address().port,udp=dgram.createSocket('udp4');
 const stopSession=session=>{
  if(session.closed)return;session.closed=true;clearTimeout(session.timer);session.tcp?.destroy();
  if(session.udp)session.udp.close();sessions.delete(session.key);
 };
 const touch=session=>{clearTimeout(session.timer);session.timer=setTimeout(()=>stopSession(session),30000);session.timer.unref();};
 udp.on('error',()=>{});
 try{await new Promise((resolve,reject)=>{udp.once('error',reject);udp.bind(port,'127.0.0.1',resolve);});}
 catch(error){await new Promise(resolve=>server.close(resolve));udp.close();throw error;}
 const header=Buffer.concat([Buffer.from([0,0,0]),address(target.address,target.port)]);
 udp.on('message',(packet,client)=>{
  if(stopped || client.address!=='127.0.0.1')return;
  const key=client.address+':'+client.port;let session=sessions.get(key);
  if(!session){
   if(sessions.size>=128)return;
   session={key,closed:false,pending:[],client};sessions.set(key,session);touch(session);
   (async()=>{
    const result=await connectGatewayTcp(upstream,3,target,track);session.tcp=result.socket;
    if(session.closed){result.socket.destroy();return;}
    if(!result.port || !['127.0.0.1','0.0.0.0'].includes(result.host))throw Error('Non-loopback gateway UDP relay');
    result.socket.once('close',()=>stopSession(session));result.socket.once('error',()=>stopSession(session));result.socket.resume();
    const socket=dgram.createSocket('udp4');session.udp=socket;socket.on('error',()=>stopSession(session));
    socket.on('message',(reply,remote)=>{
     if(session.closed || remote.address!=='127.0.0.1' || remote.port!==result.port || reply.length<4 || reply[0] || reply[1] || reply[2])return;
     const offset=reply[3]===1?10:reply[3]===4?22:reply[3]===3?7+reply[4]:0;
     if(!offset || reply.length<offset || reply.readUInt16BE(offset-2)!==target.port)return;
     touch(session);udp.send(reply.subarray(offset),client.port,client.address,()=>{});
    });
    await new Promise(resolve=>socket.bind(0,'127.0.0.1',resolve));
    if(session.closed)return;
    session.send=payload=>socket.send(Buffer.concat([header,payload]),result.port,'127.0.0.1',error=>{if(error)stopSession(session);});
    for(const payload of session.pending)session.send(payload);session.pending=[];
   })().catch(()=>stopSession(session));
  }
  touch(session);
  if(session.send)session.send(packet);else if(session.pending.length<16)session.pending.push(Buffer.from(packet));
 });
 return {port,stop:async()=>{
  if(stopped)return;stopped=true;for(const session of sessions.values())stopSession(session);for(const socket of sockets)socket.destroy();
  udp.close();await new Promise(resolve=>server.close(resolve));
 }};
}
