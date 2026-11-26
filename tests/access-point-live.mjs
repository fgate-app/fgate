// Isolated installed-engine check: no TUN, no production ports, keys or database.
import assert from 'node:assert/strict';import {spawn} from 'node:child_process';import http from 'node:http';
import {mkdtempSync,writeFileSync,rmSync,openSync,closeSync,readFileSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {randomUUID,randomBytes} from 'node:crypto';
import {ingressConfig} from '../server/access-points/runtime.js';import {policyUsers,accessUsername} from '../server/access-points/identity.js';import {unusedPort} from '../server/xray.js';import {execute} from '../server/access-points/ssh.js';import {managedPoint} from '../server/access-points/managed.js';
const xray=process.env.FREEDOMGATE_XRAY,mihomo=process.env.FREEDOMGATE_MIHOMO;assert.ok(xray && mihomo);
const dir=mkdtempSync(join(tmpdir(),'fg-ap-live-')),children=[];let release;
const target=http.createServer((req,res)=>{if(req.url==='/hold'){res.writeHead(200);res.write('open');release=()=>res.end('end');}else res.end(Buffer.alloc(32768,97));});await new Promise(resolve=>target.listen(0,'127.0.0.1',resolve));
const start=(binary,args)=>{const fd=openSync(join(dir,'engine.log'),'a',0o600);const child=spawn(binary,args,{stdio:['ignore',fd,fd]});closeSync(fd);children.push(child);return child;};
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));const ready=async url=>{for(let i=0;i<80;i++){try{const res=await fetch(url,{signal:AbortSignal.timeout(300)});if(res.ok)return await res.json();}catch{}await wait(100);}throw Error('Fixture not ready');};
try{
 const point=managedPoint();point.clients.push({id:randomUUID(),name:'Second',enabled:true,password:randomBytes(32).toString('base64url')});
 const policy=await unusedPort(),controller=await unusedPort(),ingress=await unusedPort(),metrics=await unusedPort();
 writeFileSync(join(dir,'mihomo.json'),JSON.stringify({mode:'rule','log-level':'silent','external-controller':'127.0.0.1:'+controller,listeners:[{name:'fg-remote',type:'socks',listen:'127.0.0.1',port:policy,udp:true,users:policyUsers([point])}],rules:['MATCH,DIRECT']}));
 start(mihomo,['-d',dir,'-f',join(dir,'mihomo.json')]);await ready('http://127.0.0.1:'+controller+'/connections');
 const config=ingressConfig(point,ingress,{mixedPort:policy,metricsPort:metrics});
 // Permit the local echo fixture only in this isolated process.
 config.routing.rules=config.routing.rules.filter(rule=>!rule.ip);
 writeFileSync(join(dir,'ingress.json'),JSON.stringify(config));start(xray,['run','-c',join(dir,'ingress.json')]);await ready('http://127.0.0.1:'+metrics+'/debug/vars');
 const local=[];
 for(const [index,key] of point.clients.entries()){
  const port=await unusedPort();local.push(port);const path=join(dir,'client-'+index+'.json');writeFileSync(path,JSON.stringify({log:{loglevel:'none'},inbounds:[{listen:'127.0.0.1',port,protocol:'socks',settings:{auth:'noauth',udp:true}}],outbounds:[{protocol:'shadowsocks',settings:{servers:[{address:'127.0.0.1',port:ingress,method:'chacha20-ietf-poly1305',password:key.password}]}}]}));start(xray,['run','-c',path]);
 }
 await wait(400);
 const request=(port,path)=>execute('curl',['-fsS','--max-time','15','--noproxy','','--socks5-hostname','127.0.0.1:'+port,'http://127.0.0.1:'+target.address().port+path],{maxOutput:100000});
 const held=request(local[0],'/hold');for(let i=0;i<40 && !release;i++)await wait(50);assert.ok(release);
 let connections=await ready('http://127.0.0.1:'+controller+'/connections');assert.ok((connections.connections || []).some(row=>row.metadata.inboundUser===accessUsername(point.id,point.clients[0].id)));
 assert.equal((await request(local[1],'/short')).code,0);
 const data=await ready('http://127.0.0.1:'+metrics+'/debug/vars');const user=data.stats.user;
 assert.ok(user[point.clients[1].id+'@freedomgate'].downlink>=32768,JSON.stringify(data.stats));assert.ok(user[point.clients[0].id+'@freedomgate'].downlink>0);
 release();await held;for(let i=0;i<50;i++){connections=await ready('http://127.0.0.1:'+controller+'/connections');if(!(connections.connections || []).some(row=>row.metadata.inboundUser===accessUsername(point.id,point.clients[0].id)))break;await wait(100);}assert.equal((connections.connections || []).filter(row=>row.metadata.inboundUser===accessUsername(point.id,point.clients[0].id)).length,0);
 console.log('PASS: two keys share one Shadowsocks port; authenticated per-key metadata reaches mihomo; active flow closes; cumulative per-key metrics include short closed traffic.');
}catch(error){console.error(readFileSync(join(dir,'engine.log'),'utf8').slice(-4000));throw error;}
finally{release?.();await Promise.all(children.map(child=>new Promise(resolve=>{if(child.exitCode!==null)return resolve();child.once('exit',resolve);child.kill('SIGTERM');})));await new Promise(resolve=>target.close(resolve));rmSync(dir,{recursive:true,force:true});}
