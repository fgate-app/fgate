// Test the saved live setup without modifying user settings or credentials.
import {DatabaseSync} from 'node:sqlite';import {readFileSync} from 'node:fs';import assert from 'node:assert/strict';
import {applyNetwork,applyLeases} from '../../server/network-helper.js';
const db=new DatabaseSync('/var/lib/freedomgate/freedomgate.sqlite',{readOnly:true});
const config=JSON.parse(db.prepare('SELECT value FROM network_settings WHERE id=1').get().value);
const leases=db.prepare('SELECT mac,ip,hostname FROM static_leases ORDER BY ip').all();db.close();
const pids=()=>['hostapd','dnsmasq'].map(name=>readFileSync(`/run/freedomgate/${name}.pid`,'utf8').trim());
const before=pids();
for(let n=0;n<2;n++){
 const result=await applyNetwork({...config,staticLeases:leases});
 assert.equal(result.ok,true);assert.equal(result.unchanged,true);assert.equal(result.wifiRestarted,false);assert.deepEqual(result.applied,[]);assert.deepEqual(pids(),before);
}
const result=await applyLeases(leases);assert.equal(result.unchanged,true);assert.deepEqual(pids(),before);
console.log('Repeated network/lease applies preserve hostapd and dnsmasq PIDs:',before.join(', '));
