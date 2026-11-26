import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';import net from 'node:net';import {once} from 'node:events';
import {MihomoSupervisor} from '../server/mihomo.js';import {unusedPort} from '../server/xray.js';import {defaultDnsSettings} from '../server/dns-resolvers.js';
test('unchanged config is skipped; changed config reloads without closing an established connection',async()=>{
 const stateDir=mkdtempSync(join(tmpdir(),'fg-hot-'));
 const bridge={prepare:async()=>({bridges:{},commit:async()=>{},rollback:async()=>{}}),status:()=>({}),stop:async()=>{}};
 const supervisor=new MihomoSupervisor({binary:resolve('tests/fixtures/mihomo-reload.mjs'),stateDir,mixedPort:await unusedPort(),dnsPort:await unusedPort(),controllerPort:await unusedPort(),xray:bridge,ssRelay:bridge});
 let socket;
 try{
  assert.equal((await supervisor.apply(defaultDnsSettings)).ok,true);const pid=supervisor.status().pid;
  socket=net.connect(supervisor.mixedPort,'127.0.0.1');await once(socket,'connect');
  assert.equal((await supervisor.reapply()).unchanged,true);
  supervisor.setRoutes([], [{id:'test',entries:['reload.invalid'],routeId:'direct'}],[{id:'direct',engine:'direct'}]);
  assert.equal((await supervisor.reapply()).ok,true);assert.equal(supervisor.status().pid,pid);
  const reply=once(socket,'data');socket.write('still connected');assert.equal(String((await reply)[0]),'still connected');assert.equal((await supervisor.controller('/test')).loads,1);
  supervisor.setRoutes([],[{id:'fail',entries:['fail.invalid'],routeId:'direct'}],[{id:'direct',engine:'direct'}]);
  assert.equal((await supervisor.reapply()).ok,false);assert.equal(supervisor.status().state,'running');assert.equal(supervisor.status().pid,pid);
  const restored=once(socket,'data');socket.write('rollback');assert.equal(String((await restored)[0]),'rollback');
 }finally{socket?.destroy();await supervisor.stop();rmSync(stateDir,{recursive:true,force:true});}
});
