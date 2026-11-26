import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import {logicalInterface, normalizeNetworkSetup, clientNetworks} from '../shared/network.js';
export {logicalInterface, normalizeNetworkSetup, clientNetworks};

const IPV4_CIDR = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/;

function readValue(path) {
  try {
    return readFileSync(path, 'utf8').trim();
  } catch {
    return '';
  }
}

function ipv4Addresses() {
  try {
    const data = JSON.parse(execFileSync('ip', ['-j', '-4', 'addr', 'show'], { encoding: 'utf8' }));
    const map = {};
    for (const item of data) {
      map[item.ifname] = (item.addr_info || []).map(address => `${address.local}/${address.prefixlen}`);
    }
    return map;
  } catch {
    return {};
  }
}

// Read-only interface inventory: no network changes happen here.
export function listInterfaces() {
  let names = [];
  try {
    names = readdirSync('/sys/class/net');
  } catch {
    return [];
  }
  const addresses = ipv4Addresses();
  return names
    .filter(name => name !== 'lo')
    .map(name => {
      const base = `/sys/class/net/${name}`;
      const wireless = existsSync(`${base}/wireless`) || existsSync(`${base}/phy80211`);
      return {
        name,
        type: wireless ? 'wifi' : readValue(`${base}/type`) === '1' ? 'ethernet' : 'other',
        state: readValue(`${base}/operstate`) || 'unknown',
        carrier: readValue(`${base}/carrier`) === '1',
        address: readValue(`${base}/address`),
        addresses: addresses[name] || [],
      };
    });
}

function parseCidr(value) {
  const match = IPV4_CIDR.exec(String(value || '').trim());
  if (!match) return null;
  const octets = match.slice(1, 5).map(Number);
  if (octets.some(octet => octet > 255)) return null;
  const prefix = Number(match[5]);
  if (prefix < 8 || prefix > 30) return null;
  const address = octets.join('.');
  const ip = (octets[0] << 24) + (octets[1] << 16) + (octets[2] << 8) + octets[3];
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const network = (ip & mask) >>> 0;
  return { address, prefix, ip, network, mask, cidr: `${address}/${prefix}` };
}

