// Isolated Linux/root preflight; no proxy server access or firewall mutation.
import assert from 'node:assert/strict';
import {createServer} from 'node:net';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {traceEndpointRoute} from '../server/endpoint-route.js';
const execute=promisify(execFile),servers=[];
try{
 for(const address of ['127.0.0.1','::1']){
  const server=createServer(socket=>socket.destroy());servers.push(server);
  await new Promise((resolve,reject)=>server.once('error',reject).listen(0,address,resolve));
  const result=await traceEndpointRoute({addresses:[address],port:server.address().port,interfaceName:'lo'});
  assert.equal(result.results[0].targetReached,true,JSON.stringify(result));
  assert.equal(result.results[0].hopCount,1);
 }
 const controller=new AbortController();
 await assert.rejects(traceEndpointRoute({addresses:['198.18.0.1'],port:443,interfaceName:'lo',signal:controller.signal,run:(command,args,options)=>{
  const pending=execute(command,args,options);controller.abort();return pending;
 }}),{code:'ABORTED'});
 console.log('Native endpoint route preflight passed: marked TCP traceroute on IPv4/IPv6 loopback, original ports, one-hop results, cancellation.');
}finally{await Promise.all(servers.map(server=>new Promise(resolve=>server.close(resolve))));}
