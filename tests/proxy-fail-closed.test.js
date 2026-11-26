import test from 'node:test';import assert from 'node:assert/strict';
import {buildMihomoConfig} from '../server/mihomo.js';import {defaultDnsSettings} from '../server/dns-resolvers.js';import {nftConfig} from '../server/network-config.js';import {multiNftConfig} from '../server/network-runtime.js';
const render=routes=>buildMihomoConfig(defaultDnsSettings,{}, {devices:[],groups:[],profiles:[],configs:[],...routes});
test('missing, unsupported and disabled individual gateways reject instead of omitting their rules',()=>{
 for(const profiles of [[],[{id:'broken',engine:'outline'}],[{id:'broken',engine:'mihomo',enabled:false}]]){
  const config=render({profiles,groups:[{id:'site',entries:['example.com'],routeId:'broken'}],devices:[{id:'phone',identifier:'10.20.0.2',routeId:'broken'}]});
  assert.match(config,/DOMAIN-SUFFIX,example.com,REJECT/);assert.match(config,/SRC-IP-CIDR,10.20.0.2\/32,REJECT/);
 }
});
test('UDP fallback guard follows proxy match and precedes later direct routes for all proxy types',()=>{
 const config=render({profiles:[{id:'socks',engine:'mihomo'}],configs:[{profile_id:'socks',engine:'mihomo',config:JSON.stringify({type:'socks5',server:'127.0.0.1',port:9,udp:false})}],groups:[{id:'site',entries:['example.com'],routeId:'socks'}],devices:[{id:'phone',identifier:'2001:db8::2',routeId:'socks'}]});
 const rule=config.indexOf('DOMAIN-SUFFIX,example.com,p-socks-grp'),guard=config.indexOf('AND,((NETWORK,udp),(DOMAIN-SUFFIX,example.com)),REJECT');
 assert.ok(rule>0 && guard>rule && guard<config.indexOf('MATCH,DIRECT'));
 assert.match(config,/AND,\(\(NETWORK,udp\),\(SRC-IP-CIDR,2001:db8::2\/128\)\),REJECT/);
});
test('empty groups reject; disabled members remain saved but are excluded; no implicit DIRECT is inserted',()=>{
 const config=render({profiles:[{id:'disabled',engine:'outline',enabled:false}],connectionGroups:[{id:'pool',members:['disabled']}],groups:[{id:'site',entries:['example.com'],routeId:'pool'}]});
 assert.match(config,/name: cg-pool\n    type: url-test\n    proxies:\n      - REJECT/);assert.match(config,/DOMAIN-SUFFIX,example.com,cg-pool/);
});
test('single and multiple LANs cannot forward directly to uplink when TUN vanishes, including IPv6',()=>{
 for(const config of [nftConfig('wlan0','eth0','10.20.0.0/24','192.168.1.0/24'),multiNftConfig([{interface:'wlan0',subnet:'10.20.0.0/24'}],'eth0','192.168.1.0/24')]){
  assert.match(config,/iifname "wlan0" oifname "eth0" counter drop comment "fg-tun-required"/);
  assert.ok(!config.includes('iifname "wlan0" oifname "eth0" accept'));
 }
});
test('explicit zapret/direct members are lower-priority fallback tiers, never latency competitors to proxies',()=>{
 const config=render({profiles:[{id:'direct',engine:'direct'},{id:'zapret',engine:'zapret'},{id:'proxy',engine:'mihomo'}],configs:[{profile_id:'zapret',engine:'zapret',config:''},{profile_id:'proxy',engine:'mihomo',config:JSON.stringify({type:'socks5',server:'127.0.0.1',port:9})}],connectionGroups:[{id:'pool',members:['direct','zapret','proxy']}],groups:[]});
 assert.match(config,/name: cg-pool-proxies\n    type: url-test\n    proxies:\n      - p-proxy-grp/);
 assert.match(config,/name: cg-pool\n    type: fallback\n    proxies:\n      - cg-pool-proxies\n      - p-zapret-grp\n      - DIRECT/);
});
