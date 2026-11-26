import {isIP} from 'node:net';
import {dhcpHostLine} from './dhcp-config.js';
const MAC_PATTERN = /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i;

export function hostapdConfig(ssid, password, client) {
  return [
    `interface=${client}`,
    'driver=nl80211',
    `ssid=${ssid}`,
    'hw_mode=g',
    'channel=6',
    'ieee80211n=1',
    'ht_capab=[HT40][SHORT-GI-20][DSSS_CCK-40]',
    'wmm_enabled=1',
    'auth_algs=1',
    'macaddr_acl=0',
    'ignore_broadcast_ssid=0',
    'wpa=2',
    `wpa_passphrase=${password}`,
    'wpa_key_mgmt=WPA-PSK',
    'wpa_pairwise=CCMP',
    'rsn_pairwise=CCMP',
    'ctrl_interface=/run/freedomgate/hostapd',
    'logger_syslog=-1',
    'logger_syslog_level=1',
    'logger_stdout=-1',
    'logger_stdout_level=1',
    '',
  ].join('\n');
}

export function normalizeStaticLeases(input) {
  if (!Array.isArray(input)) return [];
  const seen = new Set();
  const leases = [];
  for (const item of input) {
    const mac = String(item?.mac || '').trim().toLowerCase();
    const ip = String(item?.ip || '').trim();
    if (!MAC_PATTERN.test(mac) || !isIP(ip) || seen.has(mac)) continue;
    seen.add(mac);
    leases.push({ mac, ip, hostname: String(item?.hostname || '').trim().slice(0, 100) });
  }
  return leases;
}

export function dnsmasqConfig(client, address, dhcpStart, dhcpEnd, staticLeases = []) {
  return [
    `interface=${client}`,
    'bind-interfaces',
    `listen-address=${address}`,
    `dhcp-range=${dhcpStart},${dhcpEnd},24h`,
    ...staticLeases.map(dhcpHostLine),
    `dhcp-option=3,${address}`,
    `dhcp-option=6,${address}`,
    'pid-file=/run/freedomgate/dnsmasq.pid',
    'dhcp-leasefile=/run/freedomgate/dnsmasq.leases',
    'server=127.0.0.1#53053',
    'no-resolv',
    'no-hosts',
    '',
  ].join('\n');
}

export function nftConfig(client, uplink, subnet, uplinkSubnet, table = 'freedomgate_nat') {
  return `table inet ${table} {
  chain prerouting {
    type nat hook prerouting priority dstnat; policy accept;
    iifname "${client}" ip saddr ${subnet} udp dport 53 redirect to :53053 comment "fg-dns-udp"
    iifname "${client}" ip saddr ${subnet} tcp dport 53 redirect to :53053 comment "fg-dns-tcp"
  }
  chain forward {
    type filter hook forward priority filter; policy accept;
    ${uplinkSubnet ? `iifname "${client}" ip saddr ${subnet} ip daddr ${uplinkSubnet} drop comment "fg-lan-isolation"` : ''}
    iifname "${client}" ip saddr ${subnet} tcp dport 853 drop comment "fg-dot-tcp"
    iifname "${client}" ip saddr ${subnet} udp dport 853 drop comment "fg-dot-udp"
    iifname "${client}" oifname "${uplink}" counter drop comment "fg-tun-required"
    iifname "${uplink}" oifname "${client}" accept
  }
  chain postrouting {
    type nat hook postrouting priority srcnat; policy accept;
    oifname "${uplink}" ip saddr ${subnet} masquerade
  }
}
`;
}