function ipToString(value) {
  return [value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join('.');
}

function ipv4ToInt(value) {
  const parts = String(value || '').trim().split('.');
  if (parts.length !== 4 || parts.some(part => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return null;
  return parts.reduce((total, part) => ((total << 8) + Number(part)) >>> 0, 0);
}

export function defaultNetworkSetup(interfaces = listInterfaces()) {
  const names = interfaces.map(item => item.name);
  const wired = interfaces.find(item => item.type === 'ethernet' && item.carrier) || interfaces.find(item => item.type === 'ethernet');
  const wifi = interfaces.find(item => item.type === 'wifi');
  const uplink = wired?.name || wifi?.name || names[0] || '';
  const client = wifi && wifi.name !== uplink ? wifi.name : names.find(name => name !== uplink) || '';
  const base = parseCidr('10.10.0.1/24');
  return {
    uplink: { interface: uplink },
    client: { interface: client, type: interfaces.find(item=>item.name===client)?.type==='wifi'?'ap':'ethernet', subnet: base.cidr, ssid: 'FreedomGate', password: '' },
    dhcp: { start: '10.10.0.100', end: '10.10.0.200' },
  };
}

export class NetworkError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NetworkError';
  }
}

function requireInterface(name, label, interfaces) {
  if (!/^[a-zA-Z0-9_.:-]{1,15}$/.test(name)) throw new NetworkError("Invalid network interface name.");
  const found = interfaces.find(item => item.name === name);
  if (!found) throw new NetworkError(`Specify an existing interface for "${label}".`);
  if (found.type === 'other') throw new NetworkError("Select an Ethernet or Wi-Fi interface.");
  if (name === 'lo') throw new NetworkError("Loopback cannot be used as an ingress or egress interface.");
  return found;
}

export function validateNetworkSetup(input, interfaces = listInterfaces()) {
  if (!input || typeof input !== 'object') throw new NetworkError("Specify network settings as an object.");
  const uplinkName = String(input.uplink?.interface || '').trim();
  const clientName = String(input.client?.interface || '').trim();
  const uplink = requireInterface(uplinkName, 'ingress', interfaces);
  const client = requireInterface(clientName, 'egress', interfaces);
  const vlanId = input.client?.vlanId;
  let effectiveClient;
  try {effectiveClient = logicalInterface(clientName, vlanId);} catch(error) {throw new NetworkError(error.message);}
  if (uplinkName === effectiveClient) throw new NetworkError("Ingress and egress must use different interfaces.");

  const type = input.client?.type === 'ethernet' ? 'ethernet' : 'ap';
  if (type === 'ap' && vlanId) throw new NetworkError("VLAN is available only for wired networks.");
  if (type === 'ap' && client.type !== 'wifi') throw new NetworkError("An access point requires a Wi-Fi interface.");
  if (type === 'ethernet' && client.type === 'wifi') throw new NetworkError("Select a wired interface for Ethernet egress.");

  const subnet = parseCidr(input.client?.subnet ?? '10.10.0.1/24');
  if (!subnet) throw new NetworkError("Specify the client subnet in IPv4/CIDR format, such as 10.10.0.1/24.");
  const gateway = ipv4ToInt(subnet.address);
  if ((gateway & subnet.mask) >>> 0 !== subnet.network) {
    throw new NetworkError("The gateway address must belong to the client subnet.");
  }

  const dhcpStart = ipv4ToInt(input.dhcp?.start);
  const dhcpEnd = ipv4ToInt(input.dhcp?.end);
  if (dhcpStart === null || dhcpEnd === null) throw new NetworkError("Specify the DHCP range using its first and last addresses.");
  if (dhcpStart > dhcpEnd) throw new NetworkError("The DHCP range start must not exceed its end.");
  for (const [label, value] of [['start', dhcpStart], ['end', dhcpEnd]]) {
    if ((value & subnet.mask) >>> 0 !== subnet.network) throw new NetworkError(`The "${label}" DHCP address must belong to the client subnet.`);
    if (value === subnet.network) throw new NetworkError("The first subnet address is reserved.");
    if (value === gateway) throw new NetworkError("DHCP addresses must not match the gateway address.");
    const last = (subnet.network | (~subnet.mask >>> 0)) >>> 0;
    if (value === last) throw new NetworkError("The last subnet address is reserved.");
  }

  if (gateway === subnet.network || gateway === ((subnet.network | (~subnet.mask >>> 0)) >>> 0)) throw new NetworkError("The network or broadcast address cannot be used as the gateway.");
  if (dhcpStart <= gateway && gateway <= dhcpEnd) throw new NetworkError("The DHCP range must not include the gateway address.");
  const ssid = String(input.client?.ssid ?? '').trim();
  const password = String(input.client?.password ?? '');
  if (type === 'ap') {
    if (!ssid || Buffer.byteLength(ssid) > 32 || /[\r\n\0]/.test(ssid)) throw new NetworkError("Specify an access point SSID of up to 32 characters.");
    if (Buffer.byteLength(password) < 8 || Buffer.byteLength(password) > 63 || /[\r\n\0]/.test(password)) throw new NetworkError("Specify a Wi-Fi password of between 8 and 63 characters.");
  }

  const warnings = [];
  if (!uplink.carrier) warnings.push(`Ingress ${uplink.name} has no link. Internet access requires an active connection.`);
  if (uplink.type === 'wifi' && client.type === 'wifi' && uplinkName !== clientName) {
    warnings.push('Ingress and egress share a radio. Running a Wi-Fi client and access point on the same radio is unreliable.');
  }
  if (type === 'ap' && client.state !== 'up') warnings.push(`Egress ${client.name} is down. The access point will start when settings are applied.`);

  const result = {
    uplink: { interface: uplinkName },
    client: { interface: clientName, type, ...(vlanId ? {vlanId: Number(vlanId)} : {}), subnet: subnet.cidr, ssid: type === 'ap' ? ssid : '', password: type === 'ap' ? password : '' },
    dhcp: { start: ipToString(dhcpStart), end: ipToString(dhcpEnd) },
    warnings,
  };
  if (input.wired?.enabled) {
    if (type !== 'ap') throw new NetworkError("The additional wired network requires Wi-Fi mode.");
    const wired = validateNetworkSetup({uplink: result.uplink, client: {...input.wired, type:'ethernet'}, dhcp: input.wired.dhcp}, interfaces);
    const other = parseCidr(wired.client.subnet);
    if (subnet.network <= ((other.network | (~other.mask >>> 0)) >>> 0) && other.network <= ((subnet.network | (~subnet.mask >>> 0)) >>> 0)) throw new NetworkError("Wi-Fi and wired client subnets must not overlap.");
    if (effectiveClient === logicalInterface(wired.client.interface, wired.client.vlanId)) throw new NetworkError("Client networks must use different interfaces.");
    result.wired = {...wired.client, enabled:true, dhcp:wired.dhcp};
  }
  for (const network of clientNetworks(result)) {
    const lan = parseCidr(network.subnet);
    for (const address of uplink.addresses || []) {
      const wan = parseCidr(address);
      if (wan && lan.network <= ((wan.network | (~wan.mask >>> 0)) >>> 0) && wan.network <= ((lan.network | (~lan.mask >>> 0)) >>> 0)) throw new NetworkError("The client subnet overlaps with the uplink subnet.");
    }
  }
  return result;
}

export function buildNetworkPlan(setup) {
  const subnet = parseCidr(setup.client.subnet);
  const steps = [
    `Uplink: ${setup.uplink.interface}. The current uplink configuration is preserved.`,
    setup.client.type === 'ap'
      ? `Egress: ${logicalInterface(setup.client.interface, setup.client.vlanId)}, access point "${setup.client.ssid}" (WPA2).`
      : `Egress: ${logicalInterface(setup.client.interface, setup.client.vlanId)}, wired client network.`,
    `Gateway address: ${setup.client.subnet}.`,
    `DHCP: ${setup.dhcp.start}–${setup.dhcp.end}, client DNS: ${setup.client.subnet.split('/')[0]}.`,
    'DNS interception: client UDP/TCP 53 → AdGuard 127.0.0.1:53053; DoT 853 is blocked.',
    `NAT: client network ${ipToString(subnet.network)}/${subnet.prefix} → ${setup.uplink.interface}.`,
    'Isolation: clients cannot access gateway administration or loopback.',
  ];
  if (setup.wired?.enabled) steps.push(`Wired network: ${logicalInterface(setup.wired.interface, setup.wired.vlanId)}, gateway ${setup.wired.subnet}, DHCP ${setup.wired.dhcp.start}–${setup.wired.dhcp.end}. Client networks are isolated from each other.`);
  return steps;
}
