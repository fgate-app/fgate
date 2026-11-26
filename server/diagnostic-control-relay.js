import net from 'node:net';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {connectGatewayTcp,readGatewayBytes as read} from './gateway-tunnel.js';

// Private fixed-target SOCKS relay. Its only upstream is an existing pinned
// gateway listener; every connection is correlated with the engine controller.
export async function startDiagnosticControlRelay({upstream,target,observe,signal}){
 const username=randomBytes(16).toString('hex'),password=randomBytes(24).toString('hex');
 const sockets=new Set(),records=[],tasks=new Set();let stopped=false,timer,stopping;
 const canonical=value=>net.isIP(value)===6?new URL(`http://[${value}]/`).hostname:value;
 const equal=(bytes,value)=>bytes.length===Buffer.byteLength(value) && timingSafeEqual(bytes,Buffer.from(value));
 const track=socket=>{sockets.add(socket);socket.on('error',()=>{});socket.once('close',()=>sockets.delete(socket));if(stopped || signal?.aborted)socket.destroy();};
 const server=net.createServer(socket=>{
  track(socket);socket.setTimeout(5000,()=>socket.destroy());
  const task=(async()=>{
   let peer,observer,row,finished,tuple;
   const finish=()=>finished ||= observer?.finish(tuple,{sampleFinal:true}).then(value=>{row.pathObservation=value;row.routeVerified=value.state==='verified';return value;}).catch(()=>{row.routeVerified=false;return {state:'unavailable'};});
   try{
    if(stopped || records.length>=8)throw Error('Diagnostic relay limit reached.');
    const [version,count]=await read(socket,2),methods=await read(socket,count);
    if(version!==5 || !methods.includes(2))throw Error('Authentication required.');
    socket.write(Buffer.from([5,2]));if((await read(socket,1))[0]!==1)throw Error('Invalid authentication.');
    const user=await read(socket,(await read(socket,1))[0]),pass=await read(socket,(await read(socket,1))[0]);
    if(!equal(user,username) || !equal(pass,password))throw Error('Authentication failed.');
    socket.write(Buffer.from([1,0]));const header=await read(socket,4);if(header[0]!==5 || header[1]!==1 || header[2]!==0)throw Error('Invalid command.');
    let address;
    if(header[3]===1)address=[...await read(socket,4)].join('.');
    else if(header[3]===3)address=(await read(socket,(await read(socket,1))[0])).toString();
    else if(header[3]===4){const bytes=await read(socket,16);address=new URL('http://['+Array.from({length:8},(_,i)=>bytes.readUInt16BE(i*2).toString(16)).join(':')+']/').hostname.slice(1,-1);}
    else throw Error('Invalid address.');
    const port=(await read(socket,2)).readUInt16BE();if(canonical(address)!==canonical(target.address) || port!==target.port)throw Error('Invalid destination.');
    row={state:'connecting',sentBytes:0,receivedBytes:0,routeVerified:false};records.push(row);row.finish=finish;
    const result=await connectGatewayTcp(upstream,1,target,track,async socket=>{
     peer=socket;tuple={local_port:socket.localPort,local_ip:socket.localAddress};observer=await observe({endpoint:upstream,url:`https://${net.isIP(target.address)===6?'['+target.address+']':target.address}:${target.port}/`,localPort:tuple.local_port,signal});
    });peer=result.socket;
    if(stopped || socket.destroyed){peer.destroy();return;}
    row.state='connected';socket.setTimeout(0);socket.write(Buffer.from([5,0,0,1,127,0,0,1,0,0]));
    socket.on('data',data=>row.sentBytes+=data.length);peer.on('data',data=>row.receivedBytes+=data.length);
    socket.once('close',()=>{peer.destroy();void finish();});peer.once('close',()=>{socket.destroy();void finish();});
    socket.pipe(peer);peer.pipe(socket);
   }catch{if(row)row.state='failed';socket.destroy();peer?.destroy();await finish();}
  })();tasks.add(task);task.finally(()=>tasks.delete(task));
 });
 const stop=()=>stopping ||= (async()=>{
  stopped=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);
  for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));
  await Promise.allSettled([...tasks]);await Promise.allSettled(records.map(row=>row.finish?.()));
 })();
 const abort=()=>{void stop();};
 try{await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});}
 catch(error){await stop();throw error;}
 timer=setTimeout(abort,35000);timer.unref();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)await stop();
 return {port:server.address()?.port,username,password,stop,async stats(){
  await Promise.allSettled(records.map(row=>row.finish?.()));
  return records.map(({finish,...row})=>row);
 }};
}

export function diagnosticControlHelper(options){
 let relay;
 return async request=>{
  if(request.op==='start'){relay=await startDiagnosticControlRelay(options);return {ok:true,port:relay.port,username:relay.username,password:relay.password};}
  if(request.op==='stats')return {ok:true,records:await relay.stats()};
  if(request.op==='stop'){await relay?.stop();return {ok:true};}
  throw Error('Invalid diagnostic relay operation.');
 };
}
