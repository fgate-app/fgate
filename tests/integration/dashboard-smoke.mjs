// Read-only checks against the running core and AP, with the web service UID/capability.
import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
import {createDashboardTraffic,connectedDeviceCount} from '../../server/dashboard.js';
const config=readFileSync('/var/lib/freedomgate/mihomo/config.yaml','utf8');
const secret=JSON.parse(config.match(/^secret: (.+)$/m)[1]);
const collect=createDashboardTraffic(async path=>{const response=await fetch('http://127.0.0.1:19090'+path,{headers:{Authorization:'Bearer '+secret},signal:AbortSignal.timeout(3000)});assert.equal(response.status,200);return response.json();});
const first=await collect();assert.equal(first.available,true);assert.equal(first.uploadRate,null);
await new Promise(resolve=>setTimeout(resolve,1100));const second=await collect();assert.equal(second.available,true);assert.ok(second.uploadRate>=0 && second.downloadRate>=0);
const devices=await connectedDeviceCount({client:{type:'ap',interface:'wlan0'}});assert.ok(Number.isInteger(devices) && devices>=0,'station metrics must be readable with the service capability');
console.log(JSON.stringify({traffic:second,connectedDevices:devices}));
