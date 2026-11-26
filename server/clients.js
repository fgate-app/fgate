import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const LEASE_FILE = process.env.FREEDOMGATE_LEASE_FILE || join(process.env.FREEDOMGATE_RUN_DIR || '/run/freedomgate', 'dnsmasq.leases');
export function readLeases() {
  try {
    return readFileSync(LEASE_FILE, 'utf8').split('\n').map(line => line.trim()).filter(Boolean).map(line => {
      const [expires, mac, ip, hostname, clientId] = line.split(/\s+/);
      return { expiresAt: Number(expires) * 1000, mac, ip, hostname: hostname === '*' ? '' : hostname, clientId: clientId || '' };
    }).sort((a, b) => a.ip.localeCompare(b.ip, undefined, { numeric: true }));
  } catch {
    return [];
  }
}
export function clientsView(store) {
  const leases = readLeases();
  const statics = new Map(store.staticLeases().map(lease => [lease.mac, lease]));
  const clients = leases.map(lease => ({ ...lease, staticIp: statics.get(lease.mac)?.ip || null }));
  for (const lease of statics.values()) {
    if (!leases.some(client => client.mac === lease.mac)) clients.push({ expiresAt: 0, mac: lease.mac, ip: lease.ip, hostname: lease.hostname || '', clientId: '', staticIp: lease.ip });
  }
  return clients;
}
