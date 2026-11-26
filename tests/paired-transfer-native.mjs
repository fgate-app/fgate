// Run as root under unshare -n with loopback up. No production state or public traffic.
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {execFileSync,spawn} from 'node:child_process';
import net from 'node:net';
import https from 'node:https';
import {MihomoSupervisor} from '../server/mihomo.js';
import {moduleBinary} from '../server/module-paths.js';
import {defaultDnsSettings} from '../server/dns-resolvers.js';
const dir=mkdtempSync('/tmp/fg-paired-native-'),wrapper=join(dir,'mihomo-wrapper');
const binary=moduleBinary('mihomo','mihomo','/opt/freedomgate/modules/mihomo/current/mihomo');
execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(dir,'key'),'-out',join(dir,'cert'),'-days','1','-subj','/CN=speed.cloudflare.com','-addext','subjectAltName=DNS:speed.cloudflare.com'],{stdio:'ignore'});
process.env.CURL_CA_BUNDLE=join(dir,'cert');process.env.SSL_CERT_FILE=join(dir,'cert');
writeFileSync(wrapper,`#!/usr/bin/env python3\nimport sys,os\np=sys.argv[sys.argv.index('-f')+1]\ns=open(p).read().replace('tun:\\n  enable: true','tun:\\n  enable: false')\nif '\\nhosts:\\n' not in s:s+='\\nhosts:\\n  speed.cloudflare.com: 127.0.0.1\\n'\nopen(p,'w').write(s)\nos.execv(${JSON.stringify(binary)},[${JSON.stringify(binary)}]+sys.argv[1:])\n`,{mode:0o700});
const sockets=new Set();let proxyConnections=0,httpRequests=0;
const origin=https.createServer({key:readFileSync(join(dir,'key')),cert:readFileSync(join(dir,'cert'))},(req,res)=>{httpRequests++;if(req.method==='HEAD'){res.writeHead(200);res.end();return;}assert.equal(req.url,'/__down?bytes=65536');setTimeout(()=>{res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Length':'65536'});res.end(Buffer.alloc(65536));},200);});
const proxy=net.createServer(client=>{sockets.add(client);client.on('close',()=>sockets.delete(client));client.on('error',()=>{});let buffer=Buffer.alloc(0),phase=0;
 const data=chunk=>{buffer=Buffer.concat([buffer,chunk]);if(phase===0){if(buffer.length<2+buffer[1])return;buffer=buffer.subarray(2+buffer[1]);client.write(Buffer.from([5,0]));phase=1;}
  if(phase===1){if(buffer.length<5)return;const size=buffer[3]===1?10:buffer[3]===4?22:7+buffer[4];if(buffer.length<size)return;proxyConnections++;buffer=buffer.subarray(size);phase=2;
   const upstream=net.connect(443,'127.0.0.1',()=>{client.write(Buffer.from('050000017f00000101bb','hex'));client.off('data',data);if(buffer.length)upstream.write(buffer);client.pipe(upstream);upstream.pipe(client);});upstream.on('error',()=>client.destroy());client.on('close',()=>upstream.destroy());
  }
 };client.on('data',data);
});
const supervisor=new MihomoSupervisor({binary:wrapper,stateDir:dir});
try{
 await new Promise(resolve=>origin.listen(443,'127.0.0.1',resolve));await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));
 const profiles=[{id:'direct',engine:'direct',enabled:true},{id:'12345678-fixture',engine:'socks5',enabled:true}],configs=[{profile_id:profiles[1].id,engine:'socks5',config:'socks5://127.0.0.1:'+proxy.address().port}];
 supervisor.setRoutes([],[],profiles,configs,[]);const restored=await supervisor.restore(defaultDnsSettings);assert.equal(restored.ok,true,JSON.stringify(restored)+(restored.ok?'':readFileSync(join(dir,'mihomo','mihomo.log'),'utf8')));
 const result=await supervisor.compareTransfer(profiles[1].id,{});
 assert.equal(result.outcome,'ok',JSON.stringify(result));assert.ok(result.results.every(row=>row.attempts[0].bytes===65536 && row.attempts[0].pathObservation.state==='verified'));
 assert.ok(proxyConnections>0);assert.equal(result.results[0].path.chain[0].engine,'direct');
 supervisor.diagnoseGatewayDns=async()=>({attempts:[{state:'ok',rcode:0,answers:[{type:'A',value:'93.184.215.14'}],pathObservation:{state:'verified'}}]});
 const tls=await supervisor.diagnoseTlsVersions(profiles[1].id,{name:'speed.cloudflare.com',provider:'cloudflare'});assert.equal(tls.outcome,'ok',JSON.stringify(tls));assert.deepEqual(tls.attempts.map(row=>row.negotiatedVersion),['TLSv1.2','TLSv1.3']);
 origin.setSecureContext({key:readFileSync(join(dir,'key')),cert:readFileSync(join(dir,'cert')),minVersion:'TLSv1.2',maxVersion:'TLSv1.2'});
 const restricted=await supervisor.diagnoseTlsVersions(profiles[1].id,{name:'speed.cloudflare.com',provider:'cloudflare'});assert.equal(restricted.outcome,'partial',JSON.stringify(restricted));assert.equal(restricted.attempts[0].state,'ok');assert.equal(restricted.attempts[1].state,'failed');
 let h3=null,h3Silent=null;
 if(process.env.FREEDOMGATE_H3_FIXTURE_PYTHON){
  execFileSync('ip',['addr','add','93.184.215.14/32','dev','lo']);
  const fixture=spawn(process.env.FREEDOMGATE_H3_FIXTURE_PYTHON,['tests/http3-fixture.py',join(dir,'cert'),join(dir,'key')],{stdio:['ignore','pipe','inherit']});
  try{
   await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('HTTP/3 fixture did not start.')),5000);fixture.once('exit',()=>{clearTimeout(timer);reject(Error('HTTP/3 fixture exited.'));});fixture.stdout.once('data',()=>{clearTimeout(timer);resolve();});});
   h3=await supervisor.diagnoseHttp3('direct',{name:'speed.cloudflare.com',provider:'cloudflare'});assert.equal(h3.outcome,'ok',JSON.stringify(h3));assert.equal(h3.attempts[0].httpVersion,'3');assert.equal(h3.attempts[0].pathObservation.state,'verified');
  }finally{fixture.kill();await new Promise(resolve=>fixture.exitCode!==null?resolve():fixture.once('exit',resolve));}
  const before=httpRequests;h3Silent=await supervisor.diagnoseHttp3('direct',{name:'speed.cloudflare.com',provider:'cloudflare'});assert.equal(h3Silent.outcome,'unavailable',JSON.stringify(h3Silent));assert.equal(httpRequests,before,'HTTP/3 must not fall back to the TCP origin.');
 }
 console.log(JSON.stringify({http3:h3?.outcome,http3Silent:h3Silent?.outcome,tls:tls.outcome,tls12Only:restricted.outcome,outcome:result.outcome,paths:result.results.map(row=>({id:row.id,bytes:row.attempts[0].bytes,path:row.attempts[0].pathObservation.state})),proxyConnections,publicTraffic:false}));
}finally{await supervisor.stop();for(const socket of sockets)socket.destroy();await Promise.all([new Promise(resolve=>proxy.close(resolve)),new Promise(resolve=>origin.close(resolve))]);rmSync(dir,{recursive:true,force:true});}
