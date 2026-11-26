// Run as the cloud administrator. Share the printed token over a private channel.
import {randomBytes} from 'node:crypto';
import {CloudRegistry} from '../server/cloud/broker.js';
const token=randomBytes(32).toString('base64url');
new CloudRegistry({dir:(process.env.FG_CLOUD_STATE || '/var/lib/freedomgate-cloud')+'/registry'}).invite(token);
console.log(token);
