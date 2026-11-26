// Run as root inside an isolated network namespace, never against production state.
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {Store} from '../server/store.js';
import {MihomoSupervisor} from '../server/mihomo.js';
import {createGatewayLocations} from '../server/gateway-location.js';
import {diagnosticGatewaySession} from '../server/diagnostic-gateway-session.js';
import {applyRoutesIfReady} from '../server/route-runtime.js';
const dir=mkdtempSync('/tmp/fg-session-native-'),store=new Store(':memory:');
const supervisor=new MihomoSupervisor({stateDir:dir});
supervisor.gatewayLocations.stop();let probes=0;
supervisor.gatewayLocations=createGatewayLocations(profile=>supervisor.locationEndpoints.get(profile.id),{probe:async()=>{probes++;return {ip:'203.0.113.1',country:'Fixture country',city:'Fixture city',provider:'Fixture provider'};}});
try{
 const profile=store.importProfile({name:'Disabled fixture',value:'socks5://192.0.2.1:1080'});
 store.db.prepare('UPDATE profiles SET enabled=0 WHERE id=?').run(profile.id);
 store.addRouteGroup({name:'Fixture route',entries:['session.example'],routeId:profile.id});
 await applyRoutesIfReady(store,supervisor);assert.equal((await supervisor.restore(store.dnsSettings())).ok,true);
 assert.equal(supervisor.locationEndpoints.has(profile.id),false);
 const release=await diagnosticGatewaySession(store,supervisor,profile.id);
 assert.equal(supervisor.locationEndpoints.has(profile.id),true);
 assert.match(readFileSync(supervisor.configPath,'utf8'),/DOMAIN-SUFFIX,session\.example,REJECT/);
 const before=probes;await supervisor.checkGatewayConnection(profile.id,{});assert.ok(probes>before);
 await release();assert.equal(supervisor.locationEndpoints.has(profile.id),false);
 assert.equal(store.profiles().find(p=>p.id===profile.id).enabled,false);
 const metrics=await supervisor.telemetry(store.profiles(),store.connectionGroups());
 assert.equal(metrics.profiles[profile.id].location.provider,'Fixture provider');
 assert.equal(metrics.profiles[profile.id].location.ip,'203.0.113.1');
 const controller=new AbortController();const cancel=await diagnosticGatewaySession(store,supervisor,profile.id,{signal:controller.signal});controller.abort();await cancel();
 assert.equal(supervisor.locationEndpoints.has(profile.id),false);assert.equal(supervisor.diagnosticEnabledIds,null);
 console.log('PASS: native mihomo temporary listener, REJECT production routes, fresh region/provider/IP cache, restore and cancellation; saved gateway remains disabled.');
}finally{await supervisor.stop();store.close();rmSync(dir,{recursive:true,force:true});}
