import {readLeases} from './clients.js';

export async function applyRoutesIfReady(store, supervisor) {
  if (!supervisor || supervisor.status().state === 'unavailable') return;
  const devices = store.deviceRoutes();
  const groups = store.routeGroups();
  const profiles = store.profiles().map(profile=>supervisor.diagnosticEnabledIds?.has(profile.id)?{...profile,enabled:true,diagnosticOnly:profile.enabled===false}:profile);
  const configs = store.db.prepare('SELECT c.profile_id,c.engine,c.config,p.dpi_bypass AS dpiBypass FROM profile_configs c JOIN profiles p ON p.id=c.profile_id').all();
  const leases = [...readLeases(), ...store.staticLeases()];
  const addresses = new Map(leases.filter(lease => typeof lease.mac === 'string').map(lease => [lease.mac.toLowerCase(), lease.ip]));
  const resolvedDevices = devices.map(device => ({
    ...device,
    identifier: addresses.get(device.identifier.toLowerCase()) || device.identifier,
  }));
  supervisor.setRoutes(resolvedDevices, groups, profiles, configs, store.connectionGroups());
  if (supervisor.status().state === 'running') {
    const result = await supervisor.reapply();
    if (!result?.ok) throw new Error(result?.error || "Failed to apply routes.");
  }
}

export function pinDeviceRoute(store, device) {
  const identifier = String(device?.identifier || '').trim().toLowerCase();
  if (!identifier) return;
  const lease = readLeases().find(client => client.mac.toLowerCase() === identifier || client.ip === identifier);
  if (!lease) return;
  try {
    store.pinStaticLease({ mac: lease.mac, ip: lease.ip, hostname: lease.hostname });
  } catch (error) {
    console.error('FreedomGate: static lease pin failed:', error.message);
  }
}

