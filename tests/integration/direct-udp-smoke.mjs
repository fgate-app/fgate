// Real mihomo, isolated ports and TUN disabled: never changes the host routes.
import {MihomoSupervisor} from '../../server/mihomo.js';import {moduleBinary} from '../../server/module-paths.js';import {unusedPort} from '../../server/xray.js';import {defaultDnsSettings} from '../../server/dns-resolvers.js';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import net from 'node:net';import {once} from 'node:events';import assert from 'node:assert/strict';
const folder=mkdtempSync(join(tmpdir(),'fg-live-reload-')),wrapper=join(folder,'mihomo-wrapper');
const probePort=await unusedPort();
const binary=moduleBinary('mihomo','mihomo','/opt/freedomgate/modules/mihomo/v1.19.33/mihomo');
writeFileSync(wrapper,`#!/usr/bin/env python3\nimport sys,os\np=sys.argv[sys.argv.index('-f')+1]\ns=open(p).read().replace('tun:\\n  enable: true','tun:\\n  enable: false').replace('\"port\":28000','\"port\":${probePort}')\nopen(p,'w').write(s)\nos.execv(${JSON.stringify(binary)},[${JSON.stringify(binary)}]+sys.argv[1:])\n`,{mode:0o700});
const bridge={prepare:async()=>({bridges:{},commit:async()=>{},rollback:async()=>{}}),status:()=>({}),stop:async()=>{}};
const supervisor=new MihomoSupervisor({binary:wrapper,stateDir:folder,mixedPort:await unusedPort(),dnsPort:await unusedPort(),controllerPort:await unusedPort(),xray:bridge,ssRelay:bridge});
import {probeUdp} from '../../server/udp-telemetry.js';
try{
 supervisor.setRoutes([],[{id:'block-probe-ip',entries:['stun.cloudflare.com'],routeId:'block'}],[{id:'direct',engine:'direct'}]);
 assert.equal((await supervisor.apply(defaultDnsSettings)).ok,true);
 const endpoint=supervisor.directUdpEndpoint({id:'direct'});assert.ok(endpoint?.auth);endpoint.port=probePort;
 const result=await probeUdp(endpoint.port,{auth:endpoint.auth,kind:endpoint.kind});
 assert.ok(['ok','timeout','error'].includes(result.status));assert.ok(result.measuredAt);
 const flows=(await supervisor.controller('/connections')).connections || [];
 console.log('Probe result:',result,'flows:',flows.map(row=>({network:row.metadata.network,chains:row.chains})));
 assert.ok(flows.some(row=>row.metadata.network==='udp' && row.chains.includes('DIRECT')),'probe must use pinned DIRECT despite destination REJECT rule');
 console.log('Authenticated pinned DIRECT UDP probe:',result.status,result.delay,'ms; route bypass isolation verified.');
}finally{await supervisor.stop();rmSync(folder,{recursive:true,force:true});}
