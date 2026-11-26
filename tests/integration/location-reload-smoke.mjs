// Real mihomo, isolated ports and TUN disabled: never changes the host routes.
import {MihomoSupervisor} from '../../server/mihomo.js';import {moduleBinary} from '../../server/module-paths.js';import {unusedPort} from '../../server/xray.js';import {defaultDnsSettings} from '../../server/dns-resolvers.js';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import net from 'node:net';import {once} from 'node:events';import assert from 'node:assert/strict';
const folder=mkdtempSync(join(tmpdir(),'fg-live-reload-')),wrapper=join(folder,'mihomo-wrapper');
const binary=moduleBinary('mihomo','mihomo','/opt/freedomgate/modules/mihomo/v1.19.33/mihomo');
writeFileSync(wrapper,`#!/usr/bin/env python3\nimport sys,os\np=sys.argv[sys.argv.index('-f')+1]\ns=open(p).read().replace('tun:\\n  enable: true','tun:\\n  enable: false')\nopen(p,'w').write(s)\nos.execv(${JSON.stringify(binary)},[${JSON.stringify(binary)}]+sys.argv[1:])\n`,{mode:0o700});
const bridge={prepare:async()=>({bridges:{},commit:async()=>{},rollback:async()=>{}}),status:()=>({}),stop:async()=>{}};
const supervisor=new MihomoSupervisor({binary:wrapper,stateDir:folder,mixedPort:await unusedPort(),dnsPort:await unusedPort(),controllerPort:await unusedPort(),xray:bridge,ssRelay:bridge});
const echo=net.createServer(socket=>socket.on('data',chunk=>socket.write(chunk)));await new Promise(r=>echo.listen(0,'127.0.0.1',r));
const profiles=[{id:'a-proxy',engine:'mihomo'},{id:'b-direct',engine:'direct'},{id:'c-zapret',engine:'zapret'}];
const configs=[{profile_id:'a-proxy',engine:'mihomo',config:JSON.stringify({type:'socks5',server:'127.0.0.1',port:9,udp:false})},{profile_id:'c-zapret',engine:'zapret',config:''}];
for(const [index,profile] of profiles.entries())supervisor.locationPorts.set(profile.id,36000+index);
supervisor.locationPorts.set('0-new',36003);
async function check(id){
 const entry=supervisor.locationEndpoints.get(id);assert.ok(entry);const socket=net.connect(entry.port,'127.0.0.1');
 try{await once(socket,'connect');let reply=once(socket,'data');const auth=Buffer.from('fg-geo:'+entry.secret).toString('base64');socket.write(`CONNECT 127.0.0.1:${echo.address().port} HTTP/1.1\r\nHost: 127.0.0.1\r\nProxy-Authorization: Basic ${auth}\r\n\r\n`);assert.match(String((await reply)[0]),/200/);reply=once(socket,'data');socket.write('geo listener works');assert.equal(String((await reply)[0]),'geo listener works');}finally{socket.destroy();}
}
try{
 supervisor.setRoutes([],[],profiles,configs);assert.equal((await supervisor.apply(defaultDnsSettings)).ok,true);const pid=supervisor.status().pid;
 const ports=new Map(['b-direct','c-zapret'].map(id=>[id,supervisor.locationEndpoints.get(id).port]));
 for(const next of [[{...profiles[0],enabled:false},...profiles.slice(1)],profiles.slice(1),[{id:'0-new',engine:'direct'},...profiles.slice(1)],profiles]){
  supervisor.setRoutes([],[],next,configs);assert.equal((await supervisor.reapply()).ok,true);assert.equal(supervisor.status().pid,pid);
  for(const id of ['b-direct','c-zapret']){assert.equal(supervisor.locationEndpoints.get(id).port,ports.get(id));await check(id);}
 }
 console.log('Real mihomo: direct/zapret authenticated listeners survive disable, deletion, sorted insertion and re-enable; PID unchanged.');
}finally{await supervisor.stop();await new Promise(r=>echo.close(r));rmSync(folder,{recursive:true,force:true});}
