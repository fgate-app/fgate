import {dhcpHostLine} from './dhcp-config.js';
import {clientNetworks,logicalInterface} from '../shared/network.js';
export function runtimeNetworks(setup) {
  return clientNetworks(setup).map(({ssid,password,...network})=>({...network,parent:network.interface,interface:logicalInterface(network.interface,network.vlanId),address:network.subnet.split('/')[0],prefix:Number(network.subnet.split('/')[1])}));
}
export function multiDnsmasqConfig(networks,leases=[]) {
  return [...networks.flatMap((network,index)=>[
    `interface=${network.interface}`,`listen-address=${network.address}`,
    `dhcp-range=set:lan${index},${network.dhcp.start},${network.dhcp.end},24h`,
    `dhcp-option=tag:lan${index},3,${network.address}`,`dhcp-option=tag:lan${index},6,${network.address}`,
  ]),...leases.map(dhcpHostLine),
  'bind-interfaces','pid-file=/run/freedomgate/dnsmasq.pid','dhcp-leasefile=/run/freedomgate/dnsmasq.leases','server=127.0.0.1#53053','no-resolv','no-hosts',''].join('\n');
}
export function multiNftConfig(networks,uplink,uplinkSubnet,table='freedomgate_nat') {
  const rules=(make)=>networks.flatMap(make).join('\n    ');
  return `table inet ${table} {
  chain prerouting {
    type nat hook prerouting priority dstnat; policy accept;
    ${rules(n=>['udp','tcp'].map(protocol=>`iifname "${n.interface}" ip saddr ${n.subnet} ${protocol} dport 53 redirect to :53053`))}
  }
  chain forward {
    type filter hook forward priority filter; policy accept;
    ${rules(n=>[
      ...networks.filter(other=>other.interface!==n.interface).map(other=>`iifname "${n.interface}" ip daddr ${other.subnet} drop`),
      ...(uplinkSubnet?[`iifname "${n.interface}" ip daddr ${uplinkSubnet} drop`]:[]),
      ...['tcp','udp'].map(protocol=>`iifname "${n.interface}" ${protocol} dport 853 drop`),
      `iifname "${n.interface}" oifname "${uplink}" counter drop comment "fg-tun-required"`,
      `iifname "${uplink}" oifname "${n.interface}" ct state established,related accept`,
    ])}
  }
  chain postrouting {
    type nat hook postrouting priority srcnat; policy accept;
    ${rules(n=>[`oifname "${uplink}" ip saddr ${n.subnet} masquerade`])}
  }
}
`;
}
