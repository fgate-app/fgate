import {hostname,networkInterfaces} from 'node:os';
import {isIP} from 'node:net';
// Accept literal addresses owned by this host, never arbitrary LAN hostnames.
// This preserves DNS-rebinding protection without a test-host IP in the unit.
export function isAdminHost(value,{allowed=process.env.FREEDOMGATE_ALLOWED_HOSTS || '',interfaces=networkInterfaces()}={}) {
 const host=String(value || '').toLowerCase();
 if(allowed.split(',').map(s=>s.trim().toLowerCase()).filter(Boolean).includes(host))return true;
 const match=/^(\[[0-9a-f:]+\]|[a-z0-9.-]+)(?::(\d{1,5}))?$/.exec(host);
 if(!match || match[2] && (Number(match[2])<1 || Number(match[2])>65535))return false;
 const name=match[1].replace(/^\[|\]$/g,'');
 if(['localhost','fgate.home','fgate',hostname().toLowerCase(),'127.0.0.1','::1'].includes(name))return true;
 return !!isIP(name) && Object.values(interfaces).flat().some(entry=>entry.address.toLowerCase()===name);
}
