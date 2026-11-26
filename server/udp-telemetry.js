import {randomBytes} from 'node:crypto';import net from 'node:net';import dgram from 'node:dgram';import {buildQuery} from './dns-probe.js';
function reader(socket){
 let buffer=Buffer.alloc(0),pending=null,closed=false;
 const fail=()=>{closed=true;if(pending){pending.reject(Error('Closed'));pending=null;}};
 const drain=()=>{if(pending && buffer.length>=pending.size){const {size,resolve}=pending;pending=null;const value=buffer.subarray(0,size);buffer=buffer.subarray(size);resolve(value);}};
 socket.on('data',chunk=>{buffer=Buffer.concat([buffer,chunk]);if(buffer.length>4096){socket.destroy();fail();return;}drain();});socket.on('end',fail);socket.on('close',fail);socket.on('error',fail);
 return size=>{if(buffer.length>=size){const value=buffer.subarray(0,size);buffer=buffer.subarray(size);return Promise.resolve(value);}if(closed)return Promise.reject(Error('Closed'));return new Promise((resolve,reject)=>{pending={size,resolve,reject};drain();});};
}
// Use only the selected managed SOCKS endpoint; never retry through another exit.
export function probeUdp(port,{timeout=2500,auth=null,kind='dns'}={}){
 return new Promise(resolve=>{
  const tcp=net.connect({host:'127.0.0.1',port}),read=reader(tcp);let udp,done=false,start;
  const finish=(status,delay=null)=>{if(done)return;done=true;clearTimeout(timer);tcp.destroy();udp?.close();resolve({status,delay,protocol:kind,measuredAt:new Date().toISOString()});};
  const timer=setTimeout(()=>finish('timeout'),timeout);tcp.on('error',()=>finish('error'));
  (async()=>{
   await new Promise((resolve,reject)=>{tcp.once('connect',resolve);tcp.once('error',reject);tcp.once('close',()=>reject(Error('Closed')));});
   tcp.write(Buffer.from([5,1,auth?2:0]));if(!(await read(2)).equals(Buffer.from([5,auth?2:0])))throw Error('Greeting');
   if(auth){
    const username=Buffer.from(auth.username),password=Buffer.from(auth.password);
    if(!username.length || username.length>255 || !password.length || password.length>255)throw Error('Invalid credentials');
    tcp.write(Buffer.concat([Buffer.from([1,username.length]),username,Buffer.from([password.length]),password]));
    if(!(await read(2)).equals(Buffer.from([1,0])))throw Error('Authentication');
   }
   tcp.write(Buffer.from('05030001000000000000','hex'));const header=await read(4);if(header[0]!==5 || header[1]!==0 || header[2]!==0 || header[3]!==1)throw Error('UDP unavailable');
   const endpoint=await read(6),host=[...endpoint.subarray(0,4)].join('.');if(host!=='127.0.0.1' && host!=='0.0.0.0')throw Error('Non-loopback relay');
   const relayPort=endpoint.readUInt16BE(4);if(!relayPort)throw Error('Invalid port');
   udp=dgram.createSocket('udp4');udp.on('error',()=>finish('error'));
   const query=kind==='stun'?Buffer.concat([Buffer.from('000100002112a442','hex'),randomBytes(12)]):buildQuery();
   const hostname=Buffer.from('stun.cloudflare.com');
   const target=kind==='stun'?Buffer.concat([Buffer.from([0,0,0,3,hostname.length]),hostname,Buffer.from([13,150])]):Buffer.from('00000001010101010035','hex');
   udp.on('message',(packet,remote)=>{
    if(remote.address!=='127.0.0.1' || remote.port!==relayPort || packet.length<4 || packet[0] || packet[1] || packet[2])return;
    if(kind==='stun'){
      const offset=packet[3]===1?10:packet[3]===4?22:packet[3]===3?7+packet[4]:0;
      if(!offset || packet.length<offset+20)return;
      const reply=packet.subarray(offset);
      if(reply.readUInt16BE(0)!==0x0101 || reply.readUInt32BE(4)!==0x2112a442 || !reply.subarray(8,20).equals(query.subarray(8,20)) || reply.readUInt16BE(2)+20!==reply.length)return;
      finish('ok',Math.max(1,Math.round(performance.now()-start)));return;
    }
    if(packet.length<22 || !packet.subarray(0,10).equals(target))return;
    const dns=packet.subarray(10);if(dns.readUInt16BE(0)!==query.readUInt16BE(0) || !(dns[2]&128) || dns.readUInt16BE(4)!==1)return;
    if(dns.length<query.length || !dns.subarray(12,query.length).equals(query.subarray(12)))return;
    finish((dns[3]&15)===0?'ok':'error',(dns[3]&15)===0?Math.max(1,Math.round(performance.now()-start)):null);
   });
   start=performance.now();udp.send(Buffer.concat([target,query]),relayPort,'127.0.0.1',error=>{if(error)finish('error');});
  })().catch(()=>finish('error'));
 });
}
export function createUdpTelemetry(bridge,{probe=probeUdp,now=Date.now,ttl=30000}={}){
 const cache=new Map(),queue=[];let active=0;
 const drain=()=>{while(active<2 && queue.length){const job=queue.shift();active++;Promise.resolve().then(job).finally(()=>{active--;drain();});}};
 return profile=>{
  if(profile.enabled===false)return {status:'disabled',delay:null};
  const endpoint=bridge(profile);if(!endpoint)return {status:'unmeasured',delay:null};
  const key=endpoint.key ?? endpoint.port+':'+endpoint.process?.pid,old=cache.get(profile.id);
  if(old?.key===key && (old.pending || now()-old.time<ttl))return old.value;
  const item={key,pending:true,time:now(),value:{status:'checking',delay:null}};cache.set(profile.id,item);
  queue.push(async()=>{try{item.value=endpoint.probe?await endpoint.probe():await probe(endpoint.port,{auth:endpoint.auth,kind:endpoint.kind});}catch{item.value={status:'error',delay:null};}finally{item.time=now();item.pending=false;}});drain();return item.value;
 };
}
