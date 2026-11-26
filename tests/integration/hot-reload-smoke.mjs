// Real mihomo, isolated ports and TUN disabled: never changes the host routes.
import {MihomoSupervisor} from '../../server/mihomo.js';import {moduleBinary} from '../../server/module-paths.js';import {unusedPort} from '../../server/xray.js';import {defaultDnsSettings} from '../../server/dns-resolvers.js';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import net from 'node:net';import {once} from 'node:events';import assert from 'node:assert/strict';
const folder=mkdtempSync(join(tmpdir(),'fg-live-reload-')),wrapper=join(folder,'mihomo-wrapper');
const binary=moduleBinary('mihomo','mihomo','/opt/freedomgate/modules/mihomo/v1.19.33/mihomo');
writeFileSync(wrapper,`#!/usr/bin/env python3\nimport sys,os\np=sys.argv[sys.argv.index('-f')+1]\ns=open(p).read().replace('tun:\\n  enable: true','tun:\\n  enable: false')\nopen(p,'w').write(s)\nos.execv(${JSON.stringify(binary)},[${JSON.stringify(binary)}]+sys.argv[1:])\n`,{mode:0o700});
const bridge={prepare:async()=>({bridges:{},commit:async()=>{},rollback:async()=>{}}),status:()=>({}),stop:async()=>{}};
const supervisor=new MihomoSupervisor({binary:wrapper,stateDir:folder,mixedPort:await unusedPort(),dnsPort:await unusedPort(),controllerPort:await unusedPort(),xray:bridge,ssRelay:bridge});
const echo=net.createServer(socket=>socket.on('data',chunk=>socket.write(chunk)));await new Promise(r=>echo.listen(0,'127.0.0.1',r));let socket;
try{
 assert.equal((await supervisor.apply(defaultDnsSettings)).ok,true);const pid=supervisor.status().pid;
 socket=net.connect(supervisor.mixedPort,'127.0.0.1');await once(socket,'connect');let response=once(socket,'data');socket.write(`CONNECT 127.0.0.1:${echo.address().port} HTTP/1.1\r\nHost: localhost\r\n\r\n`);assert.match(String((await response)[0]),/200/);
 response=once(socket,'data');socket.write('before');assert.equal(String((await response)[0]),'before');
 await supervisor.routeTrafficCollector.sample();
 const ids=(await supervisor.controller('/connections')).connections.map(row=>row.id);
 supervisor.setRoutes([],[{id:'smoke',entries:['hot-reload.invalid'],routeId:'direct'}],[{id:'direct',engine:'direct'}]);
 assert.equal((await supervisor.reapply()).ok,true);assert.equal(supervisor.status().pid,pid);
 response=once(socket,'data');socket.write('after');assert.equal(String((await response)[0]),'after');
 assert.ok((await supervisor.controller('/connections')).connections.some(row=>ids.includes(row.id)));
 assert.equal((await supervisor.reapply()).unchanged,true);
 console.log('Real mihomo reload: PID and established TCP stream preserved; unchanged config skipped.');
}finally{socket?.destroy();await supervisor.stop();await new Promise(r=>echo.close(r));rmSync(folder,{recursive:true,force:true});}
