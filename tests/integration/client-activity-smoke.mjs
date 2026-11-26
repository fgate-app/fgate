// Read-only checks of actual AP presence and native connection metadata.
import {readFileSync} from 'node:fs';import {DatabaseSync} from 'node:sqlite';import assert from 'node:assert/strict';
import {clientPresence,clientActivity} from '../../server/client-status.js';import {createRouteTrafficCollector} from '../../server/route-traffic.js';
const db=new DatabaseSync('/var/lib/freedomgate/freedomgate.sqlite',{readOnly:true});const setup=JSON.parse(db.prepare('SELECT value FROM network_settings WHERE id=1').get().value);
const clients=db.prepare('SELECT mac,ip FROM static_leases').all();db.close();
for(const line of readFileSync('/run/freedomgate/dnsmasq.leases','utf8').trim().split('\n')){const [,mac,ip]=line.split(/\s+/);if(mac && ip && !clients.some(c=>c.mac===mac))clients.push({mac,ip});}
const config=readFileSync('/var/lib/freedomgate/mihomo/config.yaml','utf8'),secret=JSON.parse(config.match(/^secret: (.+)$/m)[1]);
const collector=createRouteTrafficCollector(async path=>{const response=await fetch('http://127.0.0.1:19090'+path,{headers:{Authorization:'Bearer '+secret}});assert.equal(response.status,200);return response.json();},{clients:()=>clients});
collector.setOwners([]);await collector.sample();const presence=await clientPresence(setup);assert.ok(presence,'presence probe must work with service privileges');assert.equal(collector.snapshot().available,true);
const rows=clientActivity(clients,presence,collector.snapshot());for(const row of rows){assert.ok(row.traffic.upload>=0 && row.traffic.download>=0);assert.equal(typeof row.online,'boolean');}
console.log(JSON.stringify({remembered:rows.length,online:rows.filter(c=>c.online).length,stationCount:presence.online.size,nativeTrafficAvailable:true}));
