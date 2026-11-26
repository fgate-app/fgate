// Device display names are not necessarily valid DNS hostnames. Keep names in
// the database/UI, but omit them from DHCP when they cannot be emitted safely.
export function dhcpHostname(value) {
  if (typeof value !== 'string' || !value || value.length>253) return '';
  return value.split('.').every(label=>/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label)) ? value : '';
}
export function safeDhcpLeases(leases) {
  return Array.isArray(leases) ? leases.map(lease=>({...lease,hostname:dhcpHostname(lease?.hostname)})) : [];
}
export function dhcpHostLine(lease) {
  const hostname=dhcpHostname(lease.hostname);
  return `dhcp-host=${lease.mac},${lease.ip}${hostname?','+hostname:''}`;
}

// Validate before stopping a working server. A failed startup restores the last
// configuration and attempts to restore service, then reports the original error.
export async function replaceDhcpConfig(content,{read,validate,write,stop,start}) {
  const previous=await read();
  await validate(content);
  await stop();
  try {
    await write(content);
    await start();
  } catch(error) {
    try {await write(previous);await start();}
    catch(rollbackError) {throw new AggregateError([error,rollbackError],'DHCP update and rollback failed.');}
    throw error;
  }
}
