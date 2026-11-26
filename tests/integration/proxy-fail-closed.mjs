// Isolated real mihomo test, no host routing changes. Uses the same TUN-disabled wrapper as hot-reload-smoke.
import {MihomoSupervisor} from '../../server/mihomo.js';import {moduleBinary} from '../../server/module-paths.js';import {unusedPort} from '../../server/xray.js';import {defaultDnsSettings} from '../../server/dns-resolvers.js';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import net from 'node:net';import dgram from 'node:dgram';import {once} from 'node:events';import assert from 'node:assert/strict';
const health=net.createServer(socket=>socket.on('data',()=>socket.end('HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n')));await new Promise(r=>health.listen(0,'127.0.0.1',r));
const healthUrl=`http://127.0.0.1:${health.address().port}/`;
const folder=mkdtempSync(join(tmpdir(),'fg-fail-closed-')),wrapper=join(folder,'mihomo-wrapper'),binary=moduleBinary('mihomo','mihomo','/opt/freedomgate/modules/mihomo/v1.19.33/mihomo');
writeFileSync(wrapper,`#!/usr/bin/env python3\nimport sys,os\np=sys.argv[sys.argv.index('-f')+1]\ns=open(p).read().replace('tun:\\n  enable: true','tun:\\n  enable: false').replace('https://www.gstatic.com/generate_204',${JSON.stringify(healthUrl)}).replace('interval: 60','interval: 1')\nopen(p,'w').write(s)\nos.execv(${JSON.stringify(binary)},[${JSON.stringify(binary)}]+sys.argv[1:])\n`,{mode:0o700});
const bridge={prepare:async()=>({bridges:{},commit:async()=>{},rollback:async()=>{}}),status:()=>({}),stop:async()=>{}};
const supervisor=new MihomoSupervisor({binary:wrapper,stateDir:folder,mixedPort:await unusedPort(),dnsPort:await unusedPort(),controllerPort:await unusedPort(),xray:bridge,ssRelay:bridge});
const good=new MihomoSupervisor({binary:wrapper,stateDir:join(folder,'good'),mixedPort:await unusedPort(),dnsPort:await unusedPort(),controllerPort:await unusedPort(),xray:bridge,ssRelay:bridge});
let tcpHits=0,udpHits=0;const tcp=net.createServer(socket=>{tcpHits++;socket.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok');});await new Promise(r=>tcp.listen(0,'127.0.0.1',r));
const udp=dgram.createSocket('udp4');udp.on('message',()=>udpHits++);await new Promise(r=>udp.bind(0,'127.0.0.1',r));
const dead=await unusedPort();
const configs=[{profile_id:'dead',engine:'mihomo',config:JSON.stringify({type:'socks5',server:'127.0.0.1',port:dead,udp:false})}];
const profiles=[{id:'dead',engine:'mihomo'},{id:'direct',engine:'direct'}];
async function tcpAttempt(){const socket=net.connect(supervisor.mixedPort,'127.0.0.1');await once(socket,'connect');socket.on('error',()=>{});socket.write(`CONNECT 127.0.0.1:${tcp.address().port} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n`);await new Promise(r=>{socket.once('close',r);setTimeout(()=>{socket.destroy();r();},1200);});}
async function udpAttempt(){
 const socket=net.connect(supervisor.mixedPort,'127.0.0.1');await once(socket,'connect');let response=once(socket,'data');socket.write(Buffer.from([5,1,0]));await response;
 response=once(socket,'data');socket.write(Buffer.from([5,3,0,1,0,0,0,0,0,0]));const answer=(await response)[0];assert.equal(answer[1],0);assert.equal(answer[3],1);
 const port=answer.readUInt16BE(answer.length-2),packet=Buffer.from([0,0,0,1,127,0,0,1,udp.address().port>>8,udp.address().port&255,1]);
 const sender=dgram.createSocket('udp4');await new Promise(r=>sender.send(packet,port,'127.0.0.1',r));await new Promise(r=>setTimeout(r,300));sender.close();socket.destroy();
}
try{
 assert.equal((await supervisor.apply(defaultDnsSettings)).ok,true);
 await tcpAttempt();await udpAttempt();assert.equal(tcpHits,1);assert.equal(udpHits,1,'control confirms direct UDP reaches destination');
 for(const [routeId,connectionGroups] of [['dead',[]],['pool',[{id:'pool',members:['dead']}]],['empty',[{id:'empty',members:[]}]],['missing',[]]]){
  supervisor.setRoutes([],[{id:'test',entries:['127.0.0.1'],routeId}],profiles,configs,connectionGroups);
  assert.equal((await supervisor.reapply()).ok,true);
  const before=[tcpHits,udpHits];await tcpAttempt();await udpAttempt();assert.deepEqual([tcpHits,udpHits],before,routeId+' must not fall through to direct');
 }
 assert.equal((await good.apply(defaultDnsSettings)).ok,true);
 const goodConfig={profile_id:'good',engine:'mihomo',config:JSON.stringify({type:'socks5',server:'127.0.0.1',port:good.mixedPort,udp:true})};
 supervisor.setRoutes([],[{id:'priority',entries:['127.0.0.1'],routeId:'priority'}],[...profiles,{id:'good',engine:'mihomo'},{id:'zapret',engine:'zapret'}],[...configs,goodConfig,{profile_id:'zapret',engine:'zapret',config:''}],[{id:'priority',members:['zapret','dead','good']}]);
 assert.equal((await supervisor.reapply()).ok,true);
 async function waitSelected(expected){for(let n=0;n<150;n++){const registry=(await supervisor.controller('/proxies')).proxies;let selected=registry['cg-priority'].now;if(selected==='cg-priority-proxies')selected=registry[selected].now;if(selected===expected)return;await new Promise(r=>setTimeout(r,100));}assert.fail('selection never became '+expected);}
 await waitSelected('p-good-grp');
 await good.stop();await waitSelected('p-zapret-grp');assert.ok(!(await supervisor.controller('/proxies')).proxies['cg-priority'].all.includes('DIRECT'),'DIRECT is never inserted into a group without it');
 supervisor.setRoutes([],[{id:'priority',entries:['127.0.0.1'],routeId:'priority'}],[...profiles,{id:'good',engine:'mihomo'}],[...configs,goodConfig],[{id:'priority',members:['direct','dead','good']}]);
 assert.equal((await supervisor.reapply()).ok,true);await waitSelected('DIRECT');
 const before=tcpHits;await tcpAttempt();assert.equal(tcpHits,before+1,'explicit DIRECT works only after all proxies fail');
 assert.equal((await good.apply(defaultDnsSettings)).ok,true);await waitSelected('p-good-grp');
 console.log('Priority group: proxy wins over zapret/DIRECT; zapret used after proxy failure; explicit DIRECT works when zapret absent; recovery returns to proxy.');
 console.log('Real mihomo: dead single proxy, dead/empty group, missing gateway reject TCP/UDP; direct control passed.');
}finally{await supervisor.stop();await good.stop();await new Promise(r=>tcp.close(r));await new Promise(r=>health.close(r));udp.close();rmSync(folder,{recursive:true,force:true});}
