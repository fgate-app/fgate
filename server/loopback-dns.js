import dgram from 'node:dgram';
import {buildQuery} from './dns-probe.js';

// The engine readiness checks share the same bounded loopback transport.
export function requestLoopbackDns(port,name,{timeout=1500}={}) {
 return new Promise(resolve=>{
  const socket=dgram.createSocket('udp4');let settled=false;
  const finish=value=>{if(settled)return;settled=true;clearTimeout(timer);try{socket.close();}catch{}resolve(value);};
  const timer=setTimeout(()=>finish(null),timeout);
  socket.once('message',finish);socket.once('error',()=>finish(null));
  socket.send(buildQuery(name),port,'127.0.0.1',error=>{if(error)finish(null);});
 });
}
